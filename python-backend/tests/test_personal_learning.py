"""
test_personal_learning.py — Phase B end-to-end: the personal model can LEARN a
style from in-app edits and reproduce it on held-out photos.

Since the user has no Lightroom XMP data, this proves the whole pipeline
(capture -> train -> predict) works using a SYNTHETIC user whose style is a
deterministic function of image content:

  style rule (correlates with brightness so it's learnable from features):
    - dark photos  -> warm them up (temp 3800) + lift exposure (+0.7)
    - bright photos-> cool them (temp 6500) + pull exposure (-0.3)
    - everyone     -> contrast +18, vibrance +22   (constant preference)

We generate many varied photos, capture the styled edit for each, train, then
check predictions on HELD-OUT photos follow the rule (dark predicted warmer
than bright, constant prefs learned). A model that couldn't learn would predict
near the dataset mean for everything — the dark-vs-bright gap would vanish.

Run: venv/Scripts/python python-backend/tests/test_personal_learning.py
(Trains a real MLP; takes ~10-30s.)
"""

import os
import sys
import tempfile

import numpy as np
from PIL import Image

_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_here))

import catalog  # noqa: E402
import training  # noqa: E402

catalog._data_dir_override = tempfile.mkdtemp(prefix="personal_learn_test_")

passed = 0
failed = []


def check(cond, name, extra=""):
    global passed
    if cond:
        passed += 1
        print(f"PASS: {name}")
    else:
        failed.append(name)
        print(f"FAIL: {name} {extra}")


rng = np.random.default_rng(7)
img_dir = tempfile.mkdtemp(prefix="personal_learn_imgs_")
project = catalog.get_or_create_project("style", img_dir)
pid_ = project["id"]


def make_photo(brightness: float, hue_shift: float) -> np.ndarray:
    """A textured photo at a target brightness with some color variety, so the
    feature extractor sees real structure (not a flat field)."""
    base = np.zeros((160, 220, 3), dtype=np.float32)
    yy, xx = np.mgrid[0:160, 0:220].astype(np.float32)
    base[..., 0] = brightness + 0.15 * np.sin(xx / 20) + hue_shift
    base[..., 1] = brightness + 0.15 * np.cos(yy / 25)
    base[..., 2] = brightness + 0.10 * np.sin((xx + yy) / 30) - hue_shift
    # a few colored blocks for content
    base[20:60, 20:80] = [0.2 + brightness, 0.5, 0.2]
    base[90:140, 130:200] = [0.3, 0.3, 0.6 + hue_shift]
    base += rng.normal(0, 0.02, base.shape).astype(np.float32)
    return np.clip(base, 0, 1)


def styled_edit(brightness: float) -> dict:
    """The synthetic user's deterministic style."""
    if brightness < 0.4:
        temp, exp = 3800, 0.7
    else:
        temp, exp = 6500, -0.3
    return {"temperature": temp, "exposure": exp, "contrast": 18, "vibrance": 22}


# --- generate a dataset and capture styled edits ---------------------------
N = 90
brightnesses = []
for i in range(N):
    b = float(rng.uniform(0.15, 0.75))
    brightnesses.append(b)
    hue = float(rng.uniform(-0.05, 0.05))
    path = os.path.join(img_dir, f"p{i:03d}.jpg")
    Image.fromarray((make_photo(b, hue) * 255).astype("uint8")).save(path)
    catalog.upsert_photos(pid_, [{"filename": f"p{i:03d}.jpg", "path": path, "mtime": 1, "size": 1}])
    photo_id = catalog.get_photo_id(pid_, f"p{i:03d}.jpg")
    catalog.set_edit_settings(photo_id, styled_edit(b))
    training.capture_edit_sample(photo_id)

check(catalog.count_training_samples() == N, f"{N} samples captured",
      str(catalog.count_training_samples()))

# --- train -----------------------------------------------------------------
result = training.train_profile()
print(f"      trained: valLoss={result['valLoss']} usable={result['usable']} "
      f"samples={result['samples']}")
check(result["samples"] == N, "trained on all samples")

# --- predict on held-out photos --------------------------------------------
training.invalidate_model_cache()


def predict_for_brightness(b: float) -> dict:
    hue = 0.0
    img = make_photo(b, hue)
    p = os.path.join(img_dir, f"holdout_{int(b*100)}.jpg")
    Image.fromarray((img * 255).astype("uint8")).save(p)
    pil = Image.open(p)
    return training.predict_settings(pil, p) or {}


dark_pred = predict_for_brightness(0.20)
bright_pred = predict_for_brightness(0.70)
print(f"      dark  -> temp {dark_pred.get('temperature')} exp {dark_pred.get('exposure')} "
      f"contrast {dark_pred.get('contrast')} vibrance {dark_pred.get('vibrance')}")
print(f"      bright-> temp {bright_pred.get('temperature')} exp {bright_pred.get('exposure')} "
      f"contrast {bright_pred.get('contrast')} vibrance {bright_pred.get('vibrance')}")

check(dark_pred, "model produced a prediction (guard passed)")

# The learnable signal: dark photos predicted WARMER (lower temp) and BRIGHTER
# (higher exposure) than bright photos. Absolute accuracy isn't the point on a
# tiny synthetic set — the learned *direction* is.
if dark_pred and bright_pred:
    check(dark_pred.get("temperature", 9999) < bright_pred.get("temperature", 0),
          "dark predicted warmer than bright",
          f"({dark_pred.get('temperature')} vs {bright_pred.get('temperature')})")
    check(dark_pred.get("exposure", -9) > bright_pred.get("exposure", 9),
          "dark predicted brighter than bright",
          f"({dark_pred.get('exposure')} vs {bright_pred.get('exposure')})")
    # constant preferences learned toward the right zone (both positive, sizable)
    check(dark_pred.get("contrast", 0) > 8 and bright_pred.get("contrast", 0) > 8,
          "positive contrast preference learned")
    check(dark_pred.get("vibrance", 0) > 8 and bright_pred.get("vibrance", 0) > 8,
          "positive vibrance preference learned")

print()
if failed:
    print(f"{len(failed)} FAILURES: {failed}")
    sys.exit(1)
print(f"ALL {passed} PERSONAL-LEARNING CHECKS PASSED")
