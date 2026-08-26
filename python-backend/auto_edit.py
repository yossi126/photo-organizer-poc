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
DAMPING = 0.85           # apply 85% of the solved correction
DEADBAND = 0.15          # stops — skip micro corrections
FINAL_CLAMP = 1.5        # stops — hard cap on the auto correction
SOLVE_ITERS = 12         # binary-search iterations (~0.001 stop resolution)

# --- Auto white balance ----------------------------------------------------
WB_DAMPING = 0.6         # apply 60% of the estimated illuminant correction
WB_TEMP_CLAMP = 1800.0   # max Kelvin shift from 5500 the auto WB may apply
WB_TINT_CLAMP = 25.0     # max tint units the auto WB may apply
WB_NEUTRAL_SAT = 0.20    # only pixels below this saturation count as "gray"
WB_MIN_NEUTRAL = 0.02    # need >=2% near-neutral pixels for a confident estimate
WB_MID_LO, WB_MID_HI = 0.15, 0.92  # restrict gray estimate to midtones

# Face-region exposure target (portraits) — brighter than the global 0.45,
# metered on the face box(es) so a bright background can't leave the face dark.
FACE_LUMA_TARGET = 0.55

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


def _estimate_white_balance(arr: np.ndarray) -> dict:
    """Estimate a gentle temperature/tint correction from near-neutral midtone
    pixels (a robust gray-world variant). Returns {} when the frame has too few
    neutral pixels to trust the estimate.

    Inverts render._stage2_wb_exposure: that stage multiplies the LINEAR image
    by per-channel gains derived from temperature/tint. To *neutralize* an
    illuminant we want gains that equalize the mean of near-gray pixels, i.e.
    gR/gB = meanB/meanR (in linear light). We map that ratio back to a
    temperature via the same `t` parameter the renderer uses, and the residual
    green cast to tint. Both are damped and clamped so results stay natural."""
    lin = np.where(arr <= 0.04045, arr / 12.92,
                   ((arr + 0.055) / 1.055) ** 2.4).astype(np.float32)
    L = arr @ _LUMA
    sat = arr.max(axis=-1) - arr.min(axis=-1)

    # Prefer near-neutral midtone pixels (robust gray-world): filtering to
    # low-saturation pixels avoids being dragged by a few vivid objects. But a
    # strong global cast can push EVERY pixel's saturation up, leaving too few
    # "neutral" ones — then fall back to plain gray-world over midtone pixels
    # (which still sees the cast) so the correction can fire.
    mid = (L > WB_MID_LO) & (L < WB_MID_HI)
    neutral = (sat < WB_NEUTRAL_SAT) & mid
    if float(neutral.mean()) >= WB_MIN_NEUTRAL:
        select = neutral
    elif float(mid.mean()) >= WB_MIN_NEUTRAL:
        select = mid
    else:
        return {}

    px = lin[select]
    mR = float(px[:, 0].mean()) + 1e-6
    mG = float(px[:, 1].mean()) + 1e-6
    mB = float(px[:, 2].mean()) + 1e-6

    # Renderer gains: gR = 2^(0.5 t), gB = 2^(-0.5 t)  =>  gR/gB = 2^t.
    # We want post-gain R and B means equal: gR*mR = gB*mB  =>  gR/gB = mB/mR.
    # So  t = log2(mB / mR).
    t = float(np.log2(mB / mR))
    # T from t:  t = (1e6/5500 - 1e6/T) / 150  =>  1e6/T = 1e6/5500 - 150 t
    inv_T = 1e6 / 5500.0 - 150.0 * t
    T = 1e6 / inv_T if inv_T > 1e-6 else 50000.0
    temp = float(np.clip(T, 2000.0, 50000.0))

    # Tint: green channel deviation vs the R/B average. gG = 2^(-0.5 tint/150),
    # want gG * mG = target => tint = 300 * log2(mG / sqrt(mR*mB)).
    tint = 300.0 * float(np.log2(mG / np.sqrt(mR * mB)))

    # Damp toward neutral (5500 / 0), then clamp the shift magnitude.
    temp = 5500.0 + WB_DAMPING * (temp - 5500.0)
    tint = WB_DAMPING * tint
    temp = float(np.clip(temp, 5500.0 - WB_TEMP_CLAMP, 5500.0 + WB_TEMP_CLAMP))
    tint = float(np.clip(tint, -WB_TINT_CLAMP, WB_TINT_CLAMP))

    out = {}
    if abs(temp - 5500.0) >= 60.0:
        out["temperature"] = int(round(temp / 50.0) * 50)
    if abs(tint) >= 2.0:
        out["tint"] = int(round(tint))
    return out


def _tone_from_tails(stats: dict) -> dict:
    """Content-adaptive highlight/shadow/whites/blacks recovery from the
    luminance distribution. Scales with how much the photo actually clips —
    a photo with blown skies gets strong highlight recovery; a flat photo
    barely touched. Returned values are *seasoning* the caller merges under
    the scene preset (preset wins only when it asks for MORE recovery)."""
    p95, p05 = stats["p95"], stats["p05"]
    hi_blown = max(0.0, p95 - 0.90) / 0.10   # 0 at p95=0.90, 1 at p95>=1.0
    sh_crush = max(0.0, 0.10 - p05) / 0.10   # 0 at p05=0.10, 1 at p05<=0.0
    out = {}
    if hi_blown > 0.05:
        out["highlights"] = -int(round(min(45.0, 45.0 * hi_blown)))
        out["whites"] = -int(round(min(20.0, 20.0 * hi_blown)))
    if sh_crush > 0.05:
        out["shadows"] = int(round(min(40.0, 40.0 * sh_crush)))
        out["blacks"] = int(round(min(15.0, 15.0 * sh_crush)))
    return out


def _merge_recovery(settings: dict, recovery: dict) -> None:
    """Merge tail-based recovery into settings, keeping the stronger correction
    per field (more negative highlights/whites, more positive shadows/blacks)."""
    for field in ("highlights", "whites"):
        if field in recovery:
            cur = float(settings.get(field, 0) or 0)
            settings[field] = int(min(cur, recovery[field]))
    for field in ("shadows", "blacks"):
        if field in recovery:
            cur = float(settings.get(field, 0) or 0)
            settings[field] = int(max(cur, recovery[field]))


def _face_median_luma(img: np.ndarray, faces: list) -> float | None:
    """Median luma over face bounding boxes (bbox normalized [x,y,w,h]).
    Returns None when no usable face region is present."""
    if not faces:
        return None
    h, w = img.shape[:2]
    lumas = []
    for f in faces:
        bbox = f.get("bbox") if isinstance(f, dict) else f
        if not bbox or len(bbox) != 4:
            continue
        x, y, bw, bh = bbox
        x0 = int(max(0, min(w - 1, round(x * w))))
        y0 = int(max(0, min(h - 1, round(y * h))))
        x1 = int(max(x0 + 1, min(w, round((x + bw) * w))))
        y1 = int(max(y0 + 1, min(h, round((y + bh) * h))))
        region = img[y0:y1, x0:x1]
        if region.size == 0:
            continue
        lumas.append(region.reshape(-1, 3) @ _LUMA)
    if not lumas:
        return None
    return float(np.median(np.concatenate(lumas)))


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
                          normalize_exposure: bool = True,
                          faces: list = None) -> dict:
    """Pure function: HxWx3 float32 gamma-sRGB thumbnail -> EditSettings.

    Steps: classify scene -> apply per-scene preset -> auto white balance ->
    content-adaptive tone recovery -> solve exposure by simulating the ACTUAL
    render pipeline (highlight shoulder included), with a clipping guard,
    damping and a deadband. Portraits meter exposure on the face region so a
    bright background can't leave the subject dark."""
    presets = {**DEFAULT_SCENE_PRESETS, **(scene_presets or {})}
    stats = _luma_stats(img)
    scene = classify_scene(stats, face_count)
    settings = dict(presets.get(scene) or {})

    # Auto white balance (skips itself when the estimate is weak).
    settings.update(_estimate_white_balance(img))

    # Content-adaptive highlight/shadow recovery, merged under the preset.
    _merge_recovery(settings, _tone_from_tails(stats))

    # Exposure target: portraits meter on the face region; backlit stays None
    # (its highlight/shadow recovery does the work). Everything else global.
    target = SCENE_LUMA_TARGETS[scene]
    metric = "median"
    face_target = None
    if scene == "portrait":
        face_med = _face_median_luma(img, faces)
        if face_med is not None:
            face_target = FACE_LUMA_TARGET
            metric = "face"

    if normalize_exposure and (target is not None or face_target is not None):
        eff_target = face_target if face_target is not None else target
        preset_exp = float(settings.get("exposure", 0) or 0)

        target = eff_target

        def sim(ev: float):
            """Render at this ev; return (metric_luma, new_clip_fraction).
            metric_luma is the face-region median for portraits, else global
            median; the clip guard is always measured globally."""
            out = render.apply_edit_settings(img, {**settings, "exposure": preset_exp + ev})
            luma = out @ _LUMA
            if metric == "face":
                fm = _face_median_luma(out, faces)
                m = fm if fm is not None else float(np.median(luma))
            else:
                m = float(np.median(luma))
            new_clip = float((luma[base_ok] > CLIP_LUMA).mean()) if base_ok.any() else 0.0
            return m, new_clip

        # Pixels already (nearly) clipped at baseline — e.g. street lights,
        # specular highlights — are exempt from the clip guard; we only limit
        # NEW clipping introduced by the exposure push.
        base_luma = render.apply_edit_settings(img, {**settings, "exposure": preset_exp}) @ _LUMA
        base_ok = base_luma <= BASE_BRIGHT
        med0, _c0 = sim(0.0)

        ev_sol = 0.0
        if abs(med0 - target) > MEDIAN_TOL:
            # Binary search: metric(ev) is monotone increasing in ev
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
            # 512px analysis thumb: enough resolution for WB neutral-pixel
            # detection and face-region metering. Personal model uses the same.
            thumb = thumbs.get_thumbnail_bytes(photo["path"], 512)
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
                faces = catalog.get_face_results(photo_id)
                settings = compute_auto_settings(
                    arr, len(faces),
                    scene_presets=scene_presets,
                    normalize_exposure=normalize_exposure,
                    faces=faces,
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
