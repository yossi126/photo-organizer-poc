# Changelog — Photo Organizer

All notable changes to this project are documented here.

---

## [Feature] Auto-Edit quality + personal editing profile — 2026-08-26

Rebuilt Auto-Edit quality and made the app learn each user's editing style from the edits
they make in the app, then choose Standard vs their learned style at Auto-Edit time
(the Aftershoot/Imagen model). The personal profile is machine learning — a small MLP that
maps image features to develop-slider values.

### Auto-Edit quality (scene-based path)

Previously: scene → fixed preset → exposure-only solve. Now adds real per-photo correction.

| File | Changes |
|---|---|
| `python-backend/auto_edit.py` | **Auto white balance** (robust gray-world, inverts the renderer's temp/tint model, damped + clamped); **face-weighted exposure** (portraits meter the solver on the face bbox, not the global median); **content-adaptive tone recovery** (highlights/shadows/whites/blacks scaled by measured clipping); solver tuning (damping 0.7→0.85, deadband 0.3→0.15, analysis thumb 300→512px) |

### Learn from in-app edits

| File | Changes |
|---|---|
| `python-backend/training.py` | `capture_edit_sample(photo_id)` — a manual edit becomes/updates a training sample (features + sliders set); skips AI-written and no-slider edits; UNIQUE path means re-edits update, not duplicate |
| `python-backend/sidecar.py` | `handle_set_edit_settings` captures the sample in the background (non-blocking) |
| `src/App.tsx` | `handleEditSettingsChange` strips `aiEdited`/`aiScene` on manual change, so the edit records as a genuine demonstration and the Auto-Edit button reappears |
| `src/components/home/TrainingDialog.tsx` | Two data sources (in-app edits + optional XMP folders); "N edits collected" progress; trains with zero folders once ≥50 in-app edits exist |

### Standard vs My Style

| File | Changes |
|---|---|
| `src/components/cull/AutoEditDialog.tsx` | Standard / My Style selector; My Style disabled with "N/50 edits collected" hint until a trained, guard-passing model exists, then defaults to it (choice stays switchable) |
| `src/components/edit/EditTab.tsx` | Edit badge shows "🧠 My Style" for personal-model edits |
| `src/lib/sidecar.ts` | Mock: tracks in-app sample count, reports a usable model once ≥50 samples, so the flow is exercisable in browser mode |

### Tests

- `test_auto_edit_realism.py` extended with white-balance and face-metering cases (27 checks).
- `test_edit_capture.py` (new) — in-app edits become training samples, re-edits update, AI/no-slider edits skipped (14 checks).
- `test_personal_learning.py` (new) — end-to-end proof the model learns a synthetic style from 90 in-app edits and reproduces it on held-out photos (7 checks).
- Full backend suite green: 27 realism + 14 edit-capture + 7 personal-learning + 18 parity + 37 XMP.

Plan: `docs/plans/personal-editing-profile/plan.md`.

---

## [Feature] Single-image Auto Edit + home screen refresh — 2026-08-24

### Single-image Auto Edit (Develop view)

A photo with no AI edit (never auto-edited, or reverted) now shows a **✨ Auto Edit** pill in the top-right badge spot of the EDIT tab. One click runs the auto-edit engine on just that photo using the saved AI Profile (scene presets, personal model when trained) — no dialog. After it runs, the pill swaps to the existing "AI · scene" badge + Revert. The run is undoable and errors show inline.

| File | Changes |
|---|---|
| `python-backend/sidecar.py` | New `get_edit_settings` JSON-RPC command returning one photo's catalog settings |
| `src/lib/sidecar.ts` | `getEditSettings()` RPC + browser-mock case |
| `src/App.tsx` | `handleAutoEditSingle` — loads AI profile + personal-model status, runs `auto_edit` with `skipEdited: false` for the single photo, fetches the result, seeds undo history, clears pending debounced saves |
| `src/components/edit/EditTab.tsx` | `onAutoEditSingle` prop; Auto Edit pill with busy/error states, error clears on photo switch |

Plan: `docs/plans/single-image-auto-edit/plan.md`.

### Home screen polish + motion

- Emoji replaced with a consistent SVG icon set (aperture mark, plus/spark/folder/trash); AI Profile demoted to secondary button.
- Skeleton loading rows, dashed empty state, alert-style errors, focus rings, keyboard-operable project rows, contrast fixes, LTR-forced folder paths, relative dates.
- Authored entrance animation: aperture rotates open, card + sections cascade in (<0.5s); row stagger, button press feedback, `prefers-reduced-motion` fade-only path (`src/index.css`, `HomeScreen.tsx`).

---

## [Feature] Lightroom-style Edit UI — 2026-03-02

### Professional Develop Module (complete Edit tab redesign)

The Edit tab has been redesigned from a basic panel layout into a full **Lightroom-style Develop Module** with a three-column layout, tabbed controls, live histogram, and a preset system.

### New files

- **`src/components/edit/EditLeftPanel.tsx`** — 200px left panel with a search bar, 8 one-click presets (Cinematic Warm, Moody Desaturated, Clean Portrait, Vivid Landscape, B&W Classic, Faded Film, High Contrast, Soft Pastel), and collapsible Snapshots / History sections.

### Modified files

| File | Changes |
|---|---|
| `src/index.css` | Added `.lr-slider` CSS class — 2px transparent track (real track is a `div`), circular 11px thumb, blue `#4a9eff` glow when adjusted, thin `.lr-panel-scroll` scrollbar for all panels |
| `src/components/edit/panel/EditSlider.tsx` | Complete visual redesign: custom track `div` behind a transparent native `<input type="range">`; bipolar sliders fill from center outward; unipolar fill left-to-thumb; blue fill + monospace value display when adjusted |
| `src/components/edit/panel/PanelSection.tsx` | Uppercase small-caps section titles with animated chevron; "Reset" text button on the right |
| `src/components/edit/EditTopBar.tsx` | New **Library / Develop** module tabs (Library = back to grid); clickable gold 5-star rating inline with filename; zoom % badge; undo/redo placeholders; layout toggle icons |
| `src/components/edit/EditFilmstrip.tsx` | Blue 2px border on selected thumbnail; colored category dot badges; star rating overlay; **status bar** below the strip showing `"N photos • Develop Module"` and current filename |
| `src/components/edit/EditRightPanel.tsx` | Canvas-based **RGB histogram** at top (bell curves driven by `scores.brightness`); **BASIC / TONE CURVE / HSL/COLOR / DETAIL** tab bar; sections reorganised per tab; Photo Info moved inside BASIC (collapsed by default); Copy / Paste / Reset actions moved to bottom |
| `src/components/edit/EditTab.tsx` | Wires in `EditLeftPanel`; passes `zoom`, `stars`, `onRatingChange` to `EditTopBar`; floating bottom zoom controls removed (zoom % now lives in the top bar) |

### Preset system

Clicking a preset in the left panel immediately applies a predefined `EditSettings` partial over `DEFAULT_EDIT_SETTINGS`. The active preset is highlighted with a blue left border.

| Preset | Key adjustments |
|---|---|
| Cinematic Warm | +0.3 EV, +20 contrast, shadows +30, temp 6800K, vibrance +20 |
| Moody Desaturated | −0.5 EV, +30 contrast, highlights −50, saturation −60 |
| Clean Portrait | +0.2 EV, clarity +10, shadows +20, vibrance +15 |
| Vivid Landscape | vibrance +50, saturation +20, shadows +40, clarity +25 |
| B&W Classic | saturation −100, contrast +20, clarity +15 |
| Faded Film | +0.5 EV, contrast −20, blacks +30 |
| High Contrast | contrast +60, highlights −30, shadows −30, clarity +30 |
| Soft Pastel | +0.8 EV, contrast −15, shadows +50, saturation −20 |

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
