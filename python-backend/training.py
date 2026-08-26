"""
training.py — personal AI profile: ingestion + trainer (Phase 5).

Ingestion: walk folders for image+XMP pairs, parse develop settings via
xmp_mapping, extract features (features.py), store in training_samples.

Trainer: PyTorch MLP head (features -> 50 normalized slider values), masked
MSE on the sliders each sample's XMP actually set, AdamW, early stopping.
Artifacts: <app-data>/profiles/1/head.onnx + stats.json. Inference runs on
onnxruntime only (torch is needed for training alone).
"""

import json
import os
import threading

import numpy as np
from PIL import Image

import catalog
import features
import xmp_mapping

IMAGE_EXTS = {
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".heic", ".heif",
    ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf",
    ".orf", ".raf", ".rw2", ".pef", ".dng", ".raw",
}

MIN_SAMPLES = 50           # hard floor to train at all
RECOMMENDED_SAMPLES = 500  # UI guidance threshold
VAL_FRACTION = 0.1
MAX_EPOCHS = 200
PATIENCE = 10
BATCH_SIZE = 64
LR = 1e-3

# Confidence guard: if masked val MSE exceeds this, inference falls back to
# scene-based auto-edit (targets are in [-1,1], so 0.04 ~= RMSE 0.2 = 10% of range)
VAL_LOSS_GUARD = 0.04


class TrainingCancelled(Exception):
    pass


def _check_cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise TrainingCancelled()


def profile_dir() -> str:
    d = os.path.join(catalog.data_dir(), "profiles", "1")
    os.makedirs(d, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------

def _thumb_for_features(path: str) -> Image.Image:
    import thumbs
    from io import BytesIO
    return Image.open(BytesIO(thumbs.get_thumbnail_bytes(path, 300)))


def ingest_training_data(folders: list, progress_callback=None, cancel_event=None) -> dict:
    """Find image+XMP pairs under the folders (recursive), extract features +
    targets, store in training_samples. Returns count + per-slider coverage."""
    pairs = []
    for folder in folders:
        for root, _dirs, files in os.walk(folder):
            names = {f.lower() for f in files}
            for f in files:
                stem, ext = os.path.splitext(f)
                if ext.lower() not in IMAGE_EXTS:
                    continue
                if f"{stem.lower()}.xmp" in names:
                    pairs.append((os.path.join(root, f), os.path.join(root, stem + ".xmp")))

    total = len(pairs)
    ingested = 0
    errors = 0
    coverage = np.zeros(features.N_TARGETS, dtype=np.int64)

    for i, (img_path, xmp_path) in enumerate(pairs):
        _check_cancel(cancel_event)
        if progress_callback:
            progress_callback(i + 1, total, f"Ingesting: {os.path.basename(img_path)}")
        try:
            settings, _warnings = xmp_mapping.read_xmp_file(xmp_path)
            if not settings:
                continue
            targets, mask = features.encode_targets(settings)
            if mask.sum() == 0:
                continue
            feat = features.extract_features(_thumb_for_features(img_path), img_path)
            catalog.add_training_sample(
                img_path, feat.tobytes(), targets.tobytes(), mask.tobytes()
            )
            coverage += (mask > 0).astype(np.int64)
            ingested += 1
        except TrainingCancelled:
            raise
        except Exception:
            errors += 1

    total_samples = catalog.count_training_samples()
    cov = {
        features.FIELD_NAMES[i]: int(coverage[i])
        for i in range(features.N_TARGETS)
        if coverage[i] > 0
    }
    if progress_callback:
        progress_callback(total, total,
                          f"Ingested {ingested} pairs ({total_samples} total in library).")
    return {
        "pairsFound": total,
        "ingested": ingested,
        "errors": errors,
        "totalSamples": total_samples,
        "coverage": cov,
        "minSamples": MIN_SAMPLES,
        "recommendedSamples": RECOMMENDED_SAMPLES,
    }


def capture_edit_sample(photo_id: int) -> bool:
    """Record a manual in-app edit as a training sample (image features +
    the sliders the user set). Called after the user adjusts a photo in the
    Edit tab, so the personal profile can learn from work done inside the app
    — no Lightroom XMP export required.

    Returns True when a sample was stored. Silently no-ops (returns False) on
    any problem — this must never break the edit-save path. Safe to call
    repeatedly for the same photo: source_path is UNIQUE, so re-edits update
    the existing sample rather than duplicating it (catalog.add_training_sample
    uses INSERT ... ON CONFLICT)."""
    try:
        photo = catalog.get_photo(photo_id)
        if photo is None:
            return False
        settings = catalog.get_edit_settings(photo_id)
        if not settings:
            return False
        # Only learn from human edits; AI-written settings are not demonstrations
        # of the user's taste. (The frontend strips aiEdited on manual change,
        # but guard here too.)
        if settings.get("aiEdited"):
            return False

        targets, mask = features.encode_targets(settings)
        if mask.sum() == 0:
            return False  # nothing trainable was set (e.g. only crop/rating)

        feat = features.extract_features(_thumb_for_features(photo["path"]), photo["path"])
        catalog.add_training_sample(
            photo["path"], feat.tobytes(), targets.tobytes(), mask.tobytes()
        )
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def train_profile(progress_callback=None, cancel_event=None) -> dict:
    """Train the MLP head on all training_samples; export ONNX + stats."""
    import torch
    import torch.nn as nn

    rows = catalog.get_training_samples()
    n = len(rows)
    if n < MIN_SAMPLES:
        raise ValueError(
            f"Not enough training data: {n} pairs (need at least {MIN_SAMPLES}, "
            f"recommend {RECOMMENDED_SAMPLES}+)"
        )

    X = np.stack([np.frombuffer(r["features"], dtype=np.float32) for r in rows])
    Y = np.stack([np.frombuffer(r["targets"], dtype=np.float32) for r in rows])
    M = np.stack([np.frombuffer(r["mask"], dtype=np.float32) for r in rows])

    # Feature standardization (saved for inference)
    mean = X.mean(axis=0)
    std = X.std(axis=0)
    std[std < 1e-6] = 1.0
    Xn = (X - mean) / std

    # Split (deterministic shuffle)
    rng = np.random.default_rng(42)
    order = rng.permutation(n)
    n_val = max(1, int(n * VAL_FRACTION))
    val_idx = order[:n_val]
    train_idx = order[n_val:]

    device = torch.device("cpu")
    Xt = torch.from_numpy(Xn[train_idx]).to(device)
    Yt = torch.from_numpy(Y[train_idx]).to(device)
    Mt = torch.from_numpy(M[train_idx]).to(device)
    Xv = torch.from_numpy(Xn[val_idx]).to(device)
    Yv = torch.from_numpy(Y[val_idx]).to(device)
    Mv = torch.from_numpy(M[val_idx]).to(device)

    dim = X.shape[1]
    model = nn.Sequential(
        nn.Linear(dim, 512), nn.ReLU(), nn.Dropout(0.2),
        nn.Linear(512, 256), nn.ReLU(), nn.Dropout(0.1),
        nn.Linear(256, features.N_TARGETS), nn.Tanh(),
    )
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)

    def masked_mse(pred, target, mask):
        se = (pred - target) ** 2 * mask
        return se.sum() / mask.sum().clamp(min=1.0)

    best_val = float("inf")
    best_state = None
    patience_left = PATIENCE
    n_train = len(train_idx)

    for epoch in range(MAX_EPOCHS):
        _check_cancel(cancel_event)
        model.train()
        perm = torch.randperm(n_train)
        epoch_loss = 0.0
        batches = 0
        for start in range(0, n_train, BATCH_SIZE):
            idx = perm[start:start + BATCH_SIZE]
            opt.zero_grad()
            loss = masked_mse(model(Xt[idx]), Yt[idx], Mt[idx])
            loss.backward()
            opt.step()
            epoch_loss += float(loss.detach())
            batches += 1

        model.eval()
        with torch.no_grad():
            val_loss = float(masked_mse(model(Xv), Yv, Mv))

        if progress_callback:
            progress_callback(epoch + 1, MAX_EPOCHS,
                              f"Epoch {epoch + 1}: train {epoch_loss / max(batches, 1):.4f}, "
                              f"val {val_loss:.4f}")

        if val_loss < best_val - 1e-5:
            best_val = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            patience_left = PATIENCE
        else:
            patience_left -= 1
            if patience_left <= 0:
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()

    # Per-slider validation MAE in real slider units
    with torch.no_grad():
        pred_v = model(Xv).numpy()
    mae = {}
    for i, (field, lo, hi) in enumerate(features.TRAINED_FIELDS):
        m = M[val_idx][:, i] > 0
        if m.sum() == 0:
            continue
        real_pred = np.array([features.denormalize_target(field, p) for p in pred_v[m, i]])
        real_true = np.array([features.denormalize_target(field, t) for t in Y[val_idx][m, i]])
        mae[field] = round(float(np.abs(real_pred - real_true).mean()), 3)

    # Export ONNX + stats.
    # dynamo=False forces the legacy (TorchScript) exporter: the dynamo
    # exporter prints progress to STDOUT, which would corrupt the sidecar's
    # line-JSON protocol.
    out_dir = profile_dir()
    onnx_path = os.path.join(out_dir, "head.onnx")
    dummy = torch.zeros(1, dim)
    import contextlib
    import io
    with contextlib.redirect_stdout(io.StringIO()):
        torch.onnx.export(
            model, dummy, onnx_path,
            input_names=["features"], output_names=["sliders"],
            dynamic_axes={"features": {0: "batch"}, "sliders": {0: "batch"}},
            dynamo=False,
        )
    stats = {
        "featureMean": mean.tolist(),
        "featureStd": std.tolist(),
        "fields": features.FIELD_NAMES,
        # How many training samples actually set each slider — inference only
        # emits sliders the photographer demonstrably uses (see predict_settings)
        "fieldCoverage": M.sum(axis=0).astype(int).tolist(),
        "valLoss": best_val,
        "valGuard": VAL_LOSS_GUARD,
        "samples": n,
        "valMae": mae,
    }
    with open(os.path.join(out_dir, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f)
    catalog.set_ai_profile_model(onnx_path)

    if progress_callback:
        progress_callback(MAX_EPOCHS, MAX_EPOCHS,
                          f"Training done — val loss {best_val:.4f} on {n} samples.")
    return {
        "valLoss": round(best_val, 5),
        "samples": n,
        "valMae": mae,
        "usable": best_val <= VAL_LOSS_GUARD,
        "modelPath": onnx_path,
    }


# ---------------------------------------------------------------------------
# Inference (onnxruntime only — no torch needed)
# ---------------------------------------------------------------------------

_infer_session = None
_infer_stats = None


def load_personal_model():
    """Returns (session, stats) or (None, None) when no usable model exists."""
    global _infer_session, _infer_stats
    if _infer_session is not None:
        return _infer_session, _infer_stats
    onnx_path = os.path.join(profile_dir(), "head.onnx")
    stats_path = os.path.join(profile_dir(), "stats.json")
    if not (os.path.exists(onnx_path) and os.path.exists(stats_path)):
        return None, None
    try:
        import onnxruntime as ort
        with open(stats_path, "r", encoding="utf-8") as f:
            stats = json.load(f)
        session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
        _infer_session = session
        _infer_stats = stats
        return session, stats
    except Exception:
        return None, None


def invalidate_model_cache():
    global _infer_session, _infer_stats
    _infer_session = None
    _infer_stats = None


def personal_model_status() -> dict:
    session, stats = load_personal_model()
    if session is None:
        return {"available": False, "samples": catalog.count_training_samples()}
    return {
        "available": True,
        "usable": stats.get("valLoss", 1.0) <= stats.get("valGuard", VAL_LOSS_GUARD),
        "valLoss": stats.get("valLoss"),
        "samples": stats.get("samples"),
        "trainingSamples": catalog.count_training_samples(),
    }


def predict_settings(img: Image.Image, path: str) -> dict | None:
    """Predict EditSettings for a photo, or None when no usable model."""
    session, stats = load_personal_model()
    if session is None:
        return None
    if stats.get("valLoss", 1.0) > stats.get("valGuard", VAL_LOSS_GUARD):
        return None  # confidence guard — fall back to scene-based editing
    feat = features.extract_features(img, path)
    mean = np.asarray(stats["featureMean"], dtype=np.float32)
    std = np.asarray(stats["featureStd"], dtype=np.float32)
    if feat.shape[0] != mean.shape[0]:
        return None  # embedding backend changed since training
    x = ((feat - mean) / std)[None].astype(np.float32)
    pred = session.run(None, {"features": x})[0][0]

    decoded = features.decode_targets(pred)
    # Only emit sliders the photographer actually uses: fields absent from the
    # training data would otherwise decode to mid-range garbage.
    coverage = stats.get("fieldCoverage")
    if coverage:
        n = max(stats.get("samples", 1), 1)
        min_cov = max(5, int(0.05 * n))
        decoded = {
            field: value
            for field, value in decoded.items()
            if coverage[features.FIELD_NAMES.index(field)] >= min_cov
        }
    return decoded
