/**
 * shaders.ts — GLSL sources implementing docs/render-pipeline.md.
 * Every formula here mirrors python-backend/render.py; the spec is the contract.
 */

export const VERT_QUAD = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/** Shared helper chunk: sRGB transfer, luma. */
const COMMON = `
const float EPS = 1e-6;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 s2l(vec3 c) {
  bvec3 lo = lessThanEqual(c, vec3(0.04045));
  vec3 a = c / 12.92;
  vec3 b = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(b, a, vec3(lo));
}

vec3 l2s(vec3 c) {
  bvec3 lo = lessThanEqual(c, vec3(0.0031308));
  vec3 a = 12.92 * c;
  vec3 b = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(b, a, vec3(lo));
}
`;

/**
 * Pass 1 — TONE: Stage 2 (WB + exposure, linear) + Stage 3 (contrast, HSWB, tone curve LUT).
 * Input: source image texture (gamma sRGB). Output: T (toned image, gamma sRGB).
 */
export const FRAG_TONE = `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D uImage;
uniform sampler2D uLut;        // 256x1 RGBA32F, NEAREST
uniform float uTemperature;    // 2000..50000
uniform float uTint;           // -150..150
uniform float uExposure;       // -5..5
uniform float uContrast;       // -100..100
uniform float uHighlights, uShadows, uWhites, uBlacks;  // -100..100
uniform bool uUseLut;
in vec2 vUv;
out vec4 outColor;

vec3 applyLut(vec3 x) {
  vec3 p = clamp(x, 0.0, 1.0) * 255.0;
  ivec3 i0 = ivec3(floor(p));
  ivec3 i1 = min(i0 + 1, ivec3(255));
  vec3 f = p - vec3(i0);
  vec3 lo = vec3(
    texelFetch(uLut, ivec2(i0.r, 0), 0).r,
    texelFetch(uLut, ivec2(i0.g, 0), 0).g,
    texelFetch(uLut, ivec2(i0.b, 0), 0).b);
  vec3 hi = vec3(
    texelFetch(uLut, ivec2(i1.r, 0), 0).r,
    texelFetch(uLut, ivec2(i1.g, 0), 0).g,
    texelFetch(uLut, ivec2(i1.b, 0), 0).b);
  return mix(lo, hi, f);
}

void main() {
  vec3 rgb = texture(uImage, vUv).rgb;

  // --- Stage 2: WB + exposure in linear ---
  vec3 lin = s2l(rgb);
  float T = clamp(uTemperature, 2000.0, 50000.0);
  float t = (1e6 / 5500.0 - 1e6 / T) / 150.0;
  float gR = exp2(0.5 * t);
  float gB = exp2(-0.5 * t);
  float gG = exp2(-0.5 * uTint / 150.0);
  float k = 0.2126 * gR + 0.7152 * gG + 0.0722 * gB;
  lin *= vec3(gR, gG, gB) / k;

  // Exposure with highlight shoulder (spec Stage 2): positive exposure
  // compresses [P, 2^ev] into [P, 1] with a C1 join at P instead of clipping.
  lin *= exp2(uExposure);
  float P = 0.8;
  float w = max(exp2(uExposure), 1.0);
  float sr = (w - P) / (1.0 - P);
  vec3 t2 = clamp((lin - P) / (w - P), 0.0, 1.0);
  lin = min(lin, vec3(P)) + (1.0 - P) * sr * t2 / (1.0 + (sr - 1.0) * t2);

  rgb = clamp(l2s(clamp(lin, 0.0, 1.0)), 0.0, 1.0);

  // --- Stage 3: contrast ---
  float c = uContrast / 100.0;
  if (c >= 0.0) {
    rgb = mix(rgb, rgb * rgb * (3.0 - 2.0 * rgb), c);
  } else {
    rgb = mix(rgb, 0.5 + (rgb - 0.5) * 0.5, -c);
  }

  // --- Stage 3: highlights/shadows/whites/blacks ---
  float L = luma(rgb);
  float wHi = smoothstep(0.50, 1.00, L);
  float wSh = 1.0 - smoothstep(0.00, 0.50, L);
  float wWh = smoothstep(0.75, 1.00, L);
  float wBl = 1.0 - smoothstep(0.00, 0.25, L);
  float delta = 0.25 * (uHighlights / 100.0) * wHi
              + 0.25 * (uShadows    / 100.0) * wSh
              + 0.20 * (uWhites     / 100.0) * wWh
              + 0.20 * (uBlacks     / 100.0) * wBl;
  // Chroma-preserving luminance gain (spec Stage 3; eps is 1e-4 here)
  float gainT = clamp((L + delta + 1e-4) / (L + 1e-4), 0.25, 4.0);
  rgb = clamp(rgb * gainT, 0.0, 1.0);

  // --- Stage 3: tone curve LUT ---
  if (uUseLut) {
    rgb = clamp(applyLut(rgb), 0.0, 1.0);
  }

  outColor = vec4(rgb, 1.0);
}
`;

/**
 * Separable gaussian blur. uDir = (1,0) horizontal / (0,1) vertical.
 * uExtractLuma converts rgb → luma while sampling (used on the first pass
 * of scalar blurs). Kernel: w_i = exp(-i^2 / (2 sigma^2)), normalized.
 */
export const FRAG_BLUR = `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D uSrc;
uniform vec2 uDir;          // texel-space step direction
uniform float uSigma;
uniform int uRadius;        // ceil(3*sigma)
uniform bool uExtractLuma;
in vec2 vUv;
out vec4 outColor;

void main() {
  vec2 texel = 1.0 / vec2(textureSize(uSrc, 0));
  float twoSigma2 = 2.0 * uSigma * uSigma;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -uRadius; i <= uRadius; i++) {
    float w = exp(-float(i * i) / twoSigma2);
    vec2 uv = vUv + uDir * texel * float(i);
    vec3 s = texture(uSrc, uv).rgb;   // CLAMP_TO_EDGE ≡ BORDER_REPLICATE
    if (uExtractLuma) s = vec3(luma(s));
    sum += w * s;
    wsum += w;
  }
  outColor = vec4(sum / wsum, 1.0);
}
`;

/** 2×2 box-average downsample (one step of the quarter-res clarity path). */
export const FRAG_DOWNSAMPLE2X = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 outColor;
void main() {
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 src0 = dst * 2;
  ivec2 size = textureSize(uSrc, 0) - 1;
  vec3 a = texelFetch(uSrc, min(src0 + ivec2(0, 0), size), 0).rgb;
  vec3 b = texelFetch(uSrc, min(src0 + ivec2(1, 0), size), 0).rgb;
  vec3 c = texelFetch(uSrc, min(src0 + ivec2(0, 1), size), 0).rgb;
  vec3 d = texelFetch(uSrc, min(src0 + ivec2(1, 1), size), 0).rgb;
  outColor = vec4((a + b + c + d) * 0.25, 1.0);
}
`;

/**
 * Pass FINISH — Stages 5–9: texture/clarity, dehaze, HSV block (HSL bands +
 * calibration + vibrance), saturation + shadow tint, sharpen + NR.
 */
export const FRAG_FINISH = `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D uToned;   // T — output of the tone pass
uniform sampler2D uBtex;    // blurred luma, sigma_tex   (.r)
uniform sampler2D uBclar;   // blurred luma, sigma_clar  (.r, upsampled quarter-res)
uniform sampler2D uBsharp;  // blurred luma, sigma_sharp (.r)
uniform sampler2D uBnr;     // blurred rgb,  sigma_nr

uniform float uTexture, uClarity, uDehaze, uVibrance, uSaturation;
uniform float uCalShadowsTint;
uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];
uniform float uCalHue[3];
uniform float uCalSat[3];
uniform float uSharpenAmount, uSharpenRadius, uSharpenDetail, uSharpenMasking;
uniform float uNrLuminance, uNrColor;

in vec2 vUv;
out vec4 outColor;

vec3 rgb2hsv(vec3 c) {
  float V = max(c.r, max(c.g, c.b));
  float Cmin = min(c.r, min(c.g, c.b));
  float C = V - Cmin;
  float S = C / max(V, EPS);
  float H = 0.0;
  if (C > EPS) {
    if (V == c.r)      H = mod((c.g - c.b) / C, 6.0);
    else if (V == c.g) H = (c.b - c.r) / C + 2.0;
    else               H = (c.r - c.g) / C + 4.0;
    H /= 6.0;
    if (H < 0.0) H += 1.0;
  }
  return vec3(H, S, V);
}

vec3 hsv2rgb(vec3 c) {
  float H = c.x * 6.0;
  float S = c.y;
  float V = c.z;
  float C = V * S;
  float X = C * (1.0 - abs(mod(H, 2.0) - 1.0));
  float m = V - C;
  vec3 rgb;
  if      (H < 1.0) rgb = vec3(C, X, 0.0);
  else if (H < 2.0) rgb = vec3(X, C, 0.0);
  else if (H < 3.0) rgb = vec3(0.0, C, X);
  else if (H < 4.0) rgb = vec3(0.0, X, C);
  else if (H < 5.0) rgb = vec3(X, 0.0, C);
  else              rgb = vec3(C, 0.0, X);
  return rgb + m;
}

// Piecewise-linear band weights between adjacent centers (wrap-around).
// Writes into w[]; centers in degrees; n = 8 (HSL) or 3 (calibration).
void bandWeights8(float h, out float w[8]) {
  const float centers[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0);
  for (int i = 0; i < 8; i++) w[i] = 0.0;
  for (int i = 0; i < 8; i++) {
    float c0 = centers[i];
    float c1 = (i == 7) ? 360.0 : centers[i + 1];
    if (h >= c0 && h < c1) {
      float t = (c1 - h) / (c1 - c0);
      w[i] = t;
      w[(i + 1) % 8] = 1.0 - t;
      return;
    }
  }
  w[0] = 1.0; // h == 360 edge case
}

void bandWeights3(float h, out float w[3]) {
  const float centers[3] = float[3](0.0, 120.0, 240.0);
  for (int i = 0; i < 3; i++) w[i] = 0.0;
  for (int i = 0; i < 3; i++) {
    float c0 = centers[i];
    float c1 = (i == 2) ? 360.0 : centers[i + 1];
    if (h >= c0 && h < c1) {
      float t = (c1 - h) / (c1 - c0);
      w[i] = t;
      w[(i + 1) % 3] = 1.0 - t;
      return;
    }
  }
  w[0] = 1.0;
}

void main() {
  // The source ImageBitmap uploads with row 0 = image top (UNPACK_FLIP_Y is
  // ignored for ImageBitmap), while the default framebuffer displays row 0 at
  // the bottom. All intermediate FBOs share the source orientation, so a
  // single flip at present time renders upright.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 T = texture(uToned, uv).rgb;
  float L0 = luma(T);
  float Btex = texture(uBtex, uv).r;
  float Bclar = texture(uBclar, uv).r;
  float Bsharp = texture(uBsharp, uv).r;
  vec3 Bnr = texture(uBnr, uv).rgb;

  vec3 rgb = T;

  // --- Stage 5: texture & clarity ---
  rgb += (uTexture / 100.0) * 0.4 * (L0 - Btex);
  float wmid = 1.0 - abs(2.0 * L0 - 1.0);
  rgb += (uClarity / 100.0) * 0.3 * wmid * (L0 - Bclar);
  rgb = clamp(rgb, 0.0, 1.0);

  // --- Stage 6: dehaze ---
  float d = uDehaze / 100.0;
  if (d >= 0.0) {
    rgb = clamp((rgb - 0.15 * d) / (1.0 - 0.15 * d + EPS), 0.0, 1.0);
    float lum6 = luma(rgb);
    rgb = lum6 + (rgb - lum6) * (1.0 + 0.25 * d);
  } else {
    float a = -d;
    rgb = rgb * (1.0 - 0.3 * a) + 0.3 * a * 0.85;
    float lum6 = luma(rgb);
    rgb = lum6 + (rgb - lum6) * (1.0 - 0.3 * a);
  }
  rgb = clamp(rgb, 0.0, 1.0);

  // --- Stage 7: HSV block ---
  vec3 hsv = rgb2hsv(rgb);
  float hDeg = hsv.x * 360.0;
  float S = hsv.y;
  float mask = smoothstep(0.0, 0.2, S);

  float w8[8];
  bandWeights8(hDeg, w8);
  float w3[3];
  bandWeights3(hDeg, w3);

  float hueShift = 0.0;
  float satMul8 = 0.0;
  float lumExp = 0.0;
  for (int i = 0; i < 8; i++) {
    hueShift += w8[i] * (uHslHue[i] / 100.0) * 30.0;
    satMul8  += w8[i] * (uHslSat[i] / 100.0);
    lumExp   += w8[i] * (uHslLum[i] / 100.0);
  }
  float calSatMul = 0.0;
  for (int j = 0; j < 3; j++) {
    hueShift  += w3[j] * (uCalHue[j] / 100.0) * 20.0;
    calSatMul += w3[j] * (uCalSat[j] / 100.0);
  }

  float H = fract(hsv.x + mask * hueShift / 360.0);
  float Sp = clamp(S * (1.0 + mask * satMul8) * (1.0 + mask * 0.5 * calSatMul), 0.0, 1.0);
  float V = clamp(hsv.z * exp2(0.5 * mask * lumExp), 0.0, 1.0);

  float vib = uVibrance / 100.0;
  Sp = clamp(Sp * (1.0 + vib * (1.0 - Sp)), 0.0, 1.0);

  rgb = clamp(hsv2rgb(vec3(H, Sp, V)), 0.0, 1.0);

  // --- Stage 8: saturation + shadows tint ---
  float lum8 = luma(rgb);
  rgb = lum8 + (rgb - lum8) * (1.0 + uSaturation / 100.0);
  rgb = clamp(rgb, 0.0, 1.0);
  float L8 = luma(rgb);
  rgb.g -= 0.1 * (uCalShadowsTint / 100.0) * (1.0 - smoothstep(0.0, 0.5, L8));
  rgb = clamp(rgb, 0.0, 1.0);

  // --- Stage 9: sharpen + noise reduction ---
  float detail = L0 - Bsharp;
  float mk = uSharpenMasking / 100.0;
  float m = (mk <= 0.0) ? 1.0 : smoothstep(0.0, 0.1 * mk, abs(detail));
  float amt = (uSharpenAmount / 150.0) * (0.6 + 0.8 * uSharpenDetail / 100.0);
  rgb += amt * m * detail;

  float nrL = uNrLuminance / 100.0;
  rgb += nrL * 0.7 * (luma(Bnr) - luma(rgb));

  float nrC = uNrColor / 100.0;
  float lum9 = luma(rgb);
  float lumB = luma(Bnr);
  vec3 chr = rgb - lum9;
  // Align Bnr's chroma (from pre-saturation T) with the Stage-8 saturation,
  // so color NR doesn't re-saturate desaturated images
  vec3 chrB = (Bnr - lumB) * (1.0 + uSaturation / 100.0);
  rgb = lum9 + mix(chr, chrB, 0.8 * nrC);
  rgb = clamp(rgb, 0.0, 1.0);

  outColor = vec4(rgb, 1.0);
}
`;
