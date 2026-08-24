"""
exporter.py — full-resolution export of edited photos.

Reads photo paths + persisted edit settings from the catalog, renders through
render.py (the numpy mirror of the WebGL preview), and writes JPEGs with the
source EXIF passed through.
"""

import os
import threading

from PIL import Image

import catalog
import render


class ExportCancelled(Exception):
    pass


def _unique_path(dest_dir: str, stem: str, suffix: str, ext: str) -> str:
    candidate = os.path.join(dest_dir, f"{stem}{suffix}{ext}")
    n = 1
    while os.path.exists(candidate):
        candidate = os.path.join(dest_dir, f"{stem}{suffix} ({n}){ext}")
        n += 1
    return candidate


def export_photos(
    photo_ids: list,
    dest_dir: str,
    fmt: str = "jpeg",
    quality: int = 90,
    max_px: int = None,
    suffix: str = "_edited",
    progress_callback=None,
    cancel_event: threading.Event = None,
) -> dict:
    """Returns {"exported": [paths], "errors": [{photo_id, error}]}."""
    os.makedirs(dest_dir, exist_ok=True)
    total = len(photo_ids)
    exported = []
    errors = []

    for i, photo_id in enumerate(photo_ids):
        if cancel_event is not None and cancel_event.is_set():
            raise ExportCancelled()

        try:
            photo = catalog.get_photo(photo_id)
            if photo is None:
                raise ValueError(f"Unknown photo id: {photo_id}")
            src_path = photo["path"]
            filename = photo["filename"]

            if progress_callback:
                progress_callback(i + 1, total, f"Exporting: {filename}")

            settings = catalog.get_edit_settings(photo_id) or {}

            img, exif = render.decode_image(src_path)
            out = render.apply_edit_settings(img, settings)
            pil = Image.fromarray(render.encode_u8(out))

            if max_px and max(pil.size) > max_px:
                pil.thumbnail((max_px, max_px), Image.LANCZOS)

            stem = os.path.splitext(filename)[0]
            out_path = _unique_path(dest_dir, stem, suffix, ".jpg")
            save_kwargs = {"format": "JPEG", "quality": int(quality)}
            if exif:
                save_kwargs["exif"] = exif
            pil.save(out_path, **save_kwargs)
            exported.append(out_path)
        except ExportCancelled:
            raise
        except Exception as e:
            errors.append({"photo_id": photo_id, "error": str(e)})
            if progress_callback:
                progress_callback(i + 1, total, f"Error exporting photo {photo_id}: {e}")

    if progress_callback:
        progress_callback(total, total, f"Done. Exported {len(exported)} photos.")
    return {"exported": exported, "errors": errors}
