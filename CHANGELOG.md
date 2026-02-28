# Changelog — Photo Organizer POC

All notable changes to this project are documented here.

---

## [Current] — 2026-02-28

### Architecture: Non-Destructive Classification (major redesign)
- **No files are moved anymore.** All organization is now virtual — results are stored in
  `_classifications.json` inside the scanned folder.
- Photos remain in their original location; the app reads the JSON on next launch and
  restores the previous session automatically (existing project detection on the home screen).
- Added `clear_classifications()` to `organizer.py` to reset all classifications back to clean.

### New Detectors

| Detector | Change |
|---|---|
| **Overexposed** | New detector — flags images with mean brightness > 220. Previously only darkness was detected. |
| **Eyes Closed (MediaPipe)** | Replaced OpenCV Haar cascades with **MediaPipe FaceLandmarker** (`face_landmarker.task`). Uses Eye Aspect Ratio (EAR) for much higher accuracy. Threshold: EAR < 0.18. |
| **Eyes Closed (YuNet fallback)** | Added `face_detection_yunet.onnx` as a secondary face detector for tilted/downward-looking faces that MediaPipe's FaceLandmarker misses. |
| **RAW file support** | Added `rawpy` support — `.cr2`, `.cr3`, `.nef`, `.arw`, `.dng`, and other RAW camera formats can now be scanned. |
| **Blur (CLAHE + region-aware)** | Blur detection now applies CLAHE normalization before Laplacian. When faces are detected, uses only the face ROI instead of the whole image (prevents bokeh backgrounds from being mistakenly flagged). |

### Multi-Label Detection
- `analyze_photo()` now runs **all detectors on every photo** and records all matching labels.
- A **priority order** determines the primary category:
  `_blurry` > `_eyes_closed` > `_dark` > `_overexposed`
- The full list of labels and raw scores (brightness, blur, EAR) are saved to `_classifications.json`.

### GUI — Full Redesign

**Home Screen**
- Folder picker with detection of existing projects (shows "Resume" button if `_classifications.json` is found).

**Review Screen — 3-tab layout**
- **IMPORT tab** — scan progress bar, log output, threshold controls (dark, blur, overexposed, duplicates, eyes-closed EAR), "Preview" dry-run mode, and "Clear & Rescan" button.
- **CULL tab** — scrollable thumbnail grid with:
  - 7 category filter buttons (All / Clean / Blurry / Dark / Overexposed / Eyes Closed / Duplicates), each showing a live count badge.
  - 5-star rating system per photo (persisted to `_ratings.json`).
  - Category color badges on each thumbnail.
  - "Min stars" filter dropdown.
  - Manual reclassify: click a photo → Edit tab opens with a category override dropdown.
- **EDIT tab** — single photo view with full metadata panel (scores, all labels), reclassify dropdown, and star rating.

**Thumbnail Loading (ThumbnailLoader)**
- Background thread pool (4 workers) for non-blocking thumbnail decoding.
- EXIF orientation correction applied automatically.
- In-memory thumbnail cache to avoid re-decoding on filter switches.
- Separate `cancel_and_load()` vs `load_entries()` methods to avoid cancelling
  already-in-flight loads when switching categories.

**VirtualGrid**
- Cells are created once and cached — category filter switches use `grid_remove`/`grid`
  (hide/show) instead of destroy+recreate, keeping the UI responsive.
- Batch cell creation (25 cells per event-loop tick) to prevent UI freezing on large folders.
- Eager thumbnail pre-fetching: all entries in the current filter are submitted to the
  loader immediately so thumbnails are ready before the user scrolls to them.

### organizer.py
- Renamed `scan_and_organize()` → `scan_and_classify()` (no longer moves files).
- Added `dry_run=True` mode (preview scan without writing `_classifications.json`).
- Added `thresholds` parameter to pass all detector thresholds from the GUI.
- Added support for RAW extensions in `IMAGE_EXTS`.

### detectors.py
- Added `PhotoReport` dataclass — carries raw scores, all boolean flags, all labels, and primary category.
- Added `analyze_photo(path, thresholds)` — single entry-point that runs all detectors and returns a `PhotoReport`.
- Added `_load_pil()` helper for RAW-aware PIL loading (used by duplicate hashing).
- Duplicate hashing now thumbnails images to 512px before hashing for faster performance on large files.

### requirements.txt
- Added: `mediapipe`, `rawpy`
- Kept: `opencv-python==4.10.0.84`, `imagehash==4.3.1`, `Pillow==10.4.0`, `customtkinter==5.2.2`

---

## [Initial] — 2026-02-24 (commit: `d6c3f9c`)

- Project plan written (`docs/PLAN.md`).
- Tech stack selected: `customtkinter`, `opencv-python`, `imagehash`, `Pillow`.
- Initial commit with Claude settings and plan only — no working code yet.

---

## [Bootstrap] — 2026-02-24 (commit: `2438779`)

- Repository created: `photo-organizer-poc` on GitHub (`yossi126/photo-organizer-poc`).

---

## Known Issues / Open Problems

### 🐛 UI Slowness When Switching Between Category Filters (UNRESOLVED)

**Symptom:** When clicking a category filter button (e.g. switching from "All Photos" to
"Blurry"), there is a noticeable lag before the thumbnail grid updates. The delay is most
visible when the folder contains a large number of photos (100+).

**Root cause analysis:**
The `VirtualGrid` already uses cell caching (`grid_remove`/`grid` instead of
destroy+recreate) and background thumbnail loading. However, several bottlenecks remain:

1. **Tkinter grid layout is slow on large cell counts.** Even hiding/showing 200+ cells
   via `grid_remove`/`grid` in a single event-loop tick causes a measurable freeze because
   Tkinter processes each geometry manager call synchronously on the main thread.

2. **Thumbnail cache miss on first visit to a category.** Despite eager pre-fetching,
   thumbnails that haven't finished loading yet still appear as gray placeholders, and
   the visible "pop-in" as they load one-by-one feels slow.

3. **`CTkScrollableFrame` canvas recalculation.** After showing/hiding many cells,
   the inner canvas triggers a full `configure` + scroll region recalculation which
   blocks the main thread.

**Approaches attempted:**
- Batch cell creation (25/tick) — helps for initial load, but doesn't fix filter-switch lag.
- Separate `load_entries()` / `cancel_and_load()` to preserve in-flight thumbnail loads.
- Generation counter on `ThumbnailLoader` to drop stale callbacks.

**Approaches not yet tried that may help:**
- True virtualization: only create/show cells that are currently in the visible viewport
  (requires calculating scroll position and dynamically creating/destroying cells on scroll).
- `canvas.create_image()` grid instead of `CTkFrame` cells — native canvas items are
  significantly faster than Tkinter widget trees for large grids.
- Pre-rendering all category views to off-screen canvases and swapping them in on click.

**Status:** Unresolved. The current implementation is acceptable for folders up to ~80
photos. Performance degrades noticeably above that.
