"""
features.py — feature extraction + slider-target encoding for the personal
AI profile (Phase 5).

Feature vector (per photo):
  - MobileNetV2 embedding (1000, L2-normalized)   [embeddings.py]
  - RGB histograms 3x32 bins + luma histogram 32  (128, density/32)
  - EXIF vector (5): log10(ISO), log10(1/shutter), aperture, log10(focal), flash

Targets: TRAINED_FIELDS slider values normalized to [-1, 1] by their UI
ranges, with a per-sample mask marking which sliders the XMP actually set.
"""

import os

import numpy as np
from PIL import Image

import embeddings

# Scalar sliders the personal model predicts (tone curves excluded)
_HSL = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"]

# (field, min, max)
TRAINED_FIELDS = [
    ("temperature", 2000.0, 50000.0),
    ("tint", -150.0, 150.0),
    ("exposure", -5.0, 5.0),
    ("contrast", -100.0, 100.0),
    ("highlights", -100.0, 100.0),
    ("shadows", -100.0, 100.0),
    ("whites", -100.0, 100.0),
    ("blacks", -100.0, 100.0),
    ("texture", -100.0, 100.0),
    ("clarity", -100.0, 100.0),
    ("dehaze", -100.0, 100.0),
    ("vibrance", -100.0, 100.0),
    ("saturation", -100.0, 100.0),
    ("sharpenAmount", 0.0, 150.0),
    ("sharpenRadius", 0.5, 3.0),
    ("sharpenDetail", 0.0, 100.0),
    ("sharpenMasking", 0.0, 100.0),
    ("noiseReduceLuminance", 0.0, 100.0),
    ("noiseReduceColor", 0.0, 100.0),
]
for _ch in _HSL:
    TRAINED_FIELDS.append((f"hslHue{_ch}", -100.0, 100.0))
    TRAINED_FIELDS.append((f"hslSat{_ch}", -100.0, 100.0))
    TRAINED_FIELDS.append((f"hslLum{_ch}", -100.0, 100.0))
TRAINED_FIELDS += [
    ("calShadowsTint", -100.0, 100.0),
    ("calRedHue", -100.0, 100.0), ("calRedSat", -100.0, 100.0),
    ("calGreenHue", -100.0, 100.0), ("calGreenSat", -100.0, 100.0),
    ("calBlueHue", -100.0, 100.0), ("calBlueSat", -100.0, 100.0),
]

N_TARGETS = len(TRAINED_FIELDS)  # 50
FIELD_NAMES = [f for f, _lo, _hi in TRAINED_FIELDS]

# Integer-valued sliders (rounded at inference time)
INT_FIELDS = {
    f for f, _lo, _hi in TRAINED_FIELDS
    if f not in ("exposure", "sharpenRadius", "temperature")
}


def normalize_target(field: str, value: float) -> float:
    """Slider value -> [-1, 1]. Temperature uses log scale (perceptual)."""
    idx = FIELD_NAMES.index(field)
    _f, lo, hi = TRAINED_FIELDS[idx]
    if field == "temperature":
        lv = np.log(np.clip(value, lo, hi))
        return float(2.0 * (lv - np.log(lo)) / (np.log(hi) - np.log(lo)) - 1.0)
    return float(2.0 * (np.clip(value, lo, hi) - lo) / (hi - lo) - 1.0)


def denormalize_target(field: str, norm: float) -> float:
    idx = FIELD_NAMES.index(field)
    _f, lo, hi = TRAINED_FIELDS[idx]
    n = float(np.clip(norm, -1.0, 1.0))
    if field == "temperature":
        lv = np.log(lo) + (n + 1.0) / 2.0 * (np.log(hi) - np.log(lo))
        return float(np.exp(lv))
    return float(lo + (n + 1.0) / 2.0 * (hi - lo))


def encode_targets(settings: dict):
    """XMP-parsed settings -> (targets[N], mask[N]) float32."""
    targets = np.zeros(N_TARGETS, dtype=np.float32)
    mask = np.zeros(N_TARGETS, dtype=np.float32)
    for i, (field, _lo, _hi) in enumerate(TRAINED_FIELDS):
        if field in settings and settings[field] is not None:
            targets[i] = normalize_target(field, float(settings[field]))
            mask[i] = 1.0
    return targets, mask


def decode_targets(pred: np.ndarray) -> dict:
    """Model output -> EditSettings dict (clamped, ints rounded)."""
    out = {}
    for i, (field, _lo, _hi) in enumerate(TRAINED_FIELDS):
        v = denormalize_target(field, float(pred[i]))
        if field in INT_FIELDS:
            v = int(round(v))
        elif field == "temperature":
            v = int(round(v / 50.0) * 50)   # 50K steps
        else:
            v = round(v, 2)
        out[field] = v
    return out


def _exif_vector(path: str) -> np.ndarray:
    iso = shutter = fnum = focal = flash = 0.0
    try:
        exif = Image.open(path).getexif()
        ifd = exif.get_ifd(0x8769) if exif else {}
        iso_v = ifd.get(34855)
        if iso_v:
            iso = float(np.log10(max(float(iso_v), 1.0)))
        exp_v = ifd.get(33434)
        if exp_v:
            t = float(exp_v)
            if t > 0:
                shutter = float(np.log10(1.0 / t))
        fn_v = ifd.get(33437)
        if fn_v:
            fnum = float(fn_v)
        fl_v = ifd.get(37386)
        if fl_v:
            focal = float(np.log10(max(float(fl_v), 1.0)))
        fl = ifd.get(37385)
        if fl is not None:
            flash = 1.0 if int(fl) & 1 else 0.0
    except Exception:
        pass
    return np.array([iso, shutter, fnum, focal, flash], dtype=np.float32)


def extract_features(img: Image.Image, path: str = "") -> np.ndarray:
    """Full feature vector for one photo (PIL image, original file path for EXIF)."""
    if img.mode != "RGB":
        img = img.convert("RGB")
    emb = embeddings.embed_pil(img)

    arr = np.asarray(img, dtype=np.float32) / 255.0
    hists = [
        np.histogram(arr[..., c], bins=32, range=(0, 1), density=True)[0] / 32.0
        for c in range(3)
    ]
    luma = arr @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    hists.append(np.histogram(luma, bins=32, range=(0, 1), density=True)[0] / 32.0)

    exif = _exif_vector(path) if path and os.path.exists(path) else np.zeros(5, dtype=np.float32)

    return np.concatenate([emb, np.concatenate(hists).astype(np.float32), exif]).astype(np.float32)


def feature_dim() -> int:
    """Determined empirically (embedding backend may be model or fallback)."""
    dummy = Image.new("RGB", (32, 32), (128, 128, 128))
    return len(extract_features(dummy))
