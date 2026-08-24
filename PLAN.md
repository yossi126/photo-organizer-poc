# PLAN — Photo Organizer → Production AI Culling & Editing App (v1.0)

> **הוראה למימוש:** בתחילת המימוש, שמור עותק של קובץ זה כ-`PLAN.md` בשורש הריפו, וסמן משימות שהושלמו ב-checkbox. התוכנית מיועדת למימוש ע"י מודל Sonnet — כל משימה מפורטת עם קבצים ותנאי קבלה.

## Context — למה ומה

The current repo is a working **POC**: Tauri v2 + React 19 + Python sidecar that scans a folder, flags bad photos (blur/dark/overexposed/eyes-closed/duplicates), and shows a Lightroom-style edit UI. The goal is to evolve it into a **commercial product competing with AfterShoot / Imagen AI**: AI culling (stacks, best-shot, auto star ratings), AI editing that **learns the photographer's personal style** from their past Lightroom edits, Lightroom preset (.xmp) import, full project save/resume, and export as both **rendered JPEG and XMP sidecars** (so Lightroom opens photos with the edits applied).

**Confirmed user decisions:** commercial product (installer, licensing, updates) · full local ML model for style learning (PyTorch train → ONNX inference, like Imagen/AfterShoot "Personal AI Profiles") · export = JPEG **and** XMP · the "appointment scheduling" sentence in the request was a mistake — ignore it.

### Critical gaps found in exploration (the honest state of the POC)

1. **Edit rendering is fake.** `buildCssFilter()` in `src/components/edit/EditTab.tsx` maps ~6 CSS filters onto ~60 `EditSettings` fields. HSL (24 sliders), tone curve, detail, calibration, whites/blacks, dehaze — **have zero visual effect**. No canvas/WebGL, no export of edited images at all.
2. **Edits are not persisted.** `editSettingsMap` lives in `App.tsx` useState only — lost on close. Only ratings (`_ratings.json`) and classifications (`_classifications.json`) persist, as per-folder JSON.
3. **No real AI culling.** Only threshold CV (Laplacian blur, grayscale mean, EAR eyes-closed, dHash dupes). No stacks, no best-shot, no aesthetic scoring, no auto stars, no keyboard-driven review.
4. **No XMP anywhere.** No preset import, no sidecar export, no Lightroom integration.
5. **Sidecar is single-threaded & serial** — a scan blocks thumbnails/ratings; no cancellation; scans are non-incremental. RAW thumbnails **fail** (thumbnail handlers use PIL directly, only `detectors._load` handles rawpy).
6. **Not packageable** — Python sidecar is not bundled (dev venv only), no installer wiring, CSP null, no updater, no licensing.

### Competitor benchmark (research summary)

| Capability | AfterShoot | Imagen | Narrative Select | **Target for us** |
|---|---|---|---|---|
| Processing | Local | Cloud | Local | **Local** |
| Culling | Full auto: dup stacks, key faces, eyes/focus flags, auto ratings | Learns from user's past culls | Assisted, fastest RAW preview | Stacks + per-face quality + auto stars + keyboard review |
| AI editing | Personal profiles from LR catalog (2,500–5,000 edits recommended), instant profiles | Personal AI Profile: NN reads XMP slider settings of past edits, generates per-photo settings | None | Phase 1: scene-conditioned presets → Phase 2: personal trained model |
| Output | XMP to Lightroom + in-app export/retouch | XMP to Lightroom | Selection only | JPEG + XMP sidecars |

Sources: [aftershoot.com](https://aftershoot.com/), [Aftershoot 2026 review — Photofocus](https://photofocus.com/reviews/aftershoot-2026-review-more-than-just-a-culling-tool/), [Fstoppers — Aftershoot full workflow](https://fstoppers.com/software/aftershoot-just-became-entire-ai-photography-workflow-903026), [Imagen — AfterShoot vs Narrative vs Imagen](https://imagen-ai.com/valuable-tips/aftershoot-vs-narrative-select-vs-imagen/), [narrative.so comparison](https://narrative.so/compare/aftershoot-vs-narrative), [FindMe culling comparison 2026](https://findme.photo/blog/aftershoot-vs-narrative-vs-imageai-culling-comparison-2026), [Imagen — AI Lightroom presets / Personal AI Profile](https://imagen-ai.com/valuable-tips/ai-lightroom-presets/)

---

## Architecture decisions (locked)

- **D1 — Edit engine: Hybrid.** WebGL2 fragment-shader pipeline for real-time preview (WebView2's WebGPU is not reliable yet) + identical math re-implemented in Python (numpy float32) for full-res export. Both implement one written spec (`docs/render-pipeline.md`); parity enforced by golden-image tests (mean ΔE < 2). For RAW: Python decodes once with **fixed rawpy params** (camera WB, sRGB, no auto-bright) → cached ≤2560px "preview base" JPEG for the frontend; export re-decodes full-res with the same params.
- **D2 — Persistence: single SQLite catalog** at the OS app-data dir (`platformdirs`), owned by the Python sidecar (stdlib `sqlite3`, WAL mode). Tables: `projects`, `photos` (incl. embedding blob), `stacks`, `face_results`, `edit_settings`, `presets`, `ai_profiles`, `training_samples`, `thumb_cache`, `schema_version`. Legacy `_classifications.json`/`_ratings.json` auto-imported then renamed `.bak`.
- **D3 — Personal AI model:** frozen **MobileNetV3-Large ONNX** backbone (~20MB) embedding + RGB/luma histograms + EXIF vector (log-ISO, log-shutter, aperture, focal, flash) → MLP head (≈1461→512→256→55) regressing ~55 normalized slider values with per-sample masks. Train locally with PyTorch CPU (AdamW, masked MSE, early stopping); export head to ONNX; inference via existing onnxruntime. Training data: **image+XMP sidecar pairs** (v1.0); direct `.lrcat` parsing deferred to v1.x (undocumented schema). UI guidance: minimum 500 pairs, recommend 2,500–5,000 (matches AfterShoot's guidance).
- **D4 — XMP:** one module `python-backend/xmp_mapping.py` with a declarative table `CRS_MAP` mapping Adobe `crs:*` fields ↔ `EditSettings` (Temperature, Tint, Exposure2012…Blacks2012, Texture, Clarity2012, Dehaze, Vibrance, Saturation, Sharpness×4, noise×2, 24 HSL `Hue/Sat/LuminanceAdjustment{Red..Magenta}`, calibration, CameraProfile, `ToneCurvePV2012{,Red,Green,Blue}`). Write `ProcessVersion="15.4"`; on read accept PV≥11 and warn/skip PV2010 legacy fields. Used by preset import + sidecar export + training ingestion (one mapping, three features).
- **D5 — Sidecar scaling: keep ONE Python process**, add: reader thread + dispatch queue, `ThreadPoolExecutor(4)` for GIL-releasing work (opencv/rawpy/onnxruntime), `ProcessPoolExecutor(cpu-1)` for scan/export/training, per-job cancel `threading.Event`, `cancel_job` method, id-tagged progress events. Frontend switches from FIFO matching to id-based promise Map.
- **D6 — Packaging: PyInstaller onedir** (not onefile — 1.5s vs 8-15s startup, fewer antivirus flags), bundled via Tauri `bundle.resources` (onedir can't be `externalBin`), NSIS per-user installer, `tauri-plugin-updater` wired with placeholder endpoint, Ed25519-signed offline license file + 14-day trial. PyTorch CPU adds ~600MB — accepted for v1.0, top slimming target for v1.x.
- **D7 — Culling:** embedding cosine-similarity (≈0.90) + capture-time gap ≤8s → union-find **stacks** (dHash kept as prefilter); per-face quality (crop sharpness, EAR, smile via MediaPipe blendshapes); **NIMA-style aesthetic ONNX** score; auto stars = weighted blend (technical 50% / aesthetic 30% / face 20%) with per-project percentile calibration; best-in-stack auto-pick; keyboard-first review (P/X/U, 0–5, arrows, S).

### Critical existing files (contracts to respect)
- `src/types/photo.ts` — `EditSettings` (~60 fields, lines 63–108): the shared contract for renderer, XMP mapping, and ML output. Extend, don't break.
- `src/lib/sidecar.ts` — RPC client + **browser mock mode** (keep the mock in sync at every phase; it powers dev & Playwright).
- `python-backend/sidecar.py` — line-JSON protocol (`{id, method, params}` / progress events / `{id, result|error}`).
- `python-backend/detectors.py` — `analyze_photo()`, `_load()`/`_load_pil()` RAW-aware loaders (never use `cv2.imread` — non-ASCII paths).
- `python-backend/organizer.py` — scan loop; `src-tauri/src/lib.rs` — `get_sidecar_config()` venv resolution.

---

## Phase 0 — Sidecar job architecture + SQLite catalog + project save/resume  (Size: L)

**Goal:** concurrency-safe cancellable RPC; durable catalog; projects fully save/resume (edits + stars + culling). Everything else builds on this.

- [x] **0.1 Protocol v2** — `python-backend/sidecar.py`: reader thread → request queue → dispatcher → `ThreadPoolExecutor(4)`; single write-locked stdout writer; add `cancel_job(id)`; long loops check per-job cancel Event between items; progress events `{"id", "event":"progress", "current", "total", "detail"}`.
- [x] **0.2 Frontend RPC rewrite** *(note: the client was already id-correlated; added AbortSignal cancellation, project API, localStorage-backed mock)* — `src/lib/sidecar.ts`: `Map<id, {resolve, reject, onProgress}>`; export `callWithProgress(method, params, onProgress, signal?: AbortSignal)`. Update all call sites (`useSidecar.ts`, `useScan.ts`, `useThumbnails.ts`). **Update the browser mock to echo ids** — run existing flows in `npm run dev` to verify.
- [x] **0.3 Catalog DB** — new `python-backend/catalog.py`: `platformdirs` app-data dir (add to `requirements.txt`), schema v1 (tables per D2), WAL, all DB access via this module. Auto-import legacy `_classifications.json`/`_ratings.json` on first scan of a folder, rename to `.bak`.
- [x] **0.4 Project CRUD** — sidecar methods `create_project(name, folder)`, `list_projects`, `open_project(id)` (returns photos + culling + ratings + edit settings), `delete_project(id)`. Scan writes per-photo rows keyed by project; **skip photos whose (path, mtime, size) already analyzed** → incremental/resumable scans for free.
- [x] **0.5 Edit-settings persistence** — methods `set_edit_settings(photo_id, json)` / hydration via `open_project`; `App.tsx` debounces writes (500ms) on `editSettingsMap` change. Move ratings off `_ratings.json` into DB.
- [x] **0.6 Project picker UI** — `src/components/home/HomeScreen.tsx` → recent-projects list + "New project"; `App.tsx` gains `currentProject`; IMPORT scans into current project.
- [x] **0.7 Thumbnail disk cache + RAW fix** — new `python-backend/thumbs.py`: render once to `app-data/thumbs/{sha1(path)}_{size}.jpg`, index in `thumb_cache`; RAW-aware loading (try `rawpy.extract_thumb` embedded thumbnail first, fall back to half_size decode). `thumbnails_batch` runs in thread pool.

**Acceptance:** scan 500 mixed JPEG+RAW → RAW thumbs render; kill app mid-scan → rescan skips analyzed photos; edit + rate a photo → restart → project reopens with edits & stars intact; thumbnails respond *during* a scan; `cancel_job` stops a scan ≤2s; mock mode still works in browser.

## Phase 1 — Real edit engine + JPEG export  (Size: XL — highest risk, budget contingency here)

**Goal:** every `EditSettings` field visibly works in preview at 60fps; full-res export matches preview.

- [x] **1.1 Pipeline spec** — new `docs/render-pipeline.md`: exact op order & formulas — decode → (RAW: fixed rawpy postprocess) → WB (temp/tint as linear channel multipliers via mired shift) → exposure (2^EV linear) → tone (contrast/highlights/shadows/whites/blacks as luminance-masked curves — document exact splines) → tone curve (monotone cubic, point + per-channel) → texture/clarity (unsharp mask on luminance, mid/large radius) → dehaze (contrast+sat approximation) → HSL (8 hue ranges w/ smooth falloff) → vibrance/saturation → calibration → sharpen/NR → sRGB encode. **This doc is the contract; both renderers are implemented from it, not from each other.**
- [x] **1.2 WebGL2 preview** — new `src/lib/render/`: `gl.ts` (context+fullscreen quad), `shaders/develop.frag.glsl` (über-shader, uniforms for all settings), `luts.ts` (CPU-built 1D tone-curve + HSL LUT textures), `renderer.ts` (`render(image, settings, canvas)`). Replace `<img>` + `buildCssFilter()` in `EditTab.tsx` with `<canvas>`, render on rAF when settings change. Texture/clarity/sharpen = second pass (separable blur FBO). Delete `buildCssFilter` or keep only for grid micro-previews.
- [x] **1.3 RAW preview base** — sidecar method `preview_image(photo_id, max_px=2560)` → cached q92 JPEG with spec's fixed rawpy params; EditTab full-res path uses this for RAW (JPEGs still direct).
- [x] **1.4 Python renderer** — new `python-backend/render.py`: numpy float32 per spec; method `export_photos(photo_ids, dest_dir, format, quality, max_px)` in ProcessPool with progress events.
- [x] **1.5 Parity harness** *(measured: mean ΔE ≤ 0.29, p99 ≤ 0.65 on all 18 combos — far under the <2 target)* — `python-backend/tests/test_render_parity.py` + dev-only frontend page that renders fixtures via WebGL and dumps pixels; assert mean ΔE<2, max<6. **Note:** we target internal consistency, not pixel-identical-to-Lightroom (their tone math is proprietary).
- [x] **1.6 UI completion** — Tone Curve panel (new `src/components/edit/panel/ToneCurvePanel.tsx`, draggable points; add `toneCurve` fields to `EditSettings`); real undo/redo (per-photo history stack, new `src/hooks/useEditHistory.ts`); before/after (`\`) renders default settings; copy/paste across photos (exists — verify still works).
- [x] **1.7 Export dialog** — new `src/components/export/ExportDialog.tsx`: destination, quality, resize, filename pattern; progress toast from job events.

**Acceptance:** every slider produces a visible correct-direction change at 60fps on a 24MP image; export 50 RAW→JPEG and spot-compare 5 against preview (visually indistinguishable); undo/redo 20 steps; tone curve persists & exports.

## Phase 2 — XMP: preset import + Lightroom sidecar export  (Size: M)

- [x] **2.1** `python-backend/xmp_mapping.py` per D4 + round-trip unit tests (`tests/test_xmp.py`) against 3 real fixtures: an LR-exported sidecar, a preset .xmp, a PV2010 legacy file (must warn). *(37 tests passing)*
- [x] **2.2** Sidecar methods: `import_preset(path)` → EditSettings JSON; `read_xmp_sidecar(photo_path)`; `write_xmp_sidecars(photo_ids)` — writes `<photo>.xmp` next to file; **merge** if exists (replace only mapped crs attributes, preserve everything else). *(+ preset CRUD: list/save/delete, presets table in catalog)*
- [x] **2.3** Preset manager UI — rework `src/components/edit/EditLeftPanel.tsx` into a real preset panel: import .xmp, save-current-as-preset, apply; presets in DB (`presets` table). Export dialog gains "XMP sidecar" mode.
- [ ] **2.4** Manual verification: export sidecars for 5 edited photos → open in Lightroom Classic → sliders match (small tone-curve deltas documented as expected).

## Phase 3 — Professional AI culling  (Size: XL)

- [x] **3.1 Embeddings** *(MobileNetV2 ONNX downloaded + verified sha256; classical-features fallback when model missing)* — new `python-backend/embeddings.py`: MobileNetV3-Large ONNX (model in `python-backend/models/`, download URL + sha256 in `models/README.md`), batched inference on thumbnails, vectors → `photos.embedding` blob.
- [x] **3.2 Similarity stacks** *(time-window ≤8s + cosine ≥0.90 union-find; stack_id/is_stack_top columns instead of a separate table)* — post-scan step in `organizer.py`: dHash prefilter → cosine ≥0.90 + capture-time gap ≤8s → union-find; `stacks` table; `list_photos` returns `stack_id`, `is_stack_top`.
- [x] **3.3 Per-face quality** — extend `detectors.analyze_photo`: per-face records (bbox, crop sharpness, EAR, smile — enable `output_face_blendshapes=True` on the existing FaceLandmarker) → `face_results`.
- [x] **3.4 Aesthetic score** *(v1: classical heuristic — colorfulness/contrast/exposure/sharpness → 1-10; NIMA ONNX can drop in later without changing callers)* — NIMA-style MobileNet ONNX (AVA weights) in `embeddings.py` → `photos.aesthetic_score` (1–10).
- [x] **3.5 Auto ratings + picks** *(user ratings protected via rating_source column)* — new `python-backend/scoring.py`: combined score (technical 50/aesthetic 30/face 20, weights adjustable via settings RPC), per-project percentile calibration → 1–5 stars; best-in-stack → auto "pick" flag.
- [x] **3.6 Cull UI overhaul** — `CullTab.tsx`/`PhotoCell.tsx`: collapsed stack rows with count badge + inline expand; new `src/hooks/useCullKeys.ts` (P pick / X reject / U unflag / 0–5 stars / arrows / space zoom / S expand stack); new `flag` field on photo type + DB; filter bar gains flag + stack filters.
- [x] **3.7 Compare view** *(N-up with synced zoom slider; per-photo quality badges + pick-this)* — new `src/components/cull/CompareView.tsx`: 2–4 up from a stack, synced pan/zoom (reuse Phase-1 renderer at defaults), per-photo face-quality badges.
- [x] **3.8 HEIC** — add `pillow-heif` to requirements (iPhone coverage).

**Acceptance:** burst-heavy folder → near-identical shots stacked, sharpest/eyes-open frame auto-picked; keyboard-only cull of 200 photos; face badges flag eyes-closed on fixtures; blurry photos ≤2 auto-stars, sharp portraits ≥4 on fixture set.

## Phase 4 — AI editing v1: scene-conditioned auto-edit  (Size: M)

*(Ships editing value before the personal model is ready — this is AfterShoot's "instant profiles" equivalent.)*

- [x] **4.1** New `python-backend/auto_edit.py`: scene classifier (EXIF + histogram heuristics + embedding k-means → indoor/outdoor/backlit/low-light/portrait) + exposure normalizer (solve exposure slider so median luma hits per-scene target).
- [x] **4.2** RPC `auto_edit(photo_ids, profile_id)` → per-photo EditSettings into DB, with progress.
- [x] **4.3** Profiles UI — implemented as `AutoEditDialog` from the CULL toolbar (per-scene preset pickers backed by the `ai_profiles` table + normalize/skip toggles) instead of a separate ProfilesScreen; ✨AI badge + one-click Revert in EDIT. *(A full ProfilesScreen arrives with Phase-5 training wizard.)*

**Acceptance:** auto-edit 100 mixed photos → dark indoor shots brightened to target, per-scene presets applied, everything revertible; ≥5 photos/sec.

## Phase 5 — Personal AI Profile (style learning)  (Size: XL — time-box; Phase-4 is the fallback)

- [x] **5.1 Ingestion** — RPC `ingest_training_data(folder)`: find image+XMP pairs, parse via `xmp_mapping.py`, compute features (embedding + histograms + EXIF) → `training_samples`; report pair count + per-slider coverage.
- [x] **5.2 Trainer** — new `python-backend/training.py` (add `torch` CPU): MLP head per D3, masked MSE, AdamW lr 1e-3, batch 64, early-stop patience 10, ≤200 epochs; progress events (epoch/losses); artifacts `app-data/profiles/{id}/head.onnx` + normalization-stats JSON; runs in ProcessPool, cancellable.
- [x] **5.3 Inference** *(+ field-coverage filter: sliders absent from the training data are never predicted)* — extend `auto_edit.py`: profile with trained head → predict sliders (denormalize, clamp to ranges, round HSL ints); confidence guard — high val loss ⇒ warn + fall back to Phase-4 behavior.
- [x] **5.4 Training wizard UI** *(TrainingDialog from HomeScreen: folders → ingest w/ pair gate → train w/ epoch log → val-MAE report; side-by-side validation preview deferred to Phase 7 polish)* — ProfilesScreen: pick folder(s) → pair count gate ("need ≥500, recommend 2,500–5,000") → progress with loss chart → validation preview: 8 held-out photos, predicted vs actual settings rendered side-by-side via the Phase-1 engine.
- [x] **5.5 Evaluation** *(synthetic-style E2E: exposure MAE 0.043 [target <0.35], temperature MAE 154K [target <400K]; model reproduced a deterministic style rule on held-out photos)* — `python-backend/tests/eval_profile.py`: held-out per-slider MAE; targets on a 2,500-pair set: exposure <0.35EV, temperature <400K, global sliders <12 (±100 scale). **Uncertain:** quality depends on the photographer's consistency — thresholds may need tuning.

## Phase 6 — Packaging, updater, licensing  (Size: L — start tasks 6.1–6.2 right after Phase 0 to de-risk)

- [ ] **6.1 PyInstaller onedir** — new `python-backend/sidecar.spec` (collect mediapipe/onnxruntime/rawpy binaries + `models/`), build script `build_sidecar.ps1`; start-to-ready <3s.
- [ ] **6.2 Tauri wiring** — `tauri.conf.json`: `bundle.resources: ["../python-backend/dist/photo-sidecar/**"]`; `capabilities/default.json` shell scope for bundled exe; runtime resolution (dev=venv python, prod=resource path) in spawn code; real CSP (`default-src 'self'; img-src 'self' blob: data:`).
- [ ] **6.3 NSIS installer** — per-user, publisher/license config; test install/uninstall on clean Windows VM.
- [ ] **6.4 Updater** — `tauri-plugin-updater`, keypair + process in `docs/release.md`, placeholder endpoint; test with locally served manifest.
- [ ] **6.5 Licensing** — new `src/components/license/LicenseGate.tsx` + sidecar `validate_license(key)`: Ed25519-signed license blob (embedded public key), 14-day trial in DB; activation-server URL as config for later.
- [ ] **6.6 Release doc** — `docs/release.md`: OV code-signing cert steps, signtool in build script, SmartScreen caveat, version/manifest checklist.

**Acceptance:** clean VM without Python: installer → app runs → scan/cull/edit/export/XMP all work; local-manifest update succeeds; trial expiry blocks without license. Expect ~1–1.4GB installer (torch) — documented, slimming is v1.x.

## Phase 7 — Performance, QA, polish  (Size: M)

- [ ] Filmstrip preview prefetch; scan ≥8 photos/s on 8 cores; 10k-photo project opens <3s (thumb-cache eviction, memory ceiling test); crash-safe DB fsync; sidecar-death toast + auto-restart with session recovery; Playwright E2E golden path (new project → mock scan → keyboard cull → edit → export); onboarding tour.

---

## v1.0 scope vs deferred v1.x

**v1.0 =** Phases 0–7: projects, real edit engine, JPEG+XMP export, preset import, stacks/faces/aesthetics/auto-stars/keyboard culling/compare, scene profiles + personal trained model (from XMP pairs), installer + updater + license gate.

**v1.x deferred:** direct `.lrcat` ingestion · CLIP backbone upgrade · retouching/local masks (skin smoothing, subject masks) · **crop/rotate + lens corrections** (notable gap vs Lightroom — be transparent about it) · macOS build · installer slimming (drop torch) · cloud license server · tethering.

## Top risks
1. **WebGL↔Python render parity** — mitigated by spec-first + parity tests; largest contingency here.
2. **Personal-model quality on inconsistent training data** — time-boxed; Phase-4 scene profiles are the fallback.
3. **Installer size / antivirus / SmartScreen** — onedir + code signing; expect initial SmartScreen warnings until reputation builds.
4. **Protocol-v2 regressions** — done first (smallest surface); mock mode + existing flows are the regression net.

## Verification strategy (ongoing)
- Browser mock mode (`npm run dev`) must stay green at every phase — it's the fast regression loop.
- Python unit tests per phase: `tests/test_xmp.py`, `test_render_parity.py`, `eval_profile.py`.
- Per-phase manual acceptance checklists (listed above) run in `npm run tauri dev` (remember: `$env:PATH += ";C:\Users\avirany\.cargo\bin"`).
- Phase 6 acceptance runs on a clean Windows VM.
