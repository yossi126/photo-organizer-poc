"""
embeddings.py — image embeddings for similarity stacking and AI features.

Primary: MobileNetV2 ONNX (models/mobilenetv2-7.onnx) via onnxruntime —
1000-d logits, L2-normalized. Fallback (model file missing): classical
feature vector (16x16 downscaled pixels + per-channel histograms), weaker
semantically but fine for burst grouping.
"""

import os

import numpy as np
from PIL import Image

_MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
_MODEL_PATH = os.path.join(_MODELS_DIR, "mobilenetv2-7.onnx")

_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

_session = None
_session_failed = False


def _get_session():
    global _session, _session_failed
    if _session is not None or _session_failed:
        return _session
    if not os.path.exists(_MODEL_PATH):
        _session_failed = True
        return None
    try:
        import onnxruntime as ort
        _session = ort.InferenceSession(_MODEL_PATH, providers=["CPUExecutionProvider"])
    except Exception:
        _session_failed = True
        _session = None
    return _session


def model_available() -> bool:
    return _get_session() is not None


def _l2norm(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    return (v / n if n > 1e-9 else v).astype(np.float32)


def _fallback_embedding(img: Image.Image) -> np.ndarray:
    """Classical features: 16x16 RGB pixels + 3x32-bin histograms."""
    small = np.asarray(img.resize((16, 16), Image.LANCZOS), dtype=np.float32) / 255.0
    arr = np.asarray(img, dtype=np.float32) / 255.0
    hists = [
        np.histogram(arr[..., c], bins=32, range=(0, 1), density=True)[0]
        for c in range(3)
    ]
    feat = np.concatenate([small.ravel(), np.concatenate(hists) / 32.0])
    return _l2norm(feat)


def embed_pil(img: Image.Image) -> np.ndarray:
    """Embed one PIL RGB image. Returns a float32 L2-normalized vector."""
    if img.mode != "RGB":
        img = img.convert("RGB")
    session = _get_session()
    if session is None:
        return _fallback_embedding(img)

    # Resize short side to 256, center-crop 224 (standard ImageNet eval)
    w, h = img.size
    scale = 256 / min(w, h)
    img2 = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.BILINEAR)
    w2, h2 = img2.size
    left = (w2 - 224) // 2
    top = (h2 - 224) // 2
    img2 = img2.crop((left, top, left + 224, top + 224))

    x = np.asarray(img2, dtype=np.float32) / 255.0
    x = (x - _IMAGENET_MEAN) / _IMAGENET_STD
    x = x.transpose(2, 0, 1)[None]  # NCHW

    input_name = session.get_inputs()[0].name
    logits = session.run(None, {input_name: x})[0][0]
    return _l2norm(logits)


def embed_bytes(jpeg_bytes: bytes) -> np.ndarray:
    from io import BytesIO
    return embed_pil(Image.open(BytesIO(jpeg_bytes)))


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def to_blob(v: np.ndarray) -> bytes:
    return v.astype(np.float32).tobytes()


def from_blob(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)
