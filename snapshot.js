(function () {
    'use strict';

    let currentVideoId = null;
    let lastHashes = { editor: "", rail: "" };
    let observer = null;
    let debounceTimer = null;

    const STORAGE_PREFIX = "video_html_";

    // ------------------------
    // HELPERS
    // ------------------------
    function getVideoId() {
        return new URLSearchParams(window.location.search).get("video_id");
    }

    function getTargets() {
        return {
            editor: document.querySelector("#editor"),
            rail: document.querySelector("#rail")
        };
    }

    function hash(str) {
        let h = 0, i, chr;
        if (!str) return "";
        for (i = 0; i < str.length; i++) {
            chr = str.charCodeAt(i);
            h = ((h << 5) - h) + chr;
            h |= 0;
        }
        return h.toString();
    }

    function createSnapshot() {
        const { editor, rail } = getTargets();
        if (!editor || !rail) return null;

        const editorHTML = editor.outerHTML;
        const railHTML = rail.outerHTML;

        return {
            editorHTML,
            railHTML,
            editorHash: hash(editorHTML),
            railHash: hash(railHTML)
        };
    }

    function storeSnapshot(snapshot) {
        const key = STORAGE_PREFIX + currentVideoId;
        const data = JSON.parse(sessionStorage.getItem(key) || "[]");

        data.push({
            timestamp: new Date().toLocaleTimeString(),
            editorHTML: snapshot.editorHTML,
            railHTML: snapshot.railHTML
        });

        // prevent storage explosion
        if (data.length > 30) data.shift();

        sessionStorage.setItem(key, JSON.stringify(data));
        renderUI();
    }

    // ------------------------
    // OBSERVER
    // ------------------------
    function startObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver(() => {
            clearTimeout(debounceTimer);

            debounceTimer = setTimeout(() => {
                const snap = createSnapshot();
                if (!snap) return;

                const changed =
                    snap.editorHash !== lastHashes.editor ||
                    snap.railHash !== lastHashes.rail;

                if (changed) {
                    lastHashes = {
                        editor: snap.editorHash,
                        rail: snap.railHash
                    };

                    storeSnapshot(snap);
                }
            }, 600);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });

        // initial baseline
        const snap = createSnapshot();
        if (snap) {
            lastHashes = {
                editor: snap.editorHash,
                rail: snap.railHash
            };
        }
    }

    // ------------------------
    // UI
    // ------------------------
    let panel, toggleBtn, visible = true;

    function createUI() {
        toggleBtn = document.createElement("button");
        toggleBtn.textContent = "Snapshots";
        Object.assign(toggleBtn.style, {
            position: "fixed",
            bottom: "10px",
            right: "10px",
            zIndex: 999999,
            padding: "6px 10px",
            background: "#0f0",
            border: "none",
            cursor: "pointer"
        });

        document.body.appendChild(toggleBtn);

        panel = document.createElement("div");
        Object.assign(panel.style, {
            position: "fixed",
            bottom: "50px",
            right: "10px",
            width: "340px",
            maxHeight: "400px",
            overflow: "auto",
            background: "#111",
            color: "#0f0",
            fontSize: "12px",
            zIndex: 999999,
            padding: "10px",
            border: "1px solid #0f0",
            borderRadius: "8px"
        });

        document.body.appendChild(panel);

        toggleBtn.onclick = () => {
            visible = !visible;
            panel.style.display = visible ? "block" : "none";
        };
    }

    function renderUI() {
        if (!panel || !currentVideoId) return;

        const key = STORAGE_PREFIX + currentVideoId;
        const data = JSON.parse(sessionStorage.getItem(key) || "[]");

        const reversed = data.slice().reverse();

        panel.innerHTML = `
            <div><strong>Video:</strong> ${currentVideoId}</div>
            <button id="clearBtn">Clear</button>
            <hr/>
            ${reversed.map((d, i) => `
                <div style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <div>[${d.timestamp}]</div>
                    </div>
                    <div>
                        <button data-i="${i}" class="viewBtn">View</button>
                        <button data-i="${i}" class="deleteBtn" style="color:red;">X</button>
                    </div>
                </div>
            `).join("")}
        `;

        document.querySelectorAll(".viewBtn").forEach(btn => {
            btn.onclick = () => {
                const idx = btn.getAttribute("data-i");
                const snap = reversed[idx];

                const win = window.open("", "_blank");
                const styles = Array.from(document.querySelectorAll("link[rel='stylesheet'], style"))
                    .map(el => el.outerHTML)
                    .join("");
                win.document.write(`
                    <html>
                    <head>
                        <title>Snapshot</title>
                        ${styles}
                    </head>
                    <body>
                    <h2>Editor</h2>
                    ${snap.editorHTML}
                    <hr/>
                    <h2>Rail</h2>
                    ${snap.railHTML}
                `);
            };
        });
        document.querySelectorAll(".deleteBtn").forEach(btn => {
            btn.onclick = () => {
                const idx = Number(btn.getAttribute("data-i"));

                // convert reversed index → real index
                const realIndex = data.length - 1 - idx;

                data.splice(realIndex, 1);

                sessionStorage.setItem(STORAGE_PREFIX + currentVideoId, JSON.stringify(data));
                renderUI();
            };
        });
        document.getElementById("clearBtn").onclick = () => {
            sessionStorage.removeItem(key);
            renderUI();
        };
    }

    // ------------------------
    // ROUTE CHANGE
    // ------------------------
    function hookHistory() {
        const wrap = (type) => {
            const orig = history[type];
            return function () {
                const res = orig.apply(this, arguments);
                setTimeout(init, 500);
                return res;
            };
        };

        history.pushState = wrap("pushState");
        history.replaceState = wrap("replaceState");
        window.addEventListener("popstate", () => setTimeout(init, 500));
    }

    // ------------------------
    // INIT
    // ------------------------
    function init() {
        const vid = getVideoId();
        if (!vid || vid === currentVideoId) return;

        currentVideoId = vid;
        console.log("Tracking HTML snapshots:", vid);

        startObserver();
        renderUI();
    }

    function boot() {
        createUI();
        hookHistory();
        init();
    }

    boot();

})();