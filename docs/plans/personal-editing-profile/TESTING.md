# How to test — Auto-Edit quality + Personal Editing Profile

Two ways to test: **automated** (fast, proves the engine works) and **manual in the app**
(what you'd actually click through). Do the automated tests first — if they pass, the logic
is sound and manual testing is just confirming the UX.

---

## 1. Automated tests (no photos needed) — ~1 minute

From the project root, with the venv Python:

```bash
venv/Scripts/python.exe python-backend/tests/test_auto_edit_realism.py
venv/Scripts/python.exe python-backend/tests/test_edit_capture.py
venv/Scripts/python.exe python-backend/tests/test_personal_learning.py
```

Expected — each ends with a green summary line:

- `ALL 27 REALISM CHECKS PASSED` — Auto-Edit quality (white balance direction, face-metering
  brightens the subject, exposure lands on target, no color washing, clipping bounded).
- `ALL 14 EDIT-CAPTURE CHECKS PASSED` — a manual edit becomes a training sample, re-edits
  update (no duplicates), AI/no-slider edits are skipped.
- `ALL 7 PERSONAL-LEARNING CHECKS PASSED` — **the important one**: trains a real model on 90
  synthetic edits with a known style and confirms it reproduces that style on held-out photos.
  Watch its printed output — dark photos should predict a warmer temperature and higher
  exposure than bright photos, matching the injected style rule.

(Warnings like `WARNING: Logging before InitGoogle` / `XNNPACK` are MediaPipe noise — ignore.)

Regression check (should still pass — we didn't change the renderer):

```bash
venv/Scripts/python.exe python-backend/tests/test_render_parity.py   # ALL 18 PARITY COMBOS PASSED
venv/Scripts/python.exe python-backend/tests/test_xmp.py             # ALL 37 XMP TESTS PASSED
```

---

## 2. Manual test in the real app (Tauri) — the full experience

### Start the app

```bash
npm run tauri dev
```

A native window opens. (First run compiles Rust ~2-3 min; later runs ~seconds.)

### 2a. Auto-Edit quality (Standard mode)

Use a folder with a few problem photos — ideally: one warm/tungsten indoor shot, one dark
shot, one backlit portrait (bright background, face in shadow), one already-good photo.

1. **New Project** → pick the folder → **Start Scan**.
2. Go to the **CULL** tab → click **✨ Auto-Edit** (top-right).
3. Mode is **Standard** (My Style is disabled for now — that's expected).
4. Click **Auto-Edit N photos**.
5. Open each photo in the **EDIT** tab and check the result:
   - Warm/tungsten shot → **Temperature slider moved below 5500** (cast neutralized).
   - Dark shot → **Exposure lifted**, shadows opened.
   - Backlit portrait → **the face is brighter**, not left dark against the background.
   - Already-good photo → **barely touched** (small or zero exposure change).
   - Each edited photo shows a **✨ AI · scene** badge top-right.

Compare against the old behavior mentally: the key wins are white balance (previously never
touched) and the face no longer staying dark on backlit portraits.

### 2b. Teach it your style (Phase B)

The profile learns from photos **you edit by hand**. So:

1. Still in the project, open a photo in the **EDIT** tab and adjust sliders to your taste
   (exposure, temperature, contrast, whatever you'd normally do). Move to the next photo,
   edit it, and so on.
2. Each manual edit is silently captured as a training sample. (When you touch a slider on an
   AI-edited photo, the AI badge disappears — that's correct: it's now your edit.)
3. To train you need **at least 50 edited photos** (500+ for good quality). For a quick
   functional test you can reach 50 by editing 50 photos even lightly.

Check progress: **Home screen → AI Profile** button. The dialog shows **"N edits collected"**.

### 2c. Train the profile

1. Home → **AI Profile**.
2. Once you have ≥50 edits, click **Train** (no folders needed — it trains on your in-app
   edits). You'll see epoch progress and a final **validation loss**.
3. If it reports **"trained and active"**, the model passed the quality bar. If it says
   **"below the quality bar"**, you need more (or more consistent) edits — Auto-Edit keeps
   using Standard mode until then.

### 2d. Use My Style (Phase C)

1. CULL tab → **✨ Auto-Edit**.
2. **My Style** is now **enabled and selected by default** (violet). The button reads
   **"Edit in My Style N photos"**.
3. Run it. Open the results in EDIT — photos now show a **🧠 My Style** badge, and the edits
   should lean toward how *you* edit rather than the generic scene look.
4. You can always switch back to **Standard** with one click.

---

## 3. Fast UX-only test in the browser (no Python, no real editing)

If you just want to see the Standard/My Style dialog states without editing 50 real photos:

```bash
npm run dev
```

Open http://localhost:1420 (mock mode). New Project → Start Scan → CULL → Auto-Edit. You'll
see **My Style disabled with "0/50 edits collected"**. The mock reports a usable model once
50 sample edits are recorded, so this path mainly demonstrates the **new-user** state; the
real learning loop is what the Tauri run (section 2) and the automated tests exercise.

> Note: in a plain browser the folder picker falls back to a text prompt, which some embedded
> browsers block. Use `npm run tauri dev` for real testing.

---

## What "passing" looks like — quick checklist

- [ ] All three new/updated backend tests print their green summary lines.
- [ ] Standard Auto-Edit fixes white balance, brightens dark shots, keeps backlit faces lit.
- [ ] Editing photos by hand raises the "N edits collected" count.
- [ ] Training with ≥50 in-app edits produces an active model.
- [ ] Auto-Edit then offers **My Style** as the default; results carry the 🧠 badge.
