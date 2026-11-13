/**
 * WebGL2 / WebGL1 Utilities for HalftoneAurora
 * Single full-screen triangle, shader compilation, context loss handling.
 */

export interface GLContextResult {
  gl: WebGL2RenderingContext | WebGLRenderingContext;
  isWebGL2: boolean;
}

export function initGL(canvas: HTMLCanvasElement): GLContextResult | null {
  const glOpts: WebGLContextAttributes = {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  };

  const gl2 = canvas.getContext('webgl2', glOpts) as WebGL2RenderingContext | null;
  if (gl2) {
    return { gl: gl2, isWebGL2: true };
  }

  const gl1 = (canvas.getContext('webgl', glOpts) ||
    canvas.getContext('experimental-webgl', glOpts)) as WebGLRenderingContext | null;
  if (gl1) {
    return { gl: gl1, isWebGL2: false };
  }

  return null;
}

export function createShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    console.error(`[HalftoneAurora] Shader compilation error (${type === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT'}):`, info);
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

export function createProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string
): WebGLProgram | null {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragSrc);

  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    console.error('[HalftoneAurora] Program link error:', info);
    gl.deleteProgram(program);
    return null;
  }

  // Once linked, shaders can be detached and deleted to free GPU memory
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  return program;
}

export function createFullScreenTriangle(gl: WebGLRenderingContext | WebGL2RenderingContext): WebGLBuffer | null {
  if ('createVertexArray' in gl && typeof (gl as WebGL2RenderingContext).createVertexArray === 'function') {
    try {
      const vao = (gl as WebGL2RenderingContext).createVertexArray();
      if (vao) (gl as WebGL2RenderingContext).bindVertexArray(vao);
    } catch {}
  }

  // Single triangle spanning [-1, -1] to [3, -1] and [-1, 3] covering NDC [-1, 1]
  const vertices = new Float32Array([
    -1.0, -1.0,
     3.0, -1.0,
    -1.0,  3.0,
  ]);

  const buffer = gl.createBuffer();
  if (!buffer) return null;

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  return buffer;
}
