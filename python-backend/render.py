"""
render.py — numpy implementation of docs/render-pipeline.md.

Mirrors the WebGL2 preview renderer (src/lib/render/) stage by stage.
The spec document is the contract — do not "fix" formulas here without
updating the spec and the GLSL side together. Parity is enforced by
tests/test_render_parity.py (mean dE76 < 2).
"""

import os

import cv2
import numpy as np
from PIL import Image, ImageOps

# Kept local (not imported from detectors) so render workers don't pull in
# mediapipe/onnxruntime just to check a file extension.
_RAW_EXTS = {
    ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf",
    ".orf", ".raf", ".rw2", ".pef", ".dng", ".raw",
}

EPS = 1e-6
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

IDENTITY_CURVE = [[0.0, 0.0], [1.0, 1.0]]

DEFAULTS = {
    "colorProfile": "color",
    "wbPreset": "as-shot",
    "temperature": 5500, "tint": 0,
    "exposure": 0, "contrast": 0, "highlights": 0, "shadows": 0, "whites": 0, "blacks": 0,
    "texture": 0, "clarity": 0, "dehaze": 0, "vibrance": 0, "saturation": 0,
    "sharpenAmount": 40, "sharpenRadius": 1.0, "sharpenDetail": 25, "sharpenMasking": 0,
    "noiseReduceLuminance": 0, "noiseReduceColor": 25,
    "hslHueRed": 0, "hslHueOrange": 0, "hslHueYellow": 0, "hslHueGreen": 0,
    "hslHueAqua": 0, "hslHueBlue": 0, "hslHuePurple": 0, "hslHueMagenta": 0,
    "hslSatRed": 0, "hslSatOrange": 0, "hslSatYellow": 0, "hslSatGreen": 0,
    "hslSatAqua": 0, "hslSatBlue": 0, "hslSatPurple": 0, "hslSatMagenta": 0,
    "hslLumRed": 0, "hslLumOrange": 0, "hslLumYellow": 0, "hslLumGreen": 0,
    "hslLumAqua": 0, "hslLumBlue": 0, "hslLumPurple": 0, "hslLumMagenta": 0,
    "calShadowsTint": 0,
    "calRedHue": 0, "calRedSat": 0, "calGreenHue": 0, "calGreenSat": 0,
    "calBlueHue": 0, "calBlueSat": 0,
    "toneCurve": IDENTITY_CURVE, "toneCurveRed": IDENTITY_CURVE,
    "toneCurveGreen": IDENTITY_CURVE, "toneCurveBlue": IDENTITY_CURVE,
}

PROFILE_DELTAS = {
    "color":     {"contrast": 0,   "saturation": 0,   "vibrance": 0,  "shadows": 0,  "highlights": 0},
    "vivid":     {"contrast": 15,  "saturation": 15,  "vibrance": 10, "shadows": 0,  "highlights": 0},
    "landscape": {"contrast": 10,  "saturation": 5,   "vibrance": 20, "shadows": 0,  "highlights": 0},
    "portrait":  {"contrast": -5,  "saturation": -5,  "vibrance": 5,  "shadows": 0,  "highlights": 0},
    "neutral":   {"contrast": -15, "saturation": -10, "vibrance": 0,  "shadows": 0,  "highlights": 0},
    "flat":      {"contrast": -30, "saturation": -20, "vibrance": 0,  "shadows": 20, "highlights": -20},
}

HSL_CENTERS = np.array([0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0], dtype=np.float32)
CAL_CENTERS = np.array([0.0, 120.0, 240.0], dtype=np.float32)
HSL_CHANNELS = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb @ LUMA


def sstep(a: float, b: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, None)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * (c ** (1.0 / 2.4)) - 0.055).astype(np.float32)


def resolve_effective(settings: dict) -> dict:
    s = {**DEFAULTS, **(settings or {})}
    d = PROFILE_DELTAS.get(s.get("colorProfile", "color"), PROFILE_DELTAS["color"])
    for key in ("contrast", "saturation", "vibrance", "shadows", "highlights"):
        s[key] = float(np.clip(s[key] + d[key], -100, 100))
    return s


# ---------------------------------------------------------------------------
# Tone curve — Fritsch–Carlson monotone cubic, 256-entry LUT
# ---------------------------------------------------------------------------

def _sanitize_curve(points) -> list:
    if not points or len(points) < 2:
        return IDENTITY_CURVE
    pts = sorted((float(p[0]), float(p[1])) for p in points)
    out = [pts[0]]
    for p in pts[1:]:
        if p[0] > out[-1][0] + 1e-9:
            out.append(p)
    return out if len(out) >= 2 else IDENTITY_CURVE


def monotone_cubic_lut(points, n: int = 256) -> np.ndarray:
    pts = _sanitize_curve(points)
    k = len(pts)
    xs = np.array([p[0] for p in pts], dtype=np.float64)
    ys = np.array([p[1] for p in pts], dtype=np.float64)

    d = (ys[1:] - ys[:-1]) / (xs[1:] - xs[:-1])
    m = np.empty(k)
    m[0] = d[0]
    m[-1] = d[-1]
    if k > 2:
        m[1:-1] = (d[:-1] + d[1:]) / 2.0

    for i in range(k - 1):
        if d[i] == 0.0:
            m[i] = 0.0
            m[i + 1] = 0.0
        else:
            a = m[i] / d[i]
            b = m[i + 1] / d[i]
            s = a * a + b * b
            if s > 9.0:
                tau = 3.0 / np.sqrt(s)
                m[i] = tau * a * d[i]
                m[i + 1] = tau * b * d[i]

    lut = np.empty(n, dtype=np.float32)
    for si in range(n):
        x = si / (n - 1)
        if x <= xs[0]:
            y = ys[0]
        elif x >= xs[-1]:
            y = ys[-1]
        else:
            i = 0
            while i < k - 2 and x > xs[i + 1]:
                i += 1
            h = xs[i + 1] - xs[i]
            t = (x - xs[i]) / h
            t2, t3 = t * t, t * t * t
            h00 = 2 * t3 - 3 * t2 + 1
            h10 = t3 - 2 * t2 + t
            h01 = -2 * t3 + 3 * t2
            h11 = t3 - t2
            y = h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]
        lut[si] = min(1.0, max(0.0, y))
    return lut


def _apply_lut_scalar(lut: np.ndarray, x: np.ndarray) -> np.ndarray:
    p = np.clip(x, 0.0, 1.0) * 255.0
    i = np.floor(p).astype(np.int32)
    f = (p - i).astype(np.float32)
    i1 = np.minimum(i + 1, 255)
    return lut[i] * (1.0 - f) + lut[i1] * f


def bake_tone_luts(settings: dict) -> np.ndarray:
    """Composed per-channel LUTs: lutC[i] = curveC(curveMain(i/255)). Shape (256, 3)."""
    main = monotone_cubic_lut(settings.get("toneCurve"))
    r = monotone_cubic_lut(settings.get("toneCurveRed"))
    g = monotone_cubic_lut(settings.get("toneCurveGreen"))
    b = monotone_cubic_lut(settings.get("toneCurveBlue"))
    out = np.empty((256, 3), dtype=np.float32)
    out[:, 0] = _apply_lut_scalar(r, main)
    out[:, 1] = _apply_lut_scalar(g, main)
    out[:, 2] = _apply_lut_scalar(b, main)
    return out


def _is_identity_curves(s: dict) -> bool:
    def ident(p):
        return not p or (len(p) == 2 and list(map(list, p)) == [[0, 0], [1, 1]])
    return all(ident(s.get(k)) for k in ("toneCurve", "toneCurveRed", "toneCurveGreen", "toneCurveBlue"))


# ---------------------------------------------------------------------------
# Blur helpers — hand-built gaussian kernels, BORDER_REPLICATE
# ---------------------------------------------------------------------------

def _gauss_kernel(sigma: float) -> np.ndarray:
    r = int(np.ceil(3.0 * sigma))
    i = np.arange(-r, r + 1, dtype=np.float32)
    w = np.exp(-(i * i) / (2.0 * sigma * sigma))
    return (w / w.sum()).astype(np.float32)


def _blur(img: np.ndarray, sigma: float) -> np.ndarray:
    k = _gauss_kernel(sigma)
    return cv2.sepFilter2D(img, -1, k, k, borderType=cv2.BORDER_REPLICATE)


# ---------------------------------------------------------------------------
# Pipeline stages (see docs/render-pipeline.md)
# ---------------------------------------------------------------------------

def _stage2_wb_exposure(rgb: np.ndarray, s: dict) -> np.ndarray:
    lin = srgb_to_linear(rgb)
    T = float(np.clip(s["temperature"], 2000, 50000))
    t = (1e6 / 5500.0 - 1e6 / T) / 150.0
    gR = 2.0 ** (0.5 * t)
    gB = 2.0 ** (-0.5 * t)
    gG = 2.0 ** (-0.5 * s["tint"] / 150.0)
    k = 0.2126 * gR + 0.7152 * gG + 0.0722 * gB
    gains = np.array([gR, gG, gB], dtype=np.float32) / k
    lin = lin * gains

    # Exposure with highlight shoulder (see spec Stage 2): positive exposure
    # compresses [P, 2^ev] into [P, 1] with a C1 join at P instead of clipping.
    ev = float(s["exposure"])
    lin = lin * (2.0 ** ev)
    P = 0.8
    w = max(2.0 ** ev, 1.0)
    sr = (w - P) / (1.0 - P)
    t2 = np.clip((lin - P) / (w - P), 0.0, 1.0)
    lin = np.minimum(lin, P) + (1.0 - P) * sr * t2 / (1.0 + (sr - 1.0) * t2)

    return np.clip(linear_to_srgb(np.clip(lin, 0.0, 1.0)), 0.0, 1.0)


def _stage3_tone(rgb: np.ndarray, s: dict) -> np.ndarray:
    c = s["contrast"] / 100.0
    if c >= 0:
        rgb = rgb + (rgb * rgb * (3.0 - 2.0 * rgb) - rgb) * c
    else:
        rgb = rgb + ((0.5 + (rgb - 0.5) * 0.5) - rgb) * (-c)

    L = luma(rgb)
    wHi = sstep(0.50, 1.00, L)
    wSh = 1.0 - sstep(0.00, 0.50, L)
    wWh = sstep(0.75, 1.00, L)
    wBl = 1.0 - sstep(0.00, 0.25, L)
    delta = (0.25 * (s["highlights"] / 100.0) * wHi
             + 0.25 * (s["shadows"] / 100.0) * wSh
             + 0.20 * (s["whites"] / 100.0) * wWh
             + 0.20 * (s["blacks"] / 100.0) * wBl)
    # Chroma-preserving luminance gain (spec Stage 3; eps is 1e-4 here)
    gain = np.clip((L + delta + 1e-4) / (L + 1e-4), 0.25, 4.0)
    rgb = np.clip(rgb * gain[..., None], 0.0, 1.0)

    if not _is_identity_curves(s):
        lut = bake_tone_luts(s)
        out = np.empty_like(rgb)
        for ch in range(3):
            out[..., ch] = _apply_lut_scalar(lut[:, ch], rgb[..., ch])
        rgb = np.clip(out, 0.0, 1.0)
    return rgb.astype(np.float32)


def _band_weights(h_deg: np.ndarray, centers: np.ndarray) -> np.ndarray:
    """Piecewise-linear weights between adjacent centers with wrap-around.
    h_deg: (...,) in [0, 360). Returns (..., n)."""
    n = len(centers)
    w = np.zeros(h_deg.shape + (n,), dtype=np.float32)
    for i in range(n):
        c0 = centers[i]
        c1 = 360.0 if i == n - 1 else centers[i + 1]
        in_band = (h_deg >= c0) & (h_deg < c1)
        t = np.where(in_band, (c1 - h_deg) / (c1 - c0), 0.0).astype(np.float32)
        w[..., i] += np.where(in_band, t, 0.0)
        w[..., (i + 1) % n] += np.where(in_band, 1.0 - t, 0.0)
    return w


def _rgb2hsv(rgb: np.ndarray):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    V = np.max(rgb, axis=-1)
    Cmin = np.min(rgb, axis=-1)
    C = V - Cmin
    S = C / np.maximum(V, EPS)
    H = np.zeros_like(V)
    m = C > EPS
    r_is = m & (V == r)
    g_is = m & (V == g) & ~r_is
    b_is = m & ~r_is & ~g_is
    H = np.where(r_is, np.mod((g - b) / np.maximum(C, EPS), 6.0), H)
    H = np.where(g_is, (b - r) / np.maximum(C, EPS) + 2.0, H)
    H = np.where(b_is, (r - g) / np.maximum(C, EPS) + 4.0, H)
    H = H / 6.0
    H = np.where(H < 0, H + 1.0, H)
    H = np.where(m, H, 0.0)
    return H.astype(np.float32), S.astype(np.float32), V.astype(np.float32)


def _hsv2rgb(H: np.ndarray, S: np.ndarray, V: np.ndarray) -> np.ndarray:
    h6 = H * 6.0
    C = V * S
    X = C * (1.0 - np.abs(np.mod(h6, 2.0) - 1.0))
    Z = np.zeros_like(C)
    m = V - C
    conds = [h6 < 1.0, h6 < 2.0, h6 < 3.0, h6 < 4.0, h6 < 5.0]
    r = np.select(conds, [C, X, Z, Z, X], default=C)
    g = np.select(conds, [X, C, C, X, Z], default=Z)
    b = np.select(conds, [Z, Z, X, C, C], default=X)
    return np.stack([r + m, g + m, b + m], axis=-1).astype(np.float32)


def apply_edit_settings(img: np.ndarray, settings: dict) -> np.ndarray:
    """img: HxWx3 float32 gamma-sRGB in [0,1] → edited float32 [0,1]."""
    s = resolve_effective(settings)
    rgb = img.astype(np.float32)

    # Stages 2–3 → T
    rgb = _stage2_wb_exposure(rgb, s)
    T = _stage3_tone(rgb, s)

    H_px, W_px = T.shape[:2]
    min_dim = min(W_px, H_px)
    sigma_tex = float(np.clip(2.0 * min_dim / 1000.0, 1.0, 8.0))
    sigma_clar = float(np.clip(12.0 * min_dim / 1000.0, 4.0, 50.0))
    sigma_sharp = float(s["sharpenRadius"])
    sigma_nr = 2.0

    # Stage 4 — blur sources from T
    L0 = luma(T).astype(np.float32)
    Btex = _blur(L0, sigma_tex)
    Bsharp = _blur(L0, sigma_sharp)
    Bnr = _blur(T, sigma_nr)
    # Clarity quarter-res path
    qw, qh = max(1, W_px // 4), max(1, H_px // 4)
    Lq = cv2.resize(L0, (qw, qh), interpolation=cv2.INTER_AREA)
    Bq = _blur(Lq, sigma_clar / 4.0)
    Bclar = cv2.resize(Bq, (W_px, H_px), interpolation=cv2.INTER_LINEAR)

    rgb = T.copy()

    # Stage 5 — texture & clarity
    rgb += ((s["texture"] / 100.0) * 0.4 * (L0 - Btex))[..., None]
    wmid = 1.0 - np.abs(2.0 * L0 - 1.0)
    rgb += ((s["clarity"] / 100.0) * 0.3 * wmid * (L0 - Bclar))[..., None]
    rgb = np.clip(rgb, 0.0, 1.0)

    # Stage 6 — dehaze
    d = s["dehaze"] / 100.0
    if d >= 0:
        rgb = np.clip((rgb - 0.15 * d) / (1.0 - 0.15 * d + EPS), 0.0, 1.0)
        lum6 = luma(rgb)[..., None]
        rgb = lum6 + (rgb - lum6) * (1.0 + 0.25 * d)
    else:
        a = -d
        rgb = rgb * (1.0 - 0.3 * a) + 0.3 * a * 0.85
        lum6 = luma(rgb)[..., None]
        rgb = lum6 + (rgb - lum6) * (1.0 - 0.3 * a)
    rgb = np.clip(rgb, 0.0, 1.0)

    # Stage 7 — HSV block
    Hh, S7, V7 = _rgb2hsv(rgb)
    h_deg = Hh * 360.0
    mask = sstep(0.0, 0.2, S7)

    w8 = _band_weights(h_deg, HSL_CENTERS)
    w3 = _band_weights(h_deg, CAL_CENTERS)

    hsl_hue = np.array([s[f"hslHue{c}"] for c in HSL_CHANNELS], dtype=np.float32)
    hsl_sat = np.array([s[f"hslSat{c}"] for c in HSL_CHANNELS], dtype=np.float32)
    hsl_lum = np.array([s[f"hslLum{c}"] for c in HSL_CHANNELS], dtype=np.float32)
    cal_hue = np.array([s["calRedHue"], s["calGreenHue"], s["calBlueHue"]], dtype=np.float32)
    cal_sat = np.array([s["calRedSat"], s["calGreenSat"], s["calBlueSat"]], dtype=np.float32)

    hue_shift = w8 @ (hsl_hue / 100.0 * 30.0) + w3 @ (cal_hue / 100.0 * 20.0)
    sat_mul8 = w8 @ (hsl_sat / 100.0)
    lum_exp = w8 @ (hsl_lum / 100.0)
    cal_sat_mul = w3 @ (cal_sat / 100.0)

    Hh = np.mod(Hh + mask * hue_shift / 360.0, 1.0)
    S7 = np.clip(S7 * (1.0 + mask * sat_mul8) * (1.0 + mask * 0.5 * cal_sat_mul), 0.0, 1.0)
    V7 = np.clip(V7 * (2.0 ** (0.5 * mask * lum_exp)), 0.0, 1.0)

    vib = s["vibrance"] / 100.0
    S7 = np.clip(S7 * (1.0 + vib * (1.0 - S7)), 0.0, 1.0)

    rgb = np.clip(_hsv2rgb(Hh, S7, V7), 0.0, 1.0)

    # Stage 8 — saturation + shadows tint
    lum8 = luma(rgb)[..., None]
    rgb = lum8 + (rgb - lum8) * (1.0 + s["saturation"] / 100.0)
    rgb = np.clip(rgb, 0.0, 1.0)
    L8 = luma(rgb)
    rgb[..., 1] -= 0.1 * (s["calShadowsTint"] / 100.0) * (1.0 - sstep(0.0, 0.5, L8))
    rgb = np.clip(rgb, 0.0, 1.0)

    # Stage 9 — sharpen + NR
    detail = L0 - Bsharp
    mk = s["sharpenMasking"] / 100.0
    if mk <= 0:
        m = np.ones_like(detail)
    else:
        m = sstep(0.0, 0.1 * mk, np.abs(detail))
    amt = (s["sharpenAmount"] / 150.0) * (0.6 + 0.8 * s["sharpenDetail"] / 100.0)
    rgb = rgb + (amt * m * detail)[..., None]

    nrL = s["noiseReduceLuminance"] / 100.0
    rgb = rgb + (nrL * 0.7 * (luma(Bnr) - luma(rgb)))[..., None]

    nrC = s["noiseReduceColor"] / 100.0
    lum9 = luma(rgb)[..., None]
    lumB = luma(Bnr)[..., None]
    chr_ = rgb - lum9
    # Align Bnr's chroma (from pre-saturation T) with the Stage-8 saturation,
    # so color NR doesn't re-saturate desaturated images
    chrB = (Bnr - lumB) * (1.0 + s["saturation"] / 100.0)
    rgb = lum9 + chr_ + (chrB - chr_) * (0.8 * nrC)
    rgb = np.clip(rgb, 0.0, 1.0)

    return rgb.astype(np.float32)


# ---------------------------------------------------------------------------
# Decode / encode
# ---------------------------------------------------------------------------

def decode_image(path: str, half_size: bool = False):
    """Decode to (HxWx3 float32 gamma-sRGB [0,1], exif_bytes | None)."""
    import rawpy

    ext = os.path.splitext(path)[1].lower()
    if ext in _RAW_EXTS:
        with rawpy.imread(path) as raw:
            rgb16 = raw.postprocess(
                use_camera_wb=True,
                no_auto_bright=True,
                output_color=rawpy.ColorSpace.sRGB,
                output_bps=16,
                half_size=half_size,
            )
        return (rgb16.astype(np.float32) / 65535.0), None

    img = Image.open(path)
    exif = img.info.get("exif")
    img = ImageOps.exif_transpose(img)  # strips orientation tag from its own exif
    if img.mode != "RGB":
        img = img.convert("RGB")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return arr, exif


def encode_u8(rgb: np.ndarray) -> np.ndarray:
    return np.rint(np.clip(rgb, 0.0, 1.0) * 255.0).astype(np.uint8)


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    rng = np.random.default_rng(1)
    img = rng.random((64, 96, 3), dtype=np.float32)

    # Near-defaults with sharpening/NR off must be identity-ish
    s = {**DEFAULTS, "sharpenAmount": 0, "noiseReduceColor": 0}
    out = apply_edit_settings(img, s)
    err = np.abs(out - img).max()
    assert err < 2e-3, f"identity error too large: {err}"

    # Exposure +1 must brighten
    out2 = apply_edit_settings(img, {**s, "exposure": 1.0})
    assert luma(out2).mean() > luma(out).mean() + 0.05

    # Monotone LUT sanity
    lut = monotone_cubic_lut([[0, 0], [0.5, 0.8], [1, 1]])
    assert np.all(np.diff(lut) >= -1e-6), "LUT must be monotone"
    ident = monotone_cubic_lut(IDENTITY_CURVE)
    assert np.abs(ident - np.linspace(0, 1, 256, dtype=np.float32)).max() < 1e-6

    # HSL red saturation drop must desaturate a red image
    red = np.zeros((8, 8, 3), dtype=np.float32)
    red[..., 0] = 0.8
    red[..., 1] = 0.1
    red[..., 2] = 0.1
    out3 = apply_edit_settings(red, {**s, "hslSatRed": -100})
    _, S_before, _ = _rgb2hsv(red)
    _, S_after, _ = _rgb2hsv(out3)
    assert S_after.mean() < S_before.mean() * 0.2

    print("render.py smoke test: ALL PASSED")
