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

var ExtraNetworksData = (function() {
    "use strict";

    // extra networks tab name ("lora", "textual_inversion", ...) -> state
    var pages = {};

    function entry(pageName) {
        if (!pages[pageName]) {
            pages[pageName] = {
                data: null,
                etag: null, // of the response `data` came from
                promise: null,
                request: 0,
                listeners: [],
            };
        }
        return pages[pageName];
    }

    /**
     * change: what is different from the last "ready" state - "all" (the list was loaded),
     * "item" (one item was replaced), "stats" (usage counts and favourites only) or "none"
     * (the server was asked and has the same list as before).
     */
    function notify(page, status, change) {
        page.listeners.forEach(function(listener) {
            try {
                listener({
                    status: status,
                    data: page.data,
                    change: change || "all",
                });
            } catch (error) {
                console.error(error);
            }
        });
    }

    function prepareItem(data, item, index) {
        var description = item.description || "";
        if (data.description_is_html) {
            description = description.replace(/<[^>]*>/g, " ");
        }

        item.index = index;
        // The text the search used to collect from the card's elements, plus what the user wrote
        // about the item in "Edit metadata" (activation text, notes).
        item.searchText = (item.search_terms || [])
            .concat([description])
            .concat(item.search_extra || [])
            .join(" ")
            .toLowerCase();

        return item;
    }

    function prepare(data) {
        data.items.forEach(function(item, index) {
            prepareItem(data, item, index);
        });

        return data;
    }

    /**
     * Replaces one item with a newer description of it; null removes it.
     * Returns false if the page is not loaded.
     */
    function updateItem(pageName, name, item) {
        var page = entry(pageName);
        var data = page.data;
        if (!data) return false;

        var position = -1;
        for (var i = 0; i < data.items.length; i++) {
            if (data.items[i].name === name) {
                position = i;
                break;
            }
        }

        if (!item) {
            if (position !== -1) data.items.splice(position, 1);
        } else if (position !== -1) {
            var old = data.items[position];
            // a single item is listed without its place in the list; it stays where it was
            item.sort_keys = item.sort_keys || {};
            if (
                item.sort_keys.default === undefined ||
                item.sort_keys.default === null
            ) {
                item.sort_keys.default = (old.sort_keys || {}).default;
            }
            data.items[position] = prepareItem(data, item, old.index);
        } else {
            data.items.push(prepareItem(data, item, data.items.length));
        }

        notify(page, "ready", "item");
        return true;
    }

    function load(pageName, force) {
        var page = entry(pageName);
        if (page.promise && !force) {
            return page.promise;
        }

        var request = ++page.request;
        notify(page, "loading");

        // The server answers "304 Not Modified" without a body if the list is still the one this
        // etag came with; then there is nothing to parse, and the cards stay as they are.
        var options = {cache: "no-store"};
        if (page.data && page.etag) {
            options.headers = {"If-None-Match": page.etag};
        }

        page.promise = fetch(
            "./sd_extra_networks/items?page=" + encodeURIComponent(pageName),
            options
        )
            .then(function(response) {
                if (response.status === 304 && page.data) {
                    return null;
                }
                if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                }
                var etag = response.headers.get("ETag");
                return response.json().then(function(data) {
                    return {data: data, etag: etag};
                });
            })
            .then(function(result) {
                if (request !== page.request) {
                    return page.promise; // a newer request is on its way
                }
                if (result === null) {
                    notify(page, "ready", "none");
                    return page.data;
                }
                page.data = prepare(result.data);
                page.etag = result.etag;
                notify(page, "ready");
                return page.data;
            })
            .catch(function(error) {
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
        reloadAll: function() {
            return Promise.all(
                Object.keys(pages).map(function(pageName) {
                    return load(pageName, true);
                })
            );
        },

        updateItem: updateItem,

        /**
         * Sets usage counts and favourites from {name: {count, last_used, favorite}}.
         * complete: the map holds every item that has any; the others are reset.
         */
        applyStats: function(pageName, stats, complete) {
            var page = entry(pageName);
            if (!page.data) return;

            var changed = false;
            page.data.items.forEach(function(item) {
                var itemStats = stats[item.name];
                if (!itemStats) {
                    if (!complete) return;
                    itemStats = {count: 0, last_used: 0, favorite: false};
                }

                if (
                    (item.usage_count || 0) === itemStats.count &&
                    (item.last_used || 0) === itemStats.last_used &&
                    !!item.favorite === !!itemStats.favorite
                ) {
                    return;
                }

                item.usage_count = itemStats.count;
                item.last_used = itemStats.last_used;
                item.favorite = itemStats.favorite;
                item.sort_keys = item.sort_keys || {};
                item.sort_keys.usage_count = itemStats.count;
                item.sort_keys.last_used = itemStats.last_used;
                // the card that was drawn for the item is out of date
                item.cardKey = undefined;
                changed = true;
            });

            // Asked for every time a page is opened; most of the time the numbers are the same.
            if (changed) notify(page, "ready", "stats");
        },

        /**
         * Fetches usage counts again; they change whenever an image is generated.
         */
        refreshStats: function(pageName) {
            var self = this;
            if (!entry(pageName).data) return;

            requestGet(
                "./sd_extra_networks/stats",
                {page: pageName},
                function(data) {
                    if (data && data.stats) {
                        self.applyStats(pageName, data.stats, true);
                    }
                },
                function() {}
            );
        },

        /** Returns what the server sent for the page, or null while it is not loaded. */
        get: function(pageName) {
            return entry(pageName).data;
        },

        /** Returns the item with the given name, or null. */
        getItem: function(pageName, name) {
            var data = entry(pageName).data;
            if (!data) return null;

            for (var i = 0; i < data.items.length; i++) {
                if (data.items[i].name === name) return data.items[i];
            }
            return null;
        },

        /** Calls listener({status: "loading" | "ready" | "error", data}) whenever the page's state changes. */
        subscribe: function(pageName, listener) {
            var page = entry(pageName);
            page.listeners.push(listener);
            if (page.data) {
                listener({status: "ready", data: page.data});
            }
        },
    };
})();

// ============================================================================
// Virtual grid of cards
// ============================================================================

var ExtraNetworksGrid = (function() {
    "use strict";

    var CONFIG = {
        // Rows kept ready above and below the visible ones.
        OVERSCAN_ROWS: 2,
        // Views (search + sort + favourites filter) whose scroll position is remembered.
        REMEMBERED_VIEWS: 50,
    };

    var instances = {};

    var PREVIEW_ROUTES = /(^|\/)sd_extra_networks\/(thumb|cover-images)\?/;

    function el(tag, className) {
        var element = document.createElement(tag);
        if (className) element.className = className;
        return element;
    }

    /**
     * Removes a row. Previews in it that are still loading are cancelled first: otherwise the
     * server goes on preparing images for rows that were only scrolled past, and the ones that
     * are in view now have to wait for them.
     */
    function discardRow(row) {
        row.querySelectorAll("img.preview").forEach(function(img) {
            if (!img.complete) {
                img.onerror = null;
                img.removeAttribute("src");
            }
        });
        row.remove();
    }

    /**
     * Text that is the same for as long as the card of an item would be the same. Made on first
     * use and kept with the item; whatever changes an item in place has to clear `item.cardKey`.
     */
    function cardKey(item) {
        if (item.cardKey === undefined) {
            item.cardKey = JSON.stringify([
                item.name,
                item.filename,
                item.preview,
                item.description,
                item.search_terms,
                item.search_only,
                item.sort_keys,
                item.has_metadata,
                item.usage_count,
                item.last_used,
                item.favorite,
                item.onclick,
                item.prompt,
                item.negative_prompt,
            ]);
        }
        return item.cardKey;
    }

    /** Stops the preview of a card that is not needed anymore from loading. */
    function cancelPreview(card) {
        var img = card.querySelector("img.preview");
        if (img && !img.complete) {
            img.onerror = null;
            img.removeAttribute("src");
        }
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

    // Sort keys whose natural order is "largest first": the most used and the most recently used on top.
    var LARGEST_FIRST = {usage_count: true, last_used: true};

    function compareBy(sortKey, descending) {
        var direction = (descending ? -1 : 1) * (LARGEST_FIRST[sortKey] ? -1 : 1);

        return function(a, b) {
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

            // equal items keep their original order, whatever the direction
            return direction * result || a.index - b.index;
        };
    }

    /**
     * Splits what was typed into the search field into the words that all have to be found.
     * "Quotes" keep words together: `ink "series a"` -> ["ink", "series a"].
     */
    function searchWords(text) {
        var words = [];
        var re = /"([^"]*)"?|(\S+)/g;
        var match;
        while ((match = re.exec(text)) !== null) {
            var word = match[1] !== undefined ? match[1] : match[2];
            if (word) words.push(word);
        }
        return words;
    }

    function formatTime(timestamp) {
        var d = new Date(timestamp * 1000);
        var pad = function(n) {
            return (n < 10 ? "0" : "") + n;
        };
        return (
            d.getFullYear() +
            "-" +
            pad(d.getMonth() + 1) +
            "-" +
            pad(d.getDate()) +
            " " +
            pad(d.getHours()) +
            ":" +
            pad(d.getMinutes())
        );
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
            literal: false,
            sortKey: "default",
            descending: false,
            favoritesOnly: false,
            versions: [],
        };
        this.viewKey = null;
        this.scrollPositions = new Map(); // view key -> where that view was scrolled to when it was left
        this.pendingScrollTop = null; // position to go to once the new list has its height

        this.scroller = null; // #<tab>_<page>_cards, the element that scrolls
        this.canvas = null; // has the height of all rows together
        this.status = null; // "Loading...", "Nothing here", ...
        this.rows = new Map(); // row index -> element; only rows near the viewport

        this.columns = 0;
        this.cardWidth = 0;
        this.rowHeight = 0;
        this.measured = false; // card size is known
        this.stale = true; // rendered rows have to be thrown away: the size or the look of the cards changed
        this.dirty = true; // rendered rows may not show the right items; cards that still fit are kept
        this.epoch = null; // what all cards of the page have in common

        this.frame = null;
        this.resizeObserver = null;

        var self = this;
        this.onScroll = function() {
            self.schedule(false);
        };
    }

    Grid.prototype = {
        /**
         * Finds the container and prepares it. Done again if gradio replaced the element.
         */
        mount: function() {
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
            this.resizeObserver = new ResizeObserver(function() {
                self.schedule(true);
            });
            this.resizeObserver.observe(scroller);

            return true;
        },

        /**
         * Receives the state of the page's item list.
         */
        setState: function(state) {
            if (!this.mount()) return;

            this.scroller.classList.toggle(
                "extra-network-cards--loading",
                state.status === "loading"
            );

            if (state.status === "ready") {
                if (state.change === "none" && this.data === state.data) return;
                this.data = state.data;
                this.update();
            } else if (!this.data) {
                this.status.textContent =
                    state.status === "loading" ?
                        "Loading..." :
                        "Could not load the list. Press the refresh button to try again.";
            }
        },

        /**
         * Sets search, sort and the favourites filter. A view that has not been shown before starts at
         * the top; coming back to one (favourites off again, the previous sort, a cleared search, a
         * directory opened earlier) returns to where it was left.
         */
        setView: function(view) {
            var viewKey = JSON.stringify(view);
            if (viewKey === this.viewKey) return;

            var isFirst = this.viewKey === null;
            if (!isFirst && this.scroller) {
                this.scrollPositions.delete(this.viewKey);
                if (this.scroller.scrollTop > 0) {
                    this.scrollPositions.set(
                        this.viewKey,
                        this.scroller.scrollTop
                    );
                    if (this.scrollPositions.size > CONFIG.REMEMBERED_VIEWS) {
                        this.scrollPositions.delete(
                            this.scrollPositions.keys().next().value
                        );
                    }
                }
            }

            this.view = view;
            this.viewKey = viewKey;

            if (!this.data || !this.mount()) return;

            // applied by layout(): the list being left may be shorter than the position to return to
            if (!isFirst) {
                this.pendingScrollTop = this.scrollPositions.get(viewKey) || 0;
            }
            this.update();
        },

        /**
         * Recomputes which items are shown, and in what order, then draws them.
         */
        update: function() {
            if (!this.data || !this.mount()) return;

            var view = this.view;
            var term = view.term.trim();
            var matches;

            if (view.useRegex) {
                try {
                    var regex = new RegExp(term, "i");
                    matches = function(text) {
                        return regex.test(text);
                    };
                } catch (error) {
                    // Invalid regex, treat as no match
                    matches = function() {
                        return false;
                    };
                }
            } else {
                // A directory picked in the tree or with the directory buttons is looked for as it
                // is; text that was typed is taken word by word, and every word has to be there.
                var words = view.literal ?
                    [term.toLowerCase()] :
                    searchWords(term.toLowerCase());
                matches = function(text) {
                    for (var i = 0; i < words.length; i++) {
                        if (text.indexOf(words[i]) === -1) return false;
                    }
                    return true;
                };
            }

            var versions = view.versions || [];

            var items = this.data.items.filter(function(item) {
                if (view.favoritesOnly && !item.favorite) return false;
                if (
                    versions.length &&
                    versions.indexOf(item.sd_version || "") === -1
                ) {
                    return false;
                }
                // items in hidden directories only show up when searched for
                if (item.search_only && term.length < 4) return false;
                return matches(item.searchText);
            });

            items.sort(compareBy(view.sortKey, view.descending));

            this.visibleItems = items;
            this.dirty = true;

            // Options that set the size and the look of every card arrive with the data. Only when
            // they change are the cards measured and built anew; otherwise the cards on screen that
            // still show the right thing stay, and just the ones that differ are replaced.
            var epoch = JSON.stringify([
                this.data.card_style,
                this.data.description_is_html,
                this.data.allow_negative_prompt,
            ]);
            if (epoch !== this.epoch) {
                this.epoch = epoch;
                this.measured = false;
                this.stale = true;
            }

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
        schedule: function(remeasure) {
            if (remeasure) this.measured = false;
            if (this.frame !== null) return;

            var self = this;
            this.frame = requestAnimationFrame(function() {
                self.frame = null;
                self.layout();
            });
        },

        /**
         * Card size comes from CSS and from options, so an invisible card is laid out to learn it.
         */
        measure: function() {
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
        layout: function() {
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

            if (this.pendingScrollTop !== null) {
                this.scroller.scrollTop = this.pendingScrollTop;
                this.pendingScrollTop = null;
            }

            if (this.stale) {
                this.rows.forEach(discardRow);
                this.rows.clear();
                this.stale = false;
                this.dirty = false;
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

            if (this.dirty) {
                this.dirty = false;
                this.reconcile(first, last);
                return;
            }

            var rows = this.rows;
            rows.forEach(function(row, index) {
                if (index < first || index > last) {
                    discardRow(row);
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

        createRow: function(index) {
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
         * Makes rows first..last show the items they should, after the items or their order
         * changed. Cards that are on screen and still right are kept - moved to their new place if
         * need be - so a favourite that is toggled or a count that goes up replaces one card, and
         * a search that narrows the list down does not load the previews of what stays again.
         */
        reconcile: function(first, last) {
            var rows = this.rows;
            var canvas = this.canvas;

            // every card there is now, by what it shows
            var pool = new Map();
            rows.forEach(function(row) {
                for (var i = 0; i < row.children.length; i++) {
                    var card = row.children[i];
                    var list = pool.get(card.cardKey);
                    if (!list) pool.set(card.cardKey, (list = []));
                    list.push(card);
                }
            });

            rows.forEach(function(row, index) {
                if (index < first || index > last) {
                    row.remove(); // its cards may still be taken over by another row
                    rows.delete(index);
                }
            });

            for (var index = first; index <= last; index++) {
                var row = rows.get(index);
                if (!row) {
                    row = el("div", "extra-network-cards-row");
                    row.style.top = index * this.rowHeight + "px";
                    rows.set(index, row);
                    canvas.appendChild(row);
                }

                var start = index * this.columns;
                var end = Math.min(
                    start + this.columns,
                    this.visibleItems.length
                );
                var wanted = [];
                for (var i = start; i < end; i++) {
                    var item = this.visibleItems[i];
                    var existing = pool.get(cardKey(item));
                    wanted.push(
                        existing && existing.length ?
                            existing.shift() :
                            this.createCard(item)
                    );
                }

                var same = row.children.length === wanted.length;
                for (var j = 0; same && j < wanted.length; j++) {
                    same = row.children[j] === wanted[j];
                }
                if (!same) row.replaceChildren.apply(row, wanted);
            }

            // what no row wanted
            pool.forEach(function(list) {
                list.forEach(function(card) {
                    cancelPreview(card);
                    card.remove();
                });
            });
        },

        /**
         * Javascript that runs when the item is chosen.
         */
        onclickFor: function(item) {
            if (item.onclick !== undefined && item.onclick !== null) {
                return item.onclick;
            }

            // prompt and negative_prompt are javascript expressions, evaluated when the card is clicked
            return (
                "cardClicked('" +
                this.tabname +
                "', " +
                item.prompt +
                ", " +
                item.negative_prompt +
                ", " +
                (this.data && this.data.allow_negative_prompt ?
                    "true" :
                    "false") +
                ");"
            );
        },

        /**
         * Does what clicking the item's card does; the card itself may not exist at the moment.
         */
        activate: function(item, event) {
            return new Function("event", this.onclickFor(item)).call(
                null,
                event
            );
        },

        /**
         * Builds the element for one item; same structure as html/extra-networks-card.html.
         */
        createCard: function(item) {
            var data = this.data || {};
            var tabname = this.tabname;
            var pageName = this.pageName;

            var card = el("div", item.favorite ? "card favorite" : "card");
            card.cardKey = cardKey(item);
            if (data.card_style) card.setAttribute("style", data.card_style);
            card.setAttribute("data-name", item.name);
            Object.keys(item.sort_keys || {}).forEach(function(key) {
                card.setAttribute("data-sort-" + key, item.sort_keys[key]);
            });

            card.setAttribute("onclick", this.onclickFor(item));

            if (item.preview) {
                var img = el("img", "preview");
                img.loading = "lazy";
                img.decoding = "async";
                img.onerror = function() {
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

                if (
                    PREVIEW_ROUTES.test(item.preview) &&
                    gradioApp().getElementById(
                        tabname + "_extra_networks_paste_apply"
                    )
                ) {
                    var apply = cardButton(
                        "div",
                        "apply-params-button",
                        "Apply the generation parameters of the preview image to this tab (Ctrl+Z to undo)",
                        "extraNetworksApplyPreviewParams(event, '" +
                            tabname +
                            "')"
                    );
                    apply.setAttribute("data-preview", item.preview);
                    imageButtons.appendChild(apply);
                }
                card.appendChild(imageButtons);
            }

            // In the corner of its own: it stays visible on a favourite, on other cards it shows up while hovering.
            card.appendChild(
                cardButton(
                    "div",
                    "favorite-button",
                    item.favorite ?
                        "Remove from favorites (Shift+H)" :
                        "Add to favorites (Shift+H)",
                    "extraNetworksToggleFavorite(event, '" + pageName + "')"
                )
            );

            var buttons = el("div", "button-row");
            if (item.usage_count > 0) {
                buttons.appendChild(
                    cardButton(
                        "div",
                        "clear-usage-button",
                        "Clear usage count of this card (" +
                            item.usage_count +
                            ")",
                        "extraNetworksClearUsage(event, '" + pageName + "')"
                    )
                );
            }
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
            if (item.usage_count > 0) {
                var usage = el("span", "usage-count");
                usage.textContent = "\u00d7" + item.usage_count;
                usage.title =
                    "Used " +
                    item.usage_count +
                    " time" +
                    (item.usage_count == 1 ? "" : "s") +
                    (item.last_used ?
                        ", last on " + formatTime(item.last_used) :
                        "");
                actions.appendChild(usage);
            }
            var additional = el("div", "additional");
            (item.search_terms || []).forEach(function(term) {
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
        create: function(tabname, pageName) {
            var key = tabname + "_" + pageName;
            if (!instances[key]) {
                instances[key] = new Grid(tabname, pageName);
            }
            return instances[key];
        },

        /** Returns the grid for an id like "txt2img_lora", if there is one. */
        get: function(tabname_full) {
            return instances[tabname_full];
        },
    };
})();

// ============================================================================
// Directory tree, built as it is opened
// ============================================================================

var ExtraNetworksTree = (function() {
    "use strict";

    var states = {}; // "txt2img_lora" -> what the tree in that pane was built from
    var nodes = new WeakMap(); // <ul> of a directory -> its content, until the directory is opened

    /** Same order as natural_sort_key on the server: numbers inside names count as numbers. */
    function naturalCompare(a, b) {
        var as = a.split(/([0-9]+)/);
        var bs = b.split(/([0-9]+)/);
        for (var i = 0; i < Math.min(as.length, bs.length); i++) {
            var x, y;
            if (i % 2) {
                x = parseInt(as[i]);
                y = parseInt(bs[i]);
            } else {
                x = as[i].toLowerCase();
                y = bs[i].toLowerCase();
            }
            if (x !== y) return x < y ? -1 : 1;
        }
        return as.length - bs.length;
    }

    function el(tag, className) {
        var element = document.createElement(tag);
        if (className) element.className = className;
        return element;
    }

    /** Groups the items into nested directories by their tree_path. */
    function buildModel(data) {
        var separator = data.path_separator || "/";
        var root = {dirs: Object.create(null), files: []};

        data.items.forEach(function(item) {
            if (!item.tree_path) return;

            var parts = item.tree_path.split(separator);
            var node = root;
            var path = "";
            for (var i = 0; i < parts.length - 1; i++) {
                path = path ? path + separator + parts[i] : parts[i];
                if (!node.dirs[parts[i]]) {
                    node.dirs[parts[i]] = {
                        name: parts[i],
                        path: path,
                        dirs: Object.create(null),
                        files: [],
                    };
                }
                node = node.dirs[parts[i]];
            }
            node.files.push(item);
        });

        return root;
    }

    /** One line of the tree; same structure as html/extra-networks-tree-button.html. */
    function createContent(tabname, pageName, options) {
        var filterText = el("span");
        filterText.setAttribute("data-filterable-item-text", "");
        filterText.hidden = true;

        var content = el("div", "tree-list-content " + options.subclass);
        content.setAttribute("type", "button");
        content.setAttribute(
            "onclick",
            "extraNetworksTreeOnClick(event, '" +
                tabname +
                "', '" +
                pageName +
                "');"
        );
        content.setAttribute("data-path", options.path);
        content.setAttribute("data-hash", options.hash || "");

        var leadingAction = el(
            "span",
            "tree-list-item-action tree-list-item-action--leading"
        );
        leadingAction.appendChild(el("i", "tree-list-item-action-chevron"));
        content.appendChild(leadingAction);

        var leadingVisual = el(
            "span",
            "tree-list-item-visual tree-list-item-visual--leading"
        );
        leadingVisual.textContent = options.icon;
        content.appendChild(leadingVisual);

        var label = el(
            "span",
            "tree-list-item-label tree-list-item-label--truncate"
        );
        label.textContent = options.label;
        content.appendChild(label);

        content.appendChild(
            el("span", "tree-list-item-visual tree-list-item-visual--trailing")
        );

        var trailingAction = el(
            "span",
            "tree-list-item-action tree-list-item-action--trailing"
        );
        content.appendChild(trailingAction);

        return {
            filterText: filterText,
            content: content,
            trailingAction: trailingAction,
        };
    }

    function createDirItem(tabname, pageName, node) {
        var li = el("li", "tree-list-item tree-list-item--has-subitem");
        li.setAttribute("data-tree-entry-type", "dir");

        var line = createContent(tabname, pageName, {
            subclass: "tree-list-content-dir",
            path: node.path,
            icon: "🗀",
            label: node.name,
        });
        li.appendChild(line.filterText);
        li.appendChild(line.content);

        // Stays empty until the directory is opened.
        var ul = el("ul", "tree-list tree-list--subgroup");
        ul.hidden = true;
        nodes.set(ul, {tabname: tabname, pageName: pageName, node: node});
        li.appendChild(ul);

        return li;
    }

    function createFileItem(tabname, pageName, item) {
        var li = el("li", "tree-list-item tree-list-item--subitem");
        li.setAttribute("data-tree-entry-type", "file");

        var line = createContent(tabname, pageName, {
            subclass: "tree-list-content-file",
            path: item.tree_path,
            hash: item.shorthash,
            icon: "🗎",
            label: item.name,
        });
        line.content.setAttribute("data-name", item.name);

        // The buttons look for the name two levels up, where a card has it.
        line.trailingAction.setAttribute("data-name", item.name);
        var buttons = el("div", "button-row");
        var copyPath = el("div", "copy-path-button card-button");
        copyPath.title = "Copy path to clipboard";
        copyPath.setAttribute("onclick", "extraNetworksCopyCardPath(event)");
        copyPath.setAttribute("data-clipboard-text", item.filename || "");
        buttons.appendChild(copyPath);
        if (item.has_metadata) {
            var metadata = el("div", "metadata-button card-button");
            metadata.title = "Show internal metadata";
            metadata.setAttribute(
                "onclick",
                "extraNetworksRequestMetadata(event, '" + pageName + "')"
            );
            buttons.appendChild(metadata);
        }
        var edit = el("div", "edit-button card-button");
        edit.title = "Edit metadata";
        edit.setAttribute(
            "onclick",
            "extraNetworksEditUserMetadata(event, '" +
                tabname +
                "', '" +
                pageName +
                "')"
        );
        buttons.appendChild(edit);
        line.trailingAction.appendChild(buttons);

        li.appendChild(line.filterText);
        li.appendChild(line.content);

        return li;
    }

    /**
     * Creates the entries of a directory. Happens when it is opened for the first time, so a
     * collapsed directory costs nothing however many files it has.
     */
    function populate(ul) {
        var pending = nodes.get(ul);
        if (!pending) return;
        nodes.delete(ul);

        var node = pending.node;
        var fragment = document.createDocumentFragment();

        // Directories are always displayed before files.
        Object.keys(node.dirs)
            .sort(naturalCompare)
            .forEach(function(name) {
                fragment.appendChild(
                    createDirItem(
                        pending.tabname,
                        pending.pageName,
                        node.dirs[name]
                    )
                );
            });

        node.files
            .slice()
            .sort(function(a, b) {
                return naturalCompare(a.tree_path, b.tree_path);
            })
            .forEach(function(item) {
                fragment.appendChild(
                    createFileItem(pending.tabname, pending.pageName, item)
                );
            });

        ul.appendChild(fragment);
    }

    /** Opens the directories whose paths are given, as far as they still exist. */
    function reopen(ul, expanded) {
        ul.querySelectorAll(
            ":scope > li > .tree-list-content-dir"
        ).forEach(function(content) {
            if (!expanded.has(content.dataset.path)) return;

            var childUl = content.nextElementSibling;
            populate(childUl);
            childUl.hidden = false;
            content.dataset.expanded = "";
            reopen(childUl, expanded);
        });
    }

    /**
     * Shows the tree for a page in a tab. Does nothing if the files are the same as last time.
     */
    function render(tabname, pageName, data) {
        var key = tabname + "_" + pageName;
        var container = gradioApp().getElementById(key + "_tree");
        if (!container) return;

        var signature = data.items
            .map(function(item) {
                return item.tree_path || "";
            })
            .join("\n");
        var state = states[key];
        if (
            state &&
            state.signature === signature &&
            state.list.isConnected
        ) {
            return;
        }

        // what the user had open stays open
        var expanded = new Set();
        var selected = null;
        container
            .querySelectorAll(".tree-list-content-dir")
            .forEach(function(content) {
                if ("expanded" in content.dataset) {
                    expanded.add(content.dataset.path);
                }
                if ("selected" in content.dataset) {
                    selected = content.dataset.path;
                }
            });

        var model = buildModel(data);
        var list = el("ul", "tree-list tree-list--tree");
        nodes.set(list, {tabname: tabname, pageName: pageName, node: model});
        populate(list);
        reopen(list, expanded);

        if (selected !== null) {
            list.querySelectorAll(".tree-list-content-dir").forEach(
                function(content) {
                    if (content.dataset.path === selected) {
                        content.dataset.selected = "";
                    }
                }
            );
        }

        container.textContent = "";
        container.appendChild(list);
        states[key] = {signature: signature, list: list};
    }

    return {
        render: render,
        populate: populate,
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

    // the buttons are only made again when the directories are different
    var signature = JSON.stringify(data.dirs || []);
    if (container.dataset.dirs === signature && container.children.length) {
        return;
    }
    container.dataset.dirs = signature;

    container.textContent = "";
    (data.dirs || []).forEach(function(subdir) {
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

// Base models in the order their filter buttons are shown; names that are not listed follow in alphabetical order.
var extraNetworksVersionOrder = [
    "SD1",
    "SD2",
    "SDXL",
    "Illustrious",
    "Noob",
    "PonyXL",
    "Unknown",
];

/**
 * Fills the base model filter of a page: one button per base model its items are for. Several can
 * be on at once; with none on, everything is shown. Pages whose items are all for the same base
 * model (or do not say) get no buttons.
 */
function extraNetworksRenderVersions(tabname, extra_networks_tabname, data) {
    var tabname_full = tabname + "_" + extra_networks_tabname;
    var container = gradioApp().getElementById(tabname_full + "_extra_versions");
    if (!container) return;

    var found = {};
    (data.items || []).forEach(function(item) {
        if (item.sd_version) found[item.sd_version] = true;
    });
    var versions = Object.keys(found).sort(function(a, b) {
        var ia = extraNetworksVersionOrder.indexOf(a);
        var ib = extraNetworksVersionOrder.indexOf(b);
        if (ia !== ib) {
            return (ia === -1 ? 1000 : ia) - (ib === -1 ? 1000 : ib);
        }
        return a < b ? -1 : a > b ? 1 : 0;
    });
    if (versions.length < 2) versions = [];

    var signature = JSON.stringify(versions);
    if (container.dataset.versions === signature) return;
    container.dataset.versions = signature;

    var enabled = {};
    container
        .querySelectorAll(".extra-network-control--enabled")
        .forEach(function(chip) {
            enabled[chip.dataset.version] = true;
        });
    var hadEnabled = Object.keys(enabled).length > 0;

    container.textContent = "";
    versions.forEach(function(version) {
        var chip = document.createElement("div");
        chip.className =
            "extra-network-control--version" +
            (enabled[version] ? " extra-network-control--enabled" : "");
        chip.dataset.version = version;
        chip.textContent = version;
        chip.addEventListener("click", function() {
            chip.classList.toggle("extra-network-control--enabled");
            applyExtraNetworkFilter(tabname_full);
        });
        container.appendChild(chip);
    });

    // a base model that was filtered for is gone from the list: the filter goes with its button
    if (hadEnabled) applyExtraNetworkFilter(tabname_full);
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

        textarea.addEventListener("focus", function() {
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
        .forEach(function(elem) {
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
            var applyView = function() {
                var activeSortElem = gradioApp().querySelector(
                    "#" +
                        tabname_full +
                        "_controls .extra-network-control--sort.extra-network-control--enabled"
                );

                var favorites = gradioApp().querySelector(
                    "#" + tabname_full + "_extra_favorites"
                );

                var versions = [];
                gradioApp()
                    .querySelectorAll(
                        "#" +
                            tabname_full +
                            "_extra_versions .extra-network-control--version.extra-network-control--enabled"
                    )
                    .forEach(function(chip) {
                        versions.push(chip.dataset.version);
                    });

                grid.setView({
                    term: search.value,
                    useRegex: !!(regexCheckbox && regexCheckbox.checked),
                    // set by a click on a directory; typing anything makes it ordinary search text again
                    literal:
                        search.value !== "" &&
                        search.dataset.literal === search.value,
                    versions: versions,
                    sortKey: activeSortElem ?
                        activeSortElem.dataset.sortkey :
                        "default",
                    descending: sort_dir.dataset.sortdir == "Descending",
                    favoritesOnly: !!(
                        favorites &&
                        favorites.classList.contains(
                            "extra-network-control--enabled"
                        )
                    ),
                });
            };

            search.addEventListener("input", function() {
                // A directory of the tree stays marked as selected only while the search is the one it set.
                var tree = gradioApp().getElementById(tabname_full + "_tree");
                if (tree) {
                    tree.querySelectorAll(
                        ".tree-list-content[data-selected]"
                    ).forEach(function(content) {
                        if (content.dataset.path !== search.value) {
                            delete content.dataset.selected;
                        }
                    });
                }

                applyView();
            });
            if (regexCheckbox) {
                regexCheckbox.addEventListener("change", applyView);
            }

            applyView();

            extraNetworksApplySort[tabname_full] = applyView;
            extraNetworksApplyFilter[tabname_full] = applyView;

            ExtraNetworksData.subscribe(pageName, function(state) {
                grid.setState(state);
                // usage counts and favourites are only shown on the cards
                if (
                    state.status === "ready" &&
                    state.change !== "stats" &&
                    state.change !== "none"
                ) {
                    extraNetworksRenderDirs(tabname, pageName, state.data);
                    extraNetworksRenderVersions(tabname, pageName, state.data);
                    ExtraNetworksTree.render(tabname, pageName, state.data);
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

    extraNetworksApplyPanelMode();

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
        .forEach(function(elem) {
            var targetId = tabname_full + "_controls";
            elem.style.display = elem.id == targetId ? "" : "none";
        });
}

function extraNetworksUnrelatedTabSelected(tabname) {
    extraNetworksMovePromptToTab(tabname, "", false, false);
    extraNetworksShowControlsForPage(tabname, null);
}

// ============================================================================
// Display mode: tabs, or a panel at the side
// ============================================================================

/** "tabs", "right" or "left", from the setting "Extra Networks display". */
function extraNetworksPanelMode() {
    var mode = (window.opts && opts.extra_networks_panel_mode) || "Tabs";
    if (mode.indexOf("right") != -1) return "right";
    if (mode.indexOf("left") != -1) return "left";
    return "tabs";
}

/**
 * Puts the pages of cards into the mode the setting asks for. Can be called any number of times.
 *
 * In tabs mode the search and sort controls of the open page sit in the row of tab buttons. In
 * side panel mode every page keeps its controls at its own top, and CSS shows the open page as a
 * panel fixed to the side while the "Generation" tab stays visible.
 */
function extraNetworksApplyPanelMode() {
    var mode = extraNetworksPanelMode();
    var side = mode != "tabs";

    ["txt2img", "img2img"].forEach(function(tabname) {
        var tabs = gradioApp().getElementById(tabname + "_extra_tabs");
        if (!tabs) return;

        tabs.classList.toggle("extra-networks-side", side);
        tabs.classList.toggle("extra-networks-side--left", mode == "left");

        var controlsDiv = tabs.querySelector(
            ":scope > .tab-nav > .extra-networks-controls-div"
        );

        tabs.querySelectorAll(":scope > .tabitem.extra-page").forEach(
            function(page) {
                var pane = page.querySelector(".extra-network-pane");
                if (!pane) return;

                var tabname_full = pane.id.replace(/_pane$/, "");
                var controls = gradioApp().getElementById(
                    tabname_full + "_controls"
                );
                if (!controls) return;

                if (side) {
                    if (controls.parentElement !== pane) {
                        pane.insertBefore(controls, pane.firstChild);
                    }
                    controls.style.display = "";
                } else if (controlsDiv) {
                    if (controls.parentElement !== controlsDiv) {
                        controlsDiv.insertBefore(controls, null);
                    }
                    controls.style.display =
                        page.style.display != "none" ? "" : "none";
                }

                // what the panel needs on top of the page: a way to close it and an edge to drag
                if (!page.querySelector(":scope > .extra-networks-side-close")) {
                    var close = document.createElement("div");
                    close.className = "extra-networks-side-close";
                    close.title = "Close the panel";
                    close.textContent = "\u00d7";
                    close.addEventListener("click", function() {
                        var first = tabs.querySelector(
                            ":scope > .tab-nav > button"
                        );
                        if (first) first.click();
                    });
                    page.appendChild(close);

                    var resizer = document.createElement("div");
                    resizer.className = "extra-networks-side-resizer";
                    resizer.title = "Drag to resize the panel";
                    resizer.addEventListener(
                        "mousedown",
                        extraNetworksSidePanelResizeStart
                    );
                    page.appendChild(resizer);
                }
            }
        );
    });

    var width = parseInt(localGet("extra_networks_side_width"));
    if (width > 0) {
        document.documentElement.style.setProperty(
            "--extra-networks-side-width",
            width + "px"
        );
    }

    extraNetworksUpdateSidePanelLayout();
}

/**
 * Makes room for the panel beside the page content while a panel is open and visible.
 */
function extraNetworksUpdateSidePanelLayout() {
    var mode = extraNetworksPanelMode();
    var open = false;

    if (mode != "tabs") {
        gradioApp()
            .querySelectorAll(".extra-networks-side > .tabitem.extra-page")
            .forEach(function(page) {
                // an open page of the tab that is on screen
                if (page.getClientRects().length > 0) open = true;
            });
    }

    document.body.classList.toggle(
        "extra-networks-side-open-right",
        open && mode == "right"
    );
    document.body.classList.toggle(
        "extra-networks-side-open-left",
        open && mode == "left"
    );
}

function extraNetworksSidePanelResizeStart(event) {
    event.preventDefault();

    var left = extraNetworksPanelMode() == "left";
    var onMove = function(moveEvent) {
        var width = left ?
            moveEvent.clientX :
            window.innerWidth - moveEvent.clientX;
        width = Math.max(
            320,
            Math.min(width, Math.round(window.innerWidth * 0.7))
        );
        document.documentElement.style.setProperty(
            "--extra-networks-side-width",
            width + "px"
        );
        localSet("extra_networks_side_width", width);
    };
    var onUp = function() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("extra-networks-side-resizing");
    };

    document.body.classList.add("extra-networks-side-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

// Panels open and close with the tab buttons, and are only on screen with their main tab.
document.addEventListener("click", function(event) {
    if (event.target.closest && event.target.closest(".tab-nav")) {
        setTimeout(extraNetworksUpdateSidePanelLayout, 0);
        setTimeout(extraNetworksUpdateSidePanelLayout, 150);
    }
});
window.addEventListener("resize", extraNetworksUpdateSidePanelLayout);

onOptionsChanged(extraNetworksApplyPanelMode);

function extraNetworksTabSelected(
    tabname,
    id,
    showPrompt,
    showNegativePrompt,
    tabname_full
) {
    if (extraNetworksPanelMode() != "tabs") {
        // the generation tab stays visible beside the panel, and the prompts stay with it
        extraNetworksMovePromptToTab(tabname, "", false, false);
    } else {
        extraNetworksMovePromptToTab(
            tabname,
            id,
            showPrompt,
            showNegativePrompt
        );
    }
    extraNetworksShowControlsForPage(tabname, tabname_full);
    extraNetworksUpdateSidePanelLayout();

    // usage counts change while generating; opening the page is when they get looked at
    if (tabname_full) {
        ExtraNetworksData.refreshStats(tabname_full.slice(tabname.length + 1));
    }
}

function applyExtraNetworkFilter(tabname_full) {
    var doFilter = function() {
        var applyFunction = extraNetworksApplyFilter[tabname_full];
        if (applyFunction) {
            applyFunction(true);
        }
    };
    setTimeout(doFilter, 1);
}

function applyExtraNetworkSort(tabname_full) {
    var doSort = function() {
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

// The weight may be negative: <lora:name:-0.5>
var re_extranet = /<([^:^>]+:[^:]+):-?[\d.]+>(.*)/s;
var re_extranet_g = /<([^:^>]+:[^:]+):-?[\d.]+>/g;
var re_extranet_neg = /\(([^:^>]+:[\d.]+)\)/;
var re_extranet_g_neg = /\(([^:^>]+:[\d.]+)\)/g;

function extraNetworksEscapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
            function(found, net, pos) {
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
        // Plain text such as the name of an embedding. It is looked for literally - names contain
        // characters like "(", "+" and "." - and as a whole word, so that it is not cut out of a longer one.
        newTextareaText = textarea.value.replaceAll(
            new RegExp(
                `((?:${extraNetworksEscapeRegExp(extraTextBeforeNet)})?(?<!\\w)${extraNetworksEscapeRegExp(
                    text
                )}(?!\\w))`,
                "g"
            ),
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
        var textarea = allowNegativePrompt ?
            activePromptTextarea[tabname] :
            gradioApp().querySelector(
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
    var text = button.classList.contains("search-all") ?
        "" :
        button.textContent.trim();

    // the name of a directory is looked for as a whole, spaces included
    searchTextarea.dataset.literal = text;
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
            // the entries of a directory are created when it is first opened
            ExtraNetworksTree.populate(_ul);
            _ul.removeAttribute("hidden");
            _btn.dataset.expanded = "";
        } else {
            _ul.setAttribute("hidden", "");
            delete _btn.dataset.expanded;
        }
    }

    function _remove_selected_from_all() {
        // Only in the tree that was clicked: the other panes keep their own search, and so their selection.
        var tree = btn.closest(".extra-network-tree") || document;
        var sels = tree.querySelectorAll("div.tree-list-content");
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
        // the path of a directory is looked for as a whole, spaces included
        search_input_elem.dataset.literal = _search_text;
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
    // Handle file click - does what clicking the card does. The card is looked up in the data:
    // it only exists as an element while it is scrolled into view.
    var grid = ExtraNetworksGrid.get(tabname + "_" + extra_networks_tabname);
    var item = ExtraNetworksData.getItem(
        extra_networks_tabname,
        btn.dataset.name
    );
    if (grid && item) {
        grid.activate(item, event);
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
        .forEach(function(x) {
            x.classList.remove("extra-network-control--enabled");
        });

    self.classList.add("extra-network-control--enabled");

    applyExtraNetworkSort(tabname + "_" + extra_networks_tabname);

    if (
        self.dataset.sortkey == "usage_count" ||
        self.dataset.sortkey == "last_used"
    ) {
        // counted on the server while generating; get the current numbers
        ExtraNetworksData.refreshStats(extra_networks_tabname);
    }
}

function extraNetworksControlFavoritesOnClick(
    event,
    tabname,
    extra_networks_tabname
) {
    event.currentTarget.classList.toggle("extra-network-control--enabled");
    applyExtraNetworkFilter(tabname + "_" + extra_networks_tabname);
}

function extraNetworksPostJson(url, body, handler) {
    fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
    })
        .then(function(response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
        })
        .then(handler)
        .catch(function(error) {
            console.error("Extra Networks:", url, error);
        });
}

/**
 * Controls button: forgets the usage counts of all cards of the page. Favourites are kept.
 * The server keeps the previous numbers in extra_networks_stats.json.bak.
 */
function extraNetworksControlClearUsageOnClick(
    event,
    tabname,
    extra_networks_tabname
) {
    // All cards of the page at once: asked first.
    var data = ExtraNetworksData.get(extra_networks_tabname);
    var used = data ?
        data.items.filter(function(item) {
            return item.usage_count > 0;
        }).length :
        0;
    if (
        !confirm(
            "Clear the usage counts of all cards on this page (" +
                used +
                " with a count)?\nFavorites are kept."
        )
    ) {
        return;
    }

    extraNetworksPostJson(
        "./sd_extra_networks/clear-usage",
        {page: extra_networks_tabname, name: ""},
        function(data) {
            ExtraNetworksData.applyStats(
                extra_networks_tabname,
                data.stats || {},
                true
            );
        }
    );
}

/**
 * Card button: forgets the usage count of this card only.
 */
function extraNetworksClearUsage(event, extra_networks_tabname) {
    event.stopPropagation();

    var name =
        event.target.parentElement.parentElement.getAttribute("data-name");

    // 確認ダイアログ(既定では無効)。有効にする場合は次の3行のコメントを外してください。
    // if (!confirm("Clear the usage count of " + name + "?")) {
    //     return;
    // }

    extraNetworksPostJson(
        "./sd_extra_networks/clear-usage",
        {page: extra_networks_tabname, name: name},
        function(data) {
            ExtraNetworksData.applyStats(
                extra_networks_tabname,
                data.stats || {},
                true
            );
        }
    );
}

/**
 * Card button: adds the card to the favourites, or removes it.
 */
function extraNetworksToggleFavorite(event, extra_networks_tabname) {
    event.stopPropagation();

    extraNetworksToggleFavoriteByName(
        extra_networks_tabname,
        event.target.closest(".card").getAttribute("data-name")
    );
}

function extraNetworksToggleFavoriteByName(extra_networks_tabname, name) {
    var item = ExtraNetworksData.getItem(extra_networks_tabname, name);
    if (!item) return;

    extraNetworksPostJson(
        "./sd_extra_networks/favorite",
        {page: extra_networks_tabname, name: name, favorite: !item.favorite},
        function(data) {
            var stats = {};
            stats[name] = data.stats;
            ExtraNetworksData.applyStats(extra_networks_tabname, stats, false);
        }
    );
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

    // The "Dirs" style has directory buttons instead of a tree; the class toggled above hides them.
    if (!tree) return;

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
        .map(function(k) {
            return encodeURIComponent(k) + "=" + encodeURIComponent(data[k]);
        })
        .join("&");
    xhr.open("GET", url + "?" + args, true);

    xhr.onreadystatechange = function() {
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
    // First of all: the click is not meant for the card, whatever becomes of the copy.
    event.stopPropagation();

    var text = event.target.getAttribute("data-clipboard-text");

    // For pages without the clipboard API: it only exists on https and on localhost, not when the
    // UI is opened from another device over plain http.
    var copyWithSelection = function() {
        var textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand("copy");
        } finally {
            document.body.removeChild(textarea);
        }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(copyWithSelection);
    } else {
        copyWithSelection();
    }
}

function extraNetworksRequestMetadata(event, extraPage) {
    var showError = function() {
        extraNetworksShowMetadata("there was an error getting metadata");
    };

    var cardName =
        event.target.parentElement.parentElement.getAttribute("data-name");

    requestGet(
        "./sd_extra_networks/metadata",
        {page: extraPage, item: cardName},
        function(data) {
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
    var pageName = page.replace(/ /g, "_");
    var reloadPage = function() {
        ExtraNetworksData.load(pageName, true);
    };

    requestGet(
        "./sd_extra_networks/get-single-card",
        {page: page, tabname: tabname, name: name},
        function(data) {
            // Only this item changes; every tab showing the page redraws its visible cards.
            if (
                !data ||
                !("item" in data) ||
                !ExtraNetworksData.updateItem(pageName, name, data.item)
            ) {
                reloadPage();
            }
        },
        reloadPage
    );
}

// ============================================================================
// Applying the parameters of a preview image, with undo
// ============================================================================

// tab name -> true while Ctrl+Z would take the last "apply" back
var extraNetworksPasteUndoArmed = {};

function extraNetworksToast(text, actionLabel, action) {
    var toast = document.getElementById("extra-networks-toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "extra-networks-toast";
        document.body.appendChild(toast);
    }

    toast.textContent = text;
    if (actionLabel) {
        var button = document.createElement("button");
        button.textContent = actionLabel;
        button.addEventListener("click", action);
        toast.appendChild(button);
    }

    toast.classList.add("extra-networks-toast--shown");
    clearTimeout(toast.hideTimer);
    toast.hideTimer = setTimeout(extraNetworksHideToast, 8000);
}

function extraNetworksHideToast() {
    var toast = document.getElementById("extra-networks-toast");
    if (toast) toast.classList.remove("extra-networks-toast--shown");
}

/**
 * Card button: fills the tab's fields from the generation parameters of the card's preview image,
 * the same as sending that image to the tab from PNG Info.
 */
function extraNetworksApplyPreviewParams(event, tabname) {
    event.stopPropagation();

    var button = event.target.closest(".card-button");
    var source = gradioApp().querySelector(
        "#" + tabname + "_extra_networks_paste_source textarea, #" +
            tabname + "_extra_networks_paste_source input"
    );
    var apply = gradioApp().getElementById(
        tabname + "_extra_networks_paste_apply"
    );
    if (!button || !source || !apply) return;

    source.value = button.getAttribute("data-preview");
    updateInput(source);
    apply.click();
}

function extraNetworksUndoPreviewParams(tabname) {
    var undo = gradioApp().getElementById(
        tabname + "_extra_networks_paste_undo"
    );
    if (!undo || !extraNetworksPasteUndoArmed[tabname]) return;

    extraNetworksPasteUndoArmed[tabname] = false;
    undo.click();
}

/**
 * Called by the server side once an apply or an undo is through.
 */
function extraNetworksPasteFinished(tabname, status) {
    if (status == "applied") {
        extraNetworksPasteUndoArmed[tabname] = true;
        extraNetworksToast(
            "Parameters of the preview image applied. Ctrl+Z takes it back.",
            "Undo",
            function() {
                extraNetworksUndoPreviewParams(tabname);
            }
        );
    } else if (status == "undone") {
        extraNetworksPasteUndoArmed[tabname] = false;
        extraNetworksToast("Previous parameters restored.");
    } else {
        extraNetworksToast(
            "The preview image has no generation parameters."
        );
    }
}

function extraNetworksVisibleGenerationTab() {
    var names = ["txt2img", "img2img"];
    for (var i = 0; i < names.length; i++) {
        var tab = gradioApp().getElementById("tab_" + names[i]);
        if (tab && tab.style.display != "none") return names[i];
    }
    return null;
}

// Ctrl+Z right after applying takes the whole apply back, wherever the focus is.
window.addEventListener(
    "keydown",
    function(event) {
        if (
            !(event.ctrlKey || event.metaKey) ||
            event.shiftKey ||
            event.altKey ||
            (event.key != "z" && event.key != "Z")
        ) {
            return;
        }

        var tabname = extraNetworksVisibleGenerationTab();
        if (!tabname || !extraNetworksPasteUndoArmed[tabname]) return;

        event.preventDefault();
        event.stopPropagation();
        extraNetworksUndoPreviewParams(tabname);
    },
    true
);

// Once the user changes something by hand, Ctrl+Z belongs to that edit again.
["input", "change"].forEach(function(type) {
    window.addEventListener(
        type,
        function(event) {
            if (!event.isTrusted) return;

            ["txt2img", "img2img"].forEach(function(tabname) {
                if (!extraNetworksPasteUndoArmed[tabname]) return;

                var tab = gradioApp().getElementById("tab_" + tabname);
                if (tab && tab.contains(event.target)) {
                    extraNetworksPasteUndoArmed[tabname] = false;
                    extraNetworksHideToast();
                }
            });
        },
        true
    );
});

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

window.addEventListener("keydown", function(event) {
    if (event.key == "Escape") {
        closePopup();
    }
});

// ============================================================================
// Keyboard shortcuts of the card pages
// ============================================================================

/**
 * The page of cards that is on screen: {tabname, pageName, tabnameFull, element}, or null.
 * In tabs mode that is the open Lora / Checkpoints / ... tab, in side panel mode the open panel.
 */
function extraNetworksVisiblePage() {
    var tabname = extraNetworksVisibleGenerationTab();
    if (!tabname) return null;

    var pages = gradioApp().querySelectorAll(
        "#" + tabname + "_extra_tabs > .tabitem.extra-page"
    );
    for (var i = 0; i < pages.length; i++) {
        if (pages[i].getClientRects().length > 0) {
            return {
                tabname: tabname,
                pageName: pages[i].id.slice(tabname.length + 1),
                tabnameFull: pages[i].id,
                element: pages[i],
            };
        }
    }
    return null;
}

/** True while the key belongs to something the user is writing in. */
function extraNetworksIsTyping(event) {
    var target =
        (event.composedPath && event.composedPath()[0]) || event.target;
    if (!target || !target.tagName) return false;

    if (target.isContentEditable) return true;
    if (target.tagName == "TEXTAREA" || target.tagName == "SELECT") return true;

    return (
        target.tagName == "INPUT" &&
        !/^(checkbox|radio|button|range|submit|reset)$/i.test(target.type)
    );
}

// H: favourites only <-> all cards, for the page of cards that is open.
// Shift+H: adds the card under the mouse pointer to the favourites, or removes it.
window.addEventListener("keydown", function(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (event.key != "h" && event.key != "H") return;
    if (extraNetworksIsTyping(event)) return;

    // a popup (metadata editor) or the full page image viewer is in front of the cards
    if (globalPopup && globalPopup.style.display != "none") return;
    var lightbox = gradioApp().getElementById("lightboxModal");
    if (lightbox && lightbox.style.display && lightbox.style.display != "none") {
        return;
    }

    var page = extraNetworksVisiblePage();
    if (!page) return;

    if (event.shiftKey) {
        var card = page.element.querySelector(".card:hover");
        if (!card) return;
        extraNetworksToggleFavoriteByName(
            page.pageName,
            card.getAttribute("data-name")
        );
    } else {
        var favorites = gradioApp().getElementById(
            page.tabnameFull + "_extra_favorites"
        );
        if (!favorites) return;
        favorites.click();
    }

    event.preventDefault();
});

// ============================================================================
// UI Initialization
// ============================================================================

var uiAfterScriptsCallbacks = [];
var uiAfterScriptsTimeout = null;
var executedAfterScripts = false;

function scheduleAfterScriptsCallbacks() {
    clearTimeout(uiAfterScriptsTimeout);
    uiAfterScriptsTimeout = setTimeout(function() {
        executeCallbacks(uiAfterScriptsCallbacks);
    }, 200);
}

onUiLoaded(function() {
    var mutationObserver = null;

    var check = function() {
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
