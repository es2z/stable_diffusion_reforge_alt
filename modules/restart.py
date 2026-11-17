import os
from pathlib import Path

from modules.paths_internal import script_path


def is_restartable() -> bool:
    """
    Return True if the webui is restartable (i.e. there is something watching to restart it with)
    """
    return bool(os.environ.get('SD_WEBUI_RESTART'))


def restart_program() -> None:
    """creates file tmp/restart and immediately stops the process, which webui.bat/webui.sh interpret as a command to start webui again"""

    tmpdir = Path(script_path) / "tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)
    (tmpdir / "restart").touch()

    stop_program()


def stop_program() -> None:
    finish_background_saves()
    os._exit(0)


def finish_background_saves() -> None:
    """Images that are saved in the background (option save_images_async) get written before the process ends."""
    try:
        from modules import images

        images.finish_background_saves_before_exit()
    except Exception as e:
        print(f"Could not wait for images that are being saved: {e}")
