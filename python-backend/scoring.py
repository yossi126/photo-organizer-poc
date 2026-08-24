"""
scoring.py — culling intelligence: aesthetic scoring, similarity stacks,
combined quality scores, auto star ratings and best-in-stack picks.

Runs as a post-scan step (see organizer.run_culling_analysis). All state is
persisted through catalog.py.
"""

import os
import threading
from io import BytesIO

import numpy as np
from PIL import Image

import catalog
import embeddings
import thumbs

# Combined-score weights (technical / aesthetic / face)
W_TECH = 0.5
W_AESTHETIC = 0.3
W_FACE = 0.2

STACK_COSINE_THRESHOLD = 0.90
STACK_TIME_GAP_S = 8.0

# Percentile -> stars mapping (cumulative from the top)
STAR_PERCENTILES = [
    (0.10, 5),   # top 10%
    (0.35, 4),   # next 25%
    (0.75, 3),   # middle 40%
    (0.90, 2),   # next 15%
    (1.01, 1),   # bottom 10%
]


class CullingCancelled(Exception):
    pass


def _check_cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise CullingCancelled()


# ---------------------------------------------------------------------------
# Aesthetic score (1..10) — classical heuristic on a thumbnail.
# A NIMA-style ONNX model can replace this later without changing callers.
# ---------------------------------------------------------------------------

def aesthetic_score(img: Image.Image) -> float:
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b

    # Colorfulness (Hasler & Süsstrunk) — typical photos land ~0.05-0.35
    rg = r - g
    yb = 0.5 * (r + g) - b
    colorfulness = float(
        np.sqrt(rg.std() ** 2 + yb.std() ** 2)
        + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2)
    )
    c_score = np.clip(colorfulness / 0.35, 0, 1)

    # RMS contrast — flat images score low
    contrast = float(luma.std())
    k_score = np.clip(contrast / 0.28, 0, 1)

    # Exposure balance — penalize clipped shadows/highlights and off-center mean
    clip_lo = float((luma < 0.02).mean())
    clip_hi = float((luma > 0.98).mean())
    mean_pen = abs(float(luma.mean()) - 0.5) / 0.5
    e_score = np.clip(1.0 - 2.0 * (clip_lo + clip_hi) - 0.5 * mean_pen, 0, 1)

    # Sharpness proxy (gradient energy on the thumbnail)
    gy, gx = np.gradient(luma)
    sharp = float(np.sqrt(gx ** 2 + gy ** 2).mean())
    s_score = np.clip(sharp / 0.06, 0, 1)

    score01 = 0.30 * c_score + 0.25 * k_score + 0.25 * e_score + 0.20 * s_score
    return round(1.0 + 9.0 * float(score01), 2)


# ---------------------------------------------------------------------------
# Technical score (0..1) from stored analysis scores
# ---------------------------------------------------------------------------

def technical_score(scores: dict, category: str) -> float:
    blur = scores.get("blur") or 0.0
    brightness = scores.get("brightness")
    # Blur: log-scaled; ~50 (threshold) -> 0.45, 200+ -> ~0.9
    t_blur = float(np.clip(np.log10(max(blur, 1.0)) / np.log10(400.0), 0, 1))
    # Exposure: distance from mid-gray
    if brightness is None:
        t_exp = 0.5
    else:
        t_exp = float(np.clip(1.0 - abs(brightness - 128.0) / 128.0, 0, 1))
    t = 0.65 * t_blur + 0.35 * t_exp
    # Hard penalties for detected problems
    if category == "_blurry":
        t *= 0.35
    elif category == "_eyes_closed":
        t *= 0.55
    elif category in ("_dark", "_overexposed"):
        t *= 0.7
    elif category == "_duplicates":
        t *= 0.8
    return float(np.clip(t, 0, 1))


def face_quality_score(faces: list) -> float | None:
    """Mean face quality 0..1 from per-face records; None when no faces."""
    if not faces:
        return None
    vals = []
    for f in faces:
        sharp = f.get("sharpness") or 0.0
        f_sharp = float(np.clip(np.log10(max(sharp, 1.0)) / np.log10(400.0), 0, 1))
        f_eyes = 1.0 if f.get("eyes_open") else 0.2
        smile = f.get("smile")
        f_smile = 0.5 if smile is None else float(np.clip(0.4 + smile, 0, 1))
        vals.append(0.5 * f_sharp + 0.35 * f_eyes + 0.15 * f_smile)
    return float(np.mean(vals))


# ---------------------------------------------------------------------------
# Similarity stacks — time window + embedding cosine + union-find
# ---------------------------------------------------------------------------

class _UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, i):
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def build_stacks(rows: list, cancel_event=None) -> dict:
    """rows: culling rows with id, capture_time/mtime, embedding blob.
    Returns {photo_id: stack_id} for photos in stacks of size >= 2."""
    items = []
    for r in rows:
        if r.get("embedding") is None:
            continue
        t = r.get("capture_time") or r.get("mtime") or 0.0
        items.append((r["id"], t, embeddings.from_blob(r["embedding"])))
    items.sort(key=lambda x: x[1])

    uf = _UnionFind(len(items))
    for i in range(len(items)):
        _check_cancel(cancel_event)
        for j in range(i + 1, len(items)):
            if items[j][1] - items[i][1] > STACK_TIME_GAP_S:
                break
            if embeddings.cosine(items[i][2], items[j][2]) >= STACK_COSINE_THRESHOLD:
                uf.union(i, j)

    groups = {}
    for idx, (photo_id, _t, _v) in enumerate(items):
        groups.setdefault(uf.find(idx), []).append(photo_id)

    stack_map = {}
    next_stack = 1
    for members in groups.values():
        if len(members) < 2:
            continue
        for pid in members:
            stack_map[pid] = next_stack
        next_stack += 1
    return stack_map


# ---------------------------------------------------------------------------
# Full culling pass for a project
# ---------------------------------------------------------------------------

def run_culling_analysis(project_id: int, progress_callback=None, cancel_event=None) -> dict:
    """Embeddings + aesthetic + combined scores + stacks + auto stars + picks.
    Skips photos that already have an embedding (incremental)."""
    rows = catalog.get_culling_rows(project_id)
    total = len(rows)

    def progress(i, msg):
        if progress_callback:
            progress_callback(i, total, msg)

    # 1. Embeddings + aesthetic + capture time (incremental per photo)
    for i, r in enumerate(rows):
        _check_cancel(cancel_event)
        needs_embed = r.get("embedding") is None
        needs_aesthetic = r.get("aesthetic_score") is None
        if not needs_embed and not needs_aesthetic:
            continue
        progress(i + 1, f"AI analysis: {r['filename']}")
        try:
            thumb = thumbs.get_thumbnail_bytes(r["path"], 300)
            img = Image.open(BytesIO(thumb))
            kwargs = {}
            if needs_embed:
                kwargs["embedding"] = embeddings.to_blob(embeddings.embed_pil(img))
            if needs_aesthetic:
                kwargs["aesthetic"] = aesthetic_score(img)
            if r.get("capture_time") is None:
                kwargs["capture_time"] = _capture_time(r["path"], r.get("mtime"))
            catalog.set_extra_analysis(r["id"], **kwargs)
        except Exception:
            continue

    # 2. Combined scores
    rows = catalog.get_culling_rows(project_id)
    import json as _json
    combined = {}
    for r in rows:
        _check_cancel(cancel_event)
        scores = _json.loads(r.get("scores") or "{}")
        tech = technical_score(scores, r.get("category") or "clean")
        aest01 = ((r.get("aesthetic_score") or 5.0) - 1.0) / 9.0
        fq = face_quality_score(catalog.get_face_results(r["id"]))
        if fq is None:
            # No faces: redistribute the face weight to technical
            c = (W_TECH + W_FACE) * tech + W_AESTHETIC * aest01
        else:
            c = W_TECH * tech + W_AESTHETIC * aest01 + W_FACE * fq
        combined[r["id"]] = float(c)
        catalog.set_extra_analysis(r["id"], combined=round(c, 4), face_quality=fq)

    # 3. Stacks
    progress(total, "Grouping similar photos into stacks...")
    stack_ids = build_stacks(rows, cancel_event)
    stack_map = {}
    stacks = {}
    for pid, sid in stack_ids.items():
        stacks.setdefault(sid, []).append(pid)
    for sid, members in stacks.items():
        top = max(members, key=lambda pid: combined.get(pid, 0.0))
        for pid in members:
            stack_map[pid] = (sid, pid == top)
    catalog.apply_stacks(project_id, stack_map)

    # 4. Auto star ratings — per-project percentile calibration
    progress(total, "Assigning auto star ratings...")
    ordered = sorted(combined.items(), key=lambda kv: kv[1], reverse=True)
    n = len(ordered)
    ratings = {}
    for rank, (pid, _score) in enumerate(ordered):
        pct = (rank + 1) / max(n, 1)
        for limit, stars in STAR_PERCENTILES:
            if pct <= limit:
                ratings[pid] = stars
                break
    catalog.set_auto_ratings(ratings)

    # 5. Best-in-stack picks (only set pick, never touch user rejects)
    pick_count = 0
    for sid, members in stacks.items():
        top = max(members, key=lambda pid: combined.get(pid, 0.0))
        row = next((r for r in rows if r["id"] == top), None)
        if row is not None:
            catalog.set_flag(project_id, row["filename"], "pick")
            pick_count += 1

    progress(total, f"Culling analysis done — {len(stacks)} stacks, {pick_count} picks.")
    return {"stacks": len(stacks), "picks": pick_count, "photos": total}


def _capture_time(path: str, fallback_mtime):
    """EXIF DateTimeOriginal as unix time; falls back to file mtime."""
    try:
        img = Image.open(path)
        exif = img.getexif()
        # 36867 DateTimeOriginal lives in the Exif IFD
        exif_ifd = exif.get_ifd(0x8769) if exif else {}
        dt = exif_ifd.get(36867) or exif.get(306)
        if dt:
            import time as _time
            return _time.mktime(_time.strptime(str(dt), "%Y:%m:%d %H:%M:%S"))
    except Exception:
        pass
    if fallback_mtime:
        return float(fallback_mtime)
    try:
        return os.path.getmtime(path)
    except OSError:
        return None
