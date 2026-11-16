"""Usage counts and favourites of Extra Networks items.

Usage is counted when an image is generated, by whatever the generation actually used - it makes no
difference whether the network got into the prompt by clicking a card, from a style, from pasted
parameters or by typing. One generation job counts once per item, however many images it makes.

Everything is kept in one file, `extra_networks_stats.json` in the data directory:

    {"lora": {"some_lora": {"count": 12, "last_used": 1731700000, "favorite": true}}}

Pages are identified by `ExtraNetworksPage.name`, items by their name on that page.
"""

import json
import os
import shutil
import tempfile
import threading
import time

from modules import errors
from modules.paths_internal import data_path

filename = os.path.join(data_path, "extra_networks_stats.json")

lock = threading.RLock()
data = None


def load():
    """Returns the stats, reading the file on first use."""
    global data

    with lock:
        if data is not None:
            return data

        data = {}
        try:
            if os.path.isfile(filename):
                with open(filename, "r", encoding="utf8") as file:
                    loaded = json.load(file)

                if isinstance(loaded, dict):
                    data = {page: items for page, items in loaded.items() if isinstance(items, dict)}
        except Exception as e:
            errors.display(e, f"reading extra networks stats from {filename}")

        return data


def save():
    """Writes the stats; a half-written file never replaces the previous one."""
    with lock:
        try:
            os.makedirs(os.path.dirname(filename), exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(filename), suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf8") as file:
                    json.dump(load(), file, ensure_ascii=False, indent=1)
                os.replace(tmp_path, filename)
            except Exception:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
                raise
        except Exception as e:
            errors.display(e, f"writing extra networks stats to {filename}")


def get(page: str, name: str) -> dict:
    """Stats of one item in the form the browser gets them."""
    with lock:
        entry = load().get(page, {}).get(name) or {}

        return {
            "count": int(entry.get("count", 0) or 0),
            "last_used": int(entry.get("last_used", 0) or 0),
            "favorite": bool(entry.get("favorite", False)),
        }


def get_page(page: str) -> dict:
    """Stats of all items of a page that have any."""
    with lock:
        return {name: get(page, name) for name in load().get(page, {})}


def _entry(page: str, name: str) -> dict:
    return load().setdefault(page, {}).setdefault(name, {})


def _drop_if_empty(page: str, name: str):
    items = load().get(page, {})
    entry = items.get(name)
    if entry is not None and not entry.get("count") and not entry.get("favorite"):
        items.pop(name, None)


def record_use(page: str, name: str):
    """Counts one use of an item."""
    if not name:
        return

    with lock:
        entry = _entry(page, name)
        entry["count"] = int(entry.get("count", 0) or 0) + 1
        entry["last_used"] = int(time.time())
        save()


_job = None
_job_recorded = set()


def record_use_once(p, page: str, name: str):
    """Counts a use by the generation job that is running, once per job.

    Extra networks are activated again for every batch and for hires fix, and extensions that run
    passes of their own (such as ADetailer) do it with processing objects of their own; all of that
    belongs to one press of Generate, which the shared state identifies.
    """
    global _job, _job_recorded

    if not name:
        return

    from modules import shared

    state = getattr(shared, "state", None)
    job = (getattr(state, "job", None), getattr(state, "job_timestamp", None)) if state is not None else None

    with lock:
        if job is None or not job[0]:
            # not started through the usual queue (some scripts and tests): fall back to one count per processing object
            recorded = getattr(p, "_extra_networks_usage_recorded", None)
            if recorded is None:
                recorded = set()
                try:
                    p._extra_networks_usage_recorded = recorded
                except Exception:
                    pass
        else:
            if job != _job:
                _job = job
                _job_recorded = set()
            recorded = _job_recorded

        key = (page, name)
        if key in recorded:
            return

        recorded.add(key)
        record_use(page, name)


def set_favorite(page: str, name: str, favorite: bool):
    with lock:
        if favorite:
            _entry(page, name)["favorite"] = True
        else:
            load().get(page, {}).get(name, {}).pop("favorite", None)
            _drop_if_empty(page, name)
        save()


def clear_usage(page: str, name: str):
    """Forgets how often and when one item was used; it stays a favourite if it is one."""
    with lock:
        entry = load().get(page, {}).get(name)
        if entry is None:
            return

        entry.pop("count", None)
        entry.pop("last_used", None)
        _drop_if_empty(page, name)
        save()


def clear_page_usage(page: str):
    """Forgets the usage of all items of a page. The previous file is kept next to it as a `.bak`."""
    with lock:
        load()
        try:
            if os.path.isfile(filename):
                shutil.copyfile(filename, filename + ".bak")
        except Exception as e:
            errors.display(e, f"backing up {filename}")

        for name in list(load().get(page, {})):
            entry = load()[page][name]
            entry.pop("count", None)
            entry.pop("last_used", None)
            _drop_if_empty(page, name)

        if not load().get(page):
            load().pop(page, None)

        save()
