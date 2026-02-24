"""
organizer.py — Scan loop, subfolder creation, and file-move logic.

Run directly for CLI testing (no GUI needed):
    python organizer.py "C:\\path\\to\\folder"
"""

import os
import shutil

from detectors import is_dark, is_blurry, has_closed_eyes, find_duplicates


SUBFOLDERS = ["_duplicates", "_dark", "_blurry", "_eyes_closed"]
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"}


def _ensure_subfolders(source_dir: str):
    """Create the four output subfolders if they don't already exist."""
    for name in SUBFOLDERS:
        os.makedirs(os.path.join(source_dir, name), exist_ok=True)


def _safe_move(src: str, dst_dir: str) -> str:
    """
    Move src into dst_dir. If a file with the same name already exists
    in the destination, append _1, _2, etc. to avoid overwriting.
    Returns the final destination path.
    """
    name = os.path.basename(src)
    base, ext = os.path.splitext(name)
    dst = os.path.join(dst_dir, name)

    counter = 1
    while os.path.exists(dst):
        dst = os.path.join(dst_dir, f"{base}_{counter}{ext}")
        counter += 1

    shutil.move(src, dst)
    return dst


def scan_and_organize(source_dir: str, progress_callback=None) -> dict:
    """
    Scans source_dir for images, detects problems, and moves them into
    categorized subfolders.

    progress_callback(current: int, total: int, message: str) — called
    after each file is processed. Optional.

    Returns a summary dict:
        { "_duplicates": N, "_dark": N, "_blurry": N, "_eyes_closed": N, "clean": N }
    """
    # --- Collect image files (top-level only, skip _ subfolders) -----------
    all_files = []
    for entry in os.scandir(source_dir):
        if not entry.is_file():
            continue
        ext = os.path.splitext(entry.name)[1].lower()
        if ext not in IMAGE_EXTS:
            continue
        # Skip files that are already inside one of our output subfolders.
        # Check the parent directory name, not the filename itself, to avoid
        # accidentally skipping files like "test_dark.jpg" or "test_blurry.jpg".
        if os.path.basename(os.path.dirname(entry.path)) in SUBFOLDERS:
            continue
        all_files.append(entry.path)

    all_files.sort()  # Consistent ordering (affects which duplicate is "kept")

    total = len(all_files)
    summary = {k: 0 for k in SUBFOLDERS}
    summary["clean"] = 0
    moved = set()

    if total == 0:
        if progress_callback:
            progress_callback(0, 0, "No images found in folder.")
        return summary

    _ensure_subfolders(source_dir)

    # --- Pass 1: Duplicate detection (needs all paths at once) -------------
    if progress_callback:
        progress_callback(0, total, "Scanning for duplicates...")

    dup_groups = find_duplicates(all_files)
    for keeper, dupes in dup_groups.items():
        for dupe_path in dupes:
            try:
                _safe_move(dupe_path, os.path.join(source_dir, "_duplicates"))
                moved.add(dupe_path)
                summary["_duplicates"] += 1
            except Exception as e:
                if progress_callback:
                    progress_callback(0, total, f"Error moving {os.path.basename(dupe_path)}: {e}")

    # --- Pass 2: Per-image checks on remaining files -----------------------
    remaining = [f for f in all_files if f not in moved]

    for i, fpath in enumerate(remaining):
        fname = os.path.basename(fpath)

        if progress_callback:
            progress_callback(i + 1, total, f"Checking: {fname}")

        try:
            if is_dark(fpath):
                _safe_move(fpath, os.path.join(source_dir, "_dark"))
                summary["_dark"] += 1
                moved.add(fpath)
                continue

            if is_blurry(fpath):
                _safe_move(fpath, os.path.join(source_dir, "_blurry"))
                summary["_blurry"] += 1
                moved.add(fpath)
                continue

            if has_closed_eyes(fpath):
                _safe_move(fpath, os.path.join(source_dir, "_eyes_closed"))
                summary["_eyes_closed"] += 1
                moved.add(fpath)
                continue

            summary["clean"] += 1

        except Exception as e:
            if progress_callback:
                progress_callback(i + 1, total, f"Error on {fname}: {e}")
            summary["clean"] += 1  # Leave file in place on error

    if progress_callback:
        progress_callback(total, total, "Done.")

    return summary


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
    result = scan_and_organize(folder, progress_callback=cli_progress)

    print("\n--- Summary ---")
    for key, count in result.items():
        print(f"  {key:15s}: {count} files")
