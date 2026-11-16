"""Cached thumbnails for Extra Networks card previews.

Preview images are usually full-size generation outputs (often several MB each). Decoding hundreds of
them just to draw small cards is what makes the Extra Networks tabs slow, so cards are given a small
JPEG instead.

The thumbnail keeps the generation parameters of the source image: they are written to the EXIF
UserComment field, which is where `modules.images.read_info_from_image` looks for them in JPEG files.
A thumbnail that is opened in a new browser tab and dropped into PNG Info therefore still reproduces
the original settings. Whenever the parameters can not be carried over, no thumbnail is made and the
caller serves the original file instead - metadata is never silently dropped.

Thumbnails live in `<cache dir>/extra_networks_thumbs` and can be deleted at any time; they are
regenerated on demand.
"""

import hashlib
import os
import tempfile
import threading
from io import BytesIO
from typing import Optional

import piexif
import piexif.helper
from PIL import Image, ImageOps

# Bump to invalidate every previously generated thumbnail.
THUMBNAIL_VERSION = 1

# Originals that are already about thumbnail-sized are served as they are.
SMALL_SOURCE_BYTES = 200 * 1024

# Sent with responses whose URL changes whenever the content does (the URL carries the source mtime).
IMMUTABLE_CACHE_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}

# Thumbnails are CPU bound, and the browser asks for a screenful of them at once.
_generation_slots = threading.BoundedSemaphore(max(2, min(8, (os.cpu_count() or 4) // 2)))

_key_locks = {}
_key_locks_guard = threading.Lock()

# Keys of sources for which the original has to be served (animated, already small, unreadable...).
_serve_original = set()


def settings():
    """Returns (enabled, long side in pixels, JPEG quality) from the user options."""
    from modules import shared

    enabled = bool(getattr(shared.opts, "extra_networks_thumbnail_enabled", True))
    size = int(getattr(shared.opts, "extra_networks_thumbnail_size", 512) or 512)
    quality = int(getattr(shared.opts, "extra_networks_thumbnail_quality", 85) or 85)

    return enabled, max(64, min(size, 4096)), max(30, min(quality, 100))


def settings_signature():
    """Short string that changes whenever generated thumbnails would differ; used to bust browser caches."""
    enabled, size, quality = settings()

    return f"{size}q{quality}v{THUMBNAIL_VERSION}" if enabled else "off"


def cache_dir():
    from modules import cache

    return os.path.join(cache.cache_dir, "extra_networks_thumbs")


def read_geninfo(image):
    """Reads generation parameters the same way PNG Info does."""
    from modules.images import read_info_from_image

    geninfo, _ = read_info_from_image(image)

    return geninfo


def make_thumbnail(image, size, quality, source_bytes=None):
    """Creates JPEG thumbnail bytes for an opened PIL image.

    Returns None when the original should be served instead: animations, images that are already
    small, and images whose generation parameters can not be stored in a JPEG.
    """
    if getattr(image, "is_animated", False) and getattr(image, "n_frames", 1) > 1:
        return None

    if max(image.size) <= size and source_bytes is not None and source_bytes <= SMALL_SOURCE_BYTES:
        return None

    # Has to happen before the image is resized or converted: the parameters are in image.info, or,
    # for stealth pnginfo, in the pixels themselves.
    geninfo = read_geninfo(image)

    image.thumbnail((size, size), Image.LANCZOS, reducing_gap=2.0)
    image = ImageOps.exif_transpose(image)

    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        image = image.convert("RGBA")
        background = Image.new("RGBA", image.size, "#ffffff")
        background.alpha_composite(image)
        image = background.convert("RGB")
    elif image.mode != "RGB":
        image = image.convert("RGB")

    save_options = {"quality": quality, "optimize": True, "progressive": True}
    if geninfo:
        # Same encoding as modules.images.save_image_with_geninfo uses for JPEG files.
        save_options["exif"] = piexif.dump({
            "Exif": {
                piexif.ExifIFD.UserComment: piexif.helper.UserComment.dump(geninfo, encoding="unicode")
            },
        })

    buffer = BytesIO()
    try:
        image.save(buffer, format="JPEG", **save_options)
    except Exception:
        if not geninfo:
            raise

        # EXIF is limited to 64KB; parameters that do not fit would be lost, so keep the original.
        return None

    return buffer.getvalue()


def _key_lock(key):
    with _key_locks_guard:
        lock = _key_locks.get(key)
        if lock is None:
            lock = _key_locks[key] = threading.Lock()

        return lock


def _cached_thumbnail(identity: str, version: str, open_source, source_bytes=None) -> Optional[str]:
    """Returns the path of the cached thumbnail, creating it if needed; None means "serve the original".

    identity: what the thumbnail is of (stays the same when the source is modified).
    version: state of the source; a thumbnail made for another version is replaced.
    open_source: callable returning something PIL can open.
    """
    enabled, size, quality = settings()
    if not enabled:
        return None

    identity_hash = hashlib.sha256(identity.encode("utf8", errors="surrogatepass")).hexdigest()[:40]
    version_hash = hashlib.sha256(f"{version}|{size}|{quality}|{THUMBNAIL_VERSION}".encode("utf8")).hexdigest()[:16]
    key = f"{identity_hash}_{version_hash}"

    directory = os.path.join(cache_dir(), identity_hash[:2])
    path = os.path.join(directory, f"{key}.jpg")

    if key in _serve_original:
        return None

    if os.path.isfile(path):
        return path

    with _key_lock(key):
        if key in _serve_original:
            return None

        if os.path.isfile(path):
            return path

        data = None
        with _generation_slots:
            try:
                with Image.open(open_source()) as image:
                    data = make_thumbnail(image, size, quality, source_bytes=source_bytes)
            except Exception as e:
                print(f"Extra Networks: could not create thumbnail for {identity}: {e}")

        if data is None:
            _serve_original.add(key)
            return None

        try:
            os.makedirs(directory, exist_ok=True)

            # Only one thumbnail is kept per source.
            for name in os.listdir(directory):
                if name.startswith(identity_hash + "_") and name.endswith(".jpg"):
                    try:
                        os.remove(os.path.join(directory, name))
                    except OSError:
                        pass

            fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(data)
                os.replace(tmp_path, path)
            except Exception:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
                raise
        except Exception as e:
            # a cache that can not be written must not take the previews away: the original is shown instead
            print(f"Extra Networks: could not store thumbnail for {identity}: {e}")
            _serve_original.add(key)
            return None

    return path


def thumbnail_for_file(filename: str) -> Optional[str]:
    """Thumbnail for an image file on disk. Returns None if the file itself should be served."""
    try:
        stat = os.stat(filename)
    except OSError:
        return None

    filename = os.path.abspath(filename)

    return _cached_thumbnail(
        identity=filename,
        version=f"{stat.st_mtime_ns}|{stat.st_size}",
        open_source=lambda: filename,
        source_bytes=stat.st_size,
    )


def thumbnail_for_bytes(identity: str, version: str, data: bytes) -> Optional[str]:
    """Thumbnail for an image that only exists in memory, such as a cover image embedded in a model file."""
    return _cached_thumbnail(
        identity=identity,
        version=version,
        open_source=lambda: BytesIO(data),
        source_bytes=len(data),
    )
