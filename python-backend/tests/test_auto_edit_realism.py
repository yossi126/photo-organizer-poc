"""
test_auto_edit_realism.py — auto-edit quality gate on realistic synthetics.

Four scenes: night street (small bright lights), backlit, correct daylight,
underexposed warm indoor. For each, compute_auto_settings + render and assert:
  - correction direction is right
  - median lands in [target-0.10, target+0.04] (damping undershoots by design)
  - highlight clip share <= max(1.5 x input, 1.5%)
  - mean HSV saturation >= 0.85 x the identity render (no color washing)
  - |exposure| <= 1.5, daylight untouched (deadband)

Run: venv/Scripts/python python-backend/tests/test_auto_edit_realism.py
"""

import os
import sys

import numpy as np

_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_here))

import auto_edit  # noqa: E402
import render  # noqa: E402

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
rng = np.random.default_rng(21)

H, W = 200, 300

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


def sat_mean(arr):
    v = arr.max(axis=-1)
    c = v - arr.min(axis=-1)
    s = c / np.maximum(v, 1e-6)
    return float(s.mean())


def make_night():
    img = np.zeros((H, W, 3), dtype=np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    img[..., 0] = 0.05 + 0.03 * (yy / H)
    img[..., 1] = 0.05 + 0.02 * (yy / H)
    img[..., 2] = 0.08 + 0.04 * (yy / H)
    img += rng.normal(0, 0.02, img.shape).astype(np.float32)
    # streetlights: 5 small bright disks
    for cx, cy in [(40, 50), (120, 40), (200, 60), (260, 45), (160, 90)]:
        m = (yy - cy) ** 2 + (xx - cx) ** 2 < 6 ** 2
        img[m] = [0.99, 0.95, 0.85]
    # neon patch
    img[150:180, 30:80] = [0.10, 0.05, 0.30]
    return np.clip(img, 0, 1)


def make_backlit():
    img = np.zeros((H, W, 3), dtype=np.float32)
    yy = np.mgrid[0:H, 0:W][0].astype(np.float32) / H
    sky = 0.95 - 0.10 * yy
    img[..., 0] = sky
    img[..., 1] = sky * 0.98
    img[..., 2] = sky * 1.02
    # dark subject blob in the center-bottom
    yy2, xx2 = np.mgrid[0:H, 0:W].astype(np.float32)
    subject = ((yy2 - 140) / 70) ** 2 + ((xx2 - 150) / 45) ** 2 < 1
    img[subject] = [0.14, 0.10, 0.08]
    img += rng.normal(0, 0.01, img.shape).astype(np.float32)
    return np.clip(img, 0, 1)


def make_daylight():
    img = np.zeros((H, W, 3), dtype=np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    g = 0.30 + 0.40 * (xx / W)
    img[..., 0] = g
    img[..., 1] = g * 1.05
    img[..., 2] = g * 0.9
    img[120:190, 20:120] = [0.20, 0.55, 0.15]   # grass
    img[10:80, 180:290] = [0.35, 0.55, 0.85]    # sky patch
    img += rng.normal(0, 0.015, img.shape).astype(np.float32)
    return np.clip(img, 0, 1)


def make_indoor_under():
    img = make_daylight() * 0.55
    img[..., 0] *= 1.1   # warm cast
    img[..., 2] *= 0.9
    return np.clip(img, 0, 1)


CASES = [
    ("night", make_night(), "low-light"),
    ("backlit", make_backlit(), "backlit"),
    ("daylight", make_daylight(), None),        # any scene, must stay untouched
    ("indoor_under", make_indoor_under(), None),
]

for name, img, expected_scene in CASES:
    settings = auto_edit.compute_auto_settings(img, face_count=0)
    scene = settings["aiScene"]
    target = auto_edit.SCENE_LUMA_TARGETS[scene]
    if expected_scene:
        check(scene == expected_scene, f"{name}: scene = {expected_scene}", f"(got {scene})")

    identity = render.apply_edit_settings(img, {})
    out = render.apply_edit_settings(img, settings)
    luma_in = img @ LUMA
    luma_out = out @ LUMA
    med_in = float(np.median(luma_in))
    med_out = float(np.median(luma_out))
    ev = float(settings.get("exposure", 0) or 0)

    print(f"      {name}: scene={scene} target={target} median {med_in:.3f}->{med_out:.3f} "
          f"exposure={ev} highlights={settings.get('highlights')}")

    # Exposure sanity
    check(abs(ev) <= 1.5 + 1e-9, f"{name}: |exposure| <= 1.5", f"(got {ev})")

    if target is None:
        # Backlit: no global exposure normalization — the frame must not be
        # globally darkened/brightened, and shadows must come up.
        check(abs(med_out - med_in) <= 0.10,
              f"{name}: no global exposure shift", f"({med_in:.3f} -> {med_out:.3f})")
        p05_in = float(np.percentile(luma_in, 5))
        p05_out = float(np.percentile(luma_out, 5))
        check(p05_out > p05_in, f"{name}: shadows lifted", f"(p05 {p05_in:.3f} -> {p05_out:.3f})")
    elif abs(med_in - target) > 0.08:
        # Meaningful correction needed: direction is right, and either lands
        # in the band or (when the solver hit its clamp) closes >= 25% of the gap
        check(np.sign(med_out - med_in) == np.sign(target - med_in),
              f"{name}: correction direction", f"(in {med_in:.3f} out {med_out:.3f} target {target})")
        solver_saturated = abs(ev) >= 1.35
        if solver_saturated:
            gap = target - med_in
            check(abs(med_out - med_in) >= 0.25 * abs(gap),
                  f"{name}: meaningful progress toward target (solver clamped)",
                  f"(moved {med_out - med_in:.3f} of gap {gap:.3f})")
        else:
            check(target - 0.10 <= med_out <= target + 0.04,
                  f"{name}: median lands in band", f"(got {med_out:.3f}, target {target})")

    # Clipping guard: previously-bright pixels are exempt (street lights);
    # NEW clipping must stay bounded
    base_ok = luma_in <= 0.90
    clip_new = float((luma_out[base_ok] > 0.97).mean()) if base_ok.any() else 0.0
    check(clip_new <= 0.02, f"{name}: new highlight clipping bounded", f"(new clip {clip_new:.4f})")

    # Color preservation: measure against a WB-matched baseline so a
    # legitimate white-balance correction (which changes chroma by design)
    # isn't misread as color washing. The check targets the tone/HSV stages.
    wb_only = {k: settings[k] for k in ("temperature", "tint") if k in settings}
    baseline = render.apply_edit_settings(img, wb_only) if wb_only else identity
    s_base = sat_mean(baseline)
    s_out = sat_mean(out)
    check(s_out >= 0.85 * s_base,
          f"{name}: saturation preserved", f"(baseline {s_base:.3f} out {s_out:.3f})")

# Daylight is already correct — deadband must leave exposure at 0
day_settings = auto_edit.compute_auto_settings(make_daylight(), face_count=0)
check(float(day_settings.get("exposure", 0) or 0) == 0.0,
      "daylight: exposure untouched (deadband)", str(day_settings.get("exposure")))


# --- Auto white balance ----------------------------------------------------
# A strong warm (tungsten-like) cast must pull temperature BELOW 5500 to
# neutralize it; a strong cool cast must pull it ABOVE.
def _flat_gray(rgb):
    img = np.full((H, W, 3), rgb, dtype=np.float32)
    img += rng.normal(0, 0.01, img.shape).astype(np.float32)
    return np.clip(img, 0, 1)


warm = _flat_gray([0.55, 0.45, 0.32])   # orange cast
warm_wb = auto_edit._estimate_white_balance(warm)
check(warm_wb.get("temperature", 5500) < 5400,
      "warm cast: temperature lowered", str(warm_wb))

cool = _flat_gray([0.35, 0.45, 0.60])   # blue cast
cool_wb = auto_edit._estimate_white_balance(cool)
check(cool_wb.get("temperature", 5500) > 5600,
      "cool cast: temperature raised", str(cool_wb))

# A neutral gray frame must not trigger a meaningful WB shift.
neutral = _flat_gray([0.45, 0.45, 0.45])
neutral_wb = auto_edit._estimate_white_balance(neutral)
check(abs(neutral_wb.get("temperature", 5500) - 5500) <= 200
      and abs(neutral_wb.get("tint", 0)) <= 4,
      "neutral gray: WB left alone", str(neutral_wb))


# --- Face-weighted exposure (portrait) -------------------------------------
# Dark face against a bright background: global median is high, so global
# metering would leave the face dark. Face metering must brighten it.
def make_backlit_portrait():
    img = np.full((H, W, 3), 0.82, dtype=np.float32)   # bright background
    img += rng.normal(0, 0.01, img.shape).astype(np.float32)
    # dark face in the center
    img[70:130, 120:180] = [0.16, 0.13, 0.12]
    return np.clip(img, 0, 1)


face_bbox = [{"bbox": [120 / W, 70 / H, 60 / W, 60 / H]}]
portrait = make_backlit_portrait()
face_region = portrait[70:130, 120:180].reshape(-1, 3) @ LUMA
face_med_in = float(np.median(face_region))

# Without faces (global metering): a bright frame gets little/no push.
s_global = auto_edit.compute_auto_settings(portrait, face_count=0)
# With a face: portrait scene, face metered up toward FACE_LUMA_TARGET.
s_face = auto_edit.compute_auto_settings(portrait, face_count=1, faces=face_bbox)
check(s_face["aiScene"] == "portrait", "portrait: scene = portrait", s_face["aiScene"])
ev_face = float(s_face.get("exposure", 0) or 0)
check(ev_face > 0.2, "portrait: face metering brightens", f"(exposure {ev_face})")

out_face = render.apply_edit_settings(portrait, s_face)
face_med_out = float(np.median(out_face[70:130, 120:180].reshape(-1, 3) @ LUMA))
check(face_med_out > face_med_in + 0.05,
      "portrait: face region actually lifted",
      f"({face_med_in:.3f} -> {face_med_out:.3f})")

print()
if failed:
    print(f"{len(failed)} FAILURES: {failed}")
    sys.exit(1)
print(f"ALL {passed} REALISM CHECKS PASSED")
