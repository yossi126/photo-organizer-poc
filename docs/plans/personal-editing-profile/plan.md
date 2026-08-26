# Auto-Edit Quality + Personal Editing Profile

## Context

The Auto-Edit button produced poor edits, and there was no way for the app to learn a
user's personal editing style from work done inside the app (the existing profile trainer
only read Lightroom XMP folders, which this user does not have). Goal: (1) fix Auto-Edit
quality, (2) learn each user's style from their in-app manual edits over time, (3) let the
user choose Standard vs their learned style at Auto-Edit time — the Aftershoot/Imagen model.

**Yes, the profile is machine learning.** Supervised regression: a small MLP maps image
features (frozen MobileNetV2 embedding + histograms + EXIF) → 50 develop-slider values.
Same architecture Aftershoot/Imagen use; their edge is data scale (2,500–5,000 edits).

## What shipped

### Phase A — Auto-Edit heuristic quality (`python-backend/auto_edit.py`)
Root cause of poor quality: scene → fixed preset → exposure-only solve. No white balance,
global-median metering (dark faces on bright backgrounds), fixed presets ignoring content,
over-damped solver. Fixes:
- **Auto white balance** (`_estimate_white_balance`): robust gray-world on near-neutral
  midtones, falls back to full gray-world under a strong global cast; inverts the renderer's
  temp/tint gain model (`render._stage2_wb_exposure`); damped 0.6×, clamped ±1800K / ±25 tint;
  no-ops when nothing neutral to measure.
- **Face-weighted exposure** (`_face_median_luma`): portraits meter the exposure solver on
  the face bbox (target 0.55) instead of global median. Face boxes come from `face_results`.
- **Content-adaptive tone recovery** (`_tone_from_tails`): highlights/whites/shadows/blacks
  scaled by measured clipping, merged under the scene preset (stronger correction wins).
- **Solver tuning**: damping 0.7→0.85, deadband 0.3→0.15 stops, analysis thumb 300→512px.

### Phase B — learn from in-app edits
- `training.capture_edit_sample(photo_id)` (`training.py`): image features + the sliders the
  user set → `training_samples` (UNIQUE source_path → re-edits update, no duplicates). Skips
  AI-written and no-slider edits.
- Wired into `sidecar.handle_set_edit_settings` — runs on the executor (non-blocking).
- Frontend (`App.tsx handleEditSettingsChange`): strips `aiEdited`/`aiScene` on manual change
  so the edit records as a genuine demonstration (and the Auto-Edit button reappears).
- `TrainingDialog.tsx`: two data sources (in-app edits + optional XMP folders), "N edits
  collected" progress; trains with zero folders once ≥50 in-app edits exist.

### Phase C — Standard vs My Style (`AutoEditDialog.tsx`, `EditTab.tsx`)
- Selector in the Auto-Edit dialog. **My Style** disabled with live "N/50 edits collected"
  hint until a trained, guard-passing model exists; then it becomes the default (choice stays
  visible and switchable). Drives the existing `usePersonalModel` param.
- Edit badge shows "🧠 My Style" for personal-model edits.

### Recommendation adopted
Explicit choice with a smart default (not silent auto-switching), matching Aftershoot/Imagen:
recommend the personal profile once it's good enough, but the user always picks and can
escape a weak early model in one click.

## Files touched
- `python-backend/auto_edit.py`, `training.py`, `sidecar.py`
- `src/App.tsx`, `src/lib/sidecar.ts`
- `src/components/cull/AutoEditDialog.tsx`, `src/components/home/TrainingDialog.tsx`,
  `src/components/edit/EditTab.tsx`
- Tests: `python-backend/tests/test_auto_edit_realism.py` (extended),
  `test_edit_capture.py` (new), `test_personal_learning.py` (new)

## Verification
- Backend: 27 realism + 14 edit-capture + 7 personal-learning + 18 parity + 37 XMP — all pass.
- Personal-learning test proves the loop end-to-end on synthetic data (no Lightroom needed):
  a model trained on 90 synthetic in-app edits reproduced the style (dark→temp 3900/exp +0.63,
  bright→temp 6250/exp −0.32 vs the rule's 3800/+0.7 and 6500/−0.3).
- TypeScript + production build clean.
- Live (browser mock): new-user Auto-Edit dialog confirmed — Standard selected, My Style
  disabled showing "0/50 edits collected".
- Live (Tauri dev): app launched with the real Python sidecar. Manual click-through of the
  enabled My Style path in the native window is still pending user confirmation.

## Not done / future
- Multi-user named profiles (schema supports it; desktop app is single-user today).
- Pre-trained "Talent"-style starter profiles (needs licensed training data).
- Feature-quality upgrade: switch `embeddings.py` from MobileNetV2 1000-d logits to the
  1280-d penultimate layer (logits encode style weakly) — noted, not yet done.
