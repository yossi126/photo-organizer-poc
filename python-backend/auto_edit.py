"""
auto_edit.py — scene-conditioned automatic editing (Phase 4, solver v2).

For each photo: classify the scene (portrait / backlit / low-light /
outdoor / indoor), apply a gentle per-scene preset, and solve the exposure
slider **by simulation**: binary-search the exposure value whose actual
rendered result (through render.apply_edit_settings, including the highlight
shoulder) puts the median luminance at the scene target — subject to a
highlight-clipping guard — then damp the correction so results stay natural.

Results persist as regular EditSettings (with `aiEdited: true`), so the
normal edit/render/export pipeline applies. The trained personal model
(training.predict_settings) takes precedence when available and usable.
"""

import threading
from io import BytesIO

import numpy as np
from PIL import Image

import catalog
import render
import thumbs

SCENES = ["portrait", "backlit", "low-light", "outdoor", "indoor"]

# Median-luma targets per scene (gamma domain, 0..1) — deliberately modest;
# low-light stays dark to preserve the mood of night shots. Backlit gets NO
# global exposure normalization (the median is dominated by the bright
# background — darkening it to a target would ruin the photo; the preset's
# highlights/shadows recovery does the work instead).
SCENE_LUMA_TARGETS = {
    "portrait": 0.45,
    "backlit": None,
    "low-light": 0.30,
    "outdoor": 0.46,
    "indoor": 0.40,
}

# Solver constants (see PLAN — Fix 3)
SOLVE_RANGE = 2.0        # binary-search bounds, stops
MEDIAN_TOL = 0.06        # "already fine" band around the target
CLIP_LUMA = 0.97         # a pixel counts as newly clipped above this luma
BASE_BRIGHT = 0.90       # pixels already above this at ev=0 are exempt
NEW_CLIP_CEIL = 0.01     # allowed share of NEWLY clipped pixels (1%)
DAMPING = 0.7            # apply only 70% of the solved correction
DEADBAND = 0.3           # stops — skip micro corrections
FINAL_CLAMP = 1.5        # stops — hard cap on the auto correction
SOLVE_ITERS = 12         # binary-search iterations (~0.001 stop resolution)

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# Gentle per-scene presets — the user can override per scene in the
# Auto-Edit dialog. Roughly half the strength of the original Phase-4 values.
DEFAULT_SCENE_PRESETS = {
    "portrait": {
        "contrast": 3, "highlights": -8, "shadows": 10,
        "clarity": 5, "vibrance": 8, "saturation": -2,
    },
    "backlit": {
        "highlights": -30, "shadows": 22, "contrast": 5,
        "vibrance": 8, "dehaze": 5,
    },
    "low-light": {
        "shadows": 15, "contrast": 6, "noiseReduceLuminance": 15,
        "noiseReduceColor": 20, "vibrance": 5,
    },
    "outdoor": {
        "contrast": 8, "highlights": -10, "shadows": 12,
        "vibrance": 12, "clarity": 6, "dehaze": 3,
    },
    "indoor": {
        "contrast": 5, "highlights": -5, "shadows": 8,
        "vibrance": 8, "noiseReduceLuminance": 5,
    },
}


class AutoEditCancelled(Exception):
    pass


def _luma_stats(arr: np.ndarray) -> dict:
    luma = arr @ _LUMA
    sat = arr.max(axis=-1) - arr.min(axis=-1)
    return {
        "median": float(np.median(luma)),
        "mean": float(luma.mean()),
        "p05": float(np.percentile(luma, 5)),
        "p95": float(np.percentile(luma, 95)),
        "sat_mean": float(sat.mean()),
    }


def classify_scene(stats: dict, face_count: int) -> str:
    """Deterministic heuristics; precedence: portrait > backlit > low-light > outdoor/indoor."""
    if face_count > 0:
        return "portrait"
    spread = stats["p95"] - stats["p05"]
    # Backlit: deep shadows AND bright background AND overall bright frame
    # (the mean guard keeps night scenes with point lights out of this class)
    if spread > 0.70 and stats["p05"] < 0.15 and stats["p95"] > 0.85 and stats["mean"] > 0.40:
        return "backlit"
    if stats["median"] < 0.22:
        return "low-light"
    if stats["mean"] > 0.42 and stats["sat_mean"] > 0.16:
        return "outdoor"        # bright and colorful
    return "indoor"


def compute_auto_settings(img: np.ndarray, face_count: int,
                          scene_presets: dict = None,
                          normalize_exposure: bool = True) -> dict:
    """Pure function: HxWx3 float32 gamma-sRGB thumbnail -> EditSettings.

    Exposure is solved by simulating the ACTUAL render pipeline (including
    the preset's tone settings and the highlight shoulder), with a clipping
    guard, damping and a deadband — see PLAN Fix 3."""
    presets = {**DEFAULT_SCENE_PRESETS, **(scene_presets or {})}
    stats = _luma_stats(img)
    scene = classify_scene(stats, face_count)
    settings = dict(presets.get(scene) or {})

    target = SCENE_LUMA_TARGETS[scene]
    if normalize_exposure and target is not None:
        preset_exp = float(settings.get("exposure", 0) or 0)

        def sim_luma(ev: float) -> np.ndarray:
            out = render.apply_edit_settings(img, {**settings, "exposure": preset_exp + ev})
            return out @ _LUMA

        base_luma = sim_luma(0.0)
        med0 = float(np.median(base_luma))
        # Pixels already (nearly) clipped at baseline — e.g. street lights,
        # specular highlights — are exempt from the clip guard; we only limit
        # NEW clipping introduced by the exposure push.
        base_ok = base_luma <= BASE_BRIGHT

        def sim(ev: float):
            luma = sim_luma(ev)
            new_clip = float((luma[base_ok] > CLIP_LUMA).mean()) if base_ok.any() else 0.0
            return float(np.median(luma)), new_clip

        ev_sol = 0.0
        if abs(med0 - target) > MEDIAN_TOL:
            # Binary search: median(ev) is monotone increasing in ev
            lo, hi = -SOLVE_RANGE, SOLVE_RANGE
            for _ in range(SOLVE_ITERS):
                mid = (lo + hi) / 2.0
                med, _clip = sim(mid)
                if med < target:
                    lo = mid
                else:
                    hi = mid
            ev_med = (lo + hi) / 2.0

            # Clip guard (positive pushes only): find the largest ev in
            # [0, ev_med] whose NEW clipping stays under the ceiling
            if ev_med > 0:
                _med, clip_at = sim(ev_med)
                if clip_at > NEW_CLIP_CEIL:
                    lo2, hi2 = 0.0, ev_med
                    for _ in range(SOLVE_ITERS):
                        mid = (lo2 + hi2) / 2.0
                        _m, c = sim(mid)
                        if c <= NEW_CLIP_CEIL:
                            lo2 = mid
                        else:
                            hi2 = mid
                    ev_sol = lo2
                else:
                    ev_sol = ev_med
            else:
                ev_sol = ev_med

        ev_final = DAMPING * ev_sol
        if abs(ev_final) < DEADBAND:
            ev_final = 0.0
        ev_final = float(np.clip(ev_final, -FINAL_CLAMP, FINAL_CLAMP))
        ev_final = round(ev_final * 20) / 20  # 0.05 steps

        # Highlight compensation for meaningful positive pushes
        if ev_final > 0.4:
            auto_hi = -min(60.0, 35.0 * ev_final)
            preset_hi = float(settings.get("highlights", 0) or 0)
            settings["highlights"] = int(round(min(preset_hi, auto_hi)))

        if ev_final != 0.0 or preset_exp != 0.0:
            settings["exposure"] = round(float(np.clip(preset_exp + ev_final, -5, 5)), 2)

    settings["aiEdited"] = True
    settings["aiScene"] = scene
    return settings


def run_auto_edit(
    project_id: int,
    photo_ids: list,
    scene_presets: dict = None,
    normalize_exposure: bool = True,
    skip_edited: bool = True,
    use_personal_model: bool = True,
    progress_callback=None,
    cancel_event: threading.Event = None,
) -> dict:
    """Apply AI edits. When a trained personal model is available (and passes
    its confidence guard) it predicts the full slider set per photo; otherwise
    the scene-conditioned path runs. Returns counts."""
    import training

    total = len(photo_ids)
    scene_counts = {s: 0 for s in SCENES}
    scene_counts["personal"] = 0
    edited = 0
    skipped = 0

    personal_active = False
    if use_personal_model:
        session, _stats = training.load_personal_model()
        personal_active = session is not None and training.personal_model_status().get("usable", False)

    for i, photo_id in enumerate(photo_ids):
        if cancel_event is not None and cancel_event.is_set():
            raise AutoEditCancelled()

        photo = catalog.get_photo(photo_id)
        if photo is None:
            continue

        if skip_edited and catalog.get_edit_settings(photo_id) is not None:
            skipped += 1
            continue

        if progress_callback:
            progress_callback(i + 1, total, f"Auto-editing: {photo['filename']}")

        try:
            thumb = thumbs.get_thumbnail_bytes(photo["path"], 300)
            pil = Image.open(BytesIO(thumb))

            settings = None
            if personal_active:
                settings = training.predict_settings(pil, photo["path"])

            if settings is not None:
                settings["aiEdited"] = True
                settings["aiScene"] = "personal"
                scene_counts["personal"] += 1
            else:
                arr = np.asarray(pil.convert("RGB"), dtype=np.float32) / 255.0
                face_count = len(catalog.get_face_results(photo_id))
                settings = compute_auto_settings(
                    arr, face_count,
                    scene_presets=scene_presets,
                    normalize_exposure=normalize_exposure,
                )
                scene_counts[settings["aiScene"]] += 1

            catalog.set_edit_settings(photo_id, settings)
            edited += 1
        except AutoEditCancelled:
            raise
        except Exception as e:
            if progress_callback:
                progress_callback(i + 1, total, f"Error on photo {photo_id}: {e}")

    if progress_callback:
        progress_callback(total, total,
                          f"Auto-edit done — {edited} edited, {skipped} skipped.")
    return {"edited": edited, "skipped": skipped, "scenes": scene_counts,
            "personalModel": personal_active}
