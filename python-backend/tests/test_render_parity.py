"""
test_render_parity.py — compares the Python renderer against WebGL captures.

Run recipe:
    1. npm run dev                                (vite on :1420)
    2. node tests/parity/capture.mjs              (writes tests/parity/out/*.png)
    3. venv/Scripts/python python-backend/tests/test_render_parity.py

Asserts mean deltaE76 < 2.0 and p99 < 6.0 for every fixture x preset combo
(see docs/render-pipeline.md — internal consistency, not Lightroom-identical).
"""

import json
import os
import sys

import numpy as np
from PIL import Image

_here = os.path.dirname(os.path.abspath(__file__))
_backend = os.path.dirname(_here)
_root = os.path.dirname(_backend)
sys.path.insert(0, _backend)

import render  # noqa: E402

FIXTURE_DIR = os.path.join(_root, "public", "parity")
PRESETS_PATH = os.path.join(_root, "tests", "parity", "presets.json")
WEBGL_OUT = os.path.join(_root, "tests", "parity", "out")

FIXTURES = ["gradient", "hues", "detail"]

MEAN_DE_LIMIT = 2.0
P99_DE_LIMIT = 6.0

# sRGB D65 -> XYZ
_M = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
], dtype=np.float64)

_D65 = np.array([0.95047, 1.00000, 1.08883])


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    lin = render.srgb_to_linear(rgb.astype(np.float32)).astype(np.float64)
    xyz = lin @ _M.T
    xyz = xyz / _D65
    d = 6.0 / 29.0
    f = np.where(xyz > d ** 3, np.cbrt(xyz), xyz / (3 * d * d) + 4.0 / 29.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def delta_e76(rgb_a: np.ndarray, rgb_b: np.ndarray) -> np.ndarray:
    return np.linalg.norm(srgb_to_lab(rgb_a) - srgb_to_lab(rgb_b), axis=-1)


def main() -> int:
    with open(PRESETS_PATH, "r", encoding="utf-8") as f:
        presets = json.load(f)

    if not os.path.isdir(WEBGL_OUT):
        print(f"ERROR: {WEBGL_OUT} missing — run `node tests/parity/capture.mjs` first.")
        return 2

    failures = []
    for fixture in FIXTURES:
        src = np.asarray(
            Image.open(os.path.join(FIXTURE_DIR, f"{fixture}.jpg")).convert("RGB"),
            dtype=np.float32,
        ) / 255.0

        for preset_name, overrides in presets.items():
            combo = f"{fixture}__{preset_name}"
            png_path = os.path.join(WEBGL_OUT, f"{combo}.png")
            if not os.path.exists(png_path):
                failures.append((combo, "missing WebGL capture"))
                continue

            webgl = np.asarray(Image.open(png_path).convert("RGB"), dtype=np.float32) / 255.0
            py = render.apply_edit_settings(src, overrides)

            if webgl.shape != py.shape:
                failures.append((combo, f"shape mismatch {webgl.shape} vs {py.shape}"))
                continue

            de = delta_e76(py, webgl)
            mean_de = float(de.mean())
            p99_de = float(np.percentile(de, 99))
            ok = mean_de < MEAN_DE_LIMIT and p99_de < P99_DE_LIMIT
            print(f"{'PASS' if ok else 'FAIL'}  {combo:32s} mean dE={mean_de:6.3f}  p99={p99_de:6.3f}")
            if not ok:
                failures.append((combo, f"mean={mean_de:.3f} p99={p99_de:.3f}"))

    print()
    if failures:
        print(f"{len(failures)} parity failure(s):")
        for combo, why in failures:
            print(f"  {combo}: {why}")
        return 1
    print(f"ALL {len(FIXTURES) * len(presets)} PARITY COMBOS PASSED "
          f"(mean dE < {MEAN_DE_LIMIT}, p99 < {P99_DE_LIMIT})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
