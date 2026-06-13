// ==UserScript==
// @name         Snapshots v1.4
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Takes snapshots of a lovable site for fixing.
// @author       RQ
// @include      *://*annotator*.lovable.app/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let currentVideoId = null;
    let lastHashes = { editor: "", rail: "" };
    let observer = null;
    let debounceTimer = null;

    let autoTrackingEnabled = true;
    let activeSnapshotTab = "auto";
    let settingsVisible = false;
    let storageFull = false;

    const STORAGE_PREFIX = "video_html_";
    const UI_POSITION_KEY = "snapshot_ui_position";
    const SETTINGS_KEY = "snapshot_settings";
    const VISIBLE_LIST_ROWS = 5;
    const DRAG_THRESHOLD = 5;
    const DEFAULT_SETTINGS = {
        maxAutoSnapshots: 10,
        debounceMs: 1000
    };

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

    function isManualSnapshot(entry) {
        return entry.manual === true || entry.name === "MANUAL";
    }

    function isAutoSnapshot(entry) {
        return !isManualSnapshot(entry);
    }

    function clampNumber(value, min, max, fallback) {
        const num = Number(value);

        if (!Number.isFinite(num)) {
            return fallback;
        }

        return Math.max(min, Math.min(max, num));
    }

    function getSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");

            if (saved) {
                return {
                    maxAutoSnapshots: clampNumber(
                        saved.maxAutoSnapshots,
                        6,
                        10,
                        DEFAULT_SETTINGS.maxAutoSnapshots
                    ),
                    debounceMs: Math.max(
                        100,
                        Number(saved.debounceMs) || DEFAULT_SETTINGS.debounceMs
                    )
                };
            }
        } catch (err) {
            console.warn("Invalid snapshot settings.", err);
        }

        return { ...DEFAULT_SETTINGS };
    }

    function saveSettings(updates) {
        const settings = {
            maxAutoSnapshots: clampNumber(
                updates.maxAutoSnapshots,
                6,
                10,
                DEFAULT_SETTINGS.maxAutoSnapshots
            ),
            debounceMs: Math.max(
                100,
                Number(updates.debounceMs) || DEFAULT_SETTINGS.debounceMs
            )
        };

        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (err) {
            notifyStorageFull(err);
            return null;
        }

        startObserver();
        return settings;
    }

    function getMaxAutoSnapshots() {
        return getSettings().maxAutoSnapshots;
    }

    function getDebounceMs() {
        return getSettings().debounceMs;
    }

    function notifyStorageFull(err) {
        if (err && err.name !== "QuotaExceededError" && err.code !== 22) {
            throw err;
        }

        storageFull = true;

        alert(
            "Browser storage is full. Snapshots could not be saved.\n\n"
            + "Try deleting snapshots from other videos, clearing older auto snapshots, "
            + "or using \"Clear Other Videos\" to free space."
        );
    }

    function persistSnapshotData(key, data) {
        const trimmed = trimSnapshots(data);

        try {
            localStorage.setItem(key, JSON.stringify(trimmed));
            storageFull = false;
            return true;
        } catch (err) {
            notifyStorageFull(err);
            return false;
        }
    }

    function getTotalSnapshotCount() {
        let total = 0;

        for (let i = 0; i < localStorage.length; i++) {
            const storageKey = localStorage.key(i);

            if (storageKey && storageKey.startsWith(STORAGE_PREFIX)) {
                const data = JSON.parse(localStorage.getItem(storageKey) || "[]");
                total += data.length;
            }
        }

        return total;
    }

    function trimSnapshots(data, maxAuto = getMaxAutoSnapshots()) {
        const manual = data.filter(isManualSnapshot);
        let auto = data.filter(isAutoSnapshot);

        auto.sort((a, b) => a.timestamp - b.timestamp);

        if (auto.length > maxAuto) {
            auto = auto.slice(auto.length - maxAuto);
        }

        return [...manual, ...auto].sort((a, b) => a.timestamp - b.timestamp);
    }

    function storeSnapshot(snapshot, options = {}) {
        const manual = options.manual === true;
        const name = options.name || (manual ? "MANUAL" : "");

        if (!currentVideoId) return;

        const key = STORAGE_PREFIX + currentVideoId;
        const data = JSON.parse(localStorage.getItem(key) || "[]");

        data.push({
            timestamp: Date.now(),
            displayTime: new Date().toLocaleTimeString(),
            name,
            manual,
            editorHTML: snapshot.editorHTML,
            railHTML: snapshot.railHTML
        });

        if (!persistSnapshotData(key, data)) {
            return false;
        }

        renderUI();
        return true;
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

                    storeSnapshot(snap, { manual: false });
                }
            }, getDebounceMs());
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
    let dragState = null;
    let suppressToggleClick = false;

    function getSavedButtonPosition() {
        try {
            const saved = JSON.parse(localStorage.getItem(UI_POSITION_KEY) || "null");

            if (
                saved
                && typeof saved.left === "number"
                && typeof saved.top === "number"
            ) {
                return saved;
            }
        } catch (err) {
            console.warn("Invalid saved snapshot UI position.", err);
        }

        return null;
    }

    function saveButtonPosition() {
        if (!toggleBtn) return;

        localStorage.setItem(UI_POSITION_KEY, JSON.stringify({
            left: parseFloat(toggleBtn.style.left) || 0,
            top: parseFloat(toggleBtn.style.top) || 0
        }));
    }

    function setButtonPosition(left, top) {
        if (!toggleBtn) return;

        const maxLeft = Math.max(0, window.innerWidth - toggleBtn.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - toggleBtn.offsetHeight);

        toggleBtn.style.left = `${Math.max(0, Math.min(maxLeft, left))}px`;
        toggleBtn.style.top = `${Math.max(0, Math.min(maxTop, top))}px`;
        toggleBtn.style.right = "auto";
        toggleBtn.style.bottom = "auto";
    }

    function positionButtonDefault() {
        if (!toggleBtn) return;

        setButtonPosition(
            window.innerWidth - toggleBtn.offsetWidth - 10,
            window.innerHeight - toggleBtn.offsetHeight - 10
        );
    }

    function loadButtonPosition() {
        const saved = getSavedButtonPosition();

        if (saved) {
            setButtonPosition(saved.left, saved.top);
        } else {
            positionButtonDefault();
        }
    }

    function updatePanelPosition() {
        if (!panel || !toggleBtn) return;

        const gap = 8;
        const panelWidth = panel.offsetWidth || 380;
        const btnRect = toggleBtn.getBoundingClientRect();
        const wasHidden = panel.style.display === "none";

        panel.style.display = "block";
        panel.style.visibility = "hidden";

        const panelHeight = panel.offsetHeight;
        const spaceAbove = btnRect.top;
        const spaceBelow = window.innerHeight - btnRect.bottom;
        const buttonInTopHalf = btnRect.top + (btnRect.height / 2) < window.innerHeight / 2;
        const preferBelow = buttonInTopHalf || spaceAbove < panelHeight + gap;

        let panelTop;

        if (preferBelow) {
            panelTop = btnRect.bottom + gap;
        } else {
            panelTop = btnRect.top - panelHeight - gap;
        }

        if (panelTop + panelHeight + gap > window.innerHeight) {
            panelTop = Math.max(gap, window.innerHeight - panelHeight - gap);
        }

        if (panelTop < gap) {
            panelTop = btnRect.bottom + gap;

            if (panelTop + panelHeight + gap > window.innerHeight) {
                panelTop = Math.max(gap, window.innerHeight - panelHeight - gap);
            }
        }

        let panelLeft = btnRect.left;

        if (panelLeft + panelWidth + gap > window.innerWidth) {
            panelLeft = window.innerWidth - panelWidth - gap;
        }

        panelLeft = Math.max(gap, panelLeft);

        panel.style.left = `${panelLeft}px`;
        panel.style.top = `${panelTop}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.visibility = "";
        panel.style.display = wasHidden && !visible ? "none" : "block";
    }

    function setupDraggableUi() {
        toggleBtn.style.cursor = "grab";

        toggleBtn.addEventListener("mousedown", (event) => {
            if (event.button !== 0) return;

            dragState = {
                startX: event.clientX,
                startY: event.clientY,
                startLeft: parseFloat(toggleBtn.style.left) || 0,
                startTop: parseFloat(toggleBtn.style.top) || 0,
                moved: false
            };

            event.preventDefault();
        });

        document.addEventListener("mousemove", (event) => {
            if (!dragState) return;

            const dx = event.clientX - dragState.startX;
            const dy = event.clientY - dragState.startY;

            if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
                return;
            }

            dragState.moved = true;
            toggleBtn.style.cursor = "grabbing";
            setButtonPosition(dragState.startLeft + dx, dragState.startTop + dy);
            updatePanelPosition();
        });

        document.addEventListener("mouseup", () => {
            if (!dragState) return;

            if (dragState.moved) {
                saveButtonPosition();
                suppressToggleClick = true;
            }

            dragState = null;
            toggleBtn.style.cursor = "grab";
        });

        window.addEventListener("resize", () => {
            const saved = getSavedButtonPosition();

            if (saved) {
                setButtonPosition(saved.left, saved.top);
            } else {
                positionButtonDefault();
            }

            updatePanelPosition();
        });
    }

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
            zIndex: 999999,
            padding: "6px 10px",
            background: "rgb(204, 216, 216)",
            border: "none",
            cursor: "grab",
            userSelect: "none"
        });

        document.body.appendChild(toggleBtn);

        panel = document.createElement("div");

        Object.assign(panel.style, {
            position: "fixed",
            width: "380px",
            background: "#111",
            color: "rgb(204, 216, 216)",
            fontSize: "12px",
            zIndex: 999999,
            padding: "10px",
            border: "1px solid rgb(27, 31, 27)",
            borderRadius: "8px",
            overflow: "visible"
        });

        document.body.appendChild(panel);

        loadButtonPosition();
        setupDraggableUi();
        updatePanelPosition();

        toggleBtn.onclick = () => {
            if (suppressToggleClick) {
                suppressToggleClick = false;
                return;
            }

            visible = !visible;
            panel.style.display = visible ? "block" : "none";

            if (visible) {
                updatePanelPosition();
            }
        };
    }

    function bindSettingsHandlers() {
        const saveSettingsBtn = document.getElementById("saveSettingsBtn");
        const settingsBtn = document.getElementById("settingsBtn");

        if (settingsBtn) {
            styleButton(settingsBtn, settingsVisible ? "#2d6a4f" : "#444");
            settingsBtn.onclick = () => {
                settingsVisible = !settingsVisible;
                renderUI();
            };
        }

        if (!saveSettingsBtn) {
            return;
        }

        styleButton(saveSettingsBtn, "#2d6a4f");

        saveSettingsBtn.onclick = () => {
            const maxAutoInput = document.getElementById("maxAutoInput");
            const debounceInput = document.getElementById("debounceInput");
            const debounceSeconds = Number(debounceInput.value);

            const saved = saveSettings({
                maxAutoSnapshots: maxAutoInput.value,
                debounceMs: Math.round(debounceSeconds * 1000)
            });

            if (!saved) {
                return;
            }

            settingsVisible = false;
            renderUI();
        };
    }

    function renderSettingsPanel(settings) {
        if (!settingsVisible) {
            return "";
        }

        return `
            <div id="settingsPanel" style="
                margin-bottom:8px;
                padding:10px;
                border:1px solid #333;
                border-radius:4px;
                background:#1a1a1a;
            ">
                <div style="margin-bottom:8px; font-weight:bold;">Settings</div>

                <label style="display:block; margin-bottom:8px;">
                    Auto snapshots to keep (6-10):
                    <input
                        id="maxAutoInput"
                        type="number"
                        min="6"
                        max="10"
                        step="1"
                        value="${settings.maxAutoSnapshots}"
                        style="width:60px; margin-left:6px;"
                    />
                </label>

                <label style="display:block; margin-bottom:8px;">
                    Debounce timer (seconds):
                    <input
                        id="debounceInput"
                        type="number"
                        min="0.1"
                        max="30"
                        step="0.1"
                        value="${(settings.debounceMs / 1000).toFixed(1)}"
                        style="width:60px; margin-left:6px;"
                    />
                </label>

                <button id="saveSettingsBtn">Save Settings</button>
            </div>
        `;
    }

    function renderPanelHeader(titleExtra = "") {
        const totalCount = getTotalSnapshotCount();

        return `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px;">
                <div style="min-width:0; overflow:hidden;">
                    <strong>Snapshots v2.5</strong>${titleExtra}
                </div>
                <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                    <button id="settingsBtn" title="Settings">Settings</button>
                    <span style="color:#8f8;">Total: ${totalCount}</span>
                </div>
            </div>
        `;
    }

    function renderUI() {
        if (!panel) return;

        const settings = getSettings();

        if (!currentVideoId) {
            panel.innerHTML = `
                ${renderPanelHeader()}
                ${storageFull ? `
                    <div style="
                        margin-bottom:8px;
                        padding:8px;
                        background:#5c1a1a;
                        border:1px solid #a33;
                        border-radius:4px;
                        color:#fcc;
                    ">
                        Storage is full. Delete snapshots to continue saving.
                    </div>
                ` : ""}
                ${renderSettingsPanel(settings)}
                <div>No video selected.</div>
            `;
            bindSettingsHandlers();
            updatePanelPosition();
            return;
        }

        const key = STORAGE_PREFIX + currentVideoId;
        const data = JSON.parse(localStorage.getItem(key) || "[]");
        const filtered = data
            .map((entry, storageIdx) => ({ entry, storageIdx }))
            .filter(({ entry }) => (
                activeSnapshotTab === "manual"
                    ? isManualSnapshot(entry)
                    : isAutoSnapshot(entry)
            ))
            .reverse();
        const tabCount = activeSnapshotTab === "manual"
            ? data.filter(isManualSnapshot).length
            : data.filter(isAutoSnapshot).length;
        const listMaxHeight = VISIBLE_LIST_ROWS * 44;

        panel.innerHTML = `
            ${renderPanelHeader(` — ${currentVideoId}`)}
            ${storageFull ? `
                <div style="
                    margin-bottom:8px;
                    padding:8px;
                    background:#5c1a1a;
                    border:1px solid #a33;
                    border-radius:4px;
                    color:#fcc;
                ">
                    Storage is full. Delete snapshots or use Clear Other Videos to free space.
                </div>
            ` : ""}
            ${renderSettingsPanel(settings)}

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

                <button id="clearOtherVideosBtn">
                    Clear Other Videos
                </button>
            </div>

            <div style="display:flex; gap:4px; margin-bottom:8px;">
                <button id="autoTabBtn" class="snapshotTabBtn">
                    Auto (${data.filter(isAutoSnapshot).length})
                </button>
                <button id="manualTabBtn" class="snapshotTabBtn">
                    Manual (${data.filter(isManualSnapshot).length})
                </button>
            </div>

            <div id="snapshotList" style="
                max-height:${listMaxHeight}px;
                overflow-y:auto;
                border:1px solid #333;
                border-radius:4px;
                margin-bottom:4px;
            ">
                ${filtered.length === 0 ? `
                    <div style="padding:12px; color:#888; text-align:center;">
                        No ${activeSnapshotTab} snapshots.
                    </div>
                ` : filtered.map(({ entry, storageIdx }) => `
                    <div class="snapshot-row" style="
                        min-height:40px;
                        padding:6px 8px;
                        display:flex;
                        justify-content:space-between;
                        align-items:center;
                        gap:8px;
                        border-bottom:1px solid #222;
                        box-sizing:border-box;
                    ">
                        <div style="flex:1; overflow:hidden;">
                            <div>
                                [${entry.displayTime}]
                                ${entry.name ? ` - ${escapeHtml(entry.name)}` : ""}
                            </div>
                        </div>

                        <div style="white-space:nowrap;">
                            <button data-i="${storageIdx}" class="renameBtn">
                                Rename
                            </button>

                            <button data-i="${storageIdx}" class="viewBtn">
                                View
                            </button>

                            <button
                                data-i="${storageIdx}"
                                class="deleteBtn"
                                style="color:red;"
                            >
                                X
                            </button>
                        </div>
                    </div>
                `).join("")}
            </div>

            <div style="color:#888; font-size:11px; text-align:right;">
                ${tabCount} ${activeSnapshotTab} snapshot${tabCount === 1 ? "" : "s"}${tabCount > VISIBLE_LIST_ROWS ? " - scroll for more" : ""}
            </div>
        `;

        const toggleTrackingBtn = document.getElementById("toggleTrackingBtn");
        const manualSnapshotBtn = document.getElementById("manualSnapshotBtn");
        const clearBtn = document.getElementById("clearBtn");
        const clearOtherVideosBtn = document.getElementById("clearOtherVideosBtn");

        styleButton(
            toggleTrackingBtn,
            autoTrackingEnabled ? "#2d6a4f" : "#7f1d1d"
        );

        styleButton(manualSnapshotBtn, "#1d4ed8");
        styleButton(clearBtn, "#991b1b");
        styleButton(clearOtherVideosBtn, "#7f1d1d");

        bindSettingsHandlers();

        const autoTabBtn = document.getElementById("autoTabBtn");
        const manualTabBtn = document.getElementById("manualTabBtn");

        styleButton(autoTabBtn, activeSnapshotTab === "auto" ? "#2d6a4f" : "#333");
        styleButton(manualTabBtn, activeSnapshotTab === "manual" ? "#2d6a4f" : "#333");

        autoTabBtn.onclick = () => {
            activeSnapshotTab = "auto";
            renderUI();
        };

        manualTabBtn.onclick = () => {
            activeSnapshotTab = "manual";
            renderUI();
        };

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
            storeSnapshot(snap, { manual: true });
        };

        clearBtn.onclick = () => {
            if (!confirm("Delete all snapshots for this video?")) {
                return;
            }

            localStorage.removeItem(key);
            storageFull = false;
            renderUI();
        };

        clearOtherVideosBtn.onclick = () => {
            if (!confirm(
                "Delete all snapshots for other videos? "
                + "This video's snapshots will be kept."
            )) {
                return;
            }

            const currentKey = STORAGE_PREFIX + currentVideoId;
            const keysToRemove = [];

            for (let i = 0; i < localStorage.length; i++) {
                const storageKey = localStorage.key(i);

                if (
                    storageKey
                    && storageKey.startsWith(STORAGE_PREFIX)
                    && storageKey !== currentKey
                ) {
                    keysToRemove.push(storageKey);
                }
            }

            keysToRemove.forEach((storageKey) => {
                localStorage.removeItem(storageKey);
            });

            storageFull = false;
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

                if (isAutoSnapshot(data[idx])) {
                    data[idx].manual = true;
                }

                if (!persistSnapshotData(key, data)) {
                    return;
                }

                renderUI();
            };
        });

        document.querySelectorAll(".viewBtn").forEach(btn => {
            styleButton(btn, "#1d4ed8");

            btn.onclick = () => {
                const idx = Number(btn.getAttribute("data-i"));
                openViewWindow(data[idx]);
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

                if (!persistSnapshotData(key, data)) {
                    return;
                }

                renderUI();
            };
        });

        if (visible) {
            updatePanelPosition();
        }
    }

    function escapeHtml(str) {
        return String(str)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function getPageStyles() {
        return Array
            .from(document.querySelectorAll("link[rel='stylesheet'], style"))
            .map((el) => el.outerHTML)
            .join("");
    }

    function getSnapshotWindowStyles(extra = "") {
        return `
        ${getPageStyles()}

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
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .header-title {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .header-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }

        #compareToggleBtn {
            border: 1px solid #999;
            background: #fff;
            border-radius: 4px;
            padding: 4px 10px;
            cursor: pointer;
            font-size: 12px;
        }

        #compareToggleBtn.active {
            background: #2d6a4f;
            border-color: #2d6a4f;
            color: #fff;
        }

        #compareToggleBtn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .compare-legend {
            display: none;
            gap: 12px;
            font-size: 11px;
            color: #555;
        }

        .compare-legend.visible {
            display: inline-flex;
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

        mark.snap-diff-add {
            background: rgba(46, 160, 67, 0.45);
            color: inherit;
            border-radius: 2px;
            padding: 0 1px;
        }

        mark.snap-diff-remove {
            background: rgba(248, 81, 73, 0.35);
            color: inherit;
            text-decoration: line-through;
            border-radius: 2px;
            padding: 0 1px;
        }

        .snap-diff-field {
            display: inline-block;
            box-sizing: border-box;
            min-height: 1.25em;
            white-space: pre-wrap;
            word-break: break-word;
        }

        input.snap-diff-field,
        textarea.snap-diff-field,
        .snap-diff-field[data-snap-diff-field="input"],
        .snap-diff-field[data-snap-diff-field="textarea"] {
            border: 1px solid #ccc;
            border-radius: 4px;
            padding: 4px 8px;
            background: #fff;
        }

        .snap-diff-state-add {
            outline: 2px solid #3fb950 !important;
            outline-offset: 2px;
        }

        .snap-diff-state-remove {
            outline: 2px solid #f85149 !important;
            outline-offset: 2px;
        }

        .legend {
            display: inline-flex;
            gap: 12px;
            margin-left: 12px;
            font-size: 11px;
            color: #555;
        }

        .legend-item {
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }

        .legend-swatch {
            width: 10px;
            height: 10px;
            border-radius: 2px;
        }

        .legend-add {
            background: rgba(46, 160, 67, 0.55);
        }

        .legend-remove {
            background: rgba(248, 81, 73, 0.45);
        }

        ${extra}
        </style>
        `;
    }

    function parseHtml(html) {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = html;
        return wrapper.firstElementChild;
    }

    function tokenizeWords(text) {
        return text.match(/\s+|[^\s]+/g) || [];
    }

    function diffWords(oldText, newText) {
        const oldWords = tokenizeWords(oldText);
        const newWords = tokenizeWords(newText);
        const m = oldWords.length;
        const n = newWords.length;
        const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (oldWords[i - 1] === newWords[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        const result = [];
        let i = m;
        let j = n;

        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
                result.unshift({ type: "same", text: oldWords[i - 1] });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                result.unshift({ type: "add", text: newWords[j - 1] });
                j--;
            } else {
                result.unshift({ type: "remove", text: oldWords[i - 1] });
                i--;
            }
        }

        return result;
    }

    function createDiffFragment(oldText, newText) {
        const parts = diffWords(oldText, newText);
        const frag = document.createDocumentFragment();

        for (const part of parts) {
            if (part.type === "same") {
                frag.appendChild(document.createTextNode(part.text));
                continue;
            }

            const mark = document.createElement("mark");
            mark.className = part.type === "add"
                ? "snap-diff-add"
                : "snap-diff-remove";
            mark.textContent = part.text;
            frag.appendChild(mark);
        }

        return frag;
    }

    function getElementByPath(root, path) {
        let node = root;

        for (const idx of path) {
            if (!node || idx >= node.childNodes.length) {
                return null;
            }

            node = node.childNodes[idx];
        }

        return node && node.nodeType === Node.ELEMENT_NODE ? node : null;
    }

    function isTextFieldElement(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }

        const tag = el.tagName;

        if (tag === "TEXTAREA") {
            return true;
        }

        if (tag === "INPUT") {
            const type = (el.getAttribute("type") || "text").toLowerCase();

            return type !== "hidden"
                && type !== "checkbox"
                && type !== "radio"
                && type !== "button"
                && type !== "submit"
                && type !== "reset"
                && type !== "file";
        }

        if (el.isContentEditable) {
            return true;
        }

        return (el.hasAttribute("contenteditable")
                && el.getAttribute("contenteditable") !== "false")
            || el.getAttribute("role") === "textbox";
    }

    function isInsideTextField(node) {
        let el = node.nodeType === Node.ELEMENT_NODE
            ? node
            : node.parentElement;

        while (el) {
            if (isTextFieldElement(el)) {
                return true;
            }

            el = el.parentElement;
        }

        return false;
    }

    function getFieldText(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) {
            return "";
        }

        const tag = el.tagName;

        if (tag === "TEXTAREA") {
            return el.value || el.textContent || el.getAttribute("value") || "";
        }

        if (tag === "INPUT") {
            return el.value || el.getAttribute("value") || "";
        }

        return el.textContent || "";
    }

    function applyFieldDiff(el, oldText, newText) {
        const tag = el.tagName;

        if (tag === "INPUT" || tag === "TEXTAREA") {
            const display = document.createElement("div");
            display.className = `${el.className} snap-diff-field`.trim();
            display.setAttribute("data-snap-diff-field", tag.toLowerCase());

            if (el.getAttribute("style")) {
                display.setAttribute("style", el.getAttribute("style"));
            }

            display.appendChild(createDiffFragment(oldText, newText));
            el.parentNode.replaceChild(display, el);
            return;
        }

        el.textContent = "";
        el.appendChild(createDiffFragment(oldText, newText));
    }

    function annotateTextFieldDiffs(oldRoot, newRoot) {
        for (const { el, path } of collectElements(newRoot)) {
            if (!isTextFieldElement(el)) {
                continue;
            }

            const oldEl = getElementByPath(oldRoot, path);
            const oldText = getFieldText(oldEl);
            const newText = getFieldText(el);

            if (oldText === newText) {
                continue;
            }

            applyFieldDiff(el, oldText, newText);
        }
    }

    function getNodeByPath(root, path) {
        let node = root;

        for (const idx of path) {
            if (!node || idx >= node.childNodes.length) {
                return null;
            }

            node = node.childNodes[idx];
        }

        return node;
    }

    function collectTextNodes(root) {
        const results = [];

        function walk(node, path) {
            if (node.nodeType === Node.ELEMENT_NODE && isTextFieldElement(node)) {
                return;
            }

            for (let i = 0; i < node.childNodes.length; i++) {
                const child = node.childNodes[i];
                const childPath = path.concat(i);

                if (child.nodeType === Node.TEXT_NODE) {
                    if (child.textContent.trim() && !isInsideTextField(child)) {
                        results.push({ node: child, path: childPath });
                    }
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    walk(child, childPath);
                }
            }
        }

        walk(root, []);
        return results;
    }

    function collectElements(root) {
        const results = [];

        function walk(node, path) {
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return;
            }

            results.push({ el: node, path });

            for (let i = 0; i < node.childNodes.length; i++) {
                const child = node.childNodes[i];

                if (child.nodeType === Node.ELEMENT_NODE) {
                    walk(child, path.concat(i));
                }
            }
        }

        walk(root, []);
        return results;
    }

    function isInteractive(el) {
        const tag = el.tagName;

        return tag === "BUTTON"
            || tag === "OPTION"
            || tag === "A"
            || el.getAttribute("role") === "button"
            || el.getAttribute("role") === "tab"
            || el.getAttribute("role") === "option";
    }

    function isSelectedLike(el) {
        if (!el) {
            return false;
        }

        const cls = String(el.className || "");
        const state = el.getAttribute("data-state") || "";
        const ariaSelected = el.getAttribute("aria-selected");
        const ariaPressed = el.getAttribute("aria-pressed");

        return /\b(active|selected|is-selected|is-active|current)\b/i.test(cls)
            || state === "active"
            || state === "selected"
            || ariaSelected === "true"
            || ariaPressed === "true"
            || el.hasAttribute("selected")
            || el.checked === true;
    }

    function annotateTextDiffs(oldRoot, newRoot) {
        const textNodes = collectTextNodes(newRoot);

        for (const { node, path } of textNodes) {
            if (isInsideTextField(node)) {
                continue;
            }

            const oldNode = getNodeByPath(oldRoot, path);
            let oldText = oldNode && oldNode.nodeType === Node.TEXT_NODE
                ? oldNode.textContent
                : "";

            const newText = node.textContent;

            if (!oldText && newText) {
                const newParent = node.parentElement;
                const oldParent = newParent
                    ? getNodeByPath(oldRoot, path.slice(0, -1))
                    : null;

                if (
                    oldParent
                    && oldParent.nodeType === Node.ELEMENT_NODE
                    && newParent
                    && oldParent.textContent === newParent.textContent
                ) {
                    continue;
                }
            }

            if (oldText === newText) {
                continue;
            }

            node.parentNode.replaceChild(
                createDiffFragment(oldText, newText),
                node
            );
        }
    }

    function annotateStateDiffs(oldRoot, newRoot) {
        for (const { el, path } of collectElements(newRoot)) {
            if (!isInteractive(el)) {
                continue;
            }

            const oldEl = getNodeByPath(oldRoot, path);

            if (!oldEl || oldEl.nodeType !== Node.ELEMENT_NODE) {
                continue;
            }

            const oldSel = isSelectedLike(oldEl);
            const newSel = isSelectedLike(el);

            if (oldSel === newSel) {
                continue;
            }

            el.classList.add(
                newSel ? "snap-diff-state-add" : "snap-diff-state-remove"
            );
        }
    }

    function buildVisualDiffHtml(oldHtml, newHtml) {
        const oldRoot = parseHtml(oldHtml);
        const newRoot = parseHtml(newHtml);

        if (!oldRoot || !newRoot) {
            return newHtml;
        }

        const clone = newRoot.cloneNode(true);
        annotateTextFieldDiffs(oldRoot, clone);
        annotateTextDiffs(oldRoot, clone);
        annotateStateDiffs(oldRoot, clone);
        return clone.outerHTML;
    }

    function getViewWindowScript(content, canCompare) {
        return `
        <script>
        const SNAPSHOT_CONTENT = ${JSON.stringify(content)};
        const CAN_COMPARE = ${canCompare ? "true" : "false"};

        const divider = document.getElementById("divider");
        const editorPanel = document.getElementById("editorPanel");
        const railPanel = document.getElementById("railPanel");
        const compareToggleBtn = document.getElementById("compareToggleBtn");
        const compareLegend = document.getElementById("compareLegend");
        let dragging = false;
        let comparing = false;

        function renderPanels() {
            const mode = comparing && CAN_COMPARE ? "diff" : "plain";
            editorPanel.innerHTML = SNAPSHOT_CONTENT[mode].editor;
            railPanel.innerHTML = SNAPSHOT_CONTENT[mode].rail;
        }

        compareToggleBtn.addEventListener("click", () => {
            if (!CAN_COMPARE) return;

            comparing = !comparing;
            compareToggleBtn.classList.toggle("active", comparing);
            compareToggleBtn.textContent = comparing ? "Compare (Experimental): ON" : "Compare (Experimental): OFF";
            compareLegend.classList.toggle("visible", comparing);
            renderPanels();
        });

        if (!CAN_COMPARE) {
            compareToggleBtn.disabled = true;
            compareToggleBtn.title = "Could not read current page for comparison.";
        }

        renderPanels();

        divider.addEventListener("mousedown", () => {
            dragging = true;
        });

        document.addEventListener("mouseup", () => {
            dragging = false;
        });

        document.addEventListener("mousemove", (e) => {
            if (!dragging) return;

            const pct = (e.clientX / window.innerWidth) * 100;
            const clamped = Math.max(15, Math.min(85, pct));
            editorPanel.style.width = clamped + "%";
        });
        </script>
        `;
    }

    function openViewWindow(snap) {
        const current = createSnapshot();
        const plainEditor = snap.editorHTML;
        const plainRail = snap.railHTML;
        const canCompare = Boolean(current);
        const content = {
            plain: {
                editor: plainEditor,
                rail: plainRail
            },
            diff: {
                editor: canCompare
                    ? buildVisualDiffHtml(current.editorHTML, snap.editorHTML)
                    : plainEditor,
                rail: canCompare
                    ? buildVisualDiffHtml(current.railHTML, snap.railHTML)
                    : plainRail
            }
        };

        const win = window.open("", "_blank");

        if (!win) {
            alert("Popup blocked. Allow popups to view snapshots.");
            return;
        }

        win.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
        <title>${escapeHtml(snap.name || "Snapshot")}</title>
        ${getSnapshotWindowStyles()}
        </head>
        <body>
        <div class="header">
            <div class="header-title">
                <strong>${escapeHtml(snap.name || "Unnamed Snapshot")}</strong>
                &nbsp;&nbsp;
                (${escapeHtml(snap.displayTime)})
            </div>
            <div class="header-actions">
                <span id="compareLegend" class="compare-legend legend">
                    <span class="legend-item">
                        <span class="legend-swatch legend-add"></span>
                        New in snapshot
                    </span>
                    <span class="legend-item">
                        <span class="legend-swatch legend-remove"></span>
                        Removed from snapshot
                    </span>
                </span>
                <button id="compareToggleBtn" type="button">Compare (Experimental): OFF</button>
            </div>
        </div>

        <div class="container">
            <div id="editorPanel" class="panel"></div>
            <div id="divider"></div>
            <div id="railPanel" class="panel"></div>
        </div>

        ${getViewWindowScript(content, canCompare)}
        </body>
        </html>
        `);

        win.document.close();
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
        renderUI();
    }

    boot();

})();