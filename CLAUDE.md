# Photo Organizer POC

A Python tool that scans a folder of photos, detects problematic images, and moves them into categorized subfolders automatically.

## What it does

Scans a folder and moves photos into four categories:

| Subfolder | What gets moved there |
|---|---|
| `_duplicates/` | Identical or near-identical images (perceptual hash match) |
| `_dark/` | Underexposed / too dark photos (mean brightness < 85/255) |
| `_blurry/` | Out-of-focus photos (Laplacian variance < 40) |
| `_eyes_closed/` | Photos where a face is detected but eyes appear closed |

Photos that pass all checks remain untouched in the source folder.

## Project structure

```
photos-poc/
  main.py            # Entry point — run this to launch the GUI
  gui.py             # CustomTkinter window (folder picker, progress bar, log)
  organizer.py       # Scan loop and file-move logic
  detectors.py       # The 4 detection functions (testable without GUI)
  requirements.txt   # Python dependencies
  PLAN.md            # Full implementation plan and research notes
  venv/              # Python virtual environment (not committed)
```

## Tech stack

| Library | Version | Purpose |
|---|---|---|
| `opencv-python` | 4.10.0.84 | Darkness detection, blur detection, face/eye detection |
| `imagehash` | 4.3.1 | Perceptual hashing for duplicate detection |
| `Pillow` | 10.4.0 | Image loading (handles non-ASCII / Hebrew paths that cv2 can't) |
| `customtkinter` | 5.2.2 | Modern dark-mode GUI |
| `numpy` | latest | Array operations for OpenCV |

## Detection methods

**Duplicates** — dHash (difference hash) via `imagehash`. Two images with Hamming distance ≤ 5 are considered duplicates. The first file alphabetically is kept; the rest are moved.

**Dark photos** — Grayscale mean pixel intensity. Threshold: `mean < 85` (out of 255). Tune the `threshold` parameter in `is_dark()` if needed.

**Blurry photos** — Variance of the Laplacian operator. Sharp images have high variance (many edges); blurry images have low variance. Threshold: `variance < 40`. Tune the `threshold` parameter in `is_blurry()` if needed.

**Eyes closed** — OpenCV Haar cascades. Detects a face, then looks for eyes within the face region. If a face is found but fewer than 2 eyes are detected, the photo is flagged. Uses `haarcascade_eye_tree_eyeglasses.xml` (more accurate than the default eye cascade).

> **Note:** Eyes-closed detection works best on front-facing, well-lit photos. Side profiles may produce false positives. This is a POC limitation — upgrading to MediaPipe FaceMesh (requires Python 3.12) would significantly improve accuracy.

## Known limitations

- **Python 3.13 only** — MediaPipe does not support Python 3.13 yet, so Haar cascades are used for eye detection instead. Accuracy is lower than MediaPipe's landmark-based EAR approach.
- **HEIC files (iPhone)** — not supported by Pillow by default. Add `pillow-heif` to requirements if needed.
- **Non-ASCII paths** — handled via the PIL `_load()` wrapper in `detectors.py`. Do not use `cv2.imread()` directly.
- **Blur threshold is content-sensitive** — very low-texture photos (solid backgrounds, night sky) may score low even if sharp.

## Diagnosing / tuning thresholds

Run `detectors.py` directly on any photo to see its raw scores:

```
venv\Scripts\python detectors.py "C:\path\to\photo.jpg"
```

Output:
```
File           : photo.jpg
Mean intensity : 101.9  → dark if < 85
Laplacian var  : 92.5   → blurry if < 40
is_dark        : False
is_blurry      : False
has_closed_eyes: False
```

## Running the CLI (no GUI)

```
venv\Scripts\python organizer.py "C:\path\to\your\photos"
```

Prints progress and a summary. Useful for testing without opening the GUI.

---

## First-time setup (after cloning the repo)

Run these commands once after cloning. You only need to do this once.

**Step 1 — Clone the repo and enter the folder**

```
git clone <your-repo-url>
cd photos-poc
```

**Step 2 — Create a virtual environment**

```
python -m venv venv
```

**Step 3 — Activate the virtual environment**

```
venv\Scripts\activate
```

You should see `(venv)` appear at the start of your prompt.

**Step 4 — Install dependencies**

```
pip install -r requirements.txt
```

That's it. The environment is ready. Now see below to launch the GUI.

---

## How to launch the GUI

Do this every time you want to run the app (after first-time setup is done).

**Step 1 — Open a terminal in the project folder**

In Windows Explorer, navigate to the `photos-poc` folder.
Right-click → "Open in Terminal" (or open Command Prompt / PowerShell there).

**Step 2 — Activate the virtual environment**

```
venv\Scripts\activate
```

You should see `(venv)` appear at the start of your prompt.

**Step 3 — Launch the app**

```
python main.py
```

**Step 4 — Use the GUI**

1. Click **Browse** and select the folder containing your photos
2. Click **Start Scan**
3. Watch the progress bar and log as photos are analyzed
4. When complete, the summary shows how many files were moved into each subfolder
