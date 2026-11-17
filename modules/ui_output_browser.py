"""History tab: browse the images in the output directories and reuse their parameters.

Nothing is cached on the server. A directory is listed when it is opened, one directory at a
time, and thumbnails are made in memory for each request - output directories grow without bound,
and a thumbnail cache would grow with them. The browser keeps what it has already been sent.

The browser side is javascript/outputBrowser.js.
"""

import os
import threading
from io import BytesIO

import gradio as gr
from fastapi.exceptions import HTTPException
from PIL import Image, ImageOps

import modules.extras
from modules import errors, infotext_utils, shared
from modules.ui_components import ResizeHandleRow

image_extensions = {".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".jxl"}

# Sent with thumbnails: the link carries the file's modification time, so a response never goes stale.
thumbnail_cache_headers = {"Cache-Control": "private, max-age=31536000, immutable"}

# Thumbnails are CPU bound and the browser asks for a screenful at once.
thumbnail_slots = threading.BoundedSemaphore(max(2, min(8, (os.cpu_count() or 4) // 2)))


def roots():
    """Directories that can be browsed: [(label, path)], from the output directory settings."""
    opts = shared.opts
    candidates = []

    if opts.outdir_samples:
        candidates.append(("Images", opts.outdir_samples))
    else:
        candidates.append(("txt2img", opts.outdir_txt2img_samples))
        candidates.append(("img2img", opts.outdir_img2img_samples))

    candidates.append(("Extras", opts.outdir_extras_samples))

    if opts.outdir_grids:
        candidates.append(("Grids", opts.outdir_grids))
    else:
        candidates.append(("txt2img grids", opts.outdir_txt2img_grids))
        candidates.append(("img2img grids", opts.outdir_img2img_grids))

    candidates.append(("Saved", opts.outdir_save))

    res = []
    seen = set()
    for label, path in candidates:
        if not path:
            continue

        path = os.path.abspath(path)
        if path in seen:
            continue

        seen.add(path)
        res.append((label, path))

    return res


def resolve(root: int, path: str = ""):
    """Returns the absolute path for a path inside one of the roots; refuses anything that leads outside."""
    all_roots = roots()
    if root < 0 or root >= len(all_roots):
        raise HTTPException(status_code=404, detail="No such directory")

    root_path = os.path.realpath(all_roots[root][1])
    full_path = os.path.realpath(os.path.join(root_path, *[x for x in (path or "").replace("\\", "/").split("/") if x]))

    if full_path != root_path and not full_path.startswith(root_path + os.sep):
        raise HTTPException(status_code=403, detail="Outside of the output directories")

    return full_path


def api_roots():
    return {"roots": [{"label": label, "path": path, "exists": os.path.isdir(path)} for label, path in roots()]}


def api_list(root: int = 0, dir: str = ""):
    """Lists one directory: its subdirectories and its images, newest first. Subdirectories are not descended into."""
    full_path = resolve(root, dir)
    if not os.path.isdir(full_path):
        return {"dirs": [], "files": []}

    dirs = []
    files = []
    try:
        with os.scandir(full_path) as entries:
            for entry in entries:
                try:
                    if entry.is_dir():
                        dirs.append(entry.name)
                    elif os.path.splitext(entry.name)[1].lower() in image_extensions:
                        files.append([entry.name, int(entry.stat().st_mtime)])
                except OSError:
                    continue
    except OSError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    dirs.sort(key=shared.natural_sort_key, reverse=True)
    files.sort(key=lambda x: (x[1], x[0]), reverse=True)

    return {"dirs": dirs, "files": files}


def resolve_image(root: int, path: str):
    full_path = resolve(root, path)
    if os.path.splitext(full_path)[1].lower() not in image_extensions or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")

    return full_path


def api_thumb(root: int = 0, path: str = "", size: int = 320, mtime: str = ""):
    """A small JPEG of an image, made on the spot and not stored anywhere."""
    from starlette.responses import FileResponse, Response

    full_path = resolve_image(root, path)
    size = max(64, min(int(size), 1024))
    headers = thumbnail_cache_headers if mtime else {}

    try:
        with thumbnail_slots:
            with Image.open(full_path) as image:
                image.thumbnail((size, size), Image.LANCZOS, reducing_gap=2.0)
                image = ImageOps.exif_transpose(image)

                if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
                    image = image.convert("RGBA")
                    background = Image.new("RGBA", image.size, "#ffffff")
                    background.alpha_composite(image)
                    image = background

                buffer = BytesIO()
                image.convert("RGB").save(buffer, format="JPEG", quality=80)
    except Exception:
        # whatever can not be shrunk is shown as it is
        return FileResponse(full_path, headers=headers)

    return Response(content=buffer.getvalue(), media_type="image/jpeg", headers=headers)


def api_file(root: int = 0, path: str = ""):
    from starlette.responses import FileResponse

    return FileResponse(resolve_image(root, path))


def add_api(app):
    app.add_api_route("/sd_output_browser/roots", api_roots, methods=["GET"])
    app.add_api_route("/sd_output_browser/list", api_list, methods=["GET"])
    app.add_api_route("/sd_output_browser/thumb", api_thumb, methods=["GET"])
    app.add_api_route("/sd_output_browser/file", api_file, methods=["GET"])


def select_image(selection: str):
    """Loads the image the browser picked: "<root index>/<path inside the root>"."""
    try:
        root, _, path = (selection or "").partition("/")
        full_path = resolve_image(int(root), path)

        with Image.open(full_path) as image:
            _, geninfo, info_html = modules.extras.run_pnginfo(image)

        # the path is handed over as it is, so the image arrives in the browser byte for byte
        return full_path, geninfo or "", info_html
    except Exception as e:
        errors.display(e, "selecting an image in the history tab")
        return gr.update(), "", ""


shell_html = """
<div id="output_browser" class="output-browser">
    <div class="output-browser-bar">
        <select id="output_browser_root" title="Output directory"></select>
        <div id="output_browser_path" class="output-browser-path"></div>
        <span id="output_browser_count" class="output-browser-count"></span>
        <button id="output_browser_refresh" class="lg secondary gradio-button tool" title="List this directory again">&#x1F504;</button>
    </div>
    <div id="output_browser_dirs" class="output-browser-dirs"></div>
    <div id="output_browser_grid" class="output-browser-grid"><div class="output-browser-status">Open this tab to list the images.</div></div>
</div>
"""


def create_ui():
    with gr.Blocks(analytics_enabled=False) as interface:
        with ResizeHandleRow(equal_height=False):
            with gr.Column(variant='panel', scale=3):
                gr.HTML(shell_html, elem_id="output_browser_html")

            with gr.Column(variant='panel', scale=2):
                image = gr.Image(elem_id="output_browser_image", label="Selected image", source="upload", interactive=False, type="pil", image_mode="RGBA")

                with gr.Row():
                    buttons = {
                        tabname: gr.Button(f"Send to {tabname}", elem_id=f"output_browser_send_{tabname}")
                        for tabname in ["txt2img", "img2img", "inpaint", "extras"]
                    }

                info_html = gr.HTML(elem_id="output_browser_info")
                generation_info = gr.Textbox(visible=False, elem_id="output_browser_generation_info")

                selection = gr.Textbox(visible=False, label="History selection", elem_id="output_browser_selection")
                selection.do_not_save_to_config = True
                select_button = gr.Button("Select", visible=False, elem_id="output_browser_select")

                for tabname, button in buttons.items():
                    infotext_utils.register_paste_params_button(infotext_utils.ParamBinding(
                        paste_button=button, tabname=tabname, source_text_component=generation_info, source_image_component=image,
                    ))

        select_button.click(
            fn=select_image,
            inputs=[selection],
            outputs=[image, generation_info, info_html],
            show_progress=False,
        )

    return interface
