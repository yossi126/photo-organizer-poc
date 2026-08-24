/**
 * renderer.ts — WebGL2 photo renderer implementing docs/render-pipeline.md.
 *
 * Pass graph per render():
 *   TONE (stages 2–3, LUT)                        → T
 *   blur(luma T, σ_tex)   H+V                     → Btex
 *   down2x ×2 (T) → blur(luma, σ_clar/4) H+V      → Bclar (quarter res, LINEAR-sampled)
 *   blur(luma T, σ_sharp) H+V                     → Bsharp
 *   blur(rgb  T, σ_nr)    H+V                     → Bnr
 *   FINISH (stages 5–9)                           → canvas
 */

import {
  createGL, compileProgram, createFbo, deleteFbo, createQuad, drawQuad,
  type Fbo,
} from "./gl";
import { VERT_QUAD, FRAG_TONE, FRAG_BLUR, FRAG_DOWNSAMPLE2X, FRAG_FINISH } from "./shaders";
import { bakeToneLuts, isIdentityCurves } from "./luts";
import { resolveEffectiveSettings } from "./profiles";
import type { EditSettings } from "../../types/photo";

const HSL_CHANNELS = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"] as const;

function clampSigma(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export class PhotoRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private floatFbo: boolean;
  private quad: WebGLVertexArrayObject;

  private progTone: WebGLProgram;
  private progBlur: WebGLProgram;
  private progDown: WebGLProgram;
  private progFinish: WebGLProgram;

  private imageTex: WebGLTexture | null = null;
  private lutTex: WebGLTexture;
  private width = 0;
  private height = 0;
  private maxDim: number;

  // FBOs (recreated on image resize)
  private fT: Fbo | null = null;
  private fTmp: Fbo | null = null;
  private fBtex: Fbo | null = null;
  private fBsharp: Fbo | null = null;
  private fBnr: Fbo | null = null;
  private fHalf: Fbo | null = null;
  private fQuarterA: Fbo | null = null;
  private fQuarterB: Fbo | null = null;

  private disposed = false;
  private lastSettings: EditSettings | null = null;

  constructor(canvas: HTMLCanvasElement, opts: { maxDim?: number; preserveDrawingBuffer?: boolean } = {}) {
    this.canvas = canvas;
    this.maxDim = opts.maxDim ?? 2560;
    const { gl, floatFbo } = createGL(canvas, { preserveDrawingBuffer: opts.preserveDrawingBuffer });
    this.gl = gl;
    this.floatFbo = floatFbo;
    this.quad = createQuad(gl);

    this.progTone = compileProgram(gl, VERT_QUAD, FRAG_TONE);
    this.progBlur = compileProgram(gl, VERT_QUAD, FRAG_BLUR);
    this.progDown = compileProgram(gl, VERT_QUAD, FRAG_DOWNSAMPLE2X);
    this.progFinish = compileProgram(gl, VERT_QUAD, FRAG_FINISH);

    // 256×1 RGBA32F LUT texture (NEAREST — sampled via texelFetch)
    this.lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    canvas.addEventListener("webglcontextlost", this.onContextLost);
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    console.warn("WebGL context lost — renderer will reinitialize on next setImage");
  };

  /** Load an image (blob/data/http URL), apply EXIF orientation, cap to maxDim, upload. */
  async setImage(src: string): Promise<{ width: number; height: number }> {
    const resp = await fetch(src);
    const blob = await resp.blob();
    // First decode without resize to learn natural dimensions
    let bmp = await createImageBitmap(blob, {
      imageOrientation: "from-image",
      colorSpaceConversion: "none",
    });
    const natW = bmp.width;
    const natH = bmp.height;
    const scale = Math.min(1, this.maxDim / Math.max(natW, natH));
    if (scale < 1) {
      const w = Math.round(natW * scale);
      const h = Math.round(natH * scale);
      const resized = await createImageBitmap(bmp, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: "high",
      });
      bmp.close();
      bmp = resized;
    }

    const gl = this.gl;
    const w = bmp.width;
    const h = bmp.height;

    if (this.imageTex) gl.deleteTexture(this.imageTex);
    this.imageTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    // Note: UNPACK_FLIP_Y_WEBGL is ignored for ImageBitmap sources — the
    // orientation flip happens once in the FINISH pass instead.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    bmp.close();

    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.allocFbos();
    }
    // Re-render with the last settings if we have them
    if (this.lastSettings) this.render(this.lastSettings);
    return { width: w, height: h };
  }

  private allocFbos() {
    const gl = this.gl;
    for (const f of [this.fT, this.fTmp, this.fBtex, this.fBsharp, this.fBnr, this.fHalf, this.fQuarterA, this.fQuarterB]) {
      deleteFbo(gl, f);
    }
    const W = this.width;
    const H = this.height;
    const hw = Math.max(1, Math.floor(W / 2));
    const hh = Math.max(1, Math.floor(H / 2));
    const qw = Math.max(1, Math.floor(W / 4));
    const qh = Math.max(1, Math.floor(H / 4));
    this.fT = createFbo(gl, W, H, this.floatFbo, gl.NEAREST);
    this.fTmp = createFbo(gl, W, H, this.floatFbo, gl.NEAREST);
    this.fBtex = createFbo(gl, W, H, this.floatFbo, gl.NEAREST);
    this.fBsharp = createFbo(gl, W, H, this.floatFbo, gl.NEAREST);
    this.fBnr = createFbo(gl, W, H, this.floatFbo, gl.NEAREST);
    this.fHalf = createFbo(gl, hw, hh, this.floatFbo, gl.NEAREST);
    this.fQuarterA = createFbo(gl, qw, qh, this.floatFbo, gl.NEAREST);
    // Bclar is LINEAR-sampled by FINISH (bilinear upsample ≡ cv2 INTER_LINEAR)
    this.fQuarterB = createFbo(gl, qw, qh, this.floatFbo, gl.LINEAR);
  }

  private bindTex(unit: number, tex: WebGLTexture, prog: WebGLProgram, name: string) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  }

  private runBlur(src: WebGLTexture, tmp: Fbo, dst: Fbo, sigma: number, extractLuma: boolean) {
    const gl = this.gl;
    const radius = Math.ceil(3 * sigma);
    gl.useProgram(this.progBlur);
    gl.uniform1f(gl.getUniformLocation(this.progBlur, "uSigma"), sigma);
    gl.uniform1i(gl.getUniformLocation(this.progBlur, "uRadius"), radius);

    // Horizontal (+ optional luma extraction)
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fbo);
    gl.viewport(0, 0, tmp.width, tmp.height);
    this.bindTex(0, src, this.progBlur, "uSrc");
    gl.uniform2f(gl.getUniformLocation(this.progBlur, "uDir"), 1, 0);
    gl.uniform1i(gl.getUniformLocation(this.progBlur, "uExtractLuma"), extractLuma ? 1 : 0);
    drawQuad(gl, this.quad);

    // Vertical
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    this.bindTex(0, tmp.tex, this.progBlur, "uSrc");
    gl.uniform2f(gl.getUniformLocation(this.progBlur, "uDir"), 0, 1);
    gl.uniform1i(gl.getUniformLocation(this.progBlur, "uExtractLuma"), 0);
    drawQuad(gl, this.quad);
  }

  render(settings: EditSettings): void {
    if (this.disposed || !this.imageTex || this.width === 0) return;
    this.lastSettings = settings;
    const gl = this.gl;
    const s = resolveEffectiveSettings(settings);
    const W = this.width;
    const H = this.height;
    const minDim = Math.min(W, H);

    // --- Pass 1: TONE → T ---
    const useLut = !isIdentityCurves(s);
    if (useLut) {
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.FLOAT, bakeToneLuts(s));
    }
    gl.useProgram(this.progTone);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fT!.fbo);
    gl.viewport(0, 0, W, H);
    this.bindTex(0, this.imageTex, this.progTone, "uImage");
    this.bindTex(1, this.lutTex, this.progTone, "uLut");
    const u = (name: string) => gl.getUniformLocation(this.progTone, name);
    gl.uniform1f(u("uTemperature"), s.temperature);
    gl.uniform1f(u("uTint"), s.tint);
    gl.uniform1f(u("uExposure"), s.exposure);
    gl.uniform1f(u("uContrast"), s.contrast);
    gl.uniform1f(u("uHighlights"), s.highlights);
    gl.uniform1f(u("uShadows"), s.shadows);
    gl.uniform1f(u("uWhites"), s.whites);
    gl.uniform1f(u("uBlacks"), s.blacks);
    gl.uniform1i(u("uUseLut"), useLut ? 1 : 0);
    drawQuad(gl, this.quad);

    // --- Blur sources (from T) ---
    const sigmaTex = clampSigma(2.0 * minDim / 1000, 1.0, 8.0);
    const sigmaClar = clampSigma(12.0 * minDim / 1000, 4.0, 50.0);
    const sigmaSharp = s.sharpenRadius;
    const sigmaNr = 2.0;

    this.runBlur(this.fT!.tex, this.fTmp!, this.fBtex!, sigmaTex, true);
    this.runBlur(this.fT!.tex, this.fTmp!, this.fBsharp!, sigmaSharp, true);
    this.runBlur(this.fT!.tex, this.fTmp!, this.fBnr!, sigmaNr, false);

    // Quarter-res clarity: down2x ×2 → blur σ/4 → (LINEAR upsample at sample time)
    gl.useProgram(this.progDown);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fHalf!.fbo);
    gl.viewport(0, 0, this.fHalf!.width, this.fHalf!.height);
    this.bindTex(0, this.fT!.tex, this.progDown, "uSrc");
    drawQuad(gl, this.quad);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fQuarterA!.fbo);
    gl.viewport(0, 0, this.fQuarterA!.width, this.fQuarterA!.height);
    this.bindTex(0, this.fHalf!.tex, this.progDown, "uSrc");
    drawQuad(gl, this.quad);

    // Blur quarter (extract luma on H pass), ping-pong via fHalf as tmp is wrong size —
    // reuse fQuarterA→fQuarterB with an extra tmp: blur H into fQuarterB, V back into fQuarterB?
    // Separable needs distinct src/dst: H: A→tmpQ (use fHalf? size mismatch). Allocate on the fly is
    // wasteful — instead: H pass A→B, V pass B→A, then FINISH samples A... but A is NEAREST.
    // Simplest correct: H: A→B(NEAREST would break upsample)... so do H: A→B, V: B→A, copy A→B via down? No.
    // Resolution: make fQuarterA LINEAR too and sample it. (Filtering choice only affects the final
    // upsample; NEAREST intermediates are irrelevant.) → blur H: A→B, blur V: B→A, FINISH samples A(LINEAR).
    {
      const qSigma = sigmaClar / 4;
      const radius = Math.ceil(3 * qSigma);
      gl.useProgram(this.progBlur);
      gl.uniform1f(gl.getUniformLocation(this.progBlur, "uSigma"), qSigma);
      gl.uniform1i(gl.getUniformLocation(this.progBlur, "uRadius"), radius);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fQuarterB!.fbo);
      gl.viewport(0, 0, this.fQuarterB!.width, this.fQuarterB!.height);
      this.bindTex(0, this.fQuarterA!.tex, this.progBlur, "uSrc");
      gl.uniform2f(gl.getUniformLocation(this.progBlur, "uDir"), 1, 0);
      gl.uniform1i(gl.getUniformLocation(this.progBlur, "uExtractLuma"), 1);
      drawQuad(gl, this.quad);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fQuarterA!.fbo);
      gl.viewport(0, 0, this.fQuarterA!.width, this.fQuarterA!.height);
      this.bindTex(0, this.fQuarterB!.tex, this.progBlur, "uSrc");
      gl.uniform2f(gl.getUniformLocation(this.progBlur, "uDir"), 0, 1);
      gl.uniform1i(gl.getUniformLocation(this.progBlur, "uExtractLuma"), 0);
      drawQuad(gl, this.quad);
    }

    // --- FINISH → canvas ---
    gl.useProgram(this.progFinish);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    this.bindTex(0, this.fT!.tex, this.progFinish, "uToned");
    this.bindTex(1, this.fBtex!.tex, this.progFinish, "uBtex");
    // fQuarterA holds the final clarity blur; needs LINEAR for the upsample
    gl.activeTexture(gl.TEXTURE0 + 2);
    gl.bindTexture(gl.TEXTURE_2D, this.fQuarterA!.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(this.progFinish, "uBclar"), 2);
    this.bindTex(3, this.fBsharp!.tex, this.progFinish, "uBsharp");
    this.bindTex(4, this.fBnr!.tex, this.progFinish, "uBnr");

    const uf = (name: string) => gl.getUniformLocation(this.progFinish, name);
    gl.uniform1f(uf("uTexture"), s.texture);
    gl.uniform1f(uf("uClarity"), s.clarity);
    gl.uniform1f(uf("uDehaze"), s.dehaze);
    gl.uniform1f(uf("uVibrance"), s.vibrance);
    gl.uniform1f(uf("uSaturation"), s.saturation);
    gl.uniform1f(uf("uCalShadowsTint"), s.calShadowsTint);
    gl.uniform1fv(uf("uHslHue"), HSL_CHANNELS.map((c) => s[`hslHue${c}`] as number));
    gl.uniform1fv(uf("uHslSat"), HSL_CHANNELS.map((c) => s[`hslSat${c}`] as number));
    gl.uniform1fv(uf("uHslLum"), HSL_CHANNELS.map((c) => s[`hslLum${c}`] as number));
    gl.uniform1fv(uf("uCalHue"), [s.calRedHue, s.calGreenHue, s.calBlueHue]);
    gl.uniform1fv(uf("uCalSat"), [s.calRedSat, s.calGreenSat, s.calBlueSat]);
    gl.uniform1f(uf("uSharpenAmount"), s.sharpenAmount);
    gl.uniform1f(uf("uSharpenRadius"), s.sharpenRadius);
    gl.uniform1f(uf("uSharpenDetail"), s.sharpenDetail);
    gl.uniform1f(uf("uSharpenMasking"), s.sharpenMasking);
    gl.uniform1f(uf("uNrLuminance"), s.noiseReduceLuminance);
    gl.uniform1f(uf("uNrColor"), s.noiseReduceColor);
    drawQuad(gl, this.quad);
  }

  get imageSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    for (const f of [this.fT, this.fTmp, this.fBtex, this.fBsharp, this.fBnr, this.fHalf, this.fQuarterA, this.fQuarterB]) {
      deleteFbo(gl, f);
    }
    if (this.imageTex) gl.deleteTexture(this.imageTex);
    gl.deleteTexture(this.lutTex);
    for (const p of [this.progTone, this.progBlur, this.progDown, this.progFinish]) {
      gl.deleteProgram(p);
    }
  }
}
