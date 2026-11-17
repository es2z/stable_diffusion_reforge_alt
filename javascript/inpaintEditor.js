/* global dropReplaceImage */

// ============================================================================
// Inpaint+: the mask editor of the img2img tab of the same name
// ============================================================================
//
// The image is held by a gradio Image component (upload, paste, drag and drop, "Copy image to" and
// the button that takes a result all go through it, and the server gets the image from it). Once it
// has an image, that component is hidden and this editor shows the image instead. The mask drawn
// here goes to the server as a PNG data URL, through a hidden textbox (see modules/img2img.py).
//
// The editor keeps two layers the size of the image, one byte per pixel:
//   mask       1 where the image is to be redrawn; this is what is sent
//   selection  1 where the selection is; it limits the brush and the eraser, and can be filled
//              into the mask or erased from it, grown, shrunk and inverted
//
// Keys follow the settings of the canvas zoom extension (Settings > Canvas Hotkeys) where there is
// one for the same thing: zoom and brush size with the mouse wheel, moving, resetting the view,
// brush size keys and the large view.

(function() {
    "use strict";

    var ROOT_ID = "img2img_inpaint_editor";
    var IMAGE_ID = "img2img_inpaint_editor_image";
    var MASK_ID = "img2img_inpaint_editor_mask";

    var MASK_COLOR = [255, 32, 96];
    var SELECTION_TINT = [64, 140, 255, 56];
    var HISTORY_BYTES = 256 * 1024 * 1024;
    var MAX_HISTORY = 100;
    var MIN_SCALE = 0.02;
    var MAX_SCALE = 32;

    // ------------------------------------------------------------------------
    // Pixel operations. Layers are Uint8Arrays of w * h, 1 = set.
    // ------------------------------------------------------------------------

    /**
     * Pixels whose colour is within `tolerance` of the colour at (sx, sy), compared channel by
     * channel. contiguous: only those connected to (sx, sy), otherwise all of them in the image.
     */
    function fuzzySelect(rgba, w, h, sx, sy, tolerance, contiguous) {
        var out = new Uint8Array(w * h);
        var seed = (sy * w + sx) * 4;
        var r0 = rgba[seed], g0 = rgba[seed + 1], b0 = rgba[seed + 2];

        function matches(p) {
            var i = p * 4;
            return Math.abs(rgba[i] - r0) <= tolerance &&
                Math.abs(rgba[i + 1] - g0) <= tolerance &&
                Math.abs(rgba[i + 2] - b0) <= tolerance;
        }

        if (!contiguous) {
            for (var p = 0; p < w * h; p++) {
                if (matches(p)) out[p] = 1;
            }
            return out;
        }

        // scanline fill
        var stack = [sx, sy];
        while (stack.length) {
            var y = stack.pop();
            var x = stack.pop();
            var row = y * w;
            if (out[row + x] || !matches(row + x)) continue;

            var left = x;
            while (left > 0 && !out[row + left - 1] && matches(row + left - 1)) left--;
            var right = x;
            while (right < w - 1 && !out[row + right + 1] && matches(row + right + 1)) right++;

            for (var i = left; i <= right; i++) out[row + i] = 1;

            for (var dy = -1; dy <= 1; dy += 2) {
                var ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                var nrow = ny * w;
                var inSpan = false;
                for (var j = left; j <= right; j++) {
                    var q = nrow + j;
                    if (!out[q] && matches(q)) {
                        if (!inSpan) {
                            stack.push(j, ny);
                            inSpan = true;
                        }
                    } else {
                        inSpan = false;
                    }
                }
            }
        }
        return out;
    }

    /** A rectangle or an ellipse inside the box (x0, y0) - (x1, y1), corners included. */
    function shapeLayer(w, h, x0, y0, x1, y1, ellipse) {
        var out = new Uint8Array(w * h);
        var left = Math.max(0, Math.min(x0, x1));
        var right = Math.min(w - 1, Math.max(x0, x1));
        var top = Math.max(0, Math.min(y0, y1));
        var bottom = Math.min(h - 1, Math.max(y0, y1));
        if (left > right || top > bottom) return out;

        var cx = (Math.min(x0, x1) + Math.max(x0, x1) + 1) / 2;
        var cy = (Math.min(y0, y1) + Math.max(y0, y1) + 1) / 2;
        var rx = (Math.abs(x1 - x0) + 1) / 2;
        var ry = (Math.abs(y1 - y0) + 1) / 2;

        for (var y = top; y <= bottom; y++) {
            var row = y * w;
            if (!ellipse) {
                out.fill(1, row + left, row + right + 1);
                continue;
            }
            // pixel centres inside the ellipse
            var ny = (y + 0.5 - cy) / ry;
            if (ny * ny > 1) continue;
            var half = rx * Math.sqrt(1 - ny * ny);
            var from = Math.max(left, Math.ceil(cx - half - 0.5));
            var to = Math.min(right, Math.floor(cx + half - 0.5));
            if (from <= to) out.fill(1, row + from, row + to + 1);
        }
        return out;
    }

    /** layer becomes layer <mode> region: "replace", "add", "subtract" or "intersect". */
    function combine(layer, region, mode) {
        var n = layer.length;
        var i;
        if (mode === "add") {
            for (i = 0; i < n; i++) if (region[i]) layer[i] = 1;
        } else if (mode === "subtract") {
            for (i = 0; i < n; i++) if (region[i]) layer[i] = 0;
        } else if (mode === "intersect") {
            for (i = 0; i < n; i++) if (!region[i]) layer[i] = 0;
        } else {
            layer.set(region);
        }
    }

    /** Smallest box holding every set pixel: {x0, y0, x1, y1} (inclusive), or null if there is none. */
    function bounds(layer, w, h) {
        var x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (var y = 0; y < h; y++) {
            var row = y * w;
            var first = -1;
            for (var x = 0; x < w; x++) {
                if (layer[row + x]) {
                    first = x;
                    break;
                }
            }
            if (first < 0) continue;
            var last = first;
            for (var xx = w - 1; xx > first; xx--) {
                if (layer[row + xx]) {
                    last = xx;
                    break;
                }
            }
            if (first < x0) x0 = first;
            if (last > x1) x1 = last;
            if (y < y0) y0 = y;
            y1 = y;
        }
        return x1 < 0 ? null : {x0: x0, y0: y0, x1: x1, y1: y1};
    }

    // Felzenszwalb & Huttenlocher, distance transforms of sampled functions
    var INF = 1e20;

    function edt1d(f, n, d, v, z) {
        var k = 0;
        v[0] = 0;
        z[0] = -INF;
        z[1] = INF;
        for (var q = 1; q < n; q++) {
            var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) {
                k--;
                s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k++;
            v[k] = q;
            z[k] = s;
            z[k + 1] = INF;
        }
        k = 0;
        for (var p = 0; p < n; p++) {
            while (z[k + 1] < p) k++;
            var dp = p - v[k];
            d[p] = dp * dp + f[v[k]];
        }
    }

    /** Squared distance of each pixel of a w x h grid to the nearest pixel for which isSource(i) holds. */
    function squaredDistance(w, h, isSource) {
        var grid = new Float32Array(w * h);
        var n = Math.max(w, h);
        var f = new Float64Array(n);
        var d = new Float64Array(n);
        var v = new Int32Array(n);
        var z = new Float64Array(n + 1);
        var x, y;

        for (var i = 0; i < w * h; i++) grid[i] = isSource(i) ? 0 : INF;

        for (x = 0; x < w; x++) {
            for (y = 0; y < h; y++) f[y] = grid[y * w + x];
            edt1d(f, h, d, v, z);
            for (y = 0; y < h; y++) grid[y * w + x] = d[y];
        }
        for (y = 0; y < h; y++) {
            var row = y * w;
            for (x = 0; x < w; x++) f[x] = grid[row + x];
            edt1d(f, w, d, v, z);
            for (x = 0; x < w; x++) grid[row + x] = d[x];
        }
        return grid;
    }

    /**
     * Grows (radius > 0) or shrinks (radius < 0) the set pixels of a layer by |radius| pixels, with
     * round corners. Shrinking also moves away from the edges of the image.
     * Only the box around the set pixels is worked on, so a small selection in a large image is fast.
     */
    function growLayer(layer, w, h, radius) {
        var box = bounds(layer, w, h);
        if (!box || !radius) return;

        var r = Math.abs(radius);
        var margin = radius > 0 ? r : 1;
        var bx0 = Math.max(0, box.x0 - margin), by0 = Math.max(0, box.y0 - margin);
        var bx1 = Math.min(w - 1, box.x1 + margin), by1 = Math.min(h - 1, box.y1 + margin);
        var bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;

        var at = function(i) {
            return layer[(by0 + Math.floor(i / bw)) * w + bx0 + (i % bw)];
        };
        var dist = squaredDistance(bw, bh, radius > 0 ? function(i) {
            return at(i) === 1;
        } : function(i) {
            return at(i) !== 1;
        });

        var limit = r * r;
        for (var y = 0; y < bh; y++) {
            var row = (by0 + y) * w + bx0;
            for (var x = 0; x < bw; x++) {
                var dd = dist[y * bw + x];
                if (radius > 0) {
                    if (dd <= limit) layer[row + x] = 1;
                } else {
                    // the outside of the image counts as not selected
                    var gx = bx0 + x, gy = by0 + y;
                    var edge = Math.min(gx + 1, w - gx, gy + 1, h - gy);
                    if (dd <= limit || edge * edge <= limit) layer[row + x] = 0;
                }
            }
        }
    }

    /** Sets (value 1) or clears (value 0) a round brush stamp, only where `clip` is set if given. */
    function stamp(layer, w, h, cx, cy, radius, value, clip) {
        var r = Math.max(0.5, radius);
        var top = Math.max(0, Math.floor(cy - r)), bottom = Math.min(h - 1, Math.ceil(cy + r));
        for (var y = top; y <= bottom; y++) {
            var dy = y + 0.5 - cy;
            if (dy * dy > r * r) continue;
            var half = Math.sqrt(r * r - dy * dy);
            var from = Math.max(0, Math.ceil(cx - half - 0.5));
            var to = Math.min(w - 1, Math.floor(cx + half - 0.5));
            var row = y * w;
            if (!clip) {
                if (from <= to) layer.fill(value, row + from, row + to + 1);
                continue;
            }
            for (var x = from; x <= to; x++) {
                if (clip[row + x]) layer[row + x] = value;
            }
        }
    }

    // ------------------------------------------------------------------------
    // The editor
    // ------------------------------------------------------------------------

    var ed = {
        root: null,
        source: null, // the gradio Image component
        viewport: null,
        stage: null,
        imageCanvas: null,
        maskCanvas: null,
        selectionCanvas: null,
        overlay: null, // brush cursor and the outline of a rectangle being drawn, in screen pixels
        controls: {},

        w: 0,
        h: 0,
        imageSrc: null,
        rgba: null,
        mask: null,
        selection: null,
        selectionBox: null, // null: nothing is selected
        maskPixels: null, // ImageData of maskCanvas
        undo: [],
        redo: [],

        tool: "brush",
        selectMode: "replace",
        brushSize: 40,
        tolerance: 32,
        contiguous: true,
        growBy: 8,
        opacity: 0.5,

        view: {scale: 1, x: 0, y: 0, moved: false},
        pointer: null, // {x, y} in the viewport
        hover: false,
        modal: false,
        placeholder: null, // where the editor goes back to after the large view
        keysDown: {},
        drag: null,

        version: 0, // of the mask
        sentVersion: 0, // of the mask in the textbox
        encoding: false,
    };

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function setting(name, fallback) {
        var value = typeof opts === "object" && opts ? opts[name] : undefined;
        return value === undefined || value === null || value === "" ? fallback : value;
    }

    function hotkeys() {
        return {
            zoom: setting("canvas_hotkey_zoom", "Alt"),
            adjust: setting("canvas_hotkey_adjust", "Ctrl"),
            move: String(setting("canvas_hotkey_move", "F")).toUpperCase(),
            reset: String(setting("canvas_hotkey_reset", "R")).toUpperCase(),
            shrink: String(setting("canvas_hotkey_shrink_brush", "Q")).toUpperCase(),
            grow: String(setting("canvas_hotkey_grow_brush", "W")).toUpperCase(),
            large: String(setting("canvas_hotkey_fullscreen", "S")).toUpperCase(),
        };
    }

    function modifierHeld(event, name) {
        if (name === "Shift") return event.shiftKey;
        if (name === "Alt") return event.altKey;
        return event.ctrlKey || event.metaKey;
    }

    function load(key, fallback) {
        var value = parseFloat(localGet("inpaint_editor_" + key));
        return isNaN(value) ? fallback : value;
    }

    function save(key, value) {
        try {
            localSet("inpaint_editor_" + key, value);
        } catch (e) {
            // storage may be unavailable; the value is only a convenience
        }
    }

    // ---- building the page --------------------------------------------------

    function button(group, label, title, onclick, name) {
        var b = el("button", "inpaint-editor-button", label);
        b.type = "button";
        b.title = title;
        b.addEventListener("click", function(event) {
            event.preventDefault();
            onclick();
        });
        group.appendChild(b);
        if (name) ed.controls[name] = b;
        return b;
    }

    function numberInput(group, label, title, min, max, value, onchange, name) {
        var wrap = el("label", "inpaint-editor-number");
        wrap.title = title;
        wrap.appendChild(el("span", "", label));
        var input = el("input");
        input.type = "number";
        input.min = min;
        input.max = max;
        input.value = value;
        input.addEventListener("change", function() {
            var v = Math.round(parseFloat(input.value));
            if (isNaN(v)) v = value;
            v = Math.max(min, Math.min(max, v));
            input.value = v;
            onchange(v);
        });
        wrap.appendChild(input);
        group.appendChild(wrap);
        ed.controls[name] = input;
        return input;
    }

    function build(root) {
        var keys = hotkeys();
        ed.root = root;
        root.classList.add("inpaint-editor");
        root.tabIndex = -1;

        var toolbar = el("div", "inpaint-editor-toolbar");
        var g;

        g = el("div", "inpaint-editor-group");
        button(g, "Brush", "Paint the mask (B). Only inside the selection if there is one. X swaps brush and eraser.", function() {
            setTool("brush");
        }, "tool_brush");
        button(g, "Eraser", "Erase the mask (E). Only inside the selection if there is one.", function() {
            setTool("eraser");
        }, "tool_eraser");
        numberInput(g, "Size", "Brush size in image pixels (" + keys.shrink + " / " + keys.grow + ", or " + keys.adjust + " + mouse wheel)", 1, 2048, ed.brushSize, function(v) {
            setBrushSize(v);
        }, "brush_size");
        toolbar.appendChild(g);

        g = el("div", "inpaint-editor-group");
        button(g, "Rectangle", "Select a rectangle (M)", function() {
            setTool("rect");
        }, "tool_rect");
        button(g, "Ellipse", "Select an ellipse (C)", function() {
            setTool("ellipse");
        }, "tool_ellipse");
        button(g, "Fuzzy", "Select by colour: click on the image (U)", function() {
            setTool("fuzzy");
        }, "tool_fuzzy");
        numberInput(g, "Tolerance", "How far a colour may be from the clicked one, per channel (0-255)", 0, 255, ed.tolerance, function(v) {
            ed.tolerance = v;
            save("tolerance", v);
        }, "tolerance");
        var contiguousLabel = el("label", "inpaint-editor-check");
        contiguousLabel.title = "On: only the area connected to the clicked pixel. Off: every pixel of a similar colour in the image.";
        var contiguous = el("input");
        contiguous.type = "checkbox";
        contiguous.checked = ed.contiguous;
        contiguous.addEventListener("change", function() {
            ed.contiguous = contiguous.checked;
            save("contiguous", ed.contiguous ? 1 : 0);
        });
        contiguousLabel.appendChild(contiguous);
        contiguousLabel.appendChild(el("span", "", "Contiguous"));
        g.appendChild(contiguousLabel);
        ed.controls.contiguous = contiguous;
        toolbar.appendChild(g);

        g = el("div", "inpaint-editor-group");
        g.title = "What a new selection does with the one there is. Hold Shift to add, Alt to subtract, both to intersect.";
        [["replace", "New"], ["add", "Add"], ["subtract", "Subtract"], ["intersect", "Intersect"]].forEach(function(mode) {
            button(g, mode[1], g.title, function() {
                ed.selectMode = mode[0];
                refreshControls();
            }, "mode_" + mode[0]);
        });
        toolbar.appendChild(g);

        g = el("div", "inpaint-editor-group");
        numberInput(g, "By", "Pixels to grow or shrink the selection by", 1, 1024, ed.growBy, function(v) {
            ed.growBy = v;
            save("grow_by", v);
        }, "grow_by");
        button(g, "Grow", "Grow the selection", function() {
            growSelection(ed.growBy);
        }, "grow");
        button(g, "Shrink", "Shrink the selection", function() {
            growSelection(-ed.growBy);
        }, "shrink");
        button(g, "Invert", "Invert the selection (Ctrl+I)", invertSelection, "invert_selection");
        button(g, "All", "Select all (Ctrl+A)", selectAll, "select_all");
        button(g, "None", "Deselect (Ctrl+D)", deselect, "deselect");
        button(g, "From mask", "Select what is masked", selectionFromMask, "selection_from_mask");
        toolbar.appendChild(g);

        g = el("div", "inpaint-editor-group");
        button(g, "Fill", "Add the selection to the mask (G)", function() {
            fillSelection(1);
        }, "fill");
        button(g, "Erase", "Remove the selection from the mask (Delete)", function() {
            fillSelection(0);
        }, "erase");
        button(g, "Invert mask", "Mask what is not masked and the other way round", invertMask, "invert_mask");
        button(g, "Clear mask", "Remove the whole mask", clearMask, "clear_mask");
        toolbar.appendChild(g);

        g = el("div", "inpaint-editor-group");
        button(g, "Undo", "Undo (Ctrl+Z)", undo, "undo");
        button(g, "Redo", "Redo (Ctrl+Shift+Z, Ctrl+Y)", redo, "redo");
        toolbar.appendChild(g);

        g = el("div", "inpaint-editor-group");
        button(g, "Fit", "Show the whole image (" + keys.reset + "). Zoom: " + keys.zoom + " + mouse wheel. Move: drag with the middle button, or hold Space or " + keys.move + " and drag.", fitView, "fit");
        button(g, "1:1", "One image pixel per screen pixel", function() {
            zoomTo(1);
        }, "actual_size");
        var opacityLabel = el("label", "inpaint-editor-range");
        opacityLabel.title = "How strongly the mask is shown";
        opacityLabel.appendChild(el("span", "", "Mask"));
        var opacity = el("input");
        opacity.type = "range";
        opacity.min = 5;
        opacity.max = 100;
        opacity.value = Math.round(ed.opacity * 100);
        opacity.addEventListener("input", function() {
            ed.opacity = opacity.value / 100;
            ed.maskCanvas.style.opacity = ed.opacity;
            save("opacity", ed.opacity);
        });
        opacityLabel.appendChild(opacity);
        g.appendChild(opacityLabel);
        ed.controls.opacity = opacity;
        toolbar.appendChild(g);

        g = el("div", "inpaint-editor-group");
        button(g, "Export mask", "Save the mask as a PNG: white is masked", exportMask, "export");
        button(g, "Import mask", "Load a mask from an image. White, or with transparency anything that is not transparent, is masked. It is scaled to the size of the image.", function() {
            ed.controls.import_file.click();
        }, "import");
        var file = el("input");
        file.type = "file";
        file.accept = "image/*";
        file.style.display = "none";
        file.addEventListener("change", function() {
            if (file.files && file.files[0]) importMask(file.files[0]);
            file.value = "";
        });
        g.appendChild(file);
        ed.controls.import_file = file;
        toolbar.appendChild(g);

        g = el("div", "inpaint-editor-group inpaint-editor-group--end");
        button(g, "Large view", "Edit in a view as large as the window (" + keys.large + ", Esc to close)", toggleModal, "large");
        button(g, "Remove image", "Take the image out of the editor. The mask is kept for the next image of the same size.", removeImage, "remove");
        toolbar.appendChild(g);

        root.appendChild(toolbar);

        var viewport = el("div", "inpaint-editor-viewport");
        var stage = el("div", "inpaint-editor-stage");
        ed.imageCanvas = el("canvas", "inpaint-editor-image");
        ed.maskCanvas = el("canvas", "inpaint-editor-mask");
        ed.selectionCanvas = el("canvas", "inpaint-editor-selection");
        stage.appendChild(ed.imageCanvas);
        stage.appendChild(ed.maskCanvas);
        stage.appendChild(ed.selectionCanvas);
        viewport.appendChild(stage);
        ed.overlay = el("canvas", "inpaint-editor-overlay");
        viewport.appendChild(ed.overlay);
        var status = el("div", "inpaint-editor-status");
        viewport.appendChild(status);
        ed.controls.status = status;
        root.appendChild(viewport);

        ed.viewport = viewport;
        ed.stage = stage;
        ed.maskCanvas.style.opacity = ed.opacity;

        viewport.addEventListener("pointerdown", onPointerDown);
        viewport.addEventListener("pointermove", onPointerMove);
        viewport.addEventListener("pointerup", onPointerUp);
        viewport.addEventListener("pointercancel", onPointerUp);
        viewport.addEventListener("pointerenter", function() {
            ed.hover = true;
        });
        viewport.addEventListener("pointerleave", function() {
            ed.hover = false;
            ed.pointer = null;
            drawOverlay();
        });
        viewport.addEventListener("wheel", onWheel, {passive: false});
        viewport.addEventListener("contextmenu", function(event) {
            event.preventDefault();
        });
        viewport.addEventListener("dragover", function(event) {
            if (event.dataTransfer && Array.from(event.dataTransfer.types || []).indexOf("Files") !== -1) {
                event.preventDefault();
                event.stopPropagation();
            }
        });
        viewport.addEventListener("drop", function(event) {
            var files = event.dataTransfer && event.dataTransfer.files;
            if (!files || !files.length) return;
            event.preventDefault();
            event.stopPropagation();
            replaceImage(files);
        });

        new ResizeObserver(function() {
            resizeOverlay();
            if (!ed.view.moved) fitView();
            else drawOverlay();
        }).observe(viewport);

        refreshControls();
    }

    function setStatus(text) {
        ed.controls.status.textContent = text || "";
    }

    function refreshControls() {
        ["brush", "eraser", "rect", "ellipse", "fuzzy"].forEach(function(tool) {
            ed.controls["tool_" + tool].classList.toggle("inpaint-editor-button--active", ed.tool === tool);
        });
        ["replace", "add", "subtract", "intersect"].forEach(function(mode) {
            ed.controls["mode_" + mode].classList.toggle("inpaint-editor-button--active", ed.selectMode === mode);
        });
        ed.controls.undo.disabled = !ed.undo.length;
        ed.controls.redo.disabled = !ed.redo.length;
        ["grow", "shrink", "fill", "erase", "deselect"].forEach(function(name) {
            ed.controls[name].disabled = !ed.selectionBox;
        });
        ed.controls.large.textContent = ed.modal ? "Close large view" : "Large view";
        ed.viewport.dataset.tool = ed.tool;
    }

    function setTool(tool) {
        ed.tool = tool;
        refreshControls();
        drawOverlay();
    }

    function setBrushSize(size) {
        ed.brushSize = Math.max(1, Math.min(2048, Math.round(size)));
        ed.controls.brush_size.value = ed.brushSize;
        save("brush_size", ed.brushSize);
        drawOverlay();
    }

    // ---- the image ----------------------------------------------------------

    function sourceImage() {
        var img = ed.source && ed.source.querySelector("img");
        return img && img.getAttribute("src") ? img : null;
    }

    function watchSource() {
        var check = function() {
            var img = sourceImage();
            var src = img ? img.getAttribute("src") : null;
            if (src === ed.imageSrc) return;
            ed.imageSrc = src;

            if (!src) {
                showEditor(false);
                return;
            }

            var image = new Image();
            image.onload = function() {
                if (ed.imageSrc === src) setImage(image);
            };
            image.src = src;
        };
        new MutationObserver(check).observe(ed.source, {subtree: true, childList: true, attributes: true, attributeFilter: ["src"]});
        check();
    }

    function showEditor(show) {
        ed.root.classList.toggle("inpaint-editor--has-image", show);
        ed.source.classList.toggle("inpaint-editor-source--hidden", show);
        if (!show && ed.modal) toggleModal();
    }

    function setImage(image) {
        var w = image.naturalWidth, h = image.naturalHeight;
        if (!w || !h) return;

        var sameSize = w === ed.w && h === ed.h && ed.mask;

        ed.imageCanvas.width = w;
        ed.imageCanvas.height = h;
        var ctx = ed.imageCanvas.getContext("2d", {willReadFrequently: true});
        ctx.drawImage(image, 0, 0);
        ed.rgba = ctx.getImageData(0, 0, w, h).data;

        if (!sameSize) {
            // a mask is only kept for an image of the same size (a result that is edited further)
            ed.w = w;
            ed.h = h;
            ed.mask = new Uint8Array(w * h);
            ed.selection = new Uint8Array(w * h);
            ed.selectionBox = null;
            ed.undo = [];
            ed.redo = [];
            [ed.maskCanvas, ed.selectionCanvas].forEach(function(canvas) {
                canvas.width = w;
                canvas.height = h;
            });
            ed.maskPixels = ed.maskCanvas.getContext("2d").createImageData(w, h);
            ed.stage.style.width = w + "px";
            ed.stage.style.height = h + "px";
            renderMask();
            renderSelection();
            maskChanged();
        }

        showEditor(true);
        ed.view.moved = false;
        requestAnimationFrame(fitView);
        refreshControls();
        setStatus(w + " x " + h + (sameSize ? " - the mask was kept" : ""));
    }

    /** Puts other image files into the gradio component, as dropping them on it would. */
    function replaceImage(files) {
        var wrap = ed.source.querySelector('[data-testid="image"]');
        if (wrap && typeof dropReplaceImage === "function") dropReplaceImage(wrap, files);
    }

    function removeImage() {
        var clear = ed.source.querySelector('button[aria-label="Clear"], button[title="Clear"]');
        if (!clear) {
            var buttons = ed.source.querySelectorAll(".modify-upload button");
            clear = buttons[buttons.length - 1];
        }
        if (clear) clear.click();
    }

    // ---- drawing the layers -------------------------------------------------

    function renderMask(box) {
        if (!ed.mask) return;
        var w = ed.w;
        var x0 = box ? box.x0 : 0, y0 = box ? box.y0 : 0;
        var x1 = box ? box.x1 : w - 1, y1 = box ? box.y1 : ed.h - 1;
        var pixels = new Uint32Array(ed.maskPixels.data.buffer);
        var on = (255 << 24 | MASK_COLOR[2] << 16 | MASK_COLOR[1] << 8 | MASK_COLOR[0]) >>> 0;
        for (var y = y0; y <= y1; y++) {
            var row = y * w;
            for (var x = x0; x <= x1; x++) pixels[row + x] = ed.mask[row + x] ? on : 0;
        }
        ed.maskCanvas.getContext("2d").putImageData(ed.maskPixels, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    }

    function renderSelection() {
        var ctx = ed.selectionCanvas.getContext("2d");
        ctx.clearRect(0, 0, ed.w, ed.h);
        var box = ed.selectionBox;
        if (!box) return;

        var w = ed.w, h = ed.h, sel = ed.selection;
        var bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
        var data = ctx.createImageData(bw, bh);
        var pixels = new Uint32Array(data.data.buffer);
        var tint = (SELECTION_TINT[3] << 24 | SELECTION_TINT[2] << 16 | SELECTION_TINT[1] << 8 | SELECTION_TINT[0]) >>> 0;
        var black = 0xff000000, white = 0xffffffff;

        for (var y = box.y0; y <= box.y1; y++) {
            for (var x = box.x0; x <= box.x1; x++) {
                var p = y * w + x;
                if (!sel[p]) continue;
                var edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
                    !sel[p - 1] || !sel[p + 1] || !sel[p - w] || !sel[p + w];
                pixels[(y - box.y0) * bw + (x - box.x0)] = edge ? (((x >> 2) + (y >> 2)) & 1 ? black : white) : tint;
            }
        }
        ctx.putImageData(data, box.x0, box.y0);
    }

    function selectionChanged() {
        ed.selectionBox = bounds(ed.selection, ed.w, ed.h);
        renderSelection();
        refreshControls();
    }

    // ---- the mask that is sent ----------------------------------------------

    function maskCanvasForExport() {
        var canvas = document.createElement("canvas");
        canvas.width = ed.w;
        canvas.height = ed.h;
        var ctx = canvas.getContext("2d");
        var data = ctx.createImageData(ed.w, ed.h);
        var pixels = new Uint32Array(data.data.buffer);
        var any = false;
        for (var i = 0; i < ed.mask.length; i++) {
            if (ed.mask[i]) {
                pixels[i] = 0xffffffff;
                any = true;
            } else {
                pixels[i] = 0xff000000;
            }
        }
        ctx.putImageData(data, 0, 0);
        return {canvas: canvas, empty: !any};
    }

    function setMaskInput(value) {
        var textarea = gradioApp().querySelector("#" + MASK_ID + " textarea");
        if (!textarea || textarea.value === value) return;
        textarea.value = value;
        updateInput(textarea);
    }

    /** The mask changed: it goes to the textbox in the background, a moment later. */
    function maskChanged() {
        ed.version++;
        if (ed.encoding) return;

        ed.encoding = true;
        setTimeout(function encode() {
            var version = ed.version;
            if (!ed.mask) {
                ed.encoding = false;
                return;
            }
            var result = maskCanvasForExport();
            var done = function(value) {
                if (version === ed.version) {
                    setMaskInput(value);
                    ed.sentVersion = version;
                    ed.encoding = false;
                } else {
                    setTimeout(encode, 0); // changed again meanwhile
                }
            };
            if (result.empty) {
                done("");
                return;
            }
            result.canvas.toBlob(function(blob) {
                var reader = new FileReader();
                reader.onload = function() {
                    done(reader.result);
                };
                reader.readAsDataURL(blob);
            }, "image/png");
        }, 0);
    }

    /** Puts the mask into the textbox right away if it is not there yet (before a generation starts). */
    function flushMask() {
        if (!ed.mask || ed.sentVersion === ed.version) return;
        var result = maskCanvasForExport();
        setMaskInput(result.empty ? "" : result.canvas.toDataURL("image/png"));
        ed.sentVersion = ed.version;
    }

    // ---- history ------------------------------------------------------------

    function historyLimit() {
        var perStep = Math.max(1, 2 * ed.w * ed.h);
        return Math.max(5, Math.min(MAX_HISTORY, Math.floor(HISTORY_BYTES / perStep)));
    }

    function snapshot() {
        return {mask: ed.mask.slice(), selection: ed.selection.slice()};
    }

    /** Remembers the state before something is changed. */
    function remember() {
        ed.undo.push(snapshot());
        while (ed.undo.length > historyLimit()) ed.undo.shift();
        ed.redo = [];
        refreshControls();
    }

    function restore(state) {
        ed.mask.set(state.mask);
        ed.selection.set(state.selection);
        renderMask();
        selectionChanged();
        maskChanged();
    }

    function undo() {
        if (!ed.mask || !ed.undo.length) return;
        ed.redo.push(snapshot());
        restore(ed.undo.pop());
    }

    function redo() {
        if (!ed.mask || !ed.redo.length) return;
        ed.undo.push(snapshot());
        restore(ed.redo.pop());
    }

    // ---- commands -----------------------------------------------------------

    function changeSelection(fn) {
        if (!ed.mask) return;
        remember();
        fn();
        selectionChanged();
    }

    function changeMask(fn) {
        if (!ed.mask) return;
        remember();
        fn();
        renderMask();
        maskChanged();
    }

    function applySelection(region, mode) {
        changeSelection(function() {
            combine(ed.selection, region, mode);
        });
    }

    function growSelection(by) {
        if (!ed.selectionBox) return;
        changeSelection(function() {
            growLayer(ed.selection, ed.w, ed.h, by);
        });
    }

    function invertSelection() {
        changeSelection(function() {
            for (var i = 0; i < ed.selection.length; i++) ed.selection[i] ^= 1;
        });
    }

    function selectAll() {
        changeSelection(function() {
            ed.selection.fill(1);
        });
    }

    function deselect() {
        if (!ed.selectionBox) return;
        changeSelection(function() {
            ed.selection.fill(0);
        });
    }

    function selectionFromMask() {
        changeSelection(function() {
            ed.selection.set(ed.mask);
        });
    }

    function fillSelection(value) {
        if (!ed.selectionBox) return;
        changeMask(function() {
            for (var i = 0; i < ed.mask.length; i++) {
                if (ed.selection[i]) ed.mask[i] = value;
            }
        });
    }

    function invertMask() {
        changeMask(function() {
            for (var i = 0; i < ed.mask.length; i++) ed.mask[i] ^= 1;
        });
    }

    function clearMask() {
        changeMask(function() {
            ed.mask.fill(0);
        });
    }

    function exportMask() {
        if (!ed.mask) return;
        maskCanvasForExport().canvas.toBlob(function(blob) {
            var link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = "inpaint-mask-" + ed.w + "x" + ed.h + ".png";
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function() {
                URL.revokeObjectURL(link.href);
            }, 10000);
        }, "image/png");
    }

    function importMask(file) {
        if (!ed.mask) return;
        var url = URL.createObjectURL(file);
        var image = new Image();
        image.onload = function() {
            URL.revokeObjectURL(url);
            var canvas = document.createElement("canvas");
            canvas.width = ed.w;
            canvas.height = ed.h;
            var ctx = canvas.getContext("2d", {willReadFrequently: true});
            ctx.drawImage(image, 0, 0, ed.w, ed.h);
            var data = ctx.getImageData(0, 0, ed.w, ed.h).data;

            var transparent = false;
            for (var i = 3; i < data.length; i += 4) {
                if (data[i] < 250) {
                    transparent = true;
                    break;
                }
            }

            changeMask(function() {
                for (var p = 0; p < ed.mask.length; p++) {
                    var j = p * 4;
                    if (transparent) {
                        ed.mask[p] = data[j + 3] >= 128 ? 1 : 0;
                    } else {
                        ed.mask[p] = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114 >= 128 ? 1 : 0;
                    }
                }
            });
            var scaled = image.naturalWidth !== ed.w || image.naturalHeight !== ed.h;
            setStatus("Mask imported" + (scaled ? " (scaled from " + image.naturalWidth + " x " + image.naturalHeight + ")" : ""));
        };
        image.onerror = function() {
            URL.revokeObjectURL(url);
            setStatus("Could not read " + file.name);
        };
        image.src = url;
    }

    // ---- view -----------------------------------------------------------------

    function applyView() {
        var v = ed.view;
        ed.stage.style.transform = "translate(" + v.x + "px, " + v.y + "px) scale(" + v.scale + ")";
        ed.stage.classList.toggle("inpaint-editor-stage--pixelated", v.scale >= 2);
        drawOverlay();
    }

    function fitView() {
        if (!ed.w) return;
        var vw = ed.viewport.clientWidth, vh = ed.viewport.clientHeight;
        if (!vw || !vh) return;
        var scale = Math.min(vw / ed.w, vh / ed.h);
        ed.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
        ed.view.x = (vw - ed.w * ed.view.scale) / 2;
        ed.view.y = (vh - ed.h * ed.view.scale) / 2;
        ed.view.moved = false;
        applyView();
    }

    /** Zooms keeping the point (px, py) of the viewport where it is; the centre if not given. */
    function zoomTo(scale, px, py) {
        if (!ed.w) return;
        if (px === undefined) {
            px = ed.viewport.clientWidth / 2;
            py = ed.viewport.clientHeight / 2;
        }
        var v = ed.view;
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
        v.x = px - (px - v.x) * scale / v.scale;
        v.y = py - (py - v.y) * scale / v.scale;
        v.scale = scale;
        v.moved = true;
        applyView();
    }

    function viewportPoint(event) {
        var rect = ed.viewport.getBoundingClientRect();
        return {x: event.clientX - rect.left, y: event.clientY - rect.top};
    }

    function imagePoint(point) {
        return {x: (point.x - ed.view.x) / ed.view.scale, y: (point.y - ed.view.y) / ed.view.scale};
    }

    function resizeOverlay() {
        var ratio = window.devicePixelRatio || 1;
        ed.overlay.width = Math.max(1, Math.round(ed.viewport.clientWidth * ratio));
        ed.overlay.height = Math.max(1, Math.round(ed.viewport.clientHeight * ratio));
    }

    function drawOverlay() {
        if (!ed.overlay) return;
        var ratio = window.devicePixelRatio || 1;
        var ctx = ed.overlay.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, ed.overlay.width, ed.overlay.height);
        if (!ed.w) return;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

        var drag = ed.drag;
        if (drag && (drag.kind === "rect" || drag.kind === "ellipse") && drag.end) {
            var a = drag.startView, b = drag.end;
            ctx.save();
            ctx.beginPath();
            if (drag.kind === "rect") {
                ctx.rect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
            } else {
                ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
            }
            ctx.lineWidth = 1;
            ctx.strokeStyle = "#fff";
            ctx.stroke();
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = "#000";
            ctx.stroke();
            ctx.restore();
        }

        if (ed.pointer && (ed.tool === "brush" || ed.tool === "eraser") && !(drag && drag.kind === "pan")) {
            var radius = ed.brushSize / 2 * ed.view.scale;
            ctx.beginPath();
            ctx.arc(ed.pointer.x, ed.pointer.y, Math.max(1, radius), 0, Math.PI * 2);
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(ed.pointer.x, ed.pointer.y, Math.max(1, radius) + 1, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
            ctx.stroke();
        }
    }

    function toggleModal() {
        ed.modal = !ed.modal;

        // Shown above everything else: taken out of the page while it is large, so that nothing around
        // it (a transformed or scrolling block) decides where it ends up.
        if (ed.modal) {
            ed.placeholder = document.createComment("inpaint editor");
            ed.root.parentNode.insertBefore(ed.placeholder, ed.root);
            gradioApp().appendChild(ed.root);
        } else if (ed.placeholder) {
            ed.placeholder.parentNode.insertBefore(ed.root, ed.placeholder);
            ed.placeholder.remove();
            ed.placeholder = null;
        }

        ed.root.classList.toggle("inpaint-editor--modal", ed.modal);
        document.body.classList.toggle("inpaint-editor-modal-open", ed.modal);
        refreshControls();
        ed.view.moved = false;
        requestAnimationFrame(function() {
            resizeOverlay();
            fitView();
        });
        if (ed.modal) ed.root.focus({preventScroll: true});
    }

    // ---- pointer and keys ---------------------------------------------------

    function selectionModeFor(event) {
        if (event.shiftKey && event.altKey) return "intersect";
        if (event.shiftKey) return "add";
        if (event.altKey) return "subtract";
        return ed.selectMode;
    }

    function wantsPan(event) {
        var keys = hotkeys();
        return event.button === 1 || (event.button === 0 && (ed.keysDown[" "] || ed.keysDown[keys.move]));
    }

    function paintTo(point) {
        var drag = ed.drag;
        var value = drag.kind === "brush" ? 1 : 0;
        var clip = ed.selectionBox ? ed.selection : null;
        var r = ed.brushSize / 2;
        var from = drag.last || point;
        var dist = Math.hypot(point.x - from.x, point.y - from.y);
        var steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 4)));
        for (var i = drag.last ? 1 : 0; i <= steps; i++) {
            var t = i / steps;
            stamp(ed.mask, ed.w, ed.h, from.x + (point.x - from.x) * t, from.y + (point.y - from.y) * t, r, value, clip);
        }
        var box = {
            x0: Math.max(0, Math.floor(Math.min(from.x, point.x) - r - 1)),
            y0: Math.max(0, Math.floor(Math.min(from.y, point.y) - r - 1)),
            x1: Math.min(ed.w - 1, Math.ceil(Math.max(from.x, point.x) + r + 1)),
            y1: Math.min(ed.h - 1, Math.ceil(Math.max(from.y, point.y) + r + 1)),
        };
        if (box.x0 <= box.x1 && box.y0 <= box.y1) renderMask(box);
        drag.last = point;
    }

    function onPointerDown(event) {
        if (!ed.mask) return;
        ed.root.focus({preventScroll: true});
        var view = viewportPoint(event);
        var point = imagePoint(view);
        ed.pointer = view;

        if (wantsPan(event)) {
            ed.drag = {kind: "pan", from: view, x: ed.view.x, y: ed.view.y};
        } else if (event.button !== 0) {
            return;
        } else if (ed.tool === "brush" || ed.tool === "eraser") {
            remember();
            ed.drag = {kind: ed.tool, last: null};
            paintTo(point);
        } else if (ed.tool === "rect" || ed.tool === "ellipse") {
            ed.drag = {kind: ed.tool, start: point, startView: view, end: null, mode: selectionModeFor(event)};
        } else if (ed.tool === "fuzzy") {
            var x = Math.floor(point.x), y = Math.floor(point.y);
            if (x >= 0 && y >= 0 && x < ed.w && y < ed.h) {
                applySelection(fuzzySelect(ed.rgba, ed.w, ed.h, x, y, ed.tolerance, ed.contiguous), selectionModeFor(event));
            }
            return;
        }

        event.preventDefault();
        ed.viewport.setPointerCapture(event.pointerId);
        drawOverlay();
    }

    function onPointerMove(event) {
        var view = viewportPoint(event);
        ed.pointer = view;
        var drag = ed.drag;

        if (drag && drag.kind === "pan") {
            ed.view.x = drag.x + view.x - drag.from.x;
            ed.view.y = drag.y + view.y - drag.from.y;
            ed.view.moved = true;
            applyView();
            return;
        }
        if (drag && (drag.kind === "brush" || drag.kind === "eraser")) {
            var events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
            if (!events.length) events = [event];
            for (var i = 0; i < events.length; i++) paintTo(imagePoint(viewportPoint(events[i])));
        }
        if (drag && (drag.kind === "rect" || drag.kind === "ellipse")) {
            drag.end = view;
        }
        drawOverlay();
    }

    function onPointerUp(event) {
        var drag = ed.drag;
        ed.drag = null;
        if (!drag) return;

        if (drag.kind === "brush" || drag.kind === "eraser") {
            maskChanged();
        } else if (drag.kind === "rect" || drag.kind === "ellipse") {
            var end = imagePoint(viewportPoint(event));
            var a = drag.start;
            var tiny = Math.abs(end.x - a.x) * ed.view.scale < 3 && Math.abs(end.y - a.y) * ed.view.scale < 3;
            if (tiny) {
                // a click without dragging drops the selection, as in other editors
                if (drag.mode === "replace") deselect();
            } else {
                var x0 = Math.floor(Math.min(a.x, end.x)), y0 = Math.floor(Math.min(a.y, end.y));
                var x1 = Math.ceil(Math.max(a.x, end.x)) - 1, y1 = Math.ceil(Math.max(a.y, end.y)) - 1;
                applySelection(shapeLayer(ed.w, ed.h, x0, y0, x1, y1, drag.kind === "ellipse"), drag.mode);
            }
        }
        drawOverlay();
    }

    function onWheel(event) {
        if (!ed.mask) return;
        var keys = hotkeys();
        var plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

        if (modifierHeld(event, keys.adjust) && !(keys.adjust === keys.zoom)) {
            event.preventDefault();
            var step = Math.max(1, Math.round(ed.brushSize * 0.1));
            setBrushSize(ed.brushSize + (event.deltaY < 0 ? step : -step));
        } else if (modifierHeld(event, keys.zoom) || (ed.modal && plain)) {
            event.preventDefault();
            var p = viewportPoint(event);
            zoomTo(ed.view.scale * Math.pow(1.0015, -event.deltaY), p.x, p.y);
        }
    }

    function isTyping(event) {
        var target = (event.composedPath && event.composedPath()[0]) || event.target;
        if (!target || !target.tagName) return false;
        if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
        return target.tagName === "INPUT" && !/^(checkbox|radio|button|range|submit|reset|file)$/i.test(target.type);
    }

    /** Keys go to the editor while the mouse is over it, it has the focus, or it is shown large. */
    function editorActive() {
        if (!ed.mask || !ed.root.classList.contains("inpaint-editor--has-image")) return false;
        if (!ed.root.getClientRects().length) return false;
        return ed.modal || ed.hover || ed.root.contains(document.activeElement);
    }

    function onKeyDown(event) {
        var key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
        if (!editorActive() || isTyping(event)) return;

        var ctrl = event.ctrlKey || event.metaKey;
        if (!ctrl && !event.altKey && (key === " " || key === hotkeys().move)) {
            // held to move the view by dragging
            ed.keysDown[key] = true;
            event.preventDefault();
            return;
        }

        var keys = hotkeys();
        var handled = true;

        if (ctrl && key === "Z" && !event.shiftKey) undo();
        else if (ctrl && (key === "Y" || (key === "Z" && event.shiftKey))) redo();
        else if (ctrl && key === "A") selectAll();
        else if (ctrl && key === "D") deselect();
        else if (ctrl && key === "I") invertSelection();
        else if (ctrl || event.altKey) handled = false;
        else if (key === "Escape" && ed.modal) toggleModal();
        else if (key === "Delete" || key === "Backspace") fillSelection(0);
        else if (event.repeat && key !== keys.shrink && key !== keys.grow) handled = false;
        else if (key === keys.large) toggleModal();
        else if (key === keys.reset) fitView();
        else if (key === keys.shrink) setBrushSize(ed.brushSize - Math.max(1, Math.round(ed.brushSize * 0.1)));
        else if (key === keys.grow) setBrushSize(ed.brushSize + Math.max(1, Math.round(ed.brushSize * 0.1)));
        else if (key === "B") setTool("brush");
        else if (key === "E") setTool("eraser");
        else if (key === "X") setTool(ed.tool === "eraser" ? "brush" : "eraser");
        else if (key === "M") setTool("rect");
        else if (key === "C") setTool("ellipse");
        else if (key === "U") setTool("fuzzy");
        else if (key === "G") fillSelection(1);
        else handled = false;

        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
    }

    function onKeyUp(event) {
        var key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
        delete ed.keysDown[key];
    }

    // ---- start --------------------------------------------------------------

    function init() {
        var root = gradioApp().getElementById(ROOT_ID);
        var source = gradioApp().getElementById(IMAGE_ID);
        if (!root || !source || ed.root) return;

        ed.source = source;
        ed.brushSize = load("brush_size", ed.brushSize);
        ed.tolerance = load("tolerance", ed.tolerance);
        ed.contiguous = load("contiguous", 1) !== 0;
        ed.growBy = load("grow_by", ed.growBy);
        ed.opacity = load("opacity", ed.opacity);

        build(root);
        watchSource();

        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", function() {
            ed.keysDown = {};
        });

        // Whatever starts a generation (the buttons, Ctrl+Enter, the queue) has to find the latest mask in
        // the textbox: it is put there before any click or key outside of the editor goes on.
        var flushOutside = function(event) {
            if (ed.root && !ed.root.contains(event.target)) flushMask();
        };
        window.addEventListener("pointerdown", flushOutside, true);
        window.addEventListener("keydown", flushOutside, true);

        // a pasted image goes into this editor while it is the one being worked with
        window.addEventListener("paste", function(event) {
            var files = event.clipboardData && event.clipboardData.files;
            if (!files || files.length !== 1 || !editorActive() || isTyping(event)) return;
            if (!/^image\//.test(files[0].type)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            replaceImage(files);
        }, true);
    }

    onUiLoaded(init);

    // for tests and other scripts
    window.InpaintEditor = {
        state: ed,
        fuzzySelect: fuzzySelect,
        shapeLayer: shapeLayer,
        combine: combine,
        bounds: bounds,
        growLayer: growLayer,
        stamp: stamp,
        undo: undo,
        redo: redo,
        flushMask: flushMask,
        fitView: fitView,
        toggleModal: toggleModal,
        selectAll: selectAll,
        deselect: deselect,
        invertSelection: invertSelection,
        growSelection: growSelection,
        fillSelection: fillSelection,
        selectionFromMask: selectionFromMask,
        invertMask: invertMask,
        clearMask: clearMask,
    };
})();
