"""
sidecar.py — JSON-RPC wrapper for Tauri sidecar communication (protocol v2).

Reads JSON commands from stdin, dispatches each to a thread pool, and writes
JSON responses to stdout. Each message is a single line of JSON. Long-running
jobs stream progress events and can be cancelled with the `cancel_job` method.

Protocol:
  Request:  {"id": 1, "method": "scan", "params": {...}}
  Progress: {"id": 1, "event": "progress", "data": {"current": 1, "total": 10, "message": "..."}}
  Response: {"id": 1, "result": {...}}
  Error:    {"id": 1, "error": "message"}
  Cancel:   {"id": 9, "method": "cancel_job", "params": {"job_id": 1}}
"""

import base64
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

# Force line-buffered stdout/stdin for reliable pipe communication with Tauri.
# On Windows, Python's text-mode stdout buffers even after flush() in some pipe configurations.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = open(sys.stdout.fileno(), "w", encoding="utf-8", buffering=1, closefd=False)
if hasattr(sys.stdin, "buffer"):
    sys.stdin = open(sys.stdin.fileno(), "r", encoding="utf-8", buffering=1, closefd=False)

# Ensure the sidecar's own directory is on sys.path so it can find its modules
# regardless of the working directory.
_this_dir = os.path.dirname(os.path.abspath(__file__))
if _this_dir not in sys.path:
    sys.path.insert(0, _this_dir)

import auto_edit
import catalog
import thumbs
import xmp_mapping
from organizer import scan_and_classify, ScanCancelled
from exporter import export_photos, ExportCancelled

EXECUTOR = ThreadPoolExecutor(max_workers=4)

# job id -> cancel event, for long-running cancellable jobs
JOBS: dict[int, threading.Event] = {}
JOBS_LOCK = threading.Lock()

_SEND_LOCK = threading.Lock()

# Capture the protocol stream once at startup. send() writes here directly so
# libraries that print to (or redirect) sys.stdout can never corrupt the
# line-JSON protocol (e.g. torch.onnx prints progress to stdout).
_PROTOCOL_OUT = sys.stdout


def send(msg: dict):
    """Write a JSON message to the protocol stream (one line). Thread-safe."""
    line = json.dumps(msg, ensure_ascii=False) + "\n"
    with _SEND_LOCK:
        _PROTOCOL_OUT.write(line)
        _PROTOCOL_OUT.flush()


def log(msg: str):
    """Log a message to stderr (visible in Tauri console as 'Sidecar stderr:')."""
    print(f"[sidecar] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Handlers — each returns a result dict (or raises); dispatch sends the reply.
# Handlers that stream progress receive req_id / cancel_event explicitly.
# ---------------------------------------------------------------------------

def handle_scan(req_id: int, params: dict, cancel_event: threading.Event):
    """Run scan_and_classify with progress streaming, writing into the catalog."""
    project_id = params["project_id"]
    thresholds = params.get("thresholds", {})
    dry_run = params.get("dry_run", False)

    project = catalog.get_project(project_id)
    if project is None:
        raise ValueError(f"Unknown project: {project_id}")

    def progress_callback(current, total, message):
        send({"id": req_id, "event": "progress", "data": {
            "current": current, "total": total, "message": message,
        }})

    summary = scan_and_classify(
        project["folder"],
        progress_callback=progress_callback,
        thresholds=thresholds,
        dry_run=dry_run,
        project_id=project_id,
        cancel_event=cancel_event,
    )
    return summary


def handle_clear(params: dict):
    """Reset analysis results for a project (photos stay, become 'clean')."""
    cleared = catalog.clear_analysis(params["project_id"])
    return {"cleared": cleared, "errors": []}


def handle_create_project(params: dict):
    """Create (or reopen) a project for a folder; import legacy JSON files."""
    folder = params["folder"]
    name = params.get("name") or os.path.basename(os.path.normpath(folder))
    if not os.path.isdir(folder):
        raise ValueError(f"Folder not found: {folder}")
    project = catalog.get_or_create_project(name, folder)
    imported = catalog.import_legacy_json(project["id"], folder)
    if imported["classifications"] or imported["ratings"]:
        log(f"Imported legacy JSON for project {project['id']}: {imported}")
    return {"project": project}


def handle_list_projects(params: dict):
    return {"projects": catalog.list_projects()}


def handle_open_project(params: dict):
    project_id = params["project_id"]
    project = catalog.get_project(project_id)
    if project is None:
        raise ValueError(f"Unknown project: {project_id}")
    catalog.touch_project(project_id)
    return {
        "project": project,
        "entries": catalog.get_photos(project_id),
        "editSettings": catalog.get_edit_settings_map(project_id),
    }


def handle_delete_project(params: dict):
    catalog.delete_project(params["project_id"])
    return {"ok": True}


def handle_list_photos(params: dict):
    return {"entries": catalog.get_photos(params["project_id"])}


def handle_set_edit_settings(params: dict):
    photo_id = params["photo_id"]
    settings = params["settings"]
    catalog.set_edit_settings(photo_id, settings)
    # Capture manual edits as personal-profile training samples, in the
    # background so slider saves stay responsive. AI-written settings carry
    # aiEdited and are skipped inside capture_edit_sample.
    if not settings.get("aiEdited"):
        def _capture():
            try:
                import training
                training.capture_edit_sample(photo_id)
            except Exception:
                pass
        EXECUTOR.submit(_capture)
    return {"ok": True}


def handle_set_rating(params: dict):
    catalog.set_rating(params["project_id"], params["filename"], params["stars"])
    return {"ok": True}


def handle_reclassify(params: dict):
    catalog.set_category(params["project_id"], params["filename"], params["category"])
    return {"ok": True}


def handle_set_flag(params: dict):
    """flag: 'pick' | 'reject' | null"""
    catalog.set_flag(params["project_id"], params["filename"], params.get("flag"))
    return {"ok": True}


def handle_get_faces(params: dict):
    return {"faces": catalog.get_face_results(params["photo_id"])}


def handle_thumbnail(params: dict):
    data = thumbs.get_thumbnail_bytes(params["path"], params.get("size", 150))
    return {"data": base64.b64encode(data).decode("ascii")}


def handle_thumbnails_batch(params: dict):
    paths = params.get("paths", [])
    size = params.get("size", 300)
    results = {}
    for path in paths:
        try:
            data = thumbs.get_thumbnail_bytes(path, size)
            results[path] = base64.b64encode(data).decode("ascii")
        except Exception:
            # Store None for failed images; frontend handles gracefully
            results[path] = None
    return {"thumbnails": results}


def handle_export(req_id: int, params: dict, cancel_event: threading.Event):
    """Export edited photos to a destination folder with progress streaming."""
    def progress_callback(current, total, message):
        send({"id": req_id, "event": "progress", "data": {
            "current": current, "total": total, "message": message,
        }})

    return export_photos(
        params["photo_ids"],
        params["dest_dir"],
        fmt=params.get("format", "jpeg"),
        quality=params.get("quality", 90),
        max_px=params.get("max_px"),
        suffix=params.get("suffix", "_edited"),
        progress_callback=progress_callback,
        cancel_event=cancel_event,
    )


def handle_import_preset(params: dict):
    """Parse a Lightroom .xmp preset, save it to the presets table."""
    path = params["path"]
    settings, warnings = xmp_mapping.read_xmp_file(path)
    if not settings:
        raise ValueError("No Camera Raw settings found in this XMP file")
    name = params.get("name") or os.path.splitext(os.path.basename(path))[0]
    preset = catalog.save_preset(name, settings)
    return {"preset": preset, "warnings": warnings}


def handle_list_presets(params: dict):
    return {"presets": catalog.list_presets()}


def handle_save_preset(params: dict):
    return {"preset": catalog.save_preset(params["name"], params["settings"])}


def handle_delete_preset(params: dict):
    catalog.delete_preset(params["preset_id"])
    return {"ok": True}


def handle_read_xmp_sidecar(params: dict):
    """Read the XMP sidecar next to a photo (if any) into EditSettings."""
    sidecar_path = xmp_mapping.sidecar_path_for(params["path"])
    if not os.path.exists(sidecar_path):
        return {"settings": None, "warnings": []}
    settings, warnings = xmp_mapping.read_xmp_file(sidecar_path)
    return {"settings": settings, "warnings": warnings}


def handle_write_xmp_sidecars(req_id: int, params: dict, cancel_event: threading.Event):
    """Write XMP sidecars next to the photos for their persisted edits."""
    photo_ids = params["photo_ids"]
    total = len(photo_ids)
    written = []
    errors = []
    for i, photo_id in enumerate(photo_ids):
        if cancel_event.is_set():
            raise ScanCancelled()
        photo = catalog.get_photo(photo_id)
        if photo is None:
            errors.append({"photo_id": photo_id, "error": "unknown photo"})
            continue
        send({"id": req_id, "event": "progress", "data": {
            "current": i + 1, "total": total, "message": f"Writing XMP: {photo['filename']}",
        }})
        try:
            settings = catalog.get_edit_settings(photo_id) or {}
            written.append(xmp_mapping.write_sidecar(photo["path"], settings))
        except Exception as e:
            errors.append({"photo_id": photo_id, "error": str(e)})
    send({"id": req_id, "event": "progress", "data": {
        "current": total, "total": total, "message": f"Done. Wrote {len(written)} XMP sidecars.",
    }})
    return {"written": written, "errors": errors}


def handle_auto_edit(req_id: int, params: dict, cancel_event: threading.Event):
    """Scene-conditioned auto-edit for the given photos."""
    def progress_callback(current, total, message):
        send({"id": req_id, "event": "progress", "data": {
            "current": current, "total": total, "message": message,
        }})

    return auto_edit.run_auto_edit(
        params["project_id"],
        params["photo_ids"],
        scene_presets=params.get("scene_presets"),
        normalize_exposure=params.get("normalize_exposure", True),
        skip_edited=params.get("skip_edited", True),
        use_personal_model=params.get("use_personal_model", True),
        progress_callback=progress_callback,
        cancel_event=cancel_event,
    )


def handle_ingest_training_data(req_id: int, params: dict, cancel_event: threading.Event):
    """Scan folders for image+XMP pairs and add them to the training library."""
    import training

    def progress_callback(current, total, message):
        send({"id": req_id, "event": "progress", "data": {
            "current": current, "total": total, "message": message,
        }})

    try:
        return training.ingest_training_data(
            params["folders"], progress_callback=progress_callback,
            cancel_event=cancel_event,
        )
    except training.TrainingCancelled:
        raise ScanCancelled()


def handle_train_profile(req_id: int, params: dict, cancel_event: threading.Event):
    """Train the personal AI profile on the ingested library."""
    import training

    def progress_callback(current, total, message):
        send({"id": req_id, "event": "progress", "data": {
            "current": current, "total": total, "message": message,
        }})

    try:
        result = training.train_profile(
            progress_callback=progress_callback, cancel_event=cancel_event
        )
        training.invalidate_model_cache()
        return result
    except training.TrainingCancelled:
        raise ScanCancelled()


def handle_personal_model_status(params: dict):
    import training
    return training.personal_model_status()


def handle_clear_training_data(params: dict):
    catalog.clear_training_samples()
    return {"ok": True}


def handle_delete_edit_settings(params: dict):
    catalog.delete_edit_settings(params["photo_id"])
    return {"ok": True}


def handle_get_edit_settings(params: dict):
    return {"settings": catalog.get_edit_settings(params["photo_id"])}


def handle_get_ai_profile(params: dict):
    profile = catalog.get_ai_profile()
    if profile is None:
        profile = {
            "id": 1,
            "name": "Default",
            "config": {
                "scenePresets": auto_edit.DEFAULT_SCENE_PRESETS,
                "normalizeExposure": True,
                "skipEdited": True,
            },
        }
    return {"profile": profile}


def handle_save_ai_profile(params: dict):
    catalog.save_ai_profile(params["config"], params.get("name", "Default"))
    return {"ok": True}


def handle_preview_image(params: dict):
    """High-quality preview base (RAW-aware, cached). Used by the EDIT tab."""
    data = thumbs.get_preview_bytes(params["path"], params.get("max_px", 2560))
    return {"data": base64.b64encode(data).decode("ascii")}


def handle_cancel_job(params: dict):
    job_id = params["job_id"]
    with JOBS_LOCK:
        event = JOBS.get(job_id)
    if event:
        event.set()
        return {"ok": True, "cancelled": job_id}
    return {"ok": False, "message": f"No running job with id {job_id}"}


# Handlers that stream progress / support cancellation get (req_id, params, cancel_event)
CANCELLABLE_HANDLERS = {
    "scan": handle_scan,
    "export": handle_export,
    "write_xmp_sidecars": handle_write_xmp_sidecars,
    "auto_edit": handle_auto_edit,
    "ingest_training_data": handle_ingest_training_data,
    "train_profile": handle_train_profile,
}

# Simple handlers get (params) and return a result dict
SIMPLE_HANDLERS = {
    "clear": handle_clear,
    "create_project": handle_create_project,
    "list_projects": handle_list_projects,
    "open_project": handle_open_project,
    "delete_project": handle_delete_project,
    "list_photos": handle_list_photos,
    "set_edit_settings": handle_set_edit_settings,
    "set_rating": handle_set_rating,
    "reclassify": handle_reclassify,
    "set_flag": handle_set_flag,
    "get_faces": handle_get_faces,
    "thumbnail": handle_thumbnail,
    "thumbnails_batch": handle_thumbnails_batch,
    "preview_image": handle_preview_image,
    "import_preset": handle_import_preset,
    "list_presets": handle_list_presets,
    "save_preset": handle_save_preset,
    "delete_preset": handle_delete_preset,
    "read_xmp_sidecar": handle_read_xmp_sidecar,
    "delete_edit_settings": handle_delete_edit_settings,
    "get_edit_settings": handle_get_edit_settings,
    "get_ai_profile": handle_get_ai_profile,
    "save_ai_profile": handle_save_ai_profile,
    "personal_model_status": handle_personal_model_status,
    "clear_training_data": handle_clear_training_data,
    "cancel_job": handle_cancel_job,
}


def run_request(req_id: int, method: str, params: dict):
    """Executed on the thread pool: run the handler and send exactly one reply."""
    try:
        if method in CANCELLABLE_HANDLERS:
            cancel_event = threading.Event()
            with JOBS_LOCK:
                JOBS[req_id] = cancel_event
            try:
                result = CANCELLABLE_HANDLERS[method](req_id, params, cancel_event)
            finally:
                with JOBS_LOCK:
                    JOBS.pop(req_id, None)
            send({"id": req_id, "result": result})
        elif method in SIMPLE_HANDLERS:
            result = SIMPLE_HANDLERS[method](params)
            send({"id": req_id, "result": result})
        else:
            send({"id": req_id, "error": f"Unknown method: {method}"})
        log(f"Handler done for method={method} id={req_id}")
    except (ScanCancelled, ExportCancelled, auto_edit.AutoEditCancelled):
        log(f"Job cancelled: method={method} id={req_id}")
        send({"id": req_id, "error": "cancelled"})
    except Exception as e:
        log(f"Handler error for method={method} id={req_id}: {e}")
        send({"id": req_id, "error": str(e)})


def main():
    """Main loop: read JSON commands from stdin, dispatch to the thread pool.

    Uses readline() instead of `for line in sys.stdin` to avoid
    Python's read-ahead buffering when stdin is a pipe.
    """
    log("Sidecar started (protocol v2), waiting for commands...")
    while True:
        line = sys.stdin.readline()
        if not line:
            log("EOF on stdin — exiting.")
            break  # EOF — parent closed stdin
        line = line.strip()
        if not line:
            continue

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

        # cancel_job must not queue behind the job it cancels — run inline
        if method == "cancel_job":
            run_request(req_id, method, params)
        else:
            EXECUTOR.submit(run_request, req_id, method, params)

    EXECUTOR.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
