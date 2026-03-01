# Changelog — Photo Organizer

All notable changes to this project are documented here.

---

## [Tauri Migration] — 2026-03-01

### Architecture: Tauri + React + TypeScript (complete rewrite of the UI)

The entire GUI has been migrated from CustomTkinter (Python) to **Tauri v2 + React + TypeScript**. The Python detection engine runs as a **sidecar process** communicating via JSON-RPC over stdin/stdout. No Python detection code was changed.

**Why:** CustomTkinter hit a hard performance wall at ~80 photos due to synchronous geometry recalculations. The new architecture uses virtual scrolling (react-virtuoso) and renders only visible thumbnails, handling 1000+ photos smoothly.

### New project structure

```
photo-organizer-poc/
├── src/                  # React + TypeScript frontend
├── src-tauri/            # Tauri (Rust) shell
├── python-backend/       # Python sidecar (detection engine)
├── legacy/               # Archived old CustomTkinter GUI
├── docs/                 # Documentation
└── e2e/                  # Playwright test scaffolding
```

### Frontend (React + TypeScript)

- **Home Screen** — folder picker via native Tauri dialog, New Scan / Resume Project buttons.
- **Import Tab** — threshold sliders (dark, blur, overexposed, duplicates, eyes-closed EAR), dry-run toggle, progress bar, activity log. Auto-switches to Cull tab on scan completion.
- **Cull Tab** — virtual-scrolling thumbnail grid (react-virtuoso), 7 category filter buttons with live counts, star rating filter, click-to-edit navigation.
- **Edit Tab** — full photo preview, score panels (brightness, blur, EAR), clickable 5-star rating, reclassify buttons, keyboard navigation (Left/Right arrows).
- **Browser mock mode** — when opened without Tauri (e.g. `npm run dev`), all sidecar calls return fake data for UI development and Playwright testing.

### Sidecar communication (src/lib/sidecar.ts + python-backend/sidecar.py)

- `sidecar.py` — JSON-RPC wrapper: reads `{"method": "scan", "params": {...}}` from stdin, calls Python backend functions, streams progress events, writes JSON results to stdout.
- `sidecar.ts` — spawns Python via Tauri shell plugin, manages stdin/stdout pipe communication, line buffering, and message routing.
- Rust `get_sidecar_config` command — locates project root, finds venv Python path, returns config to frontend so the correct Python interpreter is used.
- Forced line-buffered I/O on Windows pipes to prevent stdin/stdout buffering issues.
- Supports: `scan`, `list_photos`, `thumbnail`, `set_rating`, `reclassify`, `clear` commands.

### Tauri (Rust shell)

- `lib.rs` — `find_project_root()` walks up from exe directory to locate `python-backend/sidecar.py`. `get_sidecar_config()` returns backend_dir, venv Python path, and system PATH for sidecar spawning.
- Shell scope configured in `capabilities/default.json` — allows spawning `python` with any arguments.
- Plugins: `dialog` (native folder picker), `shell` (sidecar management), `fs` (file access), `opener` (URL opening).

### Python backend changes

- **sidecar.py** (new) — JSON-RPC wrapper, ~250 lines. Handles all commands, error recovery, and stderr logging for debugging.
- **organizer.py** — no code changes, moved to `python-backend/`.
- **detectors.py** — no code changes, moved to `python-backend/`.
- `sys.path` fix in sidecar.py ensures imports work regardless of working directory.
- `customtkinter` removed from requirements (no longer needed).

### Configuration files

- `tauri.conf.json` — window 1200x800, title "Photo Organizer", CSP disabled for dev.
- `vite.config.ts` — React + Tailwind v4 plugins.
- `package.json` — React 19, react-virtuoso, Tailwind CSS v4, Vite 7, Tauri v2 plugins.

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
- Added: `mediapipe`, `rawpy`, `onnxruntime`
- Kept: `opencv-contrib-python==4.10.0.84`, `imagehash==4.3.1`, `Pillow==10.4.0`
- Removed: `customtkinter==5.2.2` (no longer needed — GUI is now React)

---

## [Initial] — 2026-02-24 (commit: `d6c3f9c`)

- Project plan written (`docs/PLAN.md`).
- Tech stack selected: `customtkinter`, `opencv-python`, `imagehash`, `Pillow`.
- Initial commit with Claude settings and plan only — no working code yet.

---

## [Bootstrap] — 2026-02-24 (commit: `2438779`)

- Repository created: `photo-organizer-poc` on GitHub (`yossi126/photo-organizer-poc`).
