"""
organizer.py — Scan loop and classification logic.

Analyzes images and stores results in _classifications.json.
No files are moved — all organization is virtual (metadata only).

Run directly for CLI testing (no GUI needed):
    python organizer.py "C:\\path\\to\\folder"
"""

import json
import os

from detectors import analyze_photo, find_duplicates


SUBFOLDERS = ["_duplicates", "_dark", "_overexposed", "_blurry", "_eyes_closed"]
IMAGE_EXTS = {
    ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp",
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
CLASSIFICATIONS_FILE = "_classifications.json"


def scan_and_classify(
    source_dir: str,
    progress_callback=None,
    thresholds: dict = None,
    dry_run: bool = False,
) -> dict:
    """
    Scans source_dir for images, detects problems, and records classifications
    in _classifications.json. No files are moved.

    Uses multi-label detection with priority-based assignment:
        _blurry > _eyes_closed > _dark > _overexposed
    (unfixable problems take priority over fixable ones)

    thresholds: dict with optional keys:
        "dark"       (int,   default 85)
        "blur"       (float, default 50.0)  — Laplacian variance threshold
        "duplicates" (int,   default 5)

    Returns a summary dict:
        { "_duplicates": N, "_dark": N, "_blurry": N, "_eyes_closed": N, "clean": N }
    """
    th = thresholds or {}
    dup_threshold = th.get("duplicates", 5)

    # Build thresholds dict for analyze_photo
    analysis_thresholds = {
        "dark": th.get("dark", 85),
        "blur": th.get("blur", 50.0),
        "overexposed": th.get("overexposed", 220),
        "eyes_closed": th.get("eyes_closed", 0.18),
    }

    # --- Collect image files (top-level only) --------------------------------
    all_files = []
    for entry in os.scandir(source_dir):
        if not entry.is_file():
            continue
        ext = os.path.splitext(entry.name)[1].lower()
        if ext not in IMAGE_EXTS:
            continue
        all_files.append(entry.path)

    all_files.sort()

    total = len(all_files)
    summary = {k: 0 for k in SUBFOLDERS}
    summary["clean"] = 0
    classifications = {}  # basename -> {primary_category, all_labels, scores}

    if total == 0:
        if progress_callback:
            progress_callback(0, 0, "No images found in folder.")
        return summary

    # --- Pass 1: Duplicate detection (needs all paths at once) ---------------
    if progress_callback:
        progress_callback(0, total, "Scanning for duplicates...")

    dup_groups = find_duplicates(all_files, threshold=dup_threshold)
    duplicates = set()
    for keeper, dupes in dup_groups.items():
        for dupe_path in dupes:
            fname = os.path.basename(dupe_path)
            if not dry_run:
                classifications[fname] = {
                    "primary_category": "_duplicates",
                    "all_labels": ["_duplicates"],
                    "scores": {},
                }
            if progress_callback:
                prefix = "[Preview] " if dry_run else ""
                progress_callback(0, total, f"{prefix}Duplicate: {fname}")
            duplicates.add(dupe_path)
            summary["_duplicates"] += 1

    # --- Pass 2: Per-image analysis (multi-label with priority) --------------
    remaining = [f for f in all_files if f not in duplicates]

    for i, fpath in enumerate(remaining):
        fname = os.path.basename(fpath)

        if progress_callback:
            progress_callback(i + 1, total, f"Checking: {fname}")

        try:
            report = analyze_photo(fpath, thresholds=analysis_thresholds)

            if report.primary_category:
                other_labels = [l for l in report.all_labels if l != report.primary_category]
                also_str = f" (also: {', '.join(other_labels)})" if other_labels else ""

                if not dry_run:
                    classifications[fname] = {
                        "primary_category": report.primary_category,
                        "all_labels": report.all_labels,
                        "scores": {
                            "brightness": round(report.brightness_mean, 1),
                            "blur": round(report.blur_score, 1),
                            "ear": report.eye_aspect_ratio,
                        },
                    }
                if progress_callback:
                    prefix = "[Preview] " if dry_run else ""
                    progress_callback(i + 1, total,
                                      f"{prefix}Classified as {report.primary_category}: {fname}{also_str}")
                summary[report.primary_category] += 1
            else:
                summary["clean"] += 1

        except Exception as e:
            if progress_callback:
                progress_callback(i + 1, total, f"Error on {fname}: {e}")
            summary["clean"] += 1

    if progress_callback:
        progress_callback(total, total, "Done.")

    # Save classifications (only in real scan mode)
    if not dry_run and classifications:
        class_path = os.path.join(source_dir, CLASSIFICATIONS_FILE)
        with open(class_path, "w", encoding="utf-8") as f:
            json.dump(classifications, f, ensure_ascii=False, indent=2)

    return summary


def clear_classifications(source_dir: str) -> tuple[int, list[str]]:
    """
    Clears the classifications file, resetting all photos to 'clean'.
    Returns (count_cleared, list_of_errors).
    """
    class_path = os.path.join(source_dir, CLASSIFICATIONS_FILE)
    if not os.path.exists(class_path):
        return 0, ["No classifications file found. Nothing to clear."]

    try:
        with open(class_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        count = len(data)
        os.remove(class_path)
        return count, []
    except Exception as e:
        return 0, [str(e)]


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

    print(f"Scanning: {folder}\n")
    result = scan_and_classify(folder, progress_callback=cli_progress)

    print("\n--- Summary ---")
    for key, count in result.items():
        print(f"  {key:15s}: {count} files")
