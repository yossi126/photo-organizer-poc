# Photo Organizer POC — Implementation Plan

## Context

Build a Python POC tool that scans a local Windows folder of photos and moves problematic
images into categorized subfolders: `_duplicates`, `_dark`, `_blurry`, `_eyes_closed`.
The tool needs a simple GUI so a non-technical user can pick a folder and click Start.

---

## Critical Constraint: Python Version

**Only Python 3.13 is installed on this machine.**
MediaPipe (the best eyes-closed detector) does **not** yet ship wheels for Python 3.13.
**Decision:** Use OpenCV Haar cascades for eyes-closed detection as the fallback.
It is less accurate than MediaPipe EAR but requires zero extra dependencies beyond `opencv-python`.
If Python 3.12 is installed later, the MediaPipe upgrade is a one-function swap.

---

## Recommended Library Stack

| Feature | Library | Reason |
|---|---|---|
| Duplicate detection | `imagehash` (dHash) | Pure Python, pip-only, fast, handles near-duplicates with Hamming distance |
| Darkness detection | `opencv-python` | Grayscale mean intensity — simple, reliable, fast |
| Blur detection | `opencv-python` | Laplacian variance — industry standard, no extra deps |
| Eyes-closed detection | `opencv-python` (Haar cascades) | Only option for Python 3.13; detect face then count eyes |
| Image loading | `Pillow` | Required by imagehash; also used as cv2 fallback for non-ASCII paths |
| GUI | `customtkinter` | Modern look, minimal overhead, easy PyInstaller bundling |
| Packaging | `PyInstaller` (one-dir mode) | Most widely used, best docs, `--onedir` avoids temp-extraction delays |

**Notable exclusions:**
- `mediapipe` — no Python 3.13 wheels (upgrade path for later)
- `face_recognition` / `dlib` — requires C++ compilation on Windows, avoid entirely
- `deepface` — does not expose a clean "eyes open/closed" attribute
- `PyQt5/6` — overkill for a POC, GPL license complexity

---

## Project Structure

```
photos-poc/
  venv/              # Python 3.13 virtualenv (not committed)
  main.py            # 5-line entry point — imports gui, calls gui.run()
  detectors.py       # All 4 detection functions, testable without GUI
  organizer.py       # Scan loop, file-move logic, progress callback
  gui.py             # CustomTkinter window, folder picker, progress bar, log
  requirements.txt   # Pinned dependencies
  build.bat          # One-command PyInstaller build
```

---

## requirements.txt

```
Pillow==10.4.0
imagehash==4.3.1
opencv-python==4.10.0.84
customtkinter==5.2.2
pyinstaller==6.11.0
```

All install cleanly on Python 3.13 with `pip install -r requirements.txt`.
No compilation required.

---

## Implementation Phases

### Phase 1 — Environment & Skeleton (30 min)

1. Create venv: `python -m venv venv`
2. Activate: `venv\Scripts\activate`
3. `pip install -r requirements.txt`
4. Create all 5 Python files as stubs (module docstring + `pass`)
5. **Test gate:** `python -c "import cv2, imagehash, customtkinter, PIL; print('ok')"`

---

### Phase 2 — `detectors.py` (1.5 hours)

Implement four standalone functions. Each takes a file path, returns `bool`.
Test this file in isolation before building the GUI.

**Critical cross-cutting concern — non-ASCII paths:**
`cv2.imread()` silently returns `None` for paths with Hebrew/Unicode characters
(your OneDrive path may contain these). Use PIL as a universal loader:

```python
from PIL import Image
import numpy as np, cv2

def _load(path: str):
    img_pil = Image.open(path).convert('RGB')
    return cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)
```

Use `_load()` everywhere instead of `cv2.imread()` directly.

---

**`is_dark(path, threshold=85) -> bool`**
```python
gray = cv2.cvtColor(_load(path), cv2.COLOR_BGR2GRAY)
return gray.mean() < threshold
```
Threshold 85/255 ≈ 33% brightness. Tune lower (60) to only catch very dark photos.

---

**`is_blurry(path, threshold=100.0) -> bool`**
```python
gray = cv2.cvtColor(_load(path), cv2.COLOR_BGR2GRAY)
return cv2.Laplacian(gray, cv2.CV_64F).var() < threshold
```
High variance = sharp edges present. Threshold 100 is a safe starting point; tune up
to 150 if too many false positives. Run `python detectors.py <path>` to see raw scores.

---

**`find_duplicates(paths: list[str], threshold=5) -> dict[str, list[str]]`**

Takes all paths at once. Returns `{keeper: [dupe1, dupe2, ...]}`.

```python
import imagehash
from PIL import Image

hashes = {}
for p in paths:
    try: hashes[p] = imagehash.dhash(Image.open(p))
    except: continue

groups, processed = {}, set()
items = list(hashes.items())
for i, (p1, h1) in enumerate(items):
    if p1 in processed: continue
    dupes = [p2 for p2, h2 in items[i+1:]
             if p2 not in processed and (h1 - h2) <= threshold]
    if dupes:
        groups[p1] = dupes
        processed.update([p1] + dupes)
return groups
```

Keeper = first file alphabetically. Wrap every `Image.open()` in try/except — corrupt
files and HEIC (iPhone) photos will raise. Add `pillow-heif` to requirements later if HEIC support is needed.

---

**`has_closed_eyes(path) -> bool`** — Haar cascade approach (Python 3.13)

```python
_face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
_eye_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + 'haarcascade_eye.xml')

def has_closed_eyes(path):
    gray = cv2.cvtColor(_load(path), cv2.COLOR_BGR2GRAY)
    faces = _face_cascade.detectMultiScale(gray, 1.1, 5, minSize=(60,60))
    if len(faces) == 0:
        return False   # No face = not flagged
    for (x, y, w, h) in faces:
        roi = gray[y:y+h, x:x+w]
        eyes = _eye_cascade.detectMultiScale(roi, 1.1, 3)
        if len(eyes) < 2:   # Face found but < 2 eyes detected = likely closed
            return True
    return False
```

Known limitation: Haar cascades work best on front-facing, well-lit photos.
Side profiles and group shots will have higher false-positive rates.
`minSize=(60,60)` filters out tiny false faces from backgrounds.

**Add a `__main__` block for threshold tuning:**
```python
if __name__ == "__main__":
    import sys
    path = sys.argv[1]
    gray = cv2.cvtColor(_load(path), cv2.COLOR_BGR2GRAY)
    print(f"Mean intensity : {gray.mean():.1f}  (dark if < 85)")
    print(f"Laplacian var  : {cv2.Laplacian(gray, cv2.CV_64F).var():.1f}  (blurry if < 100)")
```
Run `python detectors.py some_photo.jpg` to read raw scores.

---

### Phase 3 — `organizer.py` (1 hour)

```python
SUBFOLDERS = ["_duplicates", "_dark", "_blurry", "_eyes_closed"]
IMAGE_EXTS  = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'}

def scan_and_organize(source_dir, progress_callback=None) -> dict:
    # 1. Gather all image paths (top-level only, skip _ subfolders)
    # 2. Pass 1 — find_duplicates() on all paths; move dupes; track in moved set
    # 3. Pass 2 — loop remaining files; is_dark -> is_blurry -> has_closed_eyes
    #    Use `continue` after each move so a file gets only one category
    # 4. Return summary dict {subfolder: count}
    # progress_callback(current: int, total: int, message: str)
```

Key details:
- Skip files already inside `_duplicates`, `_dark`, etc. (filter paths that contain `\_`)
- Handle name collisions in destination: append `_1`, `_2` suffix
- Use `shutil.move()` — works across drives unlike `os.rename()`
- Add `if __name__ == "__main__"` block for CLI testing without the GUI

---

### Phase 4 — `gui.py` + `main.py` (1.5 hours)

**`main.py`** — 5 lines:
```python
from gui import run
if __name__ == "__main__":
    run()
```

**`gui.py`** — CustomTkinter window:
- Dark mode, 600×450 window
- Row 1: folder path entry + Browse button (uses `tkinter.filedialog.askdirectory`)
- Row 2: Start button (disabled during scan)
- Row 3: `CTkProgressBar` (0→1 based on `current/total`)
- Row 4: Status label (current filename)
- Row 5: `CTkTextbox` scrollable log (shows each move with category)

**Threading:** Run `scan_and_organize()` in a `daemon=True` thread to keep the UI
responsive. The `progress_callback` updates widgets from the background thread —
acceptable for a POC. For correctness use `self.after(0, fn)` to marshal to main thread.

---

### Phase 5 — Manual Integration Testing (1 hour)

Prepare a test folder with:
- 2 near-identical copies of one photo → expect both hashed, one moved to `_duplicates`
- 1 near-black image (create: `python -c "from PIL import Image; Image.new('RGB',(100,100),(10,10,10)).save('dark.jpg')"`)
- 1 blurred photo: `python -c "import cv2; img=cv2.imread('x.jpg'); cv2.imwrite('blur.jpg', cv2.GaussianBlur(img,(51,51),0))"`
- 1 photo of a person with eyes visibly closed (manual)
- 5+ normal photos that must remain untouched

Run from CLI first: `python organizer.py "C:\path\to\test_folder"`
Then run via GUI: `python main.py`

---

### Phase 6 — PyInstaller Packaging (optional, 1 hour)

**`build.bat`:**
```bat
@echo off
call venv\Scripts\activate
pyinstaller ^
  --name PhotoOrganizer ^
  --onedir ^
  --windowed ^
  --collect-all customtkinter ^
  --hidden-import cv2 ^
  --hidden-import PIL._imaging ^
  --hidden-import imagehash ^
  main.py
```

- `--onedir`: no temp-extraction on startup, better for crash recovery
- `--windowed`: suppresses console window on Windows
- `--collect-all customtkinter`: bundles theme JSON files that CTk loads at runtime
- Build from the clean `venv`, **not** from a system/Anaconda Python (5x larger output)
- Output: `dist/PhotoOrganizer/` folder — zip for distribution
- Expected size: ~120–160 MB

**Known PyInstaller gotchas with these libs:**
- cv2 may need `--hidden-import cv2` to avoid recursion error on import
- Test the built exe on a machine without Python to catch missing `msvcp140.dll`

---

## Known Limitations / Gotchas Summary

| Issue | Impact | Mitigation |
|---|---|---|
| `cv2.imread` fails on non-ASCII paths | Silent `None` return | Use PIL `_load()` wrapper everywhere |
| Haar cascade eyes-closed accuracy | False positives on profiles/groups | MediaPipe upgrade when Python 3.12 available |
| HEIC files (iPhone) not supported | Silently skipped | Add `pillow-heif` if needed |
| Large images slow duplicate scan | Perceptible lag on 1000+ files | Thumbnail to 512px before hashing |
| Blur threshold content-sensitive | Low-texture shots may false-positive | Expose threshold in GUI settings later |
| PyInstaller one-dir = many files | Confusing for users | Zip into archive for distribution |

---

## Verification Checklist

- [ ] `python -c "import cv2, imagehash, customtkinter, PIL"` prints no errors
- [ ] `python detectors.py test_dark.jpg` prints mean < 85
- [ ] `python detectors.py test_blur.jpg` prints Laplacian var < 100
- [ ] `python organizer.py test_folder` moves correct files, leaves others untouched
- [ ] `python main.py` — GUI opens, Browse works, progress bar advances during scan
- [ ] After scan: `_duplicates/`, `_dark/`, `_blurry/`, `_eyes_closed/` contain expected files
- [ ] Normal photos remain in source folder
- [ ] (Optional) Built `.exe` runs without Python installed
