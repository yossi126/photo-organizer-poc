/**
 * gl.ts — WebGL2 plumbing for the photo renderer.
 */

export interface Fbo {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export function createGL(
  canvas: HTMLCanvasElement,
  opts: { preserveDrawingBuffer?: boolean } = {}
): { gl: WebGL2RenderingContext; floatFbo: boolean } {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
  });
  if (!gl) throw new Error("WebGL2 is not available");

  const floatFbo = !!gl.getExtension("EXT_color_buffer_float");
  if (!floatFbo) {
    console.warn("EXT_color_buffer_float unavailable — falling back to RGBA8 FBOs (reduced precision)");
  }
  // Needed for LINEAR sampling of float textures (upsample passes)
  gl.getExtension("OES_texture_float_linear");
  return { gl, floatFbo };
}

export function compileProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string
): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Shader compile error: ${log}\n--- source ---\n${src}`);
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${log}`);
  }
  return prog;
}

export function createFbo(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  floatFbo: boolean,
  filter: number = gl.NEAREST
): Fbo {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (floatFbo) {
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
  } else {
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, width, height };
}

export function deleteFbo(gl: WebGL2RenderingContext, f: Fbo | null) {
  if (!f) return;
  gl.deleteFramebuffer(f.fbo);
  gl.deleteTexture(f.tex);
}

/** Shared fullscreen-triangle VAO. */
export function createQuad(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // Fullscreen triangle (covers the viewport; UVs derived in the vertex shader)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export function drawQuad(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject) {
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}
