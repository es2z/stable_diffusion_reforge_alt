/**
 * History tab: browsing the output directories.
 *
 * The server lists one directory at a time and makes thumbnails on request; nothing is cached
 * there (see modules/ui_output_browser.py). Here the list of a directory is kept in memory and
 * drawn as a virtual grid, so a directory with tens of thousands of images costs no more DOM
 * than a small one.
 */

var OutputBrowser = (function () {
    "use strict";

    var CONFIG = {
        // Rows kept ready above and below the visible ones.
        OVERSCAN_ROWS: 2,
        // Requested thumbnail size in pixels (longer side); tiles are smaller, this leaves room for dense screens.
        THUMB_SIZE: 320,
    };

    var state = {
        started: false,
        roots: [],
        root: 0,
        dir: "", // inside the root, "/" separated
        files: [], // [name, mtime], newest first
        selected: null, // name of the selected file
        request: 0,
    };

    var els = {};
    var rows = new Map(); // row index -> element
    var layout = { columns: 0, tile: 0, stale: true };
    var frame = null;

    // Where the grid is scrolled to. Kept here because a hidden tab has no scroll position to read:
    // while the History tab is not shown the grid reports 0, and some browsers forget it for good.
    var scroll = { top: 0, pending: null };

    function el(tag, className, text) {
        var element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function getJson(url, params) {
        var query = Object.keys(params || {})
            .map(function (key) {
                return (
                    encodeURIComponent(key) +
                    "=" +
                    encodeURIComponent(params[key])
                );
            })
            .join("&");

        return fetch(url + (query ? "?" + query : ""), {
            cache: "no-store",
        }).then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
        });
    }

    function filePath(name) {
        return state.dir ? state.dir + "/" + name : name;
    }

    function thumbUrl(file) {
        return (
            "./sd_output_browser/thumb?root=" +
            state.root +
            "&path=" +
            encodeURIComponent(filePath(file[0])) +
            "&size=" +
            CONFIG.THUMB_SIZE +
            "&mtime=" +
            file[1]
        );
    }

    function setStatus(text) {
        els.status.textContent = text || "";
    }

    // ---------------------------------------------------------------- directories

    function renderPath() {
        els.path.textContent = "";

        var parts = state.dir ? state.dir.split("/") : [];
        var crumb = function (label, dir) {
            var link = el("a", "output-browser-crumb", label);
            link.href = "#";
            link.addEventListener("click", function (event) {
                event.preventDefault();
                openDir(dir);
            });
            els.path.appendChild(link);
        };

        crumb(state.roots[state.root] ? state.roots[state.root].label : "", "");
        parts.forEach(function (part, index) {
            els.path.appendChild(el("span", "output-browser-crumb-sep", "/"));
            crumb(part, parts.slice(0, index + 1).join("/"));
        });
    }

    function renderDirs(dirs) {
        els.dirs.textContent = "";

        if (state.dir) {
            var up = el("button", "lg secondary gradio-button custom-button", "..");
            up.title = "Parent directory";
            up.addEventListener("click", function () {
                openDir(state.dir.split("/").slice(0, -1).join("/"));
            });
            els.dirs.appendChild(up);
        }

        dirs.forEach(function (name) {
            var button = el("button", "lg secondary gradio-button custom-button", name);
            button.addEventListener("click", function () {
                openDir(filePath(name));
            });
            els.dirs.appendChild(button);
        });
    }

    /**
     * What is at the top of the grid, so the same images can be shown there after the directory
     * was listed again. null at the very top: there the newest images are what should be seen.
     */
    function captureAnchor() {
        if (!(scroll.top > 0) || !(layout.tile > 0) || !layout.columns) return null;

        var row = Math.floor(scroll.top / layout.tile);
        var file = state.files[row * layout.columns];
        if (!file) return null;

        return { name: file[0], offset: scroll.top - row * layout.tile };
    }

    function sameFiles(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
            if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
        }
        return true;
    }

    /**
     * Lists a directory and shows it.
     * descend: if it holds no images, only directories, go on into the newest of them - that is
     * where the latest images are when they are saved into a directory per day.
     * keepPosition: the directory that is open is listed again (coming back to the tab, or the
     * refresh button), so the grid stays where it was instead of going back to the top.
     */
    function openDir(dir, descend, keepPosition) {
        var request = ++state.request;
        var anchor = keepPosition && dir === state.dir ? captureAnchor() : null;
        var relisting = !!keepPosition && dir === state.dir;
        state.dir = dir;
        if (!relisting) setStatus("Loading...");

        return getJson("./sd_output_browser/list", { root: state.root, dir: dir })
            .then(function (data) {
                if (request !== state.request) return;

                if (descend && data.files.length == 0 && data.dirs.length > 0) {
                    return openDir(filePath(data.dirs[0]), true);
                }

                var unchanged = relisting && sameFiles(state.files, data.files);

                state.files = data.files;
                els.count.textContent =
                    data.files.length + (data.files.length == 1 ? " image" : " images");
                renderPath();
                renderDirs(data.dirs);
                setStatus(
                    data.files.length == 0 && data.dirs.length == 0
                        ? "No images here."
                        : ""
                );

                if (unchanged) {
                    // nothing new: the tiles that are there stay as they are
                    draw();
                    return;
                }

                // New images are listed first and push the others down: follow the image that was
                // at the top. Without one (the grid was at the top, or another directory) start at the top.
                var top = 0;
                if (anchor && layout.columns) {
                    for (var i = 0; i < data.files.length; i++) {
                        if (data.files[i][0] === anchor.name) {
                            top =
                                Math.floor(i / layout.columns) * layout.tile +
                                anchor.offset;
                            break;
                        }
                    }
                }

                scroll.pending = top;
                layout.stale = true;
                draw();
            })
            .catch(function (error) {
                if (request !== state.request) return;
                console.error("History:", error);
                state.files = [];
                layout.stale = true;
                draw();
                setStatus("Could not list this directory.");
            });
    }

    // ---------------------------------------------------------------- grid

    /** Removes a row; thumbnails in it that are still loading are cancelled, they are not needed anymore. */
    function discardRow(row) {
        row.querySelectorAll("img").forEach(function (img) {
            if (!img.complete) img.removeAttribute("src");
        });
        row.remove();
    }

    function schedule() {
        if (frame !== null) return;
        frame = requestAnimationFrame(function () {
            frame = null;
            draw();
        });
    }

    function createTile(index) {
        var file = state.files[index];
        var tile = el(
            "div",
            "output-browser-tile" +
                (file[0] === state.selected ? " output-browser-tile--selected" : "")
        );
        tile.title = file[0];
        tile.setAttribute("data-index", index);

        var img = el("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.src = thumbUrl(file);
        tile.appendChild(img);

        return tile;
    }

    function draw() {
        if (!els.grid || !els.grid.isConnected) return;

        var width = els.canvas.clientWidth;
        if (!width) return; // the tab is hidden; drawn when it is shown

        // tile size comes from CSS
        var probe = el("div", "output-browser-tile");
        probe.style.visibility = "hidden";
        els.canvas.appendChild(probe);
        var style = window.getComputedStyle(probe);
        var tile =
            probe.getBoundingClientRect().width +
            (parseFloat(style.marginLeft) || 0) +
            (parseFloat(style.marginRight) || 0);
        els.canvas.removeChild(probe);
        if (!(tile > 0)) return;

        var columns = Math.max(1, Math.floor((width + 0.5) / tile));
        if (columns !== layout.columns || tile !== layout.tile) {
            layout.columns = columns;
            layout.tile = tile;
            layout.stale = true;
        }

        var rowCount = Math.ceil(state.files.length / columns);
        els.canvas.style.height = rowCount * tile + "px";

        // applied here: the list has to have its height before it can be scrolled
        if (scroll.pending !== null) {
            els.grid.scrollTop = scroll.pending;
            scroll.top = els.grid.scrollTop;
            scroll.pending = null;
        }

        if (layout.stale) {
            rows.forEach(discardRow);
            rows.clear();
            layout.stale = false;
        }

        var top =
            els.grid.getBoundingClientRect().top -
            els.canvas.getBoundingClientRect().top;
        var first = Math.max(0, Math.floor(top / tile) - CONFIG.OVERSCAN_ROWS);
        var last = Math.min(
            rowCount - 1,
            Math.floor((top + els.grid.clientHeight) / tile) + CONFIG.OVERSCAN_ROWS
        );

        rows.forEach(function (row, index) {
            if (index < first || index > last) {
                discardRow(row);
                rows.delete(index);
            }
        });

        for (var index = first; index <= last; index++) {
            if (rows.has(index)) continue;

            var row = el("div", "output-browser-row");
            row.style.top = index * tile + "px";
            var end = Math.min((index + 1) * columns, state.files.length);
            for (var i = index * columns; i < end; i++) {
                row.appendChild(createTile(i));
            }
            rows.set(index, row);
            els.canvas.appendChild(row);
        }
    }

    function select(index) {
        var file = state.files[index];
        if (!file) return;

        state.selected = file[0];
        els.canvas
            .querySelectorAll(".output-browser-tile--selected")
            .forEach(function (tile) {
                tile.classList.remove("output-browser-tile--selected");
            });
        var tile = els.canvas.querySelector(
            '.output-browser-tile[data-index="' + index + '"]'
        );
        if (tile) tile.classList.add("output-browser-tile--selected");

        // The server loads the original and its generation parameters into the right hand side.
        var selection = gradioApp().querySelector(
            "#output_browser_selection textarea, #output_browser_selection input"
        );
        var button = gradioApp().getElementById("output_browser_select");
        if (!selection || !button) return;

        selection.value = state.root + "/" + filePath(file[0]);
        updateInput(selection);
        button.click();
    }

    // ---------------------------------------------------------------- setup

    function start() {
        var root = gradioApp().getElementById("output_browser");
        if (!root || state.started) return;
        state.started = true;

        els.rootSelect = gradioApp().getElementById("output_browser_root");
        els.path = gradioApp().getElementById("output_browser_path");
        els.count = gradioApp().getElementById("output_browser_count");
        els.dirs = gradioApp().getElementById("output_browser_dirs");
        els.grid = gradioApp().getElementById("output_browser_grid");

        els.grid.textContent = "";
        els.status = el("div", "output-browser-status");
        els.canvas = el("div", "output-browser-canvas");
        els.grid.appendChild(els.status);
        els.grid.appendChild(els.canvas);

        els.grid.addEventListener(
            "scroll",
            function () {
                // a hidden grid reports 0 whatever its position was
                if (els.grid.clientHeight > 0) scroll.top = els.grid.scrollTop;
                schedule();
            },
            { passive: true }
        );
        new ResizeObserver(schedule).observe(els.grid);

        els.canvas.addEventListener("click", function (event) {
            var tile = event.target.closest(".output-browser-tile");
            if (tile) select(parseInt(tile.getAttribute("data-index")));
        });

        els.rootSelect.addEventListener("change", function () {
            state.root = parseInt(els.rootSelect.value) || 0;
            openDir("", true);
        });

        gradioApp()
            .getElementById("output_browser_refresh")
            .addEventListener("click", function () {
                openDir(state.dir, false, true);
            });

        setStatus("Loading...");
        getJson("./sd_output_browser/roots")
            .then(function (data) {
                state.roots = data.roots;
                data.roots.forEach(function (item, index) {
                    var option = el("option", "", item.label);
                    option.value = index;
                    option.title = item.path;
                    els.rootSelect.appendChild(option);
                });
                return openDir("", true);
            })
            .catch(function (error) {
                console.error("History:", error);
                setStatus("Could not list the output directories.");
            });
    }

    /**
     * Called whenever the tab comes into view: lists the open directory again, new images included.
     * The grid stays where it was left - sending an image to txt2img and coming back does not lose
     * the place.
     */
    function shown() {
        if (!state.started) {
            start();
            return;
        }

        // browsers that dropped the position while the tab was hidden get it back right away
        if (scroll.top > 0 && els.grid.scrollTop !== scroll.top) {
            scroll.pending = scroll.top;
            draw();
        }

        openDir(state.dir, false, true);
    }

    return {
        CONFIG: CONFIG,
        shown: shown,
        state: state,
    };
})();

onUiLoaded(function () {
    var tab = gradioApp().getElementById("tab_output_browser");
    if (!tab) return;

    // Nothing is listed until the tab is opened for the first time.
    var wasVisible = false;
    var check = function () {
        var visible = tab.style.display != "none";
        if (visible && !wasVisible) OutputBrowser.shown();
        wasVisible = visible;
    };

    new MutationObserver(check).observe(tab, {
        attributes: true,
        attributeFilter: ["style"],
    });
    check();
});
