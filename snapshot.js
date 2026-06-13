(function () {
    'use strict';

    let currentVideoId = null;
    let lastHashes = { editor: "", rail: "" };
    let observer = null;
    let debounceTimer = null;

    let autoTrackingEnabled = true;

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

    function storeSnapshot(snapshot, name = "") {
        if (!currentVideoId) return;

        const key = STORAGE_PREFIX + currentVideoId;
        const data = JSON.parse(localStorage.getItem(key) || "[]");

        data.push({
            timestamp: Date.now(),
            displayTime: new Date().toLocaleTimeString(),
            name,
            editorHTML: snapshot.editorHTML,
            railHTML: snapshot.railHTML
        });

        // keep only the most recent 10 snapshots per video
        if (data.length > 10) {
            data.splice(0, data.length - 10);
        }

        localStorage.setItem(key, JSON.stringify(data));
        renderUI();
    }

    // ------------------------
    // OBSERVER
    // ------------------------
    function startObserver() {
        if (observer) {
            observer.disconnect();
        }

        observer = new MutationObserver(() => {
            clearTimeout(debounceTimer);

            debounceTimer = setTimeout(() => {
                if (!autoTrackingEnabled) return;

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
            }, 3000);
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
    let panel;
    let toggleBtn;
    let visible = true;

    function styleButton(btn, bg = "#333") {
    Object.assign(btn.style, {
        background: bg,
        color: "#fff",
        border: "1px solid #555",
        borderRadius: "4px",
        padding: "4px 8px",
        cursor: "pointer",
        fontSize: "12px"
    });
}

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
            width: "380px",
            maxHeight: "500px",
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
        const data = JSON.parse(localStorage.getItem(key) || "[]");

        panel.innerHTML = `
            <div style="margin-bottom:8px;">
                <strong>Video:</strong> ${currentVideoId}
            </div>

            <div style="display:flex; gap:4px; flex-wrap:wrap; margin-bottom:8px;">
                <button id="toggleTrackingBtn">
                    Auto: ${autoTrackingEnabled ? "ON" : "OFF"}
                </button>

                <button id="manualSnapshotBtn">
                    Take Snapshot
                </button>

                <button id="clearBtn">
                    Clear This Video
                </button>

                <button id="clearAllBtn">
                    Clear All Snapshots
                </button>
            </div>

            <hr/>

            ${data.map((d, i) => `
                <div style="
                    margin-bottom:8px;
                    display:flex;
                    justify-content:space-between;
                    align-items:center;
                    gap:8px;
                ">
                    <div style="flex:1; overflow:hidden;">
                        <div>
                            [${d.displayTime}]
                            ${d.name ? ` - ${escapeHtml(d.name)}` : ""}
                        </div>
                    </div>

                    <div style="white-space:nowrap;">
                        <button data-i="${i}" class="renameBtn">
                            Rename
                        </button>

                        <button data-i="${i}" class="viewBtn">
                            View
                        </button>

                        <button
                            data-i="${i}"
                            class="deleteBtn"
                            style="color:red;"
                        >
                            X
                        </button>
                    </div>
                </div>
            `).join("")}
        `;

        const toggleTrackingBtn = document.getElementById("toggleTrackingBtn");
        const manualSnapshotBtn = document.getElementById("manualSnapshotBtn");
        const clearBtn = document.getElementById("clearBtn");
        const clearAllBtn = document.getElementById("clearAllBtn");

        styleButton(
            toggleTrackingBtn,
            autoTrackingEnabled ? "#2d6a4f" : "#7f1d1d"
        );

        styleButton(manualSnapshotBtn, "#1d4ed8");
        styleButton(clearBtn, "#991b1b");
        styleButton(clearAllBtn, "#7f1d1d");

        toggleTrackingBtn.onclick = () => {
            autoTrackingEnabled = !autoTrackingEnabled;
            renderUI();
        };

        manualSnapshotBtn.onclick = () => {
            const snap = createSnapshot();
            if (!snap) {
                alert("Could not capture snapshot.");
                return;
            }

            // const name = prompt("Snapshot name (optional):") || "";
            storeSnapshot(snap, "MANUAL");
        };

        clearBtn.onclick = () => {
            if (!confirm("Delete all snapshots for this video?")) {
                return;
            }

            localStorage.removeItem(key);
            renderUI();
        };

        clearAllBtn.onclick = () => {
            if (!confirm("Delete all saved snapshot data for every video?")) {
                return;
            }

            for (let i = 0; i < localStorage.length; i++) {
                const storageKey = localStorage.key(i);

                if (storageKey && storageKey.startsWith(STORAGE_PREFIX)) {
                    localStorage.removeItem(storageKey);
                }
            }

            // currentVideoId = null;
            // lastHashes = { editor: "", rail: "" };
            renderUI();
        };

        document.querySelectorAll(".renameBtn").forEach(btn => {
            styleButton(btn, "#444");
            btn.onclick = () => {
                const idx = Number(btn.getAttribute("data-i"));

                const currentName = data[idx].name || "";

                const newName = prompt(
                    "Snapshot name:",
                    currentName
                );

                if (newName === null) return;

                data[idx].name = newName;

                localStorage.setItem(
                    key,
                    JSON.stringify(data)
                );

                renderUI();
            };
        });

        document.querySelectorAll(".viewBtn").forEach(btn => {

            styleButton(btn, "#1d4ed8");

            btn.onclick = () => {

                const idx = Number(btn.getAttribute("data-i"));
                const snap = data[idx];

                const win = window.open("", "_blank");

                const styles = Array
                    .from(
                        document.querySelectorAll(
                            "link[rel='stylesheet'], style"
                        )
                    )
                    .map(el => el.outerHTML)
                    .join("");

                win.document.write(`
        <!DOCTYPE html>
        <html>

        <head>

        <title>
            ${snap.name || "Snapshot"}
        </title>

        ${styles}

        <style>

        html,
        body {
            margin: 0;
            height: 100%;
            overflow: hidden;
            font-family: sans-serif;
        }

        .header {
            height: 52px;
            padding: 10px;
            box-sizing: border-box;
            border-bottom: 1px solid #ccc;
            background: #f5f5f5;
        }

        .container {
            display: flex;
            height: calc(100% - 52px);
        }

        .panel {
            overflow: auto;
            padding: 12px;
            box-sizing: border-box;
        }

        #editorPanel {
            width: 60%;
            min-width: 150px;
        }

        #railPanel {
            flex: 1;
            min-width: 150px;
        }

        #divider {
            width: 8px;
            cursor: col-resize;
            background: #999;
            user-select: none;
        }

        #divider:hover {
            background: #666;
        }

        .panelTitle {
            margin-top: 0;
            position: sticky;
            top: 0;
            background: white;
            padding-bottom: 8px;
            border-bottom: 1px solid #ddd;
        }

        </style>

        </head>

        <body>

        <div class="header">
            <strong>${snap.name || "Unnamed Snapshot"}</strong>
            &nbsp;&nbsp;
            (${snap.displayTime})
        </div>

        <div class="container">

            <div id="editorPanel" class="panel">
                ${snap.editorHTML}
            </div>

            <div id="divider"></div>

            <div id="railPanel" class="panel">
                ${snap.railHTML}
            </div>

        </div>

        <script>

        const divider = document.getElementById("divider");
        const editorPanel = document.getElementById("editorPanel");

        let dragging = false;

        divider.addEventListener("mousedown", () => {
            dragging = true;
        });

        document.addEventListener("mouseup", () => {
            dragging = false;
        });

        document.addEventListener("mousemove", (e) => {

            if (!dragging) return;

            const pct =
                (e.clientX / window.innerWidth) * 100;

            const clamped =
                Math.max(15, Math.min(85, pct));

            editorPanel.style.width =
                clamped + "%";
        });

        </script>

        </body>

        </html>
        `);

                win.document.close();
            };
        });

        document.querySelectorAll(".deleteBtn").forEach(btn => {
            styleButton(btn, "#991b1b");
            btn.onclick = () => {
                const idx = Number(btn.getAttribute("data-i"));

                // if (!confirm("Delete this snapshot?")) {
                //     return;
                // }

                data.splice(idx, 1);

                localStorage.setItem(
                    key,
                    JSON.stringify(data)
                );

                renderUI();
            };
        });
    }

    function escapeHtml(str) {
        return String(str)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
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

        window.addEventListener("popstate", () => {
            setTimeout(init, 500);
        });
    }

    // ------------------------
    // INIT
    // ------------------------
    function init() {
        const vid = getVideoId();

        if (!vid || vid === currentVideoId) {
            return;
        }

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