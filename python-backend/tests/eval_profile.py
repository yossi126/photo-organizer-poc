"""
eval_profile.py — report the trained personal model's held-out accuracy.

Reads the stats.json written by training.py (which evaluates on a 10%
held-out split) and checks it against the acceptance thresholds from
PLAN.md Phase 5.5.

Run: venv/Scripts/python python-backend/tests/eval_profile.py
"""

import json
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_here))

import training  # noqa: E402

# Acceptance thresholds (real slider units)
THRESHOLDS = {
    "exposure": 0.35,       # stops
    "temperature": 400.0,   # kelvin
}
GLOBAL_SLIDER_LIMIT = 12.0  # for ±100-range sliders


def main() -> int:
    stats_path = os.path.join(training.profile_dir(), "stats.json")
    if not os.path.exists(stats_path):
        print("No trained model found — run training first.")
        return 2

    with open(stats_path, "r", encoding="utf-8") as f:
        stats = json.load(f)

    print(f"Model: {stats['samples']} samples, val loss {stats['valLoss']:.5f} "
          f"(guard {stats['valGuard']}) — "
          f"{'USABLE' if stats['valLoss'] <= stats['valGuard'] else 'BELOW QUALITY BAR'}")
    print()

    failures = []
    mae = stats.get("valMae", {})
    for field, value in sorted(mae.items()):
        limit = THRESHOLDS.get(field, GLOBAL_SLIDER_LIMIT if field != "sharpenRadius" else 0.5)
        ok = value <= limit
        print(f"{'PASS' if ok else 'FAIL'}  {field:24s} MAE {value:9.3f}  (limit {limit})")
        if not ok:
            failures.append(field)

    print()
    if failures:
        print(f"{len(failures)} slider(s) above threshold: {failures}")
        print("Note: thresholds assume a consistent editing style — noisy or "
              "mixed-style training data raises MAE (documented in PLAN.md).")
        return 1
    print("ALL EVALUATED SLIDERS WITHIN THRESHOLDS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
