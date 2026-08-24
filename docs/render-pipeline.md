# Render Pipeline Specification

**This document is the single source of truth for the edit-render engine.**
Two implementations exist and MUST follow this spec exactly, stage by stage:

- **Preview:** WebGL2 — `src/lib/render/` (shaders.ts, renderer.ts, luts.ts, profiles.ts)
- **Export:** Python/numpy — `python-backend/render.py`

Neither implementation is the reference for the other; THIS document is.
Parity is enforced by `python-backend/tests/test_render_parity.py`
(mean ΔE76 < 2, p99 < 6 on golden fixtures). We target internal consistency,
not pixel-identity with Adobe Lightroom (their tone math is proprietary).

---

## Conventions

- All math in **float32**. RGB values in `[0, 1]`. `eps = 1e-6`.
- Luma (Rec.709): `luma(rgb) = 0.2126*R + 0.7152*G + 0.0722*B`.
  Computed in whatever domain the stage operates in (gamma-domain luma is
  intentional and part of the spec).
- `sstep(a, b, x)` = GLSL `smoothstep`:
  `t = clamp((x-a)/(b-a), 0, 1); return t*t*(3-2*t)`.
  Python implements this exact formula.
- `mix(a, b, t) = a*(1-t) + b*t`.
- **Clamp rule: clamp rgb to [0, 1] at the END of every numbered stage.**
- Exactly **two** transfer-function conversions in the whole pipeline:
  sRGB→linear before Stage 2, linear→sRGB after Stage 2.
  Stages 3–9 operate in gamma (sRGB-encoded) domain.

sRGB transfer functions (exact, both engines):

```
s2l(c) = c / 12.92                      if c <= 0.04045
       = ((c + 0.055) / 1.055)^2.4      otherwise

l2s(c) = 12.92 * c                      if c <= 0.0031308
       = 1.055 * c^(1/2.4) - 0.055      otherwise
```

---

## Stage 0 — Decode

- **JPEG/PNG/etc.:** 8-bit values / 255 → gamma-domain sRGB in [0,1].
  EXIF orientation applied at decode:
  - JS: `createImageBitmap(blob, { imageOrientation: "from-image", colorSpaceConversion: "none" })`
  - Python: `PIL.ImageOps.exif_transpose(img)` (strips the orientation tag —
    prevents double rotation when EXIF is passed through on export).
- **RAW** (both the 2560px preview base and full-res export use the SAME params):
  ```python
  rawpy.imread(path).postprocess(
      use_camera_wb=True,
      no_auto_bright=True,
      output_color=rawpy.ColorSpace.sRGB,
      output_bps=16,
  )  # then / 65535.0
  ```
  Preview base additionally passes `half_size=True` (speed).
  The output is treated as sRGB-encoded (rawpy's default gamma ≈ sRGB —
  documented approximation).
- ICC profiles are ignored (assume sRGB). Documented limitation; identical in
  both engines.

## Stage 1 — Resolve effective settings

Pure function `resolveEffectiveSettings(settings)` implemented identically in
`src/lib/render/profiles.ts` and `render.py::resolve_effective`:

1. Merge stored settings over defaults (`{...DEFAULTS, ...stored}`) so rows
   persisted before new fields existed still render.
2. Add the color-profile deltas to the corresponding slider values:

   | profile   | contrast | saturation | vibrance | shadows | highlights |
   |-----------|----------|------------|----------|---------|------------|
   | color     | 0        | 0          | 0        | 0       | 0          |
   | vivid     | +15      | +15        | +10      | 0       | 0          |
   | landscape | +10      | +5         | +20      | 0       | 0          |
   | portrait  | −5       | −5         | +5       | 0       | 0          |
   | neutral   | −15      | −10        | 0        | 0       | 0          |
   | flat      | −30      | −20        | 0        | +20     | −20        |

3. Clamp every slider to its UI range afterwards
   (contrast/sat/vib/shadows/highlights: ±100).

`wbPreset` is **UI-only**: choosing a preset writes temperature/tint slider
values (as-shot / auto / flash → 5500/0, daylight 5500/+10, cloudy 6500/+10,
shade 7500/+10, tungsten 2850/0, fluorescent 3800/+20; custom = untouched).
The engine reads only `temperature` and `tint`.

## Stage 2 — White balance + exposure (LINEAR domain)

```
lin = s2l(rgb)                                       # per channel

T   = clamp(temperature, 2000, 50000)
t   = (1e6/5500 - 1e6/T) / 150                       # mired shift
gR  = exp2( 0.5 * t)
gB  = exp2(-0.5 * t)
gG  = exp2(-0.5 * tint / 150)                        # tint > 0 → magenta
k   = 0.2126*gR + 0.7152*gG + 0.0722*gB              # luminance-preserving
lin = lin * vec3(gR, gG, gB) / k

# Exposure with a highlight shoulder (Lightroom-like rolloff).
# Positive exposure compresses [P, 2^ev] smoothly into [P, 1] with a
# slope-1 (C1) join at P instead of hard-clipping at 1.0.
lin = lin * exp2(exposure)
P   = 0.8                                            # shoulder start (linear)
w   = max(exp2(exposure), 1.0)                       # scene white point
s   = (w - P) / (1.0 - P)                            # >= 1  (w - P >= 0.2)
t2  = clamp((lin - P) / (w - P), 0, 1)               # per channel
lin = min(lin, P) + (1.0 - P) * s * t2 / (1.0 + (s - 1.0) * t2)

rgb = clamp(l2s(clamp(lin, 0, 1)), 0, 1)             # back to gamma domain
```

Properties (both engines must preserve them exactly):
- `exposure = 0` → `w = 1, s = 1` → the shoulder is the identity on [P, 1];
  the whole stage is a no-op apart from WB.
- `exposure < 0` → pure linear gain (any WB overflow above 1 clips at 1,
  same as before).
- `exposure > 0` → an input of `2^exposure` maps exactly to 1.0: whites stay
  white, highlight detail is compressed instead of clipped, midtones below
  P get the full gain.
- The shoulder is applied **per channel**: colored near-clip highlights
  desaturate toward white under strong positive exposure — intentional,
  film-like behavior.

## Stage 3 — Tone (gamma domain)

Order inside the stage: contrast → highlights/shadows/whites/blacks → tone curve.

**Contrast** — `c = contrast/100 ∈ [-1, 1]`, applied per channel to `x`:

```
c >= 0:  y = mix(x, x*x*(3 - 2*x), c)                # toward smoothstep S-curve
c <  0:  y = mix(x, 0.5 + (x - 0.5)*0.5, -c)         # toward slope-0.5 line
```

**Highlights / Shadows / Whites / Blacks** — luminance-masked,
**chroma-preserving** (multiplicative luminance gain — an additive shift
would gray out color when lifting shadows). `L = luma(rgb)` computed AFTER
contrast:

```
wHi = sstep(0.50, 1.00, L)
wSh = 1 - sstep(0.00, 0.50, L)
wWh = sstep(0.75, 1.00, L)
wBl = 1 - sstep(0.00, 0.25, L)

delta = 0.25*(highlights/100)*wHi
      + 0.25*(shadows  /100)*wSh
      + 0.20*(whites   /100)*wWh
      + 0.20*(blacks   /100)*wBl

# NOTE: the epsilon here is 1e-4 (NOT the global 1e-6) in both engines.
gain = clamp((L + delta + 1e-4) / (L + 1e-4), 0.25, 4.0)
rgb  = clamp(rgb * gain, 0, 1)
```

Properties: `delta = 0` → `gain ≡ 1` exactly for every L (identity);
midtone luma response ≈ `L + delta` (same slider strength as the previous
additive form); the 4.0 gain cap keeps true blacks black instead of
lifting them to flat gray; channel ratios are preserved, so shadow lifts
keep their color.

**Tone curve** — settings fields `toneCurve`, `toneCurveRed`, `toneCurveGreen`,
`toneCurveBlue`: lists of `[x, y]` points in [0,1], x strictly increasing,
≥ 2 points, default `[[0,0],[1,1]]`.

LUT baking (CPU, identical algorithm in JS `luts.ts` and Python `render.py`):

1. **Fritsch–Carlson monotone cubic interpolation.**
   Secants `d_k = (y_{k+1} - y_k) / (x_{k+1} - x_k)`.
   Tangents: `m_0 = d_0`, `m_n = d_{n-1}`, interior `m_k = (d_{k-1} + d_k)/2`.
   For each interval k: if `d_k == 0` then `m_k = m_{k+1} = 0`;
   else with `a = m_k/d_k`, `b = m_{k+1}/d_k`, if `a² + b² > 9`:
   `τ = 3/sqrt(a²+b²); m_k = τ*a*d_k; m_{k+1} = τ*b*d_k`.
   Evaluate with the cubic Hermite basis; clamp output to [0,1];
   outside `[x_first, x_last]` extend flat (y_first / y_last).
2. **Compose** into a 256-entry LUT per channel:
   `lutR[i] = curveRed(curveMain(i/255))`, same for G and B.
3. **Apply** with an explicit lerp — identical in both engines:
   `p = x*255; i = floor(p); f = p - i; y = lut[i]*(1-f) + lut[min(i+1, 255)]*f`.
   GLSL: two `texelFetch` calls on a NEAREST-filtered RGBA32F 256×1 texture +
   `mix` (no filtered float lookups — avoids precision/extension ambiguity).

## Stage 4 — Blur sources

All blur-based ops (texture, clarity, sharpen, noise reduction) take their
blurred input from **T = the Stage-3 output**, not from their serial position
in the pipeline. Both engines identical.

Sigmas in **pixels at the current render resolution** (resolution-invariant
look; exact parity when both engines render at identical dimensions):

```
σ_tex   = clamp(2.0  * min(W,H) / 1000, 1.0, 8.0)
σ_clar  = clamp(12.0 * min(W,H) / 1000, 4.0, 50.0)
σ_sharp = sharpenRadius                              # 0.5 .. 3.0 px
σ_nr    = 2.0
```

Gaussian kernel: radius `r = ceil(3σ)`, weights `w_i = exp(-i²/(2σ²))`
normalized to sum 1, applied separably (horizontal then vertical).
Kernels are **built by hand from this formula** in both engines
(NOT `cv2.getGaussianKernel`). Edge handling: GLSL `CLAMP_TO_EDGE`
≡ Python `cv2.sepFilter2D(..., borderType=cv2.BORDER_REPLICATE)`.

Outputs:
- `Btex   = blur(luma(T), σ_tex)`      (scalar)
- `Bclar  = blur(luma(T), σ_clar)`     (scalar, quarter-res path below)
- `Bsharp = blur(luma(T), σ_sharp)`    (scalar)
- `Bnr    = blur(T_rgb,  σ_nr)`        (rgb)

**Clarity quarter-res path** (performance; both engines):
downsample T-luma by two successive 2×2 box averages (= exact 4×4 box ≡
`cv2.resize(..., fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)` when W,H
divisible by 4; for non-divisible sizes each engine uses its native op —
covered by the ΔE tolerance), blur with `σ_clar/4`, upsample bilinearly
(GLSL LINEAR sampling ≡ `cv2.resize(..., interpolation=cv2.INTER_LINEAR)`).

## Stage 5 — Texture & clarity (gamma)

```
L = luma(T)
rgb = rgb + (texture/100) * 0.4 * (L - Btex)
wmid = 1 - abs(2*L - 1)
rgb = rgb + (clarity/100) * 0.3 * wmid * (L - Bclar)
```

## Stage 6 — Dehaze

`d = dehaze/100`:

```
d >= 0:
  x'  = clamp((x - 0.15*d) / (1 - 0.15*d + eps), 0, 1)     # per channel
  lum = luma(rgb')
  rgb' = lum + (rgb' - lum) * (1 + 0.25*d)                  # saturation boost

d < 0:  a = -d
  x'  = x*(1 - 0.3*a) + 0.3*a*0.85                          # toward light gray
  lum = luma(rgb')
  rgb' = lum + (rgb' - lum) * (1 - 0.3*a)
```

## Stage 7 — HSV block: HSL (8 bands) + calibration hue/sat + vibrance

RGB→HSV, standard definition:
`V = max(r,g,b); C = V - min(r,g,b); S = C / max(V, eps)`;
`H` piecewise in [0,1). (The Hočevar branchless GLSL form is mathematically
equivalent to the numpy piecewise form.)

**Band weights** — piecewise-linear interpolation between adjacent centers;
weights always sum to 1:

- HSL centers (degrees): `[0 red, 30 orange, 60 yellow, 120 green, 180 aqua,
  240 blue, 280 purple, 320 magenta]`, wrapping 320 → 360≡0.
- For hue `h` between adjacent centers `c_i < c_{i+1}`:
  `w_i = (c_{i+1} - h)/(c_{i+1} - c_i)`, `w_{i+1} = 1 - w_i`, all others 0.
- Calibration uses the same scheme with 3 centers `[0 red, 120 green, 240 blue]`
  (wrapping 240 → 360≡0) → weights `v_j`.

Gray protection: `mask = sstep(0.0, 0.2, S)`.

```
hueShift_deg = Σ w_i * (hslHue_i/100) * 30  +  Σ v_j * (calHue_j/100) * 20
H' = fract(H + mask * hueShift_deg/360)
S' = clamp(S * (1 + mask * Σ w_i*hslSat_i/100)
             * (1 + mask * 0.5 * Σ v_j*calSat_j/100), 0, 1)
V' = clamp(V * exp2(0.5 * mask * Σ w_i*hslLum_i/100), 0, 1)

vib = vibrance/100
S'' = clamp(S' * (1 + vib*(1 - S')), 0, 1)     # low-sat-weighted, no skin protection in v1
```

HSV→RGB standard. Note: calibration hue/sat live inside this block (documented
deviation from nominal slider order; both engines identical).

## Stage 8 — Saturation (luma-preserving) + shadows tint

```
lum = luma(rgb)
rgb = lum + (rgb - lum) * (1 + saturation/100)

L = luma(rgb)
g = g - 0.1 * (calShadowsTint/100) * (1 - sstep(0.0, 0.5, L))   # + → magenta shadows
```

## Stage 9 — Sharpen + noise reduction

```
detail = luma(T) - Bsharp
mk  = sharpenMasking/100
m   = 1.0                     if mk <= 0
    = sstep(0.0, 0.1*mk, abs(detail))   otherwise
amt = (sharpenAmount/150) * (0.6 + 0.8*sharpenDetail/100)
rgb = rgb + amt * m * detail

nrL = noiseReduceLuminance/100
rgb = rgb + nrL * 0.7 * (luma(Bnr) - luma(rgb))       # luma toward blurred

nrC  = noiseReduceColor/100
lum  = luma(rgb);  lumB = luma(Bnr)
chr  = rgb - lum
# Bnr is a blur of T (pre-saturation), so align its chroma with the global
# saturation applied in Stage 8 — otherwise color NR re-saturates B&W images.
chrB = (Bnr - lumB) * (1 + saturation/100)
rgb  = lum + mix(chr, chrB, 0.8*nrC)
```

Parity note: sharpen/NR formulas are identical in both engines; because σ is
in output pixels, a 2560px preview and a full-res export legitimately differ
in fine detail. The parity harness renders both engines at identical
dimensions.

## Encode

`clamp(rgb, 0, 1)`; output byte = `rint(x * 255)`. No further gamma encode —
the pipeline is already in gamma sRGB.
