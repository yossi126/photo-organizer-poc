"""
thumbs.py — thumbnail generation with a disk cache and RAW support.

Thumbnails are rendered once into <app-data>/thumbs/ and indexed in the
catalog's thumb_cache table. RAW files use rawpy's embedded thumbnail when
available (fast), falling back to a half-size decode.
"""

import hashlib
import os
from io import BytesIO

import rawpy
from PIL import Image, ImageOps

import catalog
from detectors import _RAW_EXTS


def _load_for_thumb(path: str) -> Image.Image:
    """Load an image as PIL RGB, RAW-aware, preferring the embedded RAW thumbnail."""
    ext = os.path.splitext(path)[1].lower()
    if ext in _RAW_EXTS:
        with rawpy.imread(path) as raw:
            try:
                thumb = raw.extract_thumb()
                if thumb.format == rawpy.ThumbFormat.JPEG:
                    img = Image.open(BytesIO(thumb.data))
                    img.load()
                    return img
                if thumb.format == rawpy.ThumbFormat.BITMAP:
                    return Image.fromarray(thumb.data)
            except (rawpy.LibRawNoThumbnailError, rawpy.LibRawUnsupportedThumbnailError):
                pass
            rgb = raw.postprocess(use_camera_wb=True, half_size=True)
            return Image.fromarray(rgb)
    return Image.open(path)


def _render_thumbnail(path: str, size: int) -> bytes:
    img = _load_for_thumb(path)
    img = ImageOps.exif_transpose(img)
    img.thumbnail((size, size), Image.LANCZOS)
    if img.mode != "RGB":
        img = img.convert("RGB")
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=80 if size <= 150 else 75)
    return buf.getvalue()


def get_preview_bytes(path: str, max_px: int = 2560) -> bytes:
    """High-quality preview base (q92 JPEG), disk-cached. For RAW files this
    uses the SAME fixed rawpy params as export (docs/render-pipeline.md Stage 0,
    plus half_size for speed) so preview and export share a base rendering."""
    try:
        src_mtime = os.path.getmtime(path)
    except OSError:
        src_mtime = 0

    cached = catalog.get_cached_thumb(path, max_px)
    if cached:
        cache_file = os.path.join(catalog.thumbs_dir(), cached["file"])
        if os.path.exists(cache_file) and abs(cached["src_mtime"] - src_mtime) < 1e-6:
            with open(cache_file, "rb") as f:
                return f.read()

    ext = os.path.splitext(path)[1].lower()
    if ext in _RAW_EXTS:
        import render
        arr, _ = render.decode_image(path, half_size=True)
        img = Image.fromarray(render.encode_u8(arr))
    else:
        img = Image.open(path)
        img = ImageOps.exif_transpose(img)
        if img.mode != "RGB":
            img = img.convert("RGB")
    img.thumbnail((max_px, max_px), Image.LANCZOS)

    buf = BytesIO()
    img.save(buf, format="JPEG", quality=92)
    data = buf.getvalue()

    key = hashlib.sha1(f"{os.path.normpath(path)}|{max_px}".encode("utf-8")).hexdigest()
    fname = f"{key}.jpg"
    with open(os.path.join(catalog.thumbs_dir(), fname), "wb") as f:
        f.write(data)
    catalog.put_cached_thumb(path, max_px, fname, src_mtime)
    return data


def get_thumbnail_bytes(path: str, size: int) -> bytes:
    """Return JPEG bytes for a thumbnail, using the disk cache when valid."""
    try:
        src_mtime = os.path.getmtime(path)
    except OSError:
        src_mtime = 0

    cached = catalog.get_cached_thumb(path, size)
    if cached:
        cache_file = os.path.join(catalog.thumbs_dir(), cached["file"])
        if os.path.exists(cache_file) and abs(cached["src_mtime"] - src_mtime) < 1e-6:
            with open(cache_file, "rb") as f:
                return f.read()

    data = _render_thumbnail(path, size)

    key = hashlib.sha1(f"{os.path.normpath(path)}|{size}".encode("utf-8")).hexdigest()
    fname = f"{key}.jpg"
    with open(os.path.join(catalog.thumbs_dir(), fname), "wb") as f:
        f.write(data)
    catalog.put_cached_thumb(path, size, fname, src_mtime)
    return data
