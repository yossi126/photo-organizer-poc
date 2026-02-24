"""
detectors.py — All 4 detection functions.
Each function is independent and testable without the GUI.

Run directly to get raw scores for a photo:
    python detectors.py path/to/photo.jpg
"""

import cv2
import numpy as np
import imagehash
from PIL import Image


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load(path: str):
    """
    Load an image as a BGR numpy array via PIL.
    cv2.imread() silently returns None for paths with non-ASCII/Hebrew characters.
    PIL handles them correctly, so we use it as the universal loader.
    """
    img_pil = Image.open(path).convert("RGB")
    return cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)


# Load Haar cascade classifiers once at module level (not per-call)
_face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)
# eye_tree_eyeglasses is more discriminative than haarcascade_eye.xml —
# it produces fewer false positives inside face ROIs on closed-eye photos.
_eye_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_eye_tree_eyeglasses.xml"
)


# ---------------------------------------------------------------------------
# Detector 1 — Darkness
# ---------------------------------------------------------------------------

def is_dark(path: str, threshold: int = 85) -> bool:
    """
    Returns True if the image is underexposed/too dark.
    Uses the mean pixel intensity of the grayscale image.
    Threshold 85 = ~33% brightness. Lower = only catch very dark photos.
    """
    try:
        img = _load(path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        return float(gray.mean()) < threshold
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Detector 2 — Blur
# ---------------------------------------------------------------------------

def is_blurry(path: str, threshold: float = 40.0) -> bool:
    """
    Returns True if the image is blurry / out of focus.
    Uses the variance of the Laplacian — sharp images have high variance
    because edges produce large second-derivative responses.
    Threshold 40 avoids false positives on normal photos (typical lap_var ~90+).
    Tune up toward 80 if real blurry photos are being missed.
    """
    try:
        img = _load(path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        variance = cv2.Laplacian(gray, cv2.CV_64F).var()
        return variance < threshold
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Detector 3 — Duplicates
# ---------------------------------------------------------------------------

def find_duplicates(paths: list, threshold: int = 5) -> dict:
    """
    Finds near-identical images using perceptual hashing (dHash).
    Takes a list of file paths, returns a dict:
        { keeper_path: [dupe_path1, dupe_path2, ...] }
    The first file encountered alphabetically is kept; duplicates are moved.
    Hamming distance <= threshold means "same image".
    threshold=5 tolerates minor JPEG compression differences.
    """
    hashes = {}
    for p in paths:
        try:
            # Thumbnail before hashing for speed on large images
            img = Image.open(p)
            img.thumbnail((512, 512))
            hashes[p] = imagehash.dhash(img)
        except Exception:
            continue  # Skip corrupt / unsupported files silently

    groups = {}
    processed = set()
    items = list(hashes.items())

    for i, (p1, h1) in enumerate(items):
        if p1 in processed:
            continue
        dupes = [
            p2 for p2, h2 in items[i + 1:]
            if p2 not in processed and (h1 - h2) <= threshold
        ]
        if dupes:
            groups[p1] = dupes
            processed.update([p1] + dupes)

    return groups


# ---------------------------------------------------------------------------
# Detector 4 — Eyes Closed
# ---------------------------------------------------------------------------

def has_closed_eyes(path: str) -> bool:
    """
    Returns True if a face is detected but fewer than 2 eyes are found,
    which indicates eyes are likely closed.

    Uses OpenCV Haar cascades (works on Python 3.13).
    Best accuracy on front-facing, well-lit photos.
    Known limitation: side profiles may produce false positives.

    Note: returns False (not flagged) when no face is detected at all.
    """
    try:
        img = _load(path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Equalize histogram to improve detection on dark/flat photos
        gray = cv2.equalizeHist(gray)

        faces = _face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(60, 60),
        )

        if len(faces) == 0:
            return False  # No face detected — do not flag

        for (x, y, w, h) in faces:
            roi = gray[y: y + h, x: x + w]
            eyes = _eye_cascade.detectMultiScale(
                roi,
                scaleFactor=1.1,
                minNeighbors=10,
            )
            if len(eyes) < 2:
                return True  # Face found but < 2 eyes = likely closed

        return False

    except Exception:
        return False


# ---------------------------------------------------------------------------
# CLI helper — prints raw scores for a given image (for threshold tuning)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python detectors.py path/to/photo.jpg")
        sys.exit(1)

    path = sys.argv[1]

    try:
        img = _load(path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        mean_intensity = float(gray.mean())
        lap_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())

        print(f"File           : {path}")
        print(f"Mean intensity : {mean_intensity:.1f}  → dark if < 85")
        print(f"Laplacian var  : {lap_variance:.1f}  → blurry if < 40")
        print(f"is_dark        : {is_dark(path)}")
        print(f"is_blurry      : {is_blurry(path)}")
        print(f"has_closed_eyes: {has_closed_eyes(path)}")

    except Exception as e:
        print(f"Error: {e}")
