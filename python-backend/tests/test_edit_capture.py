"""
test_edit_capture.py — Phase B: in-app manual edits become training samples.

Verifies training.capture_edit_sample:
  - a manual edit (sliders set, no aiEdited) is stored as one training sample
  - re-editing the same photo UPDATES rather than duplicates it (UNIQUE path)
  - an AI-written edit (aiEdited=True) is NOT captured
  - an edit that sets no trainable slider is NOT captured
  - the stored targets/mask round-trip through features encoding

Run: venv/Scripts/python python-backend/tests/test_edit_capture.py
"""

import os
import sys
import tempfile

import numpy as np
from PIL import Image

_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_here))

import catalog  # noqa: E402
import features  # noqa: E402
import training  # noqa: E402

catalog._data_dir_override = tempfile.mkdtemp(prefix="edit_capture_test_")

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


# A real image file on disk (capture_edit_sample decodes a thumbnail from it).
img_dir = tempfile.mkdtemp(prefix="edit_capture_imgs_")
img_path = os.path.join(img_dir, "shot1.jpg")
arr = (np.random.default_rng(3).random((240, 320, 3)) * 255).astype("uint8")
Image.fromarray(arr).save(img_path)

project = catalog.get_or_create_project("test", img_dir)
pid_ = project["id"]


def _add(filename, path):
    catalog.upsert_photos(pid_, [{"filename": filename, "path": path, "mtime": 1, "size": 1}])
    return catalog.get_photo_id(pid_, filename)


photo_id = _add("shot1.jpg", img_path)

# --- manual edit is captured -----------------------------------------------
manual = {"exposure": 0.6, "temperature": 6000, "contrast": 15, "shadows": 20}
catalog.set_edit_settings(photo_id, manual)
ok = training.capture_edit_sample(photo_id)
check(ok, "manual edit captured")
check(catalog.count_training_samples() == 1, "one training sample stored",
      str(catalog.count_training_samples()))

# stored targets round-trip: the sliders we set are marked in the mask
rows = catalog.get_training_samples()
mask = np.frombuffer(rows[0]["mask"], dtype=np.float32)
targets = np.frombuffer(rows[0]["targets"], dtype=np.float32)
for field in ("exposure", "temperature", "contrast", "shadows"):
    idx = features.FIELD_NAMES.index(field)
    check(mask[idx] == 1.0, f"mask set for {field}")
# a field we did NOT touch stays unmasked
check(mask[features.FIELD_NAMES.index("dehaze")] == 0.0, "untouched field unmasked")
# exposure target decodes back near 0.6
exp_idx = features.FIELD_NAMES.index("exposure")
check(abs(features.denormalize_target("exposure", targets[exp_idx]) - 0.6) < 0.01,
      "exposure target round-trips")

# --- re-edit UPDATES, does not duplicate -----------------------------------
catalog.set_edit_settings(photo_id, {**manual, "exposure": 1.2, "vibrance": 30})
training.capture_edit_sample(photo_id)
check(catalog.count_training_samples() == 1, "re-edit updates (no duplicate)",
      str(catalog.count_training_samples()))
rows = catalog.get_training_samples()
targets = np.frombuffer(rows[0]["targets"], dtype=np.float32)
check(abs(features.denormalize_target("exposure", targets[exp_idx]) - 1.2) < 0.01,
      "updated exposure reflected")
mask = np.frombuffer(rows[0]["mask"], dtype=np.float32)
check(mask[features.FIELD_NAMES.index("vibrance")] == 1.0, "newly-set slider now masked")

# --- AI edit is NOT captured -----------------------------------------------
img2 = os.path.join(img_dir, "shot2.jpg")
Image.fromarray(arr).save(img2)
pid2 = _add("shot2.jpg", img2)
catalog.set_edit_settings(pid2, {"exposure": 0.5, "aiEdited": True, "aiScene": "outdoor"})
ai_ok = training.capture_edit_sample(pid2)
check(not ai_ok, "AI edit not captured")
check(catalog.count_training_samples() == 1, "AI edit added no sample",
      str(catalog.count_training_samples()))

# --- edit with no trainable slider is NOT captured -------------------------
img3 = os.path.join(img_dir, "shot3.jpg")
Image.fromarray(arr).save(img3)
pid3 = _add("shot3.jpg", img3)
catalog.set_edit_settings(pid3, {"colorProfile": "vivid"})  # no numeric slider
empty_ok = training.capture_edit_sample(pid3)
check(not empty_ok, "no-slider edit not captured")

print()
if failed:
    print(f"{len(failed)} FAILURES: {failed}")
    sys.exit(1)
print(f"ALL {passed} EDIT-CAPTURE CHECKS PASSED")
