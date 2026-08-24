/**
 * luts.ts — tone-curve LUT baking (Stage 3 of docs/render-pipeline.md).
 *
 * Fritsch–Carlson monotone cubic interpolation baked to a 256-entry LUT.
 * Mirrored by python-backend/render.py::bake_tone_luts — keep in sync.
 */

import type { EditSettings } from "../../types/photo";

type CurvePoints = [number, number][];

const IDENTITY: CurvePoints = [[0, 0], [1, 1]];

function sanitize(points: CurvePoints | undefined): CurvePoints {
  if (!points || points.length < 2) return IDENTITY;
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  // Drop points with non-increasing x (guards divide-by-zero in secants)
  const out: CurvePoints = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] > out[out.length - 1][0] + 1e-9) out.push(sorted[i]);
  }
  return out.length >= 2 ? out : IDENTITY;
}

/** Evaluate a Fritsch–Carlson monotone cubic through `points` at each of n samples in [0,1]. */
export function monotoneCubicLut(rawPoints: CurvePoints, n = 256): Float32Array {
  const points = sanitize(rawPoints);
  const k = points.length;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);

  // Secants
  const d: number[] = [];
  for (let i = 0; i < k - 1; i++) {
    d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }

  // Tangents
  const m: number[] = new Array(k);
  m[0] = d[0];
  m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) {
    m[i] = (d[i - 1] + d[i]) / 2;
  }

  // Fritsch–Carlson monotonicity constraint
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        m[i] = tau * a * d[i];
        m[i + 1] = tau * b * d[i];
      }
    }
  }

  const lut = new Float32Array(n);
  for (let s = 0; s < n; s++) {
    const x = s / (n - 1);
    let y: number;
    if (x <= xs[0]) {
      y = ys[0];
    } else if (x >= xs[k - 1]) {
      y = ys[k - 1];
    } else {
      // Find interval (linear scan; k is tiny)
      let i = 0;
      while (i < k - 2 && x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i];
      const t = (x - xs[i]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      y = h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
    }
    lut[s] = Math.min(1, Math.max(0, y));
  }
  return lut;
}

/**
 * Bake the composed per-channel tone LUTs: lutC[i] = curveC(curveMain(i/255)).
 * Returns a 256×4 RGBA Float32Array ready for a 256×1 RGBA32F texture (A unused).
 */
export function bakeToneLuts(s: EditSettings): Float32Array {
  const main = monotoneCubicLut(s.toneCurve);
  const r = monotoneCubicLut(s.toneCurveRed);
  const g = monotoneCubicLut(s.toneCurveGreen);
  const b = monotoneCubicLut(s.toneCurveBlue);

  const applyLut = (lut: Float32Array, x: number): number => {
    const p = x * 255;
    const i = Math.floor(p);
    const f = p - i;
    return lut[i] * (1 - f) + lut[Math.min(i + 1, 255)] * f;
  };

  const out = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = main[i];
    out[i * 4 + 0] = applyLut(r, v);
    out[i * 4 + 1] = applyLut(g, v);
    out[i * 4 + 2] = applyLut(b, v);
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** True when all four curves are identity (lets the renderer skip the LUT). */
export function isIdentityCurves(s: EditSettings): boolean {
  const ident = (p: CurvePoints | undefined) =>
    !p || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1);
  return ident(s.toneCurve) && ident(s.toneCurveRed) && ident(s.toneCurveGreen) && ident(s.toneCurveBlue);
}
