"""
detectors.py — Detection functions for the Photo Organizer.

Uses Laplacian variance + CLAHE for blur detection, MediaPipe FaceLandmarker
for eyes-closed detection, and simple pixel math for dark/overexposed.

Each function is independent and testable without the GUI.

Run directly to get raw scores for a photo:
    python detectors.py path/to/photo.jpg
"""

import os
import sys
from dataclasses import dataclass, field
from typing import Optional

import cv2
import imagehash
import mediapipe as mp
import numpy as np
import rawpy
from PIL import Image

# RAW file extensions (handled by rawpy instead of PIL)
_RAW_EXTS = {
    ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf",
    ".orf", ".raf", ".rw2", ".pef", ".dng", ".raw",
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load(path: str):
    """
    Load an image as a BGR numpy array.
    Supports both standard formats (via PIL) and RAW camera files (via rawpy).
    """
    ext = os.path.splitext(path)[1].lower()
    if ext in _RAW_EXTS:
        with rawpy.imread(path) as raw:
            rgb = raw.postprocess(use_camera_wb=True, half_size=True)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    img_pil = Image.open(path).convert("RGB")
    return cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)


def _load_pil(path: str) -> Image.Image:
    """Load an image as a PIL Image (RGB). Supports RAW files."""
    ext = os.path.splitext(path)[1].lower()
    if ext in _RAW_EXTS:
        with rawpy.imread(path) as raw:
            rgb = raw.postprocess(use_camera_wb=True, half_size=True)
        return Image.fromarray(rgb)

    return Image.open(path).convert("RGB")


# ---------------------------------------------------------------------------
# MediaPipe FaceLandmarker initialization (loaded once at module level)
# ---------------------------------------------------------------------------

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_MODEL_PATH = os.path.join(_SCRIPT_DIR, "face_landmarker.task")
_face_landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(
    mp.tasks.vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=_MODEL_PATH),
        num_faces=5,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
    )
)

# ---------------------------------------------------------------------------
# YuNet face detector — fallback for tilted/downward-looking faces that
# MediaPipe's FaceLandmarker cannot detect.  YuNet is small (~230 KB) and
# handles extreme head poses much better.
# ---------------------------------------------------------------------------

_YUNET_PATH = os.path.join(_SCRIPT_DIR, "face_detection_yunet.onnx")
_yunet_available = os.path.exists(_YUNET_PATH)

# Eye landmark indices (MediaPipe 478-point model)
_LEFT_EYE_TOP    = [159, 145]
_LEFT_EYE_TOP2   = [158, 153]
_LEFT_EYE_SIDES  = [33, 133]

_RIGHT_EYE_TOP   = [386, 374]
_RIGHT_EYE_TOP2  = [385, 380]
_RIGHT_EYE_SIDES = [362, 263]

# Priority order: unfixable problems first
PRIORITY_ORDER = ["_blurry", "_eyes_closed", "_dark", "_overexposed"]


# ---------------------------------------------------------------------------
# PhotoReport — multi-label result for a single photo
# ---------------------------------------------------------------------------

@dataclass
class PhotoReport:
    path: str

    # Raw scores
    brightness_mean: float = 0.0
    blur_score: float = 0.0
    eye_aspect_ratio: Optional[float] = None
    faces_detected: int = 0

    # Boolean flags (all detectors run, all flags set)
    is_dark: bool = False
    is_overexposed: bool = False
    is_blurry: bool = False
    has_closed_eyes: bool = False

    # All detected issues + the primary (highest priority) category
    all_labels: list = field(default_factory=list)
    primary_category: Optional[str] = None


# ---------------------------------------------------------------------------
# Detector 1 — Darkness
# ---------------------------------------------------------------------------

def is_dark(path: str, threshold: int = 85) -> bool:
    try:
        img = _load(path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        return float(gray.mean()) < threshold
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Detector 2 — Overexposure
# ---------------------------------------------------------------------------

def is_overexposed(path: str, threshold: int = 220) -> bool:
    try:
        img = _load(path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        return float(gray.mean()) > threshold
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Detector 3 — Blur (Laplacian variance + CLAHE, region-aware)
# ---------------------------------------------------------------------------

def _compute_blur_score(gray: np.ndarray, face_landmarks=None,
                        img_w: int = 0, img_h: int = 0) -> float:
    """
    Compute blur score using Laplacian variance on CLAHE-normalized image.
    Higher score = sharper image.

    Strategy depends on whether faces were detected:

    WITH faces: Use ONLY the face ROI. The face is the subject — if the
    face is sharp, the photo is good even if the background is bokeh.

    WITHOUT faces: Use center 30% crop. This focuses on the likely subject
    area and avoids being fooled by intentionally blurred backgrounds.
    """
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray_norm = clahe.apply(gray)

    h, w = gray_norm.shape
    scores = []

    # If faces detected: ONLY use face ROI (ignore background completely)
    if face_landmarks and img_w > 0 and img_h > 0:
        for face_lm in face_landmarks:
            xs = [lm.x * img_w for lm in face_lm]
            ys = [lm.y * img_h for lm in face_lm]
            x1, x2 = int(min(xs)), int(max(xs))
            y1, y2 = int(min(ys)), int(max(ys))
            # Pad by 20% to include hair/shoulders
            pad_x = max(1, (x2 - x1) // 5)
            pad_y = max(1, (y2 - y1) // 5)
            x1 = max(0, x1 - pad_x)
            y1 = max(0, y1 - pad_y)
            x2 = min(w, x2 + pad_x)
            y2 = min(h, y2 + pad_y)
            face_roi = gray_norm[y1:y2, x1:x2]
            if face_roi.size > 100:
                scores.append(cv2.Laplacian(face_roi, cv2.CV_64F).var())
        if scores:
            return max(scores)

    # No faces: use center 30% crop (likely subject area)
    ch, cw = int(h * 0.35), int(w * 0.35)
    center = gray_norm[ch:h - ch, cw:w - cw]
    if center.size > 0:
        scores.append(cv2.Laplacian(center, cv2.CV_64F).var())

    return max(scores) if scores else 0.0


def is_blurry(path: str, threshold: float = 50.0) -> bool:
    """
    Returns True if the image is blurry (Laplacian variance below threshold).
    Lower threshold = stricter (catches more blur).
    Higher threshold = only catches very blurry photos.
    Default 50.0 is a moderate setting.
    """
    try:
        img = _load(path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        score = _compute_blur_score(gray)
        return score < threshold
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Detector 4 — Duplicates
# ---------------------------------------------------------------------------

def find_duplicates(paths: list, threshold: int = 5) -> dict:
    """
    Finds near-identical images using perceptual hashing (dHash).
    Returns { keeper_path: [dupe_path1, dupe_path2, ...] }
    """
    hashes = {}
    for p in paths:
        try:
            img = _load_pil(p)
            img.thumbnail((512, 512))
            hashes[p] = imagehash.dhash(img)
        except Exception:
            continue

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
# Detector 5 — Eyes Closed (MediaPipe FaceLandmarker + EAR)
# ---------------------------------------------------------------------------

def _eye_aspect_ratio(landmarks, top, top2, sides):
    """
    Compute Eye Aspect Ratio from MediaPipe face landmarks.
    Low EAR = closed eye, high EAR = open eye.
    """
    def _pt(idx):
        lm = landmarks[idx]
        return np.array([lm.x, lm.y])

    v1 = np.linalg.norm(_pt(top[0]) - _pt(top[1]))
    v2 = np.linalg.norm(_pt(top2[0]) - _pt(top2[1]))
    h1 = np.linalg.norm(_pt(sides[0]) - _pt(sides[1]))

    if h1 < 1e-6:
        return 0.3  # fallback — assume open
    return (v1 + v2) / (2.0 * h1)


def has_closed_eyes(path: str, threshold: float = 0.18) -> bool:
    """
    Returns True if MediaPipe detects a person with closed eyes (EAR < threshold).
    Both eyes must be below threshold. Default 0.18.
    """
    try:
        pil_img = _load_pil(path)
        mp_image = mp.Image(
            image_format=mp.ImageFormat.SRGB,
            data=np.array(pil_img),
        )
        result = _face_landmarker.detect(mp_image)
        if not result.face_landmarks:
            return False

        for face_lm in result.face_landmarks:
            left_ear = _eye_aspect_ratio(face_lm,
                                          _LEFT_EYE_TOP, _LEFT_EYE_TOP2, _LEFT_EYE_SIDES)
            right_ear = _eye_aspect_ratio(face_lm,
                                           _RIGHT_EYE_TOP, _RIGHT_EYE_TOP2, _RIGHT_EYE_SIDES)
            if left_ear < threshold and right_ear < threshold:
                return True
        return False
    except Exception:
        return False


# ---------------------------------------------------------------------------
# YuNet fallback — crop detected faces and re-run MediaPipe
# ---------------------------------------------------------------------------

def _yunet_fallback(img_bgr: np.ndarray, orig_w: int, orig_h: int) -> list:
    """
    Use YuNet to detect faces, crop each face with padding, and re-run
    MediaPipe FaceLandmarker on the crop.  Returns a list of face landmark
    lists (same format as MediaPipe's face_landmarks) so the caller can
    use them for EAR and blur ROI just like normal detections.

    The trick: MediaPipe often fails on full-frame images when the head is
    tilted, but succeeds on a tight crop where the face dominates the frame.
    """
    try:
        # Resize to ~2000px for YuNet (good balance of speed + accuracy)
        max_dim = 2000
        scale = max_dim / max(orig_h, orig_w)
        small = cv2.resize(img_bgr, None, fx=scale, fy=scale)
        sh, sw = small.shape[:2]

        detector = cv2.FaceDetectorYN.create(_YUNET_PATH, "", (sw, sh),
                                              0.5, 0.3, 5000)
        _, detections = detector.detect(small)
        if detections is None:
            return []

        all_landmarks = []
        for det in detections:
            # Map back to original coordinates
            fx = int(det[0] / scale)
            fy = int(det[1] / scale)
            fw = int(det[2] / scale)
            fh = int(det[3] / scale)

            # Generous padding (1x face size) so MediaPipe has context
            pad = max(fw, fh)
            cx1 = max(0, fx - pad)
            cy1 = max(0, fy - pad)
            cx2 = min(orig_w, fx + fw + pad)
            cy2 = min(orig_h, fy + fh + pad)

            crop_rgb = cv2.cvtColor(img_bgr[cy1:cy2, cx1:cx2], cv2.COLOR_BGR2RGB)
            crop_h, crop_w = crop_rgb.shape[:2]

            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=crop_rgb)
            result = _face_landmarker.detect(mp_image)

            if result.face_landmarks:
                for face_lm in result.face_landmarks:
                    # Remap landmark coordinates from crop-space to
                    # full-image-space (normalized 0-1 relative to original)
                    remapped = []
                    for lm in face_lm:
                        new_lm = type(lm)()
                        new_lm.x = (lm.x * crop_w + cx1) / orig_w
                        new_lm.y = (lm.y * crop_h + cy1) / orig_h
                        new_lm.z = lm.z
                        remapped.append(new_lm)
                    all_landmarks.append(remapped)

        return all_landmarks
    except Exception:
        return []


# ---------------------------------------------------------------------------
# analyze_photo() — single entry point, multi-label with priority
# ---------------------------------------------------------------------------

def analyze_photo(path: str, thresholds: dict = None) -> PhotoReport:
    """
    Run ALL detectors on a single photo and return a PhotoReport.

    Loads the image once, runs MediaPipe once, computes all scores,
    then resolves the primary category by priority:
        _blurry > _eyes_closed > _dark > _overexposed
    (unfixable problems take priority over fixable ones)
    """
    th = thresholds or {}
    dark_th = th.get("dark", 85)
    overexposed_th = th.get("overexposed", 220)
    blur_th = th.get("blur", 50.0)
    ear_th = th.get("eyes_closed", 0.18)

    report = PhotoReport(path=path)

    try:
        # Load image once
        img_bgr = _load(path)
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        h, w = img_bgr.shape[:2]

        # Brightness (shared for dark + overexposed)
        report.brightness_mean = float(gray.mean())

        # Face detection via MediaPipe (reused for blur ROI + eyes)
        pil_img = _load_pil(path)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.array(pil_img))
        face_result = _face_landmarker.detect(mp_image)
        face_landmarks = face_result.face_landmarks or []

        # YuNet fallback: if MediaPipe found no faces, try YuNet which
        # handles tilted/downward-looking faces much better.  When YuNet
        # finds a face, we crop it with generous padding and re-run
        # MediaPipe on the crop — this often succeeds because the face
        # fills more of the frame.
        if not face_landmarks and _yunet_available:
            face_landmarks = _yunet_fallback(img_bgr, w, h)

        report.faces_detected = len(face_landmarks)

        # Blur score (uses face regions if available)
        report.blur_score = _compute_blur_score(
            gray, face_landmarks=face_landmarks or None, img_w=w, img_h=h
        )

        # Eye aspect ratio (uses same face landmarks)
        if face_landmarks:
            min_ear = float("inf")
            for face_lm in face_landmarks:
                left_ear = _eye_aspect_ratio(face_lm,
                                              _LEFT_EYE_TOP, _LEFT_EYE_TOP2, _LEFT_EYE_SIDES)
                right_ear = _eye_aspect_ratio(face_lm,
                                               _RIGHT_EYE_TOP, _RIGHT_EYE_TOP2, _RIGHT_EYE_SIDES)
                # Both eyes must be below threshold to flag as closed.
                # Single-eye check is too aggressive — tilted/downward
                # faces cause asymmetric EAR even with open eyes.
                if left_ear < ear_th and right_ear < ear_th:
                    min_ear = min(min_ear, left_ear, right_ear)
            if min_ear < float("inf"):
                report.eye_aspect_ratio = min_ear

        # Set boolean flags
        report.is_dark = report.brightness_mean < dark_th
        report.is_overexposed = report.brightness_mean > overexposed_th
        report.is_blurry = report.blur_score < blur_th
        report.has_closed_eyes = report.eye_aspect_ratio is not None

        # Dark + blur interaction:
        # Dark images naturally have lower Laplacian variance, which can
        # falsely trigger blur. But EXTREMELY low scores (< 15) indicate
        # genuine blur even in dark photos. So for dark photos, only flag
        # blur if the score is drastically low.
        if report.is_dark and report.is_blurry:
            DARK_BLUR_FLOOR = 15  # genuinely blurry = score below this
            if report.blur_score >= DARK_BLUR_FLOOR:
                report.is_blurry = False  # ambiguous range, trust dark

        # Collect all labels
        if report.is_blurry:
            report.all_labels.append("_blurry")
        if report.has_closed_eyes:
            report.all_labels.append("_eyes_closed")
        if report.is_dark:
            report.all_labels.append("_dark")
        if report.is_overexposed:
            report.all_labels.append("_overexposed")

        # Resolve primary category by priority (unfixable first)
        for cat in PRIORITY_ORDER:
            if cat in report.all_labels:
                report.primary_category = cat
                break

    except Exception:
        pass  # Leave report with defaults (no issues detected)

    return report


# ---------------------------------------------------------------------------
# CLI helper — prints raw scores for a given image (for threshold tuning)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python detectors.py path/to/photo.jpg")
        sys.exit(1)

    path = sys.argv[1]

    try:
        report = analyze_photo(path)

        print(f"File             : {path}")
        print(f"Faces detected   : {report.faces_detected}")
        print()
        print(f"Brightness mean  : {report.brightness_mean:.1f}  (dark < 85, overexposed > 220)")
        print(f"Blur score       : {report.blur_score:.1f}  (blurry if < 50, higher = sharper)")
        print(f"Eye aspect ratio : {report.eye_aspect_ratio or 'N/A'}  (closed if < 0.18)")
        print()
        print(f"--- Flags ---")
        print(f"is_dark          : {report.is_dark}")
        print(f"is_overexposed   : {report.is_overexposed}")
        print(f"is_blurry        : {report.is_blurry}")
        print(f"has_closed_eyes  : {report.has_closed_eyes}")
        print()
        print(f"All labels       : {report.all_labels or 'clean'}")
        print(f"Primary category : {report.primary_category or 'clean'}")

    except Exception as e:
        print(f"Error: {e}")
