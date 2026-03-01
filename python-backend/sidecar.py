"""
sidecar.py — JSON-RPC wrapper for Tauri sidecar communication.

Reads JSON commands from stdin, calls organizer/detectors functions,
and writes JSON responses to stdout. Each message is a single line of JSON.

Protocol:
  Request:  {"id": 1, "method": "scan", "params": {...}}
  Progress: {"id": 1, "event": "progress", "data": {"current": 1, "total": 10, "message": "..."}}
  Response: {"id": 1, "result": {...}}
  Error:    {"id": 1, "error": "message"}
"""

import base64
import json
import os
import sys
from io import BytesIO

# Force unbuffered stdout/stdin for reliable pipe communication with Tauri.
# On Windows, Python's text-mode stdout buffers even after flush() in some pipe configurations.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = open(sys.stdout.fileno(), "w", encoding="utf-8", buffering=1, closefd=False)  # line-buffered
if hasattr(sys.stdin, "buffer"):
    sys.stdin = open(sys.stdin.fileno(), "r", encoding="utf-8", buffering=1, closefd=False)  # line-buffered

# Ensure the sidecar's own directory is on sys.path so it can find organizer/detectors
# regardless of the working directory.
_this_dir = os.path.dirname(os.path.abspath(__file__))
if _this_dir not in sys.path:
    sys.path.insert(0, _this_dir)

from PIL import Image

from organizer import scan_and_classify, clear_classifications, IMAGE_EXTS, CLASSIFICATIONS_FILE


def send(msg: dict):
    """Write a JSON message to stdout (one line)."""
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_scan(req_id: int, params: dict):
    """Run scan_and_classify with progress streaming."""
    source_dir = params["path"]
    thresholds = params.get("thresholds", {})
    dry_run = params.get("dry_run", False)

    def progress_callback(current, total, message):
        send({"id": req_id, "event": "progress", "data": {
            "current": current, "total": total, "message": message,
        }})

    try:
        summary = scan_and_classify(
            source_dir,
            progress_callback=progress_callback,
            thresholds=thresholds,
            dry_run=dry_run,
        )
        send({"id": req_id, "result": summary})
    except Exception as e:
        send({"id": req_id, "error": str(e)})


def handle_clear(req_id: int, params: dict):
    """Clear classifications for a folder."""
    source_dir = params["path"]
    try:
        count, errors = clear_classifications(source_dir)
        send({"id": req_id, "result": {"cleared": count, "errors": errors}})
    except Exception as e:
        send({"id": req_id, "error": str(e)})


def handle_list_photos(req_id: int, params: dict):
    """List image files in a folder and load classifications + ratings."""
    source_dir = params["path"]

    # Collect image files
    files = []
    for entry in os.scandir(source_dir):
        if not entry.is_file():
            continue
        ext = os.path.splitext(entry.name)[1].lower()
        if ext in IMAGE_EXTS:
            files.append({"filename": entry.name, "path": entry.path})
    files.sort(key=lambda f: f["filename"])

    # Load classifications
    class_path = os.path.join(source_dir, CLASSIFICATIONS_FILE)
    classifications = {}
    if os.path.exists(class_path):
        with open(class_path, "r", encoding="utf-8") as f:
            classifications = json.load(f)

    # Load ratings
    ratings_path = os.path.join(source_dir, "_ratings.json")
    ratings = {}
    if os.path.exists(ratings_path):
        with open(ratings_path, "r", encoding="utf-8") as f:
            ratings = json.load(f)

    # Build entries
    entries = []
    for file_info in files:
        fname = file_info["filename"]
        cls = classifications.get(fname, {})
        entries.append({
            "filename": fname,
            "path": file_info["path"],
            "category": cls.get("primary_category", "clean"),
            "allLabels": cls.get("all_labels", []),
            "scores": {
                "brightness": cls.get("scores", {}).get("brightness", 0),
                "blur": cls.get("scores", {}).get("blur", 0),
                "ear": cls.get("scores", {}).get("ear"),
            },
            "starRating": ratings.get(fname, 0),
        })

    send({"id": req_id, "result": {"entries": entries}})


def handle_thumbnail(req_id: int, params: dict):
    """Generate a base64 JPEG thumbnail for a given photo path."""
    path = params["path"]
    size = params.get("size", 150)

    try:
        img = Image.open(path)
        img.thumbnail((size, size), Image.LANCZOS)
        if img.mode != "RGB":
            img = img.convert("RGB")

        buf = BytesIO()
        img.save(buf, format="JPEG", quality=80)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        send({"id": req_id, "result": {"data": b64}})
    except Exception as e:
        send({"id": req_id, "error": str(e)})


def handle_set_rating(req_id: int, params: dict):
    """Set star rating for a photo."""
    source_dir = params["folder"]
    filename = params["filename"]
    stars = params["stars"]

    ratings_path = os.path.join(source_dir, "_ratings.json")
    ratings = {}
    if os.path.exists(ratings_path):
        with open(ratings_path, "r", encoding="utf-8") as f:
            ratings = json.load(f)

    ratings[filename] = stars
    with open(ratings_path, "w", encoding="utf-8") as f:
        json.dump(ratings, f, ensure_ascii=False, indent=2)

    send({"id": req_id, "result": {"ok": True}})


def handle_reclassify(req_id: int, params: dict):
    """Reclassify a photo to a new category."""
    source_dir = params["folder"]
    filename = params["filename"]
    new_category = params["category"]

    class_path = os.path.join(source_dir, CLASSIFICATIONS_FILE)
    classifications = {}
    if os.path.exists(class_path):
        with open(class_path, "r", encoding="utf-8") as f:
            classifications = json.load(f)

    if new_category == "clean":
        classifications.pop(filename, None)
    else:
        existing = classifications.get(filename, {})
        classifications[filename] = {
            "primary_category": new_category,
            "all_labels": existing.get("all_labels", [new_category]),
            "scores": existing.get("scores", {}),
        }

    with open(class_path, "w", encoding="utf-8") as f:
        json.dump(classifications, f, ensure_ascii=False, indent=2)

    send({"id": req_id, "result": {"ok": True}})


HANDLERS = {
    "scan": handle_scan,
    "clear": handle_clear,
    "list_photos": handle_list_photos,
    "thumbnail": handle_thumbnail,
    "set_rating": handle_set_rating,
    "reclassify": handle_reclassify,
}


def log(msg: str):
    """Log a message to stderr (visible in Tauri console as 'Sidecar stderr:')."""
    print(f"[sidecar] {msg}", file=sys.stderr, flush=True)


def main():
    """Main loop: read JSON commands from stdin, dispatch to handlers.

    Uses readline() instead of `for line in sys.stdin` to avoid
    Python's read-ahead buffering when stdin is a pipe.
    """
    log("Sidecar started, waiting for commands...")
    while True:
        line = sys.stdin.readline()
        if not line:
            log("EOF on stdin — exiting.")
            break  # EOF — parent closed stdin
        line = line.strip()
        if not line:
            continue

        log(f"Received: {line[:200]}")

        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            log(f"JSON parse error: {e}")
            send({"id": 0, "error": f"Invalid JSON: {e}"})
            continue

        req_id = req.get("id", 0)
        method = req.get("method", "")
        params = req.get("params", {})

        log(f"Dispatching method={method} id={req_id}")

        handler = HANDLERS.get(method)
        if handler:
            try:
                handler(req_id, params)
                log(f"Handler done for method={method} id={req_id}")
            except Exception as e:
                log(f"Handler CRASHED for method={method} id={req_id}: {e}")
                send({"id": req_id, "error": f"Handler error: {e}"})
        else:
            send({"id": req_id, "error": f"Unknown method: {method}"})


if __name__ == "__main__":
    main()
