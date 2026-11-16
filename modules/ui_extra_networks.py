import functools
import os.path
import re
import threading
import urllib.parse
from base64 import b64decode
from io import BytesIO
from pathlib import Path
from typing import Optional, Union
from dataclasses import dataclass

from modules import shared, ui_extra_networks_user_metadata, ui_extra_networks_thumbnails, errors, extra_networks, util
from modules.images import read_info_from_image, save_image_with_geninfo
import gradio as gr
import json
import html
from fastapi.exceptions import HTTPException
from PIL import Image

from modules.infotext_utils import image_from_url_text

extra_pages = []
allowed_dirs = set()
default_allowed_preview_extensions = ["png", "jpg", "jpeg", "webp", "gif"]

@functools.cache
def allowed_preview_extensions_with_extra(extra_extensions=None):
    return set(default_allowed_preview_extensions) | set(extra_extensions or [])


def allowed_preview_extensions():
    return allowed_preview_extensions_with_extra((shared.opts.samples_format, ))


@dataclass
class ExtraNetworksItem:
    """Wrapper for dictionaries representing ExtraNetworks items."""
    item: dict


def get_tree(paths: Union[str, list[str]], items: dict[str, ExtraNetworksItem]) -> dict:
    """Recursively builds a directory tree.

    Args:
        paths: Path or list of paths to directories. These paths are treated as roots from which
            the tree will be built.
        items: A dictionary associating filepaths to an ExtraNetworksItem instance.

    Returns:
        The result directory tree.
    """
    if isinstance(paths, (str,)):
        paths = [paths]

    def _get_tree(_paths: list[str], _root: str):
        _res = {}
        for path in _paths:
            relpath = os.path.relpath(path, _root)
            if os.path.isdir(path):
                dir_items = os.listdir(path)
                # Ignore empty directories.
                if not dir_items:
                    continue
                dir_tree = _get_tree([os.path.join(path, x) for x in dir_items], _root)
                # We only want to store non-empty folders in the tree.
                if dir_tree:
                    _res[relpath] = dir_tree
            else:
                if path not in items:
                    continue
                # Add the ExtraNetworksItem to the result.
                _res[relpath] = items[path]
        return _res

    res = {}
    # Handle each root directory separately.
    # Each root WILL have a key/value at the root of the result dict though
    # the value can be an empty dict if the directory is empty. We want these
    # placeholders for empty dirs so we can inform the user later.
    for path in paths:
        root = os.path.dirname(path)
        relpath = os.path.relpath(path, root)
        # Wrap the path in a list since that is what the `_get_tree` expects.
        res[relpath] = _get_tree([path], root)
        if res[relpath]:
            # We need to pull the inner path out one for these root dirs.
            res[relpath] = res[relpath][relpath]

    return res

def register_page(page):
    """registers extra networks page for the UI; recommend doing it in on_before_ui() callback for extensions"""

    extra_pages.append(page)
    allowed_dirs.clear()
    allowed_dirs.update(set(sum([x.allowed_directories_for_previews() for x in extra_pages], [])))


def get_page(name: str):
    """Finds a registered page by its name or by the name of its tab."""
    return next(iter([x for x in extra_pages if name in (x.name, x.extra_networks_tabname)]), None)


def check_preview_file(filename: str):
    """Raises unless the file is a preview image that the UI is allowed to read."""
    if not os.path.isfile(filename):
        raise HTTPException(status_code=404, detail="File not found")

    if not any(Path(x).absolute() in Path(filename).absolute().parents for x in allowed_dirs):
        raise ValueError(f"File cannot be fetched: {filename}. Must be in one of directories registered by extra pages.")

    ext = os.path.splitext(filename)[1].lower()[1:]
    if ext not in allowed_preview_extensions():
        raise ValueError(f"File cannot be fetched: {filename}. Extensions allowed: {allowed_preview_extensions()}.")


def fetch_file(filename: str = "", full: bool = False, mtime: str = ""):
    """Serves a preview image.

    Cards get a small cached JPEG that still carries the generation parameters of the original
    (see ui_extra_networks_thumbnails); `full=1` asks for the original file.
    """
    from starlette.responses import FileResponse

    check_preview_file(filename)

    # links made by link_preview() change together with the file, so the browser can keep the response for good
    cache_headers = ui_extra_networks_thumbnails.IMMUTABLE_CACHE_HEADERS if mtime else {}

    if not full:
        thumbnail = ui_extra_networks_thumbnails.thumbnail_for_file(filename)
        if thumbnail is not None:
            return FileResponse(thumbnail, media_type="image/jpeg", headers={**cache_headers})

    return FileResponse(filename, headers={"Accept-Ranges": "bytes", **cache_headers})


def get_cover_image(page: str = "", item: str = "", index: int = 0):
    """Returns (page, raw bytes) of a cover image embedded into a model file."""
    page = get_page(page)
    if page is None:
        raise HTTPException(status_code=404, detail="File not found")

    metadata = page.metadata.get(item)
    if metadata is None:
        raise HTTPException(status_code=404, detail="File not found")

    cover_images = json.loads(metadata.get('ssmd_cover_images') or '[]')
    image = cover_images[index] if index < len(cover_images) else None
    if not image:
        raise HTTPException(status_code=404, detail="File not found")

    try:
        return page, b64decode(image)
    except Exception as err:
        raise ValueError(f"File cannot be fetched: {item}. Failed to load cover image.") from err


def fetch_cover_images(page: str = "", item: str = "", index: int = 0, full: bool = False, mtime: str = ""):
    from starlette.responses import FileResponse, Response

    page, data = get_cover_image(page, item, index)
    cache_headers = ui_extra_networks_thumbnails.IMMUTABLE_CACHE_HEADERS if mtime else {}

    if not full:
        model_filename = page.items.get(item, {}).get("filename") or f"{page.name}/{item}"
        thumbnail = ui_extra_networks_thumbnails.thumbnail_for_bytes(
            identity=f"{model_filename}|cover|{index}",
            version=f"{mtime}|{len(data)}",
            data=data,
        )
        if thumbnail is not None:
            return FileResponse(thumbnail, media_type="image/jpeg", headers={**cache_headers})

    try:
        with Image.open(BytesIO(data)) as image:
            media_type = image.get_format_mimetype()
    except Exception as err:
        raise ValueError(f"File cannot be fetched: {item}. Failed to load cover image.") from err

    return Response(content=data, media_type=media_type, headers={**cache_headers})


def load_preview_for_pnginfo(source: str):
    """Turns the preview link of a card into a value for PNG Info's image component.

    The original image is used, not the thumbnail. Files are handed over as a path so that gradio
    passes them on byte for byte, the same as if the user had uploaded them.
    """
    try:
        parsed = urllib.parse.urlparse(source or "")
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        route = parsed.path.rsplit("/", 1)[-1]

        if route == "thumb":
            filename = query.get("filename", "")
            check_preview_file(filename)
            return filename

        if route == "cover-images":
            _, data = get_cover_image(query.get("page", ""), query.get("item", ""), int(query.get("index", 0)))
            image = Image.open(BytesIO(data))
            image.load()

            # gradio re-encodes PIL images as PNG and keeps text chunks only; parameters stored in EXIF would get lost
            geninfo, _ = read_info_from_image(image)
            if geninfo and not isinstance(image.info.get("parameters"), str):
                image.info["parameters"] = geninfo

            return image

        raise ValueError(f"not a preview link: {source}")
    except Exception as e:
        errors.display(e, "sending extra network preview to PNG Info")
        return gr.update()


def get_metadata(page: str = "", item: str = ""):
    from starlette.responses import JSONResponse

    page = get_page(page)
    if page is None:
        return JSONResponse({})

    metadata = page.metadata.get(item)
    if metadata is None:
        return JSONResponse({})

    metadata = {i:metadata[i] for i in metadata if i != 'ssmd_cover_images'}  # those are cover images, and they are too big to display in UI as text

    return JSONResponse({"metadata": json.dumps(metadata, indent=4, ensure_ascii=False)})


re_tabname = re.compile(r"^[A-Za-z0-9_]+$")


def check_tabname(tabname: str):
    """tabname ends up inside generated HTML and JS, so only plain identifiers are accepted."""
    if not re_tabname.match(tabname or ""):
        raise HTTPException(status_code=400, detail="Invalid tabname")


def get_items(page: str = ""):
    """Data for all cards of a page. The browser builds the cards itself, and only those that are on screen."""
    from starlette.responses import JSONResponse

    page = get_page(page)
    if page is None:
        raise HTTPException(status_code=404, detail="Page not found")

    return JSONResponse(page.create_items_data())


def get_single_card(page: str = "", tabname: str = "", name: str = ""):
    from starlette.responses import JSONResponse

    check_tabname(tabname)

    page = get_page(page)
    if page is None:
        raise HTTPException(status_code=404, detail="Page not found")

    try:
        item = page.create_item(name, enable_filter=False)
        if item is not None:
            page.items[name] = item
    except Exception as e:
        errors.display(e, "creating item for extra network")
        item = page.items.get(name)

    if item is None:
        # no such item (anymore); the browser reloads the whole list when it gets this
        raise HTTPException(status_code=404, detail="Item not found")

    page.read_user_metadata(item, use_cache=False)
    item_html = page.create_item_html(tabname, item, shared.html("extra-networks-card.html"))

    # "item" is what the cards are built from; "html" is kept for other users of this endpoint
    return JSONResponse({"html": item_html, "item": page.create_item_data(item)})


def add_pages_to_demo(app):
    app.add_api_route("/sd_extra_networks/thumb", fetch_file, methods=["GET"])
    app.add_api_route("/sd_extra_networks/cover-images", fetch_cover_images, methods=["GET"])
    app.add_api_route("/sd_extra_networks/metadata", get_metadata, methods=["GET"])
    app.add_api_route("/sd_extra_networks/items", get_items, methods=["GET"])
    app.add_api_route("/sd_extra_networks/get-single-card", get_single_card, methods=["GET"])


def quote_js(s: str):
    return json.dumps(s, ensure_ascii=False)


class ExtraNetworksPage:
    def __init__(self, title):
        self.title = title
        self.name = title.lower()
        # This is the actual name of the extra networks tab (not txt2img/img2img).
        self.extra_networks_tabname = self.name.replace(" ", "_")
        self.allow_prompt = True
        self.allow_negative_prompt = False
        self.metadata = {}
        self.items = {}
        self.items_lock = threading.RLock()
        self.lister = util.MassFileLister()
        # HTML Templates
        self.pane_tpl = shared.html("extra-networks-pane.html")
        self.pane_content_tree_tpl = shared.html("extra-networks-pane-tree.html")
        self.pane_content_dirs_tpl = shared.html("extra-networks-pane-dirs.html")
        self.card_tpl = shared.html("extra-networks-card.html")
        self.btn_tree_tpl = shared.html("extra-networks-tree-button.html")
        self.btn_copy_path_tpl = shared.html("extra-networks-copy-path-button.html")
        self.btn_metadata_tpl = shared.html("extra-networks-metadata-button.html")
        self.btn_edit_item_tpl = shared.html("extra-networks-edit-item-button.html")

    def refresh(self):
        pass

    def read_user_metadata(self, item, use_cache=True):
        filename = item.get("filename", None)
        metadata = extra_networks.get_user_metadata(filename, lister=self.lister if use_cache else None)

        desc = metadata.get("description", None)
        if desc is not None:
            item["description"] = desc

        item["user_metadata"] = metadata

    def link_preview(self, filename):
        quoted_filename = urllib.parse.quote(filename.replace('\\', '/'))
        mtime, _ = self.lister.mctime(filename)
        # `t` only makes the link change together with the thumbnail settings
        return f"./sd_extra_networks/thumb?filename={quoted_filename}&mtime={mtime}&t={ui_extra_networks_thumbnails.settings_signature()}"

    def search_terms_from_path(self, filename, possible_directories=None):
        abspath = os.path.abspath(filename)
        for parentdir in (possible_directories if possible_directories is not None else self.allowed_directories_for_previews()):
            parentdir = os.path.dirname(os.path.abspath(parentdir))
            if abspath.startswith(parentdir):
                return os.path.relpath(abspath, parentdir)

        return ""

    def create_item_html(
        self,
        tabname: str,
        item: dict,
        template: Optional[str] = None,
    ) -> Union[str, dict]:
        """Generates HTML for a single ExtraNetworks Item.

        Args:
            tabname: The name of the active tab.
            item: Dictionary containing item information.
            template: Optional template string to use.

        Returns:
            If a template is passed: HTML string generated for this item.
                Can be empty if the item is not meant to be shown.
            If no template is passed: A dictionary containing the generated item's attributes.
        """
        preview = item.get("preview", None)
        style_height = f"height: {shared.opts.extra_networks_card_height}px;" if shared.opts.extra_networks_card_height else ''
        style_width = f"width: {shared.opts.extra_networks_card_width}px;" if shared.opts.extra_networks_card_width else ''
        style_font_size = f"font-size: {shared.opts.extra_networks_card_text_scale*100}%;"
        card_style = style_height + style_width + style_font_size
        background_image = f'<img src="{html.escape(preview)}" class="preview" loading="lazy">' if preview else ''

        onclick = item.get("onclick", None)
        if onclick is None:
            # Don't quote prompt/neg_prompt since they are stored as js strings already.
            onclick_js_tpl = "cardClicked('{tabname}', {prompt}, {neg_prompt}, {allow_neg});"
            onclick = onclick_js_tpl.format(
                **{
                    "tabname": tabname,
                    "prompt": item["prompt"],
                    "neg_prompt": item.get("negative_prompt", "''"),
                    "allow_neg": str(self.allow_negative_prompt).lower(),
                }
            )
            onclick = html.escape(onclick)

        btn_copy_path = self.btn_copy_path_tpl.format(**{"filename": item["filename"]})
        btn_metadata = ""
        metadata = item.get("metadata")
        if metadata:
            btn_metadata = self.btn_metadata_tpl.format(
                **{
                    "extra_networks_tabname": self.extra_networks_tabname,
                }
            )
        btn_edit_item = self.btn_edit_item_tpl.format(
            **{
                "tabname": tabname,
                "extra_networks_tabname": self.extra_networks_tabname,
            }
        )

        # if this is true, the item must not be shown in the default view, and must instead only be
        # shown when searching for it
        search_only = self.is_search_only(item)

        if search_only and shared.opts.extra_networks_hidden_models == "Never":
            return ""

        sort_keys = " ".join(
            [
                f'data-sort-{k}="{html.escape(str(v))}"'
                for k, v in item.get("sort_keys", {}).items()
            ]
        ).strip()

        search_terms_html = ""
        search_term_template = "<span class='hidden {class}'>{search_term}</span>"
        for search_term in item.get("search_terms", []):
            search_terms_html += search_term_template.format(
                **{
                    "class": f"search_terms{' search_only' if search_only else ''}",
                    "search_term": search_term,
                }
            )

        description = (item.get("description", "") or "" if shared.opts.extra_networks_card_show_desc else "")
        if not shared.opts.extra_networks_card_description_is_html:
            description = html.escape(description)

        # Some items here might not be used depending on HTML template used.
        args = {
            "background_image": background_image,
            "card_clicked": onclick,
            "copy_path_button": btn_copy_path,
            "description": description,
            "edit_button": btn_edit_item,
            "local_preview": quote_js(item["local_preview"]),
            "metadata_button": btn_metadata,
            "name": html.escape(item["name"]),
            "prompt": item.get("prompt", None),
            "save_card_preview": html.escape(f"return saveCardPreview(event, '{tabname}', '{item['local_preview']}');"),
            "search_only": " search_only" if search_only else "",
            "search_terms": search_terms_html,
            "sort_keys": sort_keys,
            "style": card_style,
            "tabname": tabname,
            "extra_networks_tabname": self.extra_networks_tabname,
        }

        if template:
            return template.format(**args)
        else:
            return args

    def create_tree_dir_item_html(
        self,
        tabname: str,
        dir_path: str,
        content: Optional[str] = None,
    ) -> Optional[str]:
        """Generates HTML for a directory item in the tree.

        The generated HTML is of the format:
        ```html
        <li class="tree-list-item tree-list-item--has-subitem">
            <div class="tree-list-content tree-list-content-dir"></div>
            <ul class="tree-list tree-list--subgroup">
                {content}
            </ul>
        </li>
        ```

        Args:
            tabname: The name of the active tab.
            dir_path: Path to the directory for this item.
            content: Optional HTML string that will be wrapped by this <ul>.

        Returns:
            HTML formatted string.
        """
        if not content:
            return None

        btn = self.btn_tree_tpl.format(
            **{
                "search_terms": "",
                "subclass": "tree-list-content-dir",
                "tabname": tabname,
                "extra_networks_tabname": self.extra_networks_tabname,
                "onclick_extra": "",
                "data_path": dir_path,
                "data_hash": "",
                "action_list_item_action_leading": "<i class='tree-list-item-action-chevron'></i>",
                "action_list_item_visual_leading": "🗀",
                "action_list_item_label": os.path.basename(dir_path),
                "action_list_item_visual_trailing": "",
                "action_list_item_action_trailing": "",
            }
        )
        ul = f"<ul class='tree-list tree-list--subgroup' hidden>{content}</ul>"
        return (
            "<li class='tree-list-item tree-list-item--has-subitem' data-tree-entry-type='dir'>"
            f"{btn}{ul}"
            "</li>"
        )

    def create_tree_file_item_html(self, tabname: str, file_path: str, item: dict) -> str:
        """Generates HTML for a file item in the tree.

        The generated HTML is of the format:
        ```html
        <li class="tree-list-item tree-list-item--subitem">
            <span data-filterable-item-text hidden></span>
            <div class="tree-list-content tree-list-content-file"></div>
        </li>
        ```

        Args:
            tabname: The name of the active tab.
            file_path: The path to the file for this item.
            item: Dictionary containing the item information.

        Returns:
            HTML formatted string.
        """
        item_html_args = self.create_item_html(tabname, item)
        action_buttons = "".join(
            [
                item_html_args["copy_path_button"],
                item_html_args["metadata_button"],
                item_html_args["edit_button"],
            ]
        )
        action_buttons = f"<div class=\"button-row\">{action_buttons}</div>"
        btn = self.btn_tree_tpl.format(
            **{
                "search_terms": "",
                "subclass": "tree-list-content-file",
                "tabname": tabname,
                "extra_networks_tabname": self.extra_networks_tabname,
                "onclick_extra": item_html_args["card_clicked"],
                "data_path": file_path,
                "data_hash": item["shorthash"],
                "action_list_item_action_leading": "<i class='tree-list-item-action-chevron'></i>",
                "action_list_item_visual_leading": "🗎",
                "action_list_item_label": item["name"],
                "action_list_item_visual_trailing": "",
                "action_list_item_action_trailing": action_buttons,
            }
        )
        return (
            "<li class='tree-list-item tree-list-item--subitem' data-tree-entry-type='file'>"
            f"{btn}"
            "</li>"
        )

    def create_tree_view_html(self, tabname: str) -> str:
        """Generates HTML for displaying folders in a tree view.

        Args:
            tabname: The name of the active tab.

        Returns:
            HTML string generated for this tree view.
        """
        res = ""

        # Setup the tree dictionary.
        roots = self.allowed_directories_for_previews()
        tree_items = {v["filename"]: ExtraNetworksItem(v) for v in self.items.values()}
        tree = get_tree([os.path.abspath(x) for x in roots], items=tree_items)

        if not tree:
            return res

        def _build_tree(data: Optional[dict[str, ExtraNetworksItem]] = None) -> Optional[str]:
            """Recursively builds HTML for a tree.

            Args:
                data: Dictionary representing a directory tree. Can be NoneType.
                    Data keys should be absolute paths from the root and values
                    should be subdirectory trees or an ExtraNetworksItem.

            Returns:
                If data is not None: HTML string
                Else: None
            """
            if not data:
                return None

            # Lists for storing <li> items html for directories and files separately.
            _dir_li = []
            _file_li = []

            for k, v in sorted(data.items(), key=lambda x: shared.natural_sort_key(x[0])):
                if isinstance(v, (ExtraNetworksItem,)):
                    _file_li.append(self.create_tree_file_item_html(tabname, k, v.item))
                else:
                    _dir_li.append(self.create_tree_dir_item_html(tabname, k, _build_tree(v)))

            # Directories should always be displayed before files so we order them here.
            return "".join(_dir_li) + "".join(_file_li)

        # Add each root directory to the tree.
        for k, v in sorted(tree.items(), key=lambda x: shared.natural_sort_key(x[0])):
            item_html = self.create_tree_dir_item_html(tabname, k, _build_tree(v))
            # Only add non-empty entries to the tree.
            if item_html is not None:
                res += item_html

        return f"<ul class='tree-list tree-list--tree'>{res}</ul>"

    def list_subdirs(self) -> list[str]:
        """Lists directories for the Dirs view, in the form they are searched for."""

        subdirs = {}
        for parentdir in [os.path.abspath(x) for x in self.allowed_directories_for_previews()]:
            for root, dirs, _ in sorted(os.walk(parentdir, followlinks=True), key=lambda x: shared.natural_sort_key(x[0])):
                for dirname in sorted(dirs, key=shared.natural_sort_key):
                    x = os.path.join(root, dirname)

                    if not os.path.isdir(x):
                        continue

                    subdir = os.path.abspath(x)[len(parentdir):]

                    if shared.opts.extra_networks_dir_button_function:
                        if not subdir.startswith(os.path.sep):
                            subdir = os.path.sep + subdir
                    else:
                        while subdir.startswith(os.path.sep):
                            subdir = subdir[1:]

                    is_empty = len(os.listdir(x)) == 0
                    if not is_empty and not subdir.endswith(os.path.sep):
                        subdir = subdir + os.path.sep

                    if (os.path.sep + "." in subdir or subdir.startswith(".")) and not shared.opts.extra_networks_show_hidden_directories:
                        continue

                    subdirs[subdir] = 1

        if subdirs:
            subdirs = {"": 1, **subdirs}

        return list(subdirs)

    def create_dirs_view_html(self, tabname: str) -> str:
        """Generates HTML for displaying folders."""

        subdirs = self.list_subdirs()

        subdirs_html = "".join([f"""
        <button class='lg secondary gradio-button custom-button{" search-all" if subdir == "" else ""}' onclick='extraNetworksSearchButton("{tabname}", "{self.extra_networks_tabname}", event)'>
        {html.escape(subdir if subdir != "" else "all")}
        </button>
        """ for subdir in subdirs])

        return subdirs_html

    def create_card_view_html(self, tabname: str, *, none_message) -> str:
        """Generates HTML for the network Card View section for a tab.

        This HTML goes into the `extra-networks-pane.html` <div> with
        `id='{tabname}_{extra_networks_tabname}_cards`.

        Args:
            tabname: The name of the active tab.
            none_message: HTML text to show when there are no cards.

        Returns:
            HTML formatted string.
        """
        res = []
        for item in self.items.values():
            res.append(self.create_item_html(tabname, item, self.card_tpl))

        if not res:
            dirs = "".join([f"<li>{x}</li>" for x in self.allowed_directories_for_previews()])
            res = [none_message or shared.html("extra-networks-no-cards.html").format(dirs=dirs)]

        return "".join(res)

    def refresh_items(self):
        """Lists the items of this page anew, filling `self.items` and `self.metadata`."""
        with self.items_lock:
            self.lister.reset()
            self.metadata = {}

            items_list = self.list_items()
            self.items = {x["name"]: x for x in items_list}

            # Populate the instance metadata for each item.
            for item in self.items.values():
                metadata = item.get("metadata")
                if metadata:
                    self.metadata[item["name"]] = metadata

                if "user_metadata" not in item:
                    self.read_user_metadata(item)

    def is_search_only(self, item: dict) -> bool:
        """True if the item is in a hidden directory, and so must only be shown when searching for it."""
        if shared.opts.extra_networks_hidden_models == "Always":
            return False

        local_path = ""
        filename = item.get("filename", "") or ""
        for reldir in self.allowed_directories_for_previews():
            absdir = os.path.abspath(reldir)

            if filename.startswith(absdir):
                local_path = filename[len(absdir):]

        return "/." in local_path or "\\." in local_path

    def tree_path(self, filename: str) -> str:
        """Where the file goes in the tree view: its path starting from the name of the directory it was found in.

        The same keys `get_tree` produces, e.g. "Lora/characters/name.safetensors".
        """
        if not filename:
            return ""

        abspath = os.path.abspath(filename)
        for root in self.allowed_directories_for_previews():
            if not root:
                continue

            root = os.path.abspath(root)
            if os.path.normcase(abspath).startswith(os.path.normcase(root) + os.sep):
                return os.path.relpath(abspath, os.path.dirname(root))

        return ""

    def create_item_data(self, item: dict) -> Optional[dict]:
        """Describes a single item for the browser, which builds the card from it.

        Holds the same information as the HTML made by `create_item_html`, minus everything that
        depends on the tab the card is shown in. Returns None if the item is not meant to be shown.
        """
        search_only = self.is_search_only(item)
        if search_only and shared.opts.extra_networks_hidden_models == "Never":
            return None

        data = {
            "name": item["name"],
            "filename": item.get("filename", "") or "",
            "shorthash": item.get("shorthash", "") or "",
            "preview": item.get("preview", None) or None,
            "description": (item.get("description", "") or "") if shared.opts.extra_networks_card_show_desc else "",
            "search_terms": [str(x) for x in item.get("search_terms", [])],
            "search_only": search_only,
            "sort_keys": item.get("sort_keys", {}),
            "has_metadata": bool(item.get("metadata")),
            "tree_path": self.tree_path(item.get("filename", "")),
        }

        onclick = item.get("onclick", None)
        if onclick is not None:
            # stored escaped for use inside an HTML attribute; the browser sets the attribute directly
            data["onclick"] = html.unescape(onclick)
        else:
            # these two are javascript expressions, not text
            data["prompt"] = item["prompt"]
            data["negative_prompt"] = item.get("negative_prompt", "''")

        return data

    def create_items_data(self) -> dict:
        """Lists the items anew and returns everything the browser needs to show this page, in any tab."""
        with self.items_lock:
            self.refresh_items()
            items = [self.create_item_data(item) for item in self.items.values()]

        style_height = f"height: {shared.opts.extra_networks_card_height}px;" if shared.opts.extra_networks_card_height else ''
        style_width = f"width: {shared.opts.extra_networks_card_width}px;" if shared.opts.extra_networks_card_width else ''
        style_font_size = f"font-size: {shared.opts.extra_networks_card_text_scale*100}%;"

        dirs = "".join([f"<li>{html.escape(x)}</li>" for x in self.allowed_directories_for_previews()])

        return {
            "page": self.name,
            "extra_networks_tabname": self.extra_networks_tabname,
            "items": [x for x in items if x is not None],
            "allow_negative_prompt": bool(self.allow_negative_prompt),
            "card_style": style_height + style_width + style_font_size,
            "description_is_html": bool(shared.opts.extra_networks_card_description_is_html),
            "dirs": self.list_subdirs() if shared.opts.extra_networks_tree_view_style != "Tree" else [],
            "no_cards_html": shared.html("extra-networks-no-cards.html").format(dirs=dirs),
            "path_separator": os.sep,
        }

    def create_html(self, tabname, *, empty=False):
        """Generates an HTML string for the current pane.

        The generated HTML uses `extra-networks-pane.html` as a template.

        Only the frame of the pane is made here: controls plus empty containers. Cards, and the
        directory view next to them, are built in the browser from `create_items_data()`, which is
        what keeps pages with thousands of items responsive. The result does not depend on the
        items, so setting it again on the gradio component leaves the page alone.

        Args:
            tabname: The name of the active tab.
            empty: unused; kept for compatibility.

        Returns:
            HTML formatted string.
        """
        show_tree = shared.opts.extra_networks_tree_view_default_enabled

        page_params = {
            "tabname": tabname,
            "extra_networks_tabname": self.extra_networks_tabname,
            "data_sortdir": shared.opts.extra_networks_card_order,
            "sort_path_active": ' extra-network-control--enabled' if shared.opts.extra_networks_card_order_field == 'Path' else '',
            "sort_name_active": ' extra-network-control--enabled' if shared.opts.extra_networks_card_order_field == 'Name' else '',
            "sort_date_created_active": ' extra-network-control--enabled' if shared.opts.extra_networks_card_order_field == 'Date Created' else '',
            "sort_date_modified_active": ' extra-network-control--enabled' if shared.opts.extra_networks_card_order_field == 'Date Modified' else '',
            "tree_view_btn_extra_class": "extra-network-control--enabled" if show_tree else "",
            "items_html": "<div class='extra-network-cards-status'>Loading...</div>",
            "extra_networks_tree_view_default_width": shared.opts.extra_networks_tree_view_default_width,
            "tree_view_div_default_display_class": "" if show_tree else "extra-network-dirs-hidden",
        }

        if shared.opts.extra_networks_tree_view_style == "Tree":
            pane_content = self.pane_content_tree_tpl.format(**page_params, tree_html="")
        else:
            pane_content = self.pane_content_dirs_tpl.format(**page_params, dirs_html="")

        return self.pane_tpl.format(**page_params, pane_content=pane_content)

    def create_item(self, name, index=None):
        raise NotImplementedError()

    def list_items(self):
        raise NotImplementedError()

    def allowed_directories_for_previews(self):
        return []

    def get_sort_keys(self, path):
        """
        List of default keys used for sorting in the UI.
        """
        pth = Path(path)
        mtime, ctime = self.lister.mctime(path)
        return {
            # ctime is the creation time on Windows; elsewhere it is the closest thing there is to one
            "date_created": int(ctime),
            "date_modified": int(mtime),
            "name": pth.name.lower(),
            "path": str(pth).lower(),
        }

    def find_preview(self, path):
        """
        Find a preview PNG for a given path (without extension) and call link_preview on it.

        If there are previews in several formats, the most recently modified one is used; that is the
        one "Replace preview" has just written. Between equally old ones the order of extensions decides.
        """

        # allowed_preview_extensions() is a set: iterating it directly gives a different order on every launch
        extensions = sorted(allowed_preview_extensions(), key=lambda x: (default_allowed_preview_extensions.index(x) if x in default_allowed_preview_extensions else len(default_allowed_preview_extensions), x))
        potential_files = sum([[f"{path}.{ext}", f"{path}.preview.{ext}"] for ext in extensions], [])

        newest_file = None
        newest_mtime = None
        for file in potential_files:
            stats = self.lister.find(file)
            if stats is None:
                continue

            if newest_file is None or stats[1] > newest_mtime:
                newest_file = file
                newest_mtime = stats[1]

        return self.link_preview(newest_file) if newest_file is not None else None

    def find_embedded_preview(self, path, name, metadata):
        """
        Find if embedded preview exists in safetensors metadata and return endpoint for it.
        """

        file = f"{path}.safetensors"
        if self.lister.exists(file) and 'ssmd_cover_images' in metadata and len(list(filter(None, json.loads(metadata['ssmd_cover_images'])))) > 0:
            mtime, _ = self.lister.mctime(file)
            quoted_name = urllib.parse.quote(name, safe="")
            return f"./sd_extra_networks/cover-images?page={self.extra_networks_tabname}&item={quoted_name}&mtime={mtime}&t={ui_extra_networks_thumbnails.settings_signature()}"

        return None

    def find_description(self, path):
        """
        Find and read a description file for a given path (without extension).
        """
        for file in [f"{path}.txt", f"{path}.description.txt"]:
            if not self.lister.exists(file):
                continue

            try:
                with open(file, "r", encoding="utf-8", errors="replace") as f:
                    return f.read()
            except OSError:
                pass
        return None

    def create_user_metadata_editor(self, ui, tabname):
        return ui_extra_networks_user_metadata.UserMetadataEditor(ui, tabname, self)


def initialize():
    extra_pages.clear()


def register_default_pages():
    from modules.ui_extra_networks_textual_inversion import ExtraNetworksPageTextualInversion
    from modules.ui_extra_networks_hypernets import ExtraNetworksPageHypernetworks
    from modules.ui_extra_networks_checkpoints import ExtraNetworksPageCheckpoints
    register_page(ExtraNetworksPageTextualInversion())
    register_page(ExtraNetworksPageHypernetworks())
    register_page(ExtraNetworksPageCheckpoints())


class ExtraNetworksUi:
    def __init__(self):
        self.pages = None
        """gradio HTML components related to extra networks' pages"""

        self.page_contents = None
        """HTML content of the above; empty initially, filled when extra pages have to be shown"""

        self.stored_extra_pages = None

        self.button_save_preview = None
        self.preview_target_filename = None

        self.tabname = None


def pages_in_preferred_order(pages):
    tab_order = [x.lower().strip() for x in shared.opts.ui_extra_networks_tab_reorder.split(",")]

    def tab_name_score(name):
        name = name.lower()
        for i, possible_match in enumerate(tab_order):
            if possible_match in name:
                return i

        return len(pages)

    tab_scores = {page.name: (tab_name_score(page.name), original_index) for original_index, page in enumerate(pages)}

    return sorted(pages, key=lambda x: tab_scores[x.name])


def create_ui(interface: gr.Blocks, unrelated_tabs, tabname):
    ui = ExtraNetworksUi()
    ui.pages = []
    ui.pages_contents = []
    ui.user_metadata_editors = []
    ui.stored_extra_pages = pages_in_preferred_order(extra_pages.copy())
    ui.tabname = tabname

    related_tabs = []

    for page in ui.stored_extra_pages:
        with gr.Tab(page.title, elem_id=f"{tabname}_{page.extra_networks_tabname}", elem_classes=["extra-page"]) as tab:
            with gr.Column(elem_id=f"{tabname}_{page.extra_networks_tabname}_prompts", elem_classes=["extra-page-prompts"]):
                pass

            elem_id = f"{tabname}_{page.extra_networks_tabname}_cards_html"
            page_elem = gr.HTML(page.create_html(tabname, empty=True), elem_id=elem_id)
            ui.pages.append(page_elem)
            editor = page.create_user_metadata_editor(ui, tabname)
            editor.create_ui()
            ui.user_metadata_editors.append(editor)
            related_tabs.append(tab)

    ui.button_save_preview = gr.Button('Save preview', elem_id=f"{tabname}_save_preview", visible=False)
    ui.preview_target_filename = gr.Textbox('Preview save filename', elem_id=f"{tabname}_preview_filename", visible=False)

    for tab in unrelated_tabs:
        tab.select(fn=None, _js=f"function(){{extraNetworksUnrelatedTabSelected('{tabname}');}}", inputs=[], outputs=[], show_progress=False)

    for page, tab in zip(ui.stored_extra_pages, related_tabs):
        jscode = (
            "function(){{"
            f"extraNetworksTabSelected('{tabname}', '{tabname}_{page.extra_networks_tabname}_prompts', {str(page.allow_prompt).lower()}, {str(page.allow_negative_prompt).lower()}, '{tabname}_{page.extra_networks_tabname}');"
            f"applyExtraNetworkFilter('{tabname}_{page.extra_networks_tabname}');"
            "}}"
        )
        tab.select(fn=None, _js=jscode, inputs=[], outputs=[], show_progress=False)

        def refresh():
            for pg in ui.stored_extra_pages:
                pg.refresh()

        # The pages themselves are not outputs: the browser asks for the items again once the lists are refreshed.
        button_refresh = gr.Button("Refresh", elem_id=f"{tabname}_{page.extra_networks_tabname}_extra_refresh_internal", visible=False)
        button_refresh.click(fn=refresh, inputs=[], outputs=[]).then(fn=None, _js="function(){ extraNetworksReloadItems(); }", inputs=[], outputs=[])

    return ui


def path_is_parent(parent_path, child_path):
    parent_path = os.path.abspath(parent_path)
    child_path = os.path.abspath(child_path)

    return child_path.startswith(parent_path)


def setup_ui(ui, gallery):
    def save_preview(index, images, filename):
        # this function is here for backwards compatibility and likely will be removed soon

        if len(images) == 0:
            print("There is no image in gallery to save as a preview.")
            return

        index = int(index)
        index = 0 if index < 0 else index
        index = len(images) - 1 if index >= len(images) else index

        img_info = images[index if index >= 0 else 0]
        image = image_from_url_text(img_info)
        geninfo, items = read_info_from_image(image)

        is_allowed = False
        for extra_page in ui.stored_extra_pages:
            if any(path_is_parent(x, filename) for x in extra_page.allowed_directories_for_previews()):
                is_allowed = True
                break

        assert is_allowed, f'writing to {filename} is not allowed'

        save_image_with_geninfo(image, geninfo, filename)

    ui.button_save_preview.click(
        fn=save_preview,
        _js="function(x, y, z){return [selected_gallery_index(), y, z]}",
        inputs=[ui.preview_target_filename, gallery, ui.preview_target_filename],
        outputs=[]
    ).then(fn=None, _js="function(){ extraNetworksReloadItems(); }", inputs=[], outputs=[])

    for editor in ui.user_metadata_editors:
        editor.setup_ui(gallery)
