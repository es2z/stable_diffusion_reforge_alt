/**
 * Extra Networks cards
 *
 * The server does not send cards as HTML. Every page (Lora, Checkpoints, ...) is described by a
 * list of plain items that is fetched once from ./sd_extra_networks/items and shared by txt2img
 * and img2img. Each tab has a grid per page which creates DOM nodes only for the rows that are
 * on screen, and adds/removes whole rows as the user scrolls.
 *
 * Performance characteristics:
 * - Load: one small JSON document per page instead of megabytes of HTML per tab
 * - DOM: O(visible cards), whatever the amount of items
 * - Scroll: only rows entering or leaving the viewport are touched
 * - Search and sort: done on the item list in memory
 *
 * The cards that are created have the same structure as the ones the server used to send
 * (html/extra-networks-card.html), so code that works with a card element keeps working. Code that
 * expects every card to be present in the page has to use ExtraNetworksData instead.
 */

// ============================================================================
// Item data, shared between tabs
// ============================================================================

var ExtraNetworksData = (function () {
    "use strict";

    // extra networks tab name ("lora", "textual_inversion", ...) -> state
    var pages = {};

    function entry(pageName) {
        if (!pages[pageName]) {
            pages[pageName] = {
                data: null,
                promise: null,
                request: 0,
                listeners: [],
            };
        }
        return pages[pageName];
    }

    function notify(page, status) {
        page.listeners.forEach(function (listener) {
            try {
                listener({ status: status, data: page.data });
            } catch (error) {
                console.error(error);
            }
        });
    }

    function prepare(data) {
        data.items.forEach(function (item, index) {
            var description = item.description || "";
            if (data.description_is_html) {
                description = description.replace(/<[^>]*>/g, " ");
            }

            item.index = index;
            // the same text the search used to collect from the card's elements
            item.searchText = (item.search_terms || [])
                .concat([description])
                .join(" ")
                .toLowerCase();
        });

        return data;
    }

    function load(pageName, force) {
        var page = entry(pageName);
        if (page.promise && !force) {
            return page.promise;
        }

        var request = ++page.request;
        notify(page, "loading");

        page.promise = fetch(
            "./sd_extra_networks/items?page=" + encodeURIComponent(pageName),
            { cache: "no-store" }
        )
            .then(function (response) {
                if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                }
                return response.json();
            })
            .then(function (data) {
                if (request !== page.request) {
                    return page.promise; // a newer request is on its way
                }
                page.data = prepare(data);
                notify(page, "ready");
                return page.data;
            })
            .catch(function (error) {
                console.error(
                    "Extra Networks: could not load items for",
                    pageName,
                    error
                );
                if (request === page.request) {
                    page.promise = null;
                    notify(page, "error");
                }
                return page.data;
            });

        return page.promise;
    }

    return {
        /** Loads the items of a page; all tabs share the request and its result. */
        load: load,

        /** Asks the server for the items of every known page again. */
        reloadAll: function () {
            return Promise.all(
                Object.keys(pages).map(function (pageName) {
                    return load(pageName, true);
                })
            );
        },

        /** Returns what the server sent for the page, or null while it is not loaded. */
        get: function (pageName) {
            return entry(pageName).data;
        },

        /** Returns the item with the given name, or null. */
        getItem: function (pageName, name) {
            var data = entry(pageName).data;
            if (!data) return null;

            for (var i = 0; i < data.items.length; i++) {
                if (data.items[i].name === name) return data.items[i];
            }
            return null;
        },

        /** Calls listener({status: "loading" | "ready" | "error", data}) whenever the page's state changes. */
        subscribe: function (pageName, listener) {
            var page = entry(pageName);
            page.listeners.push(listener);
            if (page.data) {
                listener({ status: "ready", data: page.data });
            }
        },
    };
})();

// ============================================================================
// Virtual grid of cards
// ============================================================================

var ExtraNetworksGrid = (function () {
    "use strict";

    var CONFIG = {
        // Rows kept ready above and below the visible ones.
        OVERSCAN_ROWS: 2,
    };

    var instances = {};

    var PREVIEW_ROUTES = /(^|\/)sd_extra_networks\/(thumb|cover-images)\?/;

    function el(tag, className) {
        var element = document.createElement(tag);
        if (className) element.className = className;
        return element;
    }

    function cardButton(tag, className, title, onclick) {
        var button = el(tag, className + " card-button");
        button.title = title;
        if (onclick) button.setAttribute("onclick", onclick);
        return button;
    }

    /** Link to the original image behind a preview link, which itself gives a thumbnail. */
    function originalImageUrl(preview) {
        if (!PREVIEW_ROUTES.test(preview)) return preview;
        return preview + "&full=1";
    }

    function compareBy(sortKey) {
        return function (a, b) {
            var av = a.sort_keys ? a.sort_keys[sortKey] : undefined;
            var bv = b.sort_keys ? b.sort_keys[sortKey] : undefined;
            if (av === undefined || av === null) av = "";
            if (bv === undefined || bv === null) bv = "";

            var result;
            if (av !== "" && bv !== "" && !isNaN(av) && !isNaN(bv)) {
                result = Number(av) - Number(bv);
            } else {
                av = String(av);
                bv = String(bv);
                result = av < bv ? -1 : av > bv ? 1 : 0;
            }

            return result || a.index - b.index;
        };
    }

    function Grid(tabname, pageName) {
        this.tabname = tabname;
        this.pageName = pageName;
        this.tabnameFull = tabname + "_" + pageName;

        this.data = null;
        this.visibleItems = []; // sorted and filtered
        this.view = {
            term: "",
            useRegex: false,
            sortKey: "default",
            descending: false,
        };
        this.viewKey = null;

        this.scroller = null; // #<tab>_<page>_cards, the element that scrolls
        this.canvas = null; // has the height of all rows together
        this.status = null; // "Loading...", "Nothing here", ...
        this.rows = new Map(); // row index -> element; only rows near the viewport

        this.columns = 0;
        this.cardWidth = 0;
        this.rowHeight = 0;
        this.measured = false; // card size is known
        this.stale = true; // rendered rows no longer match the items

        this.frame = null;
        this.resizeObserver = null;

        var self = this;
        this.onScroll = function () {
            self.schedule(false);
        };
    }

    Grid.prototype = {
        /**
         * Finds the container and prepares it. Done again if gradio replaced the element.
         */
        mount: function () {
            if (this.scroller && this.scroller.isConnected) return true;

            var scroller = gradioApp().querySelector(
                "#" + this.tabnameFull + "_cards"
            );
            if (!scroller) return false;

            var self = this;

            this.scroller = scroller;
            this.rows.clear();
            this.measured = false;
            this.stale = true;

            scroller.textContent = "";
            this.status = el("div", "extra-network-cards-status");
            this.canvas = el("div", "extra-network-cards-canvas");
            scroller.appendChild(this.status);
            scroller.appendChild(this.canvas);

            scroller.addEventListener("scroll", this.onScroll, {
                passive: true,
            });

            // Also fires when the tab is shown for the first time: until then the container has no size.
            if (this.resizeObserver) this.resizeObserver.disconnect();
            this.resizeObserver = new ResizeObserver(function () {
                self.schedule(true);
            });
            this.resizeObserver.observe(scroller);

            return true;
        },

        /**
         * Receives the state of the page's item list.
         */
        setState: function (state) {
            if (!this.mount()) return;

            this.scroller.classList.toggle(
                "extra-network-cards--loading",
                state.status === "loading"
            );

            if (state.status === "ready") {
                this.data = state.data;
                this.update();
            } else if (!this.data) {
                this.status.textContent =
                    state.status === "loading"
                        ? "Loading..."
                        : "Could not load the list. Press the refresh button to try again.";
            }
        },

        /**
         * Sets search and sort. Scrolls back to the top when they change.
         */
        setView: function (view) {
            var viewKey = JSON.stringify(view);
            if (viewKey === this.viewKey) return;

            var isFirst = this.viewKey === null;
            this.view = view;
            this.viewKey = viewKey;

            if (!this.data || !this.mount()) return;

            if (!isFirst) this.scroller.scrollTop = 0;
            this.update();
        },

        /**
         * Recomputes which items are shown, and in what order, then draws them.
         */
        update: function () {
            if (!this.data || !this.mount()) return;

            var view = this.view;
            var term = view.term.trim();
            var matches;

            if (view.useRegex) {
                try {
                    var regex = new RegExp(term, "i");
                    matches = function (text) {
                        return regex.test(text);
                    };
                } catch (error) {
                    // Invalid regex, treat as no match
                    matches = function () {
                        return false;
                    };
                }
            } else {
                term = term.toLowerCase();
                matches = function (text) {
                    return text.indexOf(term) !== -1;
                };
            }

            var items = this.data.items.filter(function (item) {
                // items in hidden directories only show up when searched for
                if (item.search_only && term.length < 4) return false;
                return matches(item.searchText);
            });

            items.sort(compareBy(view.sortKey));
            if (view.descending) items.reverse();

            this.visibleItems = items;
            this.measured = false; // options that set the card size arrive with the data
            this.stale = true;

            if (this.data.items.length === 0) {
                this.status.innerHTML = this.data.no_cards_html || "";
            } else {
                this.status.textContent = "";
            }

            this.layout();
        },

        /**
         * Asks for a redraw on the next frame; scroll and resize events arrive in bursts.
         * remeasure: the size of the cards may have changed too.
         */
        schedule: function (remeasure) {
            if (remeasure) this.measured = false;
            if (this.frame !== null) return;

            var self = this;
            this.frame = requestAnimationFrame(function () {
                self.frame = null;
                self.layout();
            });
        },

        /**
         * Card size comes from CSS and from options, so an invisible card is laid out to learn it.
         */
        measure: function () {
            var row = el("div", "extra-network-cards-row");
            row.style.visibility = "hidden";
            var card = this.createCard({
                name: "",
                filename: "",
                search_terms: [],
                sort_keys: {},
                onclick: "",
            });
            row.appendChild(card);
            this.canvas.appendChild(row);

            var rect = card.getBoundingClientRect();
            var style = window.getComputedStyle(card);
            var width =
                rect.width +
                (parseFloat(style.marginLeft) || 0) +
                (parseFloat(style.marginRight) || 0);
            var height =
                rect.height +
                (parseFloat(style.marginTop) || 0) +
                (parseFloat(style.marginBottom) || 0);

            this.canvas.removeChild(row);

            if (!(width > 0 && height > 0)) return false;

            if (width !== this.cardWidth || height !== this.rowHeight) {
                this.cardWidth = width;
                this.rowHeight = height;
                this.stale = true;
            }
            this.measured = true;
            return true;
        },

        /**
         * Fits the grid to the container and draws the rows that are in view.
         */
        layout: function () {
            if (!this.data || !this.mount()) return;

            var width = this.scroller.clientWidth;
            // Nothing can be measured while the tab is hidden; the resize observer calls again once it is shown.
            if (!width || (!this.measured && !this.measure())) return;

            var columns = Math.max(
                1,
                Math.floor((width + 0.5) / this.cardWidth)
            );
            if (columns !== this.columns) {
                this.columns = columns;
                this.stale = true;
            }

            var rowCount = Math.ceil(this.visibleItems.length / columns);
            this.canvas.style.height = rowCount * this.rowHeight + "px";

            if (this.stale) {
                this.rows.forEach(function (row) {
                    row.remove();
                });
                this.rows.clear();
                this.stale = false;
            }

            // position of the viewport relative to the first row
            var top =
                this.scroller.getBoundingClientRect().top -
                this.canvas.getBoundingClientRect().top;
            var bottom = top + this.scroller.clientHeight;

            var first = Math.max(
                0,
                Math.floor(top / this.rowHeight) - CONFIG.OVERSCAN_ROWS
            );
            var last = Math.min(
                rowCount - 1,
                Math.floor(bottom / this.rowHeight) + CONFIG.OVERSCAN_ROWS
            );

            var rows = this.rows;
            rows.forEach(function (row, index) {
                if (index < first || index > last) {
                    row.remove();
                    rows.delete(index);
                }
            });

            for (var index = first; index <= last; index++) {
                if (!rows.has(index)) {
                    var row = this.createRow(index);
                    rows.set(index, row);
                    this.canvas.appendChild(row);
                }
            }
        },

        createRow: function (index) {
            var row = el("div", "extra-network-cards-row");
            row.style.top = index * this.rowHeight + "px";

            var start = index * this.columns;
            var end = Math.min(start + this.columns, this.visibleItems.length);
            for (var i = start; i < end; i++) {
                row.appendChild(this.createCard(this.visibleItems[i]));
            }

            return row;
        },

        /**
         * Builds the element for one item; same structure as html/extra-networks-card.html.
         */
        createCard: function (item) {
            var data = this.data || {};
            var tabname = this.tabname;
            var pageName = this.pageName;

            var card = el("div", "card");
            if (data.card_style) card.setAttribute("style", data.card_style);
            card.setAttribute("data-name", item.name);
            Object.keys(item.sort_keys || {}).forEach(function (key) {
                card.setAttribute("data-sort-" + key, item.sort_keys[key]);
            });

            var onclick = item.onclick;
            if (onclick === undefined || onclick === null) {
                // prompt and negative_prompt are javascript expressions, evaluated when the card is clicked
                onclick =
                    "cardClicked('" +
                    tabname +
                    "', " +
                    item.prompt +
                    ", " +
                    item.negative_prompt +
                    ", " +
                    (data.allow_negative_prompt ? "true" : "false") +
                    ");";
            }
            card.setAttribute("onclick", onclick);

            if (item.preview) {
                var img = el("img", "preview");
                img.loading = "lazy";
                img.decoding = "async";
                img.onerror = function () {
                    img.remove(); // leaves the "no preview" background
                };
                img.src = item.preview;
                card.appendChild(img);

                // Shown while hovering, like the buttons on the right. The preview is a thumbnail,
                // these two work with the image it was made from.
                var imageButtons = el("div", "image-button-row");
                var open = cardButton(
                    "a",
                    "open-original-button",
                    "Open original preview image in new tab",
                    "event.stopPropagation()"
                );
                open.href = originalImageUrl(item.preview);
                open.target = "_blank";
                open.rel = "noopener";
                imageButtons.appendChild(open);

                if (
                    PREVIEW_ROUTES.test(item.preview) &&
                    gradioApp().getElementById("pnginfo_extra_networks_send")
                ) {
                    var send = cardButton(
                        "div",
                        "send-pnginfo-button",
                        "Send original preview image to PNG Info",
                        "extraNetworksSendPreviewToPngInfo(event)"
                    );
                    send.setAttribute("data-preview", item.preview);
                    imageButtons.appendChild(send);
                }
                card.appendChild(imageButtons);
            }

            var buttons = el("div", "button-row");
            var copyPath = cardButton(
                "div",
                "copy-path-button",
                "Copy path to clipboard",
                "extraNetworksCopyCardPath(event)"
            );
            copyPath.setAttribute("data-clipboard-text", item.filename || "");
            buttons.appendChild(copyPath);
            if (item.has_metadata) {
                buttons.appendChild(
                    cardButton(
                        "div",
                        "metadata-button",
                        "Show internal metadata",
                        "extraNetworksRequestMetadata(event, '" +
                            pageName +
                            "')"
                    )
                );
            }
            buttons.appendChild(
                cardButton(
                    "div",
                    "edit-button",
                    "Edit metadata",
                    "extraNetworksEditUserMetadata(event, '" +
                        tabname +
                        "', '" +
                        pageName +
                        "')"
                )
            );
            card.appendChild(buttons);

            var actions = el("div", "actions");
            var additional = el("div", "additional");
            (item.search_terms || []).forEach(function (term) {
                var span = el(
                    "span",
                    "hidden search_terms" +
                        (item.search_only ? " search_only" : "")
                );
                span.textContent = term;
                additional.appendChild(span);
            });
            actions.appendChild(additional);

            var name = el("span", "name");
            name.textContent = item.name;
            actions.appendChild(name);

            var description = el("span", "description");
            if (data.description_is_html) {
                description.innerHTML = item.description || "";
            } else {
                description.textContent = item.description || "";
            }
            actions.appendChild(description);
            card.appendChild(actions);

            return card;
        },
    };

    // Public API
    return {
        CONFIG: CONFIG,

        /** Returns the grid of a page in a tab, creating it on first use. */
        create: function (tabname, pageName) {
            var key = tabname + "_" + pageName;
            if (!instances[key]) {
                instances[key] = new Grid(tabname, pageName);
            }
            return instances[key];
        },

        /** Returns the grid for an id like "txt2img_lora", if there is one. */
        get: function (tabname_full) {
            return instances[tabname_full];
        },
    };
})();

// ============================================================================
// CSS Toggle Helper
// ============================================================================

function toggleCss(key, css, enable) {
    var style = document.getElementById(key);
    if (enable && !style) {
        style = document.createElement("style");
        style.id = key;
        style.type = "text/css";
        document.head.appendChild(style);
    }
    if (style && !enable) {
        document.head.removeChild(style);
    }
    if (style) {
        style.innerHTML = "";
        style.appendChild(document.createTextNode(css));
    }
}

// ============================================================================
// Extra Networks Setup
// ============================================================================

var extraNetworksApplyFilter = {};
var extraNetworksApplySort = {};
var activePromptTextarea = {};

/**
 * Fills the directory buttons of the "Dirs" view.
 */
function extraNetworksRenderDirs(tabname, extra_networks_tabname, data) {
    var container = gradioApp().getElementById(
        tabname + "_" + extra_networks_tabname + "_dirs"
    );
    if (!container) return;

    container.textContent = "";
    (data.dirs || []).forEach(function (subdir) {
        var button = document.createElement("button");
        button.className =
            "lg secondary gradio-button custom-button" +
            (subdir === "" ? " search-all" : "");
        button.setAttribute(
            "onclick",
            "extraNetworksSearchButton('" +
                tabname +
                "', '" +
                extra_networks_tabname +
                "', event)"
        );
        button.textContent = subdir === "" ? "all" : subdir;
        container.appendChild(button);
    });
}

/**
 * Fills the tree of the "Tree" view.
 */
function extraNetworksLoadTree(tabname, extra_networks_tabname) {
    var container = gradioApp().getElementById(
        tabname + "_" + extra_networks_tabname + "_tree"
    );
    if (!container) return;

    requestGet(
        "./sd_extra_networks/tree-html",
        { page: extra_networks_tabname, tabname: tabname },
        function (data) {
            container.innerHTML = data.html || "";
        },
        function () {}
    );
}

/**
 * Asks the server for the items of all pages again and redraws the cards in every tab.
 */
function extraNetworksReloadItems() {
    return ExtraNetworksData.reloadAll();
}

function setupExtraNetworksForTab(tabname) {
    function registerPrompt(tabname, id) {
        var textarea = gradioApp().querySelector(
            "#" + id + " > label > textarea"
        );

        if (!activePromptTextarea[tabname]) {
            activePromptTextarea[tabname] = textarea;
        }

        textarea.addEventListener("focus", function () {
            activePromptTextarea[tabname] = textarea;
        });
    }

    var tabnav = gradioApp().querySelector(
        "#" + tabname + "_extra_tabs > div.tab-nav"
    );
    var controlsDiv = document.createElement("DIV");
    controlsDiv.classList.add("extra-networks-controls-div");
    tabnav.appendChild(controlsDiv);
    tabnav.insertBefore(controlsDiv, null);

    var this_tab = gradioApp().querySelector("#" + tabname + "_extra_tabs");
    this_tab
        .querySelectorAll(":scope > [id^='" + tabname + "_']")
        .forEach(function (elem) {
            var tabname_full = elem.id;
            var search = gradioApp().querySelector(
                "#" + tabname_full + "_extra_search"
            );
            var sort_dir = gradioApp().querySelector(
                "#" + tabname_full + "_extra_sort_dir"
            );
            var refresh = gradioApp().querySelector(
                "#" + tabname_full + "_extra_refresh"
            );

            if (!search || !sort_dir || !refresh) {
                return;
            }

            // "lora", "textual_inversion", ...: the part of the id after the tab's name
            var pageName = tabname_full.slice(tabname.length + 1);
            var grid = ExtraNetworksGrid.create(tabname, pageName);
            var regexCheckbox = gradioApp().querySelector(
                "#" + tabname_full + "_extra_regex"
            );

            // Search and sort both come down to telling the grid what to show.
            var applyView = function () {
                var activeSortElem = gradioApp().querySelector(
                    "#" +
                        tabname_full +
                        "_controls .extra-network-control--sort.extra-network-control--enabled"
                );

                grid.setView({
                    term: search.value,
                    useRegex: !!(regexCheckbox && regexCheckbox.checked),
                    sortKey: activeSortElem
                        ? activeSortElem.dataset.sortkey
                        : "default",
                    descending: sort_dir.dataset.sortdir == "Descending",
                });
            };

            search.addEventListener("input", applyView);
            if (regexCheckbox) {
                regexCheckbox.addEventListener("change", applyView);
            }

            applyView();

            extraNetworksApplySort[tabname_full] = applyView;
            extraNetworksApplyFilter[tabname_full] = applyView;

            ExtraNetworksData.subscribe(pageName, function (state) {
                grid.setState(state);
                if (state.status === "ready") {
                    extraNetworksRenderDirs(tabname, pageName, state.data);
                    extraNetworksLoadTree(tabname, pageName);
                }
            });
            ExtraNetworksData.load(pageName);

            var controls = gradioApp().querySelector(
                "#" + tabname_full + "_controls"
            );
            controlsDiv.insertBefore(controls, null);

            if (elem.style.display != "none") {
                extraNetworksShowControlsForPage(tabname, tabname_full);
            }
        });

    registerPrompt(tabname, tabname + "_prompt");
    registerPrompt(tabname, tabname + "_neg_prompt");
}

function extraNetworksMovePromptToTab(
    tabname,
    id,
    showPrompt,
    showNegativePrompt
) {
    if (!gradioApp().querySelector(".toprow-compact-tools")) return;

    var promptContainer = gradioApp().getElementById(
        tabname + "_prompt_container"
    );
    var prompt = gradioApp().getElementById(tabname + "_prompt_row");
    var negPrompt = gradioApp().getElementById(tabname + "_neg_prompt_row");
    var elem = id ? gradioApp().getElementById(id) : null;

    if (showNegativePrompt && elem) {
        elem.insertBefore(negPrompt, elem.firstChild);
    } else {
        promptContainer.insertBefore(negPrompt, promptContainer.firstChild);
    }

    if (showPrompt && elem) {
        elem.insertBefore(prompt, elem.firstChild);
    } else {
        promptContainer.insertBefore(prompt, promptContainer.firstChild);
    }

    if (elem) {
        elem.classList.toggle(
            "extra-page-prompts-active",
            showNegativePrompt || showPrompt
        );
    }
}

function extraNetworksShowControlsForPage(tabname, tabname_full) {
    gradioApp()
        .querySelectorAll(
            "#" + tabname + "_extra_tabs .extra-networks-controls-div > div"
        )
        .forEach(function (elem) {
            var targetId = tabname_full + "_controls";
            elem.style.display = elem.id == targetId ? "" : "none";
        });
}

function extraNetworksUnrelatedTabSelected(tabname) {
    extraNetworksMovePromptToTab(tabname, "", false, false);
    extraNetworksShowControlsForPage(tabname, null);
}

function extraNetworksTabSelected(
    tabname,
    id,
    showPrompt,
    showNegativePrompt,
    tabname_full
) {
    extraNetworksMovePromptToTab(tabname, id, showPrompt, showNegativePrompt);
    extraNetworksShowControlsForPage(tabname, tabname_full);
}

function applyExtraNetworkFilter(tabname_full) {
    var doFilter = function () {
        var applyFunction = extraNetworksApplyFilter[tabname_full];
        if (applyFunction) {
            applyFunction(true);
        }
    };
    setTimeout(doFilter, 1);
}

function applyExtraNetworkSort(tabname_full) {
    var doSort = function () {
        extraNetworksApplySort[tabname_full](true);
    };
    setTimeout(doSort, 1);
}

function setupExtraNetworks() {
    setupExtraNetworksForTab("txt2img");
    setupExtraNetworksForTab("img2img");
}

// ============================================================================
// Extra Network Prompt Handling
// ============================================================================

var re_extranet = /<([^:^>]+:[^:]+):[\d.]+>(.*)/s;
var re_extranet_g = /<([^:^>]+:[^:]+):[\d.]+>/g;
var re_extranet_neg = /\(([^:^>]+:[\d.]+)\)/;
var re_extranet_g_neg = /\(([^:^>]+:[\d.]+)\)/g;

function tryToRemoveExtraNetworkFromPrompt(textarea, text, isNeg) {
    var m = text.match(isNeg ? re_extranet_neg : re_extranet);
    var replaced = false;
    var newTextareaText;
    var extraTextBeforeNet = opts.extra_networks_add_text_separator;
    if (m) {
        var extraTextAfterNet = m[2];
        var partToSearch = m[1];
        var foundAtPosition = -1;
        newTextareaText = textarea.value.replaceAll(
            isNeg ? re_extranet_g_neg : re_extranet_g,
            function (found, net, pos) {
                m = found.match(isNeg ? re_extranet_neg : re_extranet);
                if (m[1] == partToSearch) {
                    replaced = true;
                    foundAtPosition = pos;
                    return "";
                }
                return found;
            }
        );
        if (foundAtPosition >= 0) {
            if (
                extraTextAfterNet &&
                newTextareaText.substr(
                    foundAtPosition,
                    extraTextAfterNet.length
                ) == extraTextAfterNet
            ) {
                newTextareaText =
                    newTextareaText.substr(0, foundAtPosition) +
                    newTextareaText.substr(
                        foundAtPosition + extraTextAfterNet.length
                    );
            }
            if (
                newTextareaText.substr(
                    foundAtPosition - extraTextBeforeNet.length,
                    extraTextBeforeNet.length
                ) == extraTextBeforeNet
            ) {
                newTextareaText =
                    newTextareaText.substr(
                        0,
                        foundAtPosition - extraTextBeforeNet.length
                    ) + newTextareaText.substr(foundAtPosition);
            }
        }
    } else {
        newTextareaText = textarea.value.replaceAll(
            new RegExp(`((?:${extraTextBeforeNet})?${text})`, "g"),
            ""
        );
        replaced = newTextareaText != textarea.value;
    }

    if (replaced) {
        textarea.value = newTextareaText;
        return true;
    }

    return false;
}

function updatePromptArea(text, textArea, isNeg) {
    if (!tryToRemoveExtraNetworkFromPrompt(textArea, text, isNeg)) {
        textArea.value =
            textArea.value + opts.extra_networks_add_text_separator + text;
    }

    updateInput(textArea);
}

function cardClicked(
    tabname,
    textToAdd,
    textToAddNegative,
    allowNegativePrompt
) {
    if (textToAddNegative.length > 0) {
        updatePromptArea(
            textToAdd,
            gradioApp().querySelector(
                "#" + tabname + "_prompt > label > textarea"
            )
        );
        updatePromptArea(
            textToAddNegative,
            gradioApp().querySelector(
                "#" + tabname + "_neg_prompt > label > textarea"
            ),
            true
        );
    } else {
        var textarea = allowNegativePrompt
            ? activePromptTextarea[tabname]
            : gradioApp().querySelector(
                  "#" + tabname + "_prompt > label > textarea"
              );
        updatePromptArea(textToAdd, textarea);
    }
}

function saveCardPreview(event, tabname, filename) {
    var textarea = gradioApp().querySelector(
        "#" + tabname + "_preview_filename  > label > textarea"
    );
    var button = gradioApp().getElementById(tabname + "_save_preview");

    textarea.value = filename;
    updateInput(textarea);

    button.click();

    event.stopPropagation();
    event.preventDefault();
}

// ============================================================================
// Tree View Functions
// ============================================================================

function extraNetworksSearchButton(tabname, extra_networks_tabname, event) {
    var searchTextarea = gradioApp().querySelector(
        "#" + tabname + "_" + extra_networks_tabname + "_extra_search"
    );
    var button = event.target;
    var text = button.classList.contains("search-all")
        ? ""
        : button.textContent.trim();

    searchTextarea.value = text;
    updateInput(searchTextarea);
}

function extraNetworksTreeProcessDirectoryClick(
    event,
    btn,
    tabname,
    extra_networks_tabname
) {
    var ul = btn.nextElementSibling;
    var true_targ = event.target;

    function _expand_or_collapse(_ul, _btn) {
        if (_ul.hasAttribute("hidden")) {
            _ul.removeAttribute("hidden");
            _btn.dataset.expanded = "";
        } else {
            _ul.setAttribute("hidden", "");
            delete _btn.dataset.expanded;
        }
    }

    function _remove_selected_from_all() {
        var sels = document.querySelectorAll("div.tree-list-content");
        [...sels].forEach((el) => {
            delete el.dataset.selected;
        });
    }

    function _select_button(_btn) {
        _remove_selected_from_all();
        _btn.dataset.selected = "";
    }

    function _update_search(_tabname, _extra_networks_tabname, _search_text) {
        var search_input_elem = gradioApp().querySelector(
            "#" + tabname + "_" + extra_networks_tabname + "_extra_search"
        );
        search_input_elem.value = _search_text;
        updateInput(search_input_elem);
    }

    if (
        true_targ.matches(
            ".tree-list-item-action--leading, .tree-list-item-action-chevron"
        )
    ) {
        _expand_or_collapse(ul, btn);
    } else {
        if ("selected" in btn.dataset && !ul.hasAttribute("hidden")) {
            _expand_or_collapse(ul, btn);
            delete btn.dataset.selected;
            _update_search(tabname, extra_networks_tabname, "");
        } else if (
            !(!("selected" in btn.dataset) && !ul.hasAttribute("hidden"))
        ) {
            _expand_or_collapse(ul, btn);
            _select_button(btn, tabname, extra_networks_tabname);
            _update_search(tabname, extra_networks_tabname, btn.dataset.path);
        } else {
            _select_button(btn, tabname, extra_networks_tabname);
            _update_search(tabname, extra_networks_tabname, btn.dataset.path);
        }
    }
}

function extraNetworksTreeProcessFileClick(
    event,
    btn,
    tabname,
    extra_networks_tabname
) {
    // Handle file click - typically triggers the card action
    var path = btn.dataset.path;
    var hash = btn.dataset.hash;

    // Find and click the corresponding card
    if (hash) {
        var card = gradioApp().querySelector(
            "#" +
                tabname +
                "_" +
                extra_networks_tabname +
                '_cards .card[data-name="' +
                hash +
                '"]'
        );
        if (card) {
            card.click();
        }
    }
}

function extraNetworksTreeOnClick(event, tabname, extra_networks_tabname) {
    var btn = event.currentTarget;
    var par = btn.parentElement;
    if (par.dataset.treeEntryType === "file") {
        extraNetworksTreeProcessFileClick(
            event,
            btn,
            tabname,
            extra_networks_tabname
        );
    } else {
        extraNetworksTreeProcessDirectoryClick(
            event,
            btn,
            tabname,
            extra_networks_tabname
        );
    }
}

function extraNetworksControlSortOnClick(
    event,
    tabname,
    extra_networks_tabname
) {
    var self = event.currentTarget;
    var parent = event.currentTarget.parentElement;

    parent
        .querySelectorAll(".extra-network-control--sort")
        .forEach(function (x) {
            x.classList.remove("extra-network-control--enabled");
        });

    self.classList.add("extra-network-control--enabled");

    applyExtraNetworkSort(tabname + "_" + extra_networks_tabname);
}

function extraNetworksControlSortDirOnClick(
    event,
    tabname,
    extra_networks_tabname
) {
    if (event.currentTarget.dataset.sortdir == "Ascending") {
        event.currentTarget.dataset.sortdir = "Descending";
        event.currentTarget.setAttribute("title", "Sort descending");
    } else {
        event.currentTarget.dataset.sortdir = "Ascending";
        event.currentTarget.setAttribute("title", "Sort ascending");
    }
    applyExtraNetworkSort(tabname + "_" + extra_networks_tabname);
}

function extraNetworksControlTreeViewOnClick(
    event,
    tabname,
    extra_networks_tabname
) {
    var button = event.currentTarget;
    button.classList.toggle("extra-network-control--enabled");

    var pane = gradioApp().getElementById(
        tabname + "_" + extra_networks_tabname + "_pane"
    );
    pane.classList.toggle("extra-network-dirs-hidden");

    var tree = gradioApp().getElementById(
        tabname + "_" + extra_networks_tabname + "_tree"
    );
    var cards = gradioApp().getElementById(
        tabname + "_" + extra_networks_tabname + "_cards"
    );
    var resizeHandle = pane.querySelector(".resize-handle");

    if (pane.classList.contains("extra-network-dirs-hidden")) {
        tree.style.display = "none";
        cards.style.flexGrow = "1";
        cards.style.width = "100%";
        if (resizeHandle) resizeHandle.style.display = "none";
    } else {
        tree.style.display = "block";
        cards.style.flexGrow = "1";
        cards.style.width = "auto";
        if (resizeHandle) resizeHandle.style.display = "block";
    }
}

function extraNetworksControlRefreshOnClick(
    event,
    tabname,
    extra_networks_tabname
) {
    var btn_refresh_internal = gradioApp().getElementById(
        tabname + "_" + extra_networks_tabname + "_extra_refresh_internal"
    );
    // The server lists the files again, then calls extraNetworksReloadItems().
    btn_refresh_internal.dispatchEvent(new Event("click"));
}

// ============================================================================
// Popup Functions
// ============================================================================

var globalPopup = null;
var globalPopupInner = null;

function closePopup() {
    if (!globalPopup) return;
    globalPopup.style.display = "none";
}

function popup(contents) {
    if (!globalPopup) {
        globalPopup = document.createElement("div");
        globalPopup.classList.add("global-popup");

        var close = document.createElement("div");
        close.classList.add("global-popup-close");
        close.addEventListener("click", closePopup);
        close.title = "Close";
        globalPopup.appendChild(close);

        globalPopupInner = document.createElement("div");
        globalPopupInner.classList.add("global-popup-inner");
        globalPopup.appendChild(globalPopupInner);

        gradioApp().querySelector(".main").appendChild(globalPopup);
    }

    globalPopupInner.innerHTML = "";
    globalPopupInner.appendChild(contents);

    globalPopup.style.display = "flex";
}

var storedPopupIds = {};
function popupId(id) {
    if (!storedPopupIds[id]) {
        storedPopupIds[id] = gradioApp().getElementById(id);
    }

    popup(storedPopupIds[id]);
}

function extraNetworksFlattenMetadata(obj) {
    const result = {};

    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === "string") {
            try {
                const parsed = JSON.parse(obj[key]);
                if (parsed && typeof parsed === "object") {
                    obj[key] = parsed;
                }
            } catch (error) {
                continue;
            }
        }
    }

    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === "object" && obj[key] !== null) {
            const nested = extraNetworksFlattenMetadata(obj[key]);
            for (const nestedKey of Object.keys(nested)) {
                result[`${key}/${nestedKey}`] = nested[nestedKey];
            }
        } else {
            result[key] = obj[key];
        }
    }

    for (const key of Object.keys(result)) {
        if (key.startsWith("modelspec.")) {
            result[key.replaceAll(".", "/")] = result[key];
            delete result[key];
        }
    }

    for (const key of Object.keys(result)) {
        const parts = key.split("/");
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join("/");
            if (!result[parent]) {
                result[parent] = "";
            }
        }
    }

    return result;
}

function extraNetworksShowMetadata(text) {
    try {
        let parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
            parsed = extraNetworksFlattenMetadata(parsed);
            const table = createVisualizationTable(parsed, 0);
            popup(table);
            return;
        }
    } catch (error) {
        console.error(error);
    }

    var elem = document.createElement("pre");
    elem.classList.add("popup-metadata");
    elem.textContent = text;

    popup(elem);
}

function requestGet(url, data, handler, errorHandler) {
    var xhr = new XMLHttpRequest();
    var args = Object.keys(data)
        .map(function (k) {
            return encodeURIComponent(k) + "=" + encodeURIComponent(data[k]);
        })
        .join("&");
    xhr.open("GET", url + "?" + args, true);

    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            if (xhr.status === 200) {
                try {
                    var js = JSON.parse(xhr.responseText);
                    handler(js);
                } catch (error) {
                    console.error(error);
                    errorHandler();
                }
            } else {
                errorHandler();
            }
        }
    };
    var js = JSON.stringify(data);
    xhr.send(js);
}

function extraNetworksCopyCardPath(event) {
    navigator.clipboard.writeText(
        event.target.getAttribute("data-clipboard-text")
    );
    event.stopPropagation();
}

function extraNetworksRequestMetadata(event, extraPage) {
    var showError = function () {
        extraNetworksShowMetadata("there was an error getting metadata");
    };

    var cardName =
        event.target.parentElement.parentElement.getAttribute("data-name");

    requestGet(
        "./sd_extra_networks/metadata",
        { page: extraPage, item: cardName },
        function (data) {
            if (data && data.metadata) {
                extraNetworksShowMetadata(data.metadata);
            } else {
                showError();
            }
        },
        showError
    );

    event.stopPropagation();
}

var extraPageUserMetadataEditors = {};

function extraNetworksEditUserMetadata(event, tabname, extraPage) {
    var id = tabname + "_" + extraPage + "_edit_user_metadata";

    var editor = extraPageUserMetadataEditors[id];
    if (!editor) {
        editor = {};
        editor.page = gradioApp().getElementById(id);
        editor.nameTextarea = gradioApp().querySelector(
            "#" + id + "_name" + " textarea"
        );
        editor.button = gradioApp().querySelector("#" + id + "_button");
        extraPageUserMetadataEditors[id] = editor;
    }

    var cardName =
        event.target.parentElement.parentElement.getAttribute("data-name");

    editor.nameTextarea.value = cardName;
    updateInput(editor.nameTextarea);

    editor.button.click();

    popup(editor.page);

    event.stopPropagation();
}

function extraNetworksRefreshSingleCard(page, tabname, name) {
    // `page` is the page's name; its items are kept under the name of its tab
    ExtraNetworksData.load(page.replace(/ /g, "_"), true);
}

/**
 * Switches the main tabs to the one with the given element id, e.g. "tab_pnginfo".
 */
function extraNetworksSwitchToMainTab(tabId) {
    var tabs = gradioApp().querySelector("#tabs");
    if (!tabs) return;

    var items = tabs.querySelectorAll(":scope > .tabitem");
    var buttons = tabs.querySelectorAll(":scope > .tab-nav > button");
    for (var i = 0; i < items.length; i++) {
        if (items[i].id == tabId && buttons[i]) {
            buttons[i].click();
            return;
        }
    }
}

/**
 * Card button: shows the image a preview was made from in PNG Info, with its generation parameters.
 */
function extraNetworksSendPreviewToPngInfo(event) {
    event.stopPropagation();

    var button = event.target.closest(".card-button");
    var source = gradioApp().querySelector(
        "#pnginfo_extra_networks_source textarea, #pnginfo_extra_networks_source input"
    );
    var send = gradioApp().getElementById("pnginfo_extra_networks_send");
    if (!button || !source || !send) return;

    // The server looks the original image up from the preview link and puts it into PNG Info's image.
    source.value = button.getAttribute("data-preview");
    updateInput(source);
    send.click();

    extraNetworksSwitchToMainTab("tab_pnginfo");
}

window.addEventListener("keydown", function (event) {
    if (event.key == "Escape") {
        closePopup();
    }
});

// ============================================================================
// UI Initialization
// ============================================================================

var uiAfterScriptsCallbacks = [];
var uiAfterScriptsTimeout = null;
var executedAfterScripts = false;

function scheduleAfterScriptsCallbacks() {
    clearTimeout(uiAfterScriptsTimeout);
    uiAfterScriptsTimeout = setTimeout(function () {
        executeCallbacks(uiAfterScriptsCallbacks);
    }, 200);
}

onUiLoaded(function () {
    var mutationObserver = null;

    var check = function () {
        let existingSearchfields = gradioApp().querySelectorAll(
            "[id$='_extra_search']"
        ).length;
        let neededSearchfields =
            gradioApp().querySelectorAll(
                "[id$='_extra_tabs'] > .tab-nav > button"
            ).length - 2;

        if (
            !executedAfterScripts &&
            existingSearchfields >= neededSearchfields
        ) {
            if (mutationObserver) mutationObserver.disconnect();
            executedAfterScripts = true;
            scheduleAfterScriptsCallbacks();
        }
    };

    // The panes are part of the page from the start, so there may be no further mutation to wait for.
    check();
    if (!executedAfterScripts) {
        mutationObserver = new MutationObserver(check);
        mutationObserver.observe(gradioApp(), {
            childList: true,
            subtree: true,
        });
    }
});

uiAfterScriptsCallbacks.push(setupExtraNetworks);
