"""
organizer.py — Scan loop and classification logic.

Analyzes images and stores results in the SQLite catalog (catalog.py).
No files are moved — all organization is virtual (metadata only).

Scans are incremental: photos whose (path, mtime, size) were already analyzed
are skipped. Scans are cancellable via a threading.Event.

Run directly for CLI testing (no GUI needed):
    python organizer.py "C:\\path\\to\\folder"
"""

import os

import catalog
from detectors import analyze_photo, find_duplicates


try:
    # HEIC/HEIF support (iPhone photos) — registers a PIL opener globally
    from pillow_heif import register_heif_opener
    register_heif_opener()
    _HEIF_OK = True
except ImportError:
    _HEIF_OK = False

SUBFOLDERS = ["_duplicates", "_dark", "_overexposed", "_blurry", "_eyes_closed"]
IMAGE_EXTS = {
    ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp",
    ".heic", ".heif",
    # RAW formats
    ".cr2", ".cr3",      # Canon
    ".nef", ".nrw",      # Nikon
    ".arw", ".srf",      # Sony
    ".orf",              # Olympus
    ".raf",              # Fujifilm
    ".rw2",              # Panasonic
    ".pef",              # Pentax
    ".dng",              # Adobe / universal RAW
    ".raw",              # Generic
}
# Legacy per-folder JSON file — only used by catalog.import_legacy_json now.
CLASSIFICATIONS_FILE = "_classifications.json"


class ScanCancelled(Exception):
    """Raised when a scan is cancelled via its cancel_event."""


def _check_cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise ScanCancelled()


def scan_and_classify(
    source_dir: str,
    progress_callback=None,
    thresholds: dict = None,
    dry_run: bool = False,
    project_id: int = None,
    cancel_event=None,
) -> dict:
    """
    Scans source_dir for images, detects problems, and records classifications
    in the catalog DB (per photo, crash-safe). No files are moved.

    Uses multi-label detection with priority-based assignment:
        _blurry > _eyes_closed > _dark > _overexposed
    (unfixable problems take priority over fixable ones)

    thresholds: dict with optional keys "dark", "blur", "duplicates", "overexposed".
    project_id: catalog project to write into (required unless dry_run).
    cancel_event: optional threading.Event — checked between images.

    Returns a summary dict:
        { "_duplicates": N, "_dark": N, "_blurry": N, "_eyes_closed": N,
          "clean": N, "skipped": N }
    """
    th = thresholds or {}
    dup_threshold = th.get("duplicates", 5)

    analysis_thresholds = {
        "dark": th.get("dark", 85),
        "blur": th.get("blur", 50.0),
        "overexposed": th.get("overexposed", 220),
        "eyes_closed": th.get("eyes_closed", 0.18),
    }

    persist = not dry_run and project_id is not None

    # --- Collect image files (top-level only) --------------------------------
    all_files = []
    file_stats = {}
    for entry in os.scandir(source_dir):
        if not entry.is_file():
            continue
        ext = os.path.splitext(entry.name)[1].lower()
        if ext not in IMAGE_EXTS:
            continue
        st = entry.stat()
        all_files.append(entry.path)
        file_stats[entry.path] = (st.st_mtime, st.st_size)

    all_files.sort()

    total = len(all_files)
    summary = {k: 0 for k in SUBFOLDERS}
    summary["clean"] = 0
    summary["skipped"] = 0

    if total == 0:
        if progress_callback:
            progress_callback(0, 0, "No images found in folder.")
        return summary

    # Register all files in the catalog (also resets analyzed_at when a file changed)
    if persist:
        catalog.upsert_photos(project_id, [
            {
                "filename": os.path.basename(p),
                "path": p,
                "mtime": file_stats[p][0],
                "size": file_stats[p][1],
            }
            for p in all_files
        ])

    # Split into already-analyzed (skip) and pending
    if persist:
        pending = [
            p for p in all_files
            if catalog.needs_analysis(project_id, p, file_stats[p][0], file_stats[p][1])
        ]
        skipped = total - len(pending)
        summary["skipped"] = skipped
        if skipped and progress_callback:
            progress_callback(0, total, f"Skipped {skipped} already-analyzed photos.")
    else:
        pending = list(all_files)

    if not pending:
        if progress_callback:
            progress_callback(total, total, "Done. Nothing new to analyze.")
        return summary

    _check_cancel(cancel_event)

    # --- Pass 1: Duplicate detection (needs all pending paths at once) -------
    if progress_callback:
        progress_callback(0, total, "Scanning for duplicates...")

    dup_groups = find_duplicates(pending, threshold=dup_threshold)
    duplicates = set()
    for keeper, dupes in dup_groups.items():
        _check_cancel(cancel_event)
        for dupe_path in dupes:
            fname = os.path.basename(dupe_path)
            if persist:
                catalog.set_analysis(project_id, fname, "_duplicates", ["_duplicates"], {})
            if progress_callback:
                prefix = "[Preview] " if dry_run else ""
                progress_callback(0, total, f"{prefix}Duplicate: {fname}")
            duplicates.add(dupe_path)
            summary["_duplicates"] += 1

    # --- Pass 2: Per-image analysis (multi-label with priority) --------------
    remaining = [f for f in pending if f not in duplicates]

    for i, fpath in enumerate(remaining):
        _check_cancel(cancel_event)
        fname = os.path.basename(fpath)

        if progress_callback:
            progress_callback(i + 1, total, f"Checking: {fname}")

        try:
            report = analyze_photo(fpath, thresholds=analysis_thresholds)
            scores = {
                "brightness": round(report.brightness_mean, 1),
                "blur": round(report.blur_score, 1),
                "ear": report.eye_aspect_ratio,
            }

            if report.primary_category:
                other_labels = [l for l in report.all_labels if l != report.primary_category]
                also_str = f" (also: {', '.join(other_labels)})" if other_labels else ""

                if persist:
                    catalog.set_analysis(
                        project_id, fname,
                        report.primary_category, report.all_labels, scores,
                    )
                if progress_callback:
                    prefix = "[Preview] " if dry_run else ""
                    progress_callback(i + 1, total,
                                      f"{prefix}Classified as {report.primary_category}: {fname}{also_str}")
                summary[report.primary_category] += 1
            else:
                if persist:
                    catalog.set_analysis(project_id, fname, "clean", [], scores)
                summary["clean"] += 1

            # Persist per-face quality records (Phase 3 culling)
            if persist and report.faces:
                photo_id = catalog.get_photo_id(project_id, fname)
                if photo_id is not None:
                    catalog.set_face_results(photo_id, report.faces)

        except ScanCancelled:
            raise
        except Exception as e:
            if progress_callback:
                progress_callback(i + 1, total, f"Error on {fname}: {e}")
            summary["clean"] += 1

    # --- Pass 3: AI culling — embeddings, aesthetic, stacks, auto ratings ----
    if persist:
        if progress_callback:
            progress_callback(total, total, "Running AI culling analysis...")
        import scoring
        try:
            culling = scoring.run_culling_analysis(
                project_id,
                progress_callback=progress_callback,
                cancel_event=cancel_event,
            )
            summary["stacks"] = culling["stacks"]
            summary["picks"] = culling["picks"]
        except scoring.CullingCancelled:
            raise ScanCancelled()

    if progress_callback:
        progress_callback(total, total, "Done.")

    return summary


def clear_classifications(source_dir: str, project_id: int = None) -> tuple[int, list[str]]:
    """
    Clears analysis results, resetting all photos to 'clean'.
    Returns (count_cleared, list_of_errors).
    """
    if project_id is None:
        return 0, ["No project id given."]
    return catalog.clear_analysis(project_id), []


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python organizer.py \"C:\\path\\to\\folder\"")
        sys.exit(1)

    folder = sys.argv[1]
    if not os.path.isdir(folder):
        print(f"Error: folder not found: {folder}")
        sys.exit(1)

    def cli_progress(current, total, message):
        if total > 0:
            pct = int(current / total * 100)
            print(f"[{pct:3d}%] {message}")
        else:
            print(message)

    project = catalog.get_or_create_project(os.path.basename(os.path.normpath(folder)), folder)
    print(f"Scanning: {folder} (project #{project['id']})\n")
    result = scan_and_classify(folder, progress_callback=cli_progress, project_id=project["id"])

    print("\n--- Summary ---")
    for key, count in result.items():
        print(f"  {key:15s}: {count} files")
