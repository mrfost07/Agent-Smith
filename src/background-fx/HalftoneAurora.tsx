/**
 * HalftoneAurora - Phase A: Static Halftone Gradient
 * 
 * Full-screen ambient background component:
 * - Top ~60%: pure black #000
 * - Bottom ~30-35%: glowing halftone dot matrix (cell size 6-10 CSS px, default 8)
 * - Violet/magenta on left & center, royal blue on right, faint deep navy haze under dots
 * - Soft bloom around brightest dots, anti-aliased shape borders, film grain dither
 */

import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useEffect,
  useCallback,
} from 'react';
import { initGL, createProgram, createFullScreenTriangle } from './gl';
import {
  VERTEX_SHADER_GLSL3,
  FRAGMENT_SHADER_GLSL3,
  VERTEX_SHADER_GLSL1,
  FRAGMENT_SHADER_GLSL1,
} from './shader';

export type BgState = 'idle' | 'thinking' | 'acting' | 'waiting' | 'error' | 'success';
export type Shape = 'circle' | 'square' | 'diamond' | 'bars';

export interface HalftoneAuroraProps {
  state?: BgState;
  intensity?: number;
  glowHeight?: number;
  cellSize?: number;
  shape?: Shape;
  autoTexture?: boolean;
  lowPower?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export interface HalftoneAuroraHandle {
  pulse(strength?: number): void;
  setShape(s: Shape): void;
}

const SHAPE_MAP: Record<Shape, number> = {
  circle: 0,
  square: 1,
  diamond: 2,
  bars: 3,
};

// Base colors: C1 (#7C4DFF violet), C2 (#D946EF magenta), C3 (#2F6BFF royal blue)
const DEFAULT_C1: [number, number, number] = [0.486, 0.302, 1.0];
const DEFAULT_C2: [number, number, number] = [0.851, 0.275, 0.937];
const DEFAULT_C3: [number, number, number] = [0.184, 0.420, 1.0];

export const HalftoneAurora = forwardRef<HalftoneAuroraHandle, HalftoneAuroraProps>(
  (
    {
      state = 'idle',
      intensity = 0.8,
      glowHeight = 0.34,
      cellSize = 8,
      shape = 'diamond',
      autoTexture = true,
      lowPower = false,
      className,
      style,
    },
    ref
  ) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    // Internal GL state refs
    const glRef = useRef<WebGLRenderingContext | WebGL2RenderingContext | null>(null);
    const isWebGL2Ref = useRef<boolean>(true);
    const programRef = useRef<WebGLProgram | null>(null);
    const bufferRef = useRef<WebGLBuffer | null>(null);

    // Uniform locations ref
    const uniformsRef = useRef<{
      uRes: WebGLUniformLocation | null;
      uCell: WebGLUniformLocation | null;
      uGlowH: WebGLUniformLocation | null;
      uIntensity: WebGLUniformLocation | null;
      uShape: WebGLUniformLocation | null;
      uC1: WebGLUniformLocation | null;
      uC2: WebGLUniformLocation | null;
      uC3: WebGLUniformLocation | null;
    } | null>(null);

    const currentShapeRef = useRef<Shape>(shape);
    currentShapeRef.current = shape;

    useImperativeHandle(ref, () => ({
      pulse(_strength = 1.0) {
        // Will be connected in Phase E
      },
      setShape(s: Shape) {
        currentShapeRef.current = s;
        renderStaticFrame();
      },
    }));

    // Render single static frame
    const renderStaticFrame = useCallback(() => {
      const gl = glRef.current;
      const program = programRef.current;
      const canvas = canvasRef.current;
      const uniforms = uniformsRef.current;
      if (!gl || !program || !canvas || !uniforms) return;

      const dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1.0 : 1.5);
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      gl.viewport(0, 0, width, height);
      gl.useProgram(program);

      // Set uniforms
      if (uniforms.uRes) gl.uniform2f(uniforms.uRes, width, height);
      if (uniforms.uCell) gl.uniform1f(uniforms.uCell, cellSize * dpr);
      if (uniforms.uGlowH) gl.uniform1f(uniforms.uGlowH, glowHeight);
      if (uniforms.uIntensity) gl.uniform1f(uniforms.uIntensity, intensity);
      if (uniforms.uShape) gl.uniform1i(uniforms.uShape, SHAPE_MAP[currentShapeRef.current] ?? 2);
      if (uniforms.uC1) gl.uniform3fv(uniforms.uC1, DEFAULT_C1);
      if (uniforms.uC2) gl.uniform3fv(uniforms.uC2, DEFAULT_C2);
      if (uniforms.uC3) gl.uniform3fv(uniforms.uC3, DEFAULT_C3);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }, [cellSize, glowHeight, intensity, lowPower]);

    // Setup WebGL and compile program
    const setupGL = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const glResult = initGL(canvas);
      if (!glResult) {
        console.warn('[HalftoneAurora] WebGL not supported, CSS fallback active.');
        return;
      }

      const { gl, isWebGL2 } = glResult;
      glRef.current = gl;
      isWebGL2Ref.current = isWebGL2;

      // Compile Program
      const vertSrc = isWebGL2 ? VERTEX_SHADER_GLSL3 : VERTEX_SHADER_GLSL1;
      const fragSrc = isWebGL2 ? FRAGMENT_SHADER_GLSL3 : FRAGMENT_SHADER_GLSL1;
      const program = createProgram(gl, vertSrc, fragSrc);

      if (!program) {
        console.error('[HalftoneAurora] Failed to create shader program.');
        return;
      }
      programRef.current = program;

      // Single full-screen triangle buffer
      const buffer = createFullScreenTriangle(gl);
      bufferRef.current = buffer;

      // Bind attributes
      const aPosLoc = gl.getAttribLocation(program, 'aPos');
      gl.enableVertexAttribArray(aPosLoc);
      gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

      // Cache uniform locations
      uniformsRef.current = {
        uRes: gl.getUniformLocation(program, 'uRes'),
        uCell: gl.getUniformLocation(program, 'uCell'),
        uGlowH: gl.getUniformLocation(program, 'uGlowH'),
        uIntensity: gl.getUniformLocation(program, 'uIntensity'),
        uShape: gl.getUniformLocation(program, 'uShape'),
        uC1: gl.getUniformLocation(program, 'uC1'),
        uC2: gl.getUniformLocation(program, 'uC2'),
        uC3: gl.getUniformLocation(program, 'uC3'),
      };

      renderStaticFrame();
    }, [renderStaticFrame]);

    // Initialize on mount
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      setupGL();

      // Context lost & restored handlers
      const handleContextLost = (e: Event) => {
        e.preventDefault();
        console.warn('[HalftoneAurora] WebGL context lost.');
        programRef.current = null;
        bufferRef.current = null;
      };

      const handleContextRestored = () => {
        console.log('[HalftoneAurora] WebGL context restored. Recompiling...');
        setupGL();
      };

      canvas.addEventListener('webglcontextlost', handleContextLost, false);
      canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

      // ResizeObserver
      let resizeTimer: any = null;
      const ro = new ResizeObserver(() => {
        if (resizeTimer) cancelAnimationFrame(resizeTimer);
        resizeTimer = requestAnimationFrame(() => {
          renderStaticFrame();
        });
      });
      ro.observe(canvas);

      return () => {
        canvas.removeEventListener('webglcontextlost', handleContextLost);
        canvas.removeEventListener('webglcontextrestored', handleContextRestored);
        ro.disconnect();
        if (resizeTimer) cancelAnimationFrame(resizeTimer);

        const gl = glRef.current;
        if (gl) {
          if (bufferRef.current) gl.deleteBuffer(bufferRef.current);
          if (programRef.current) gl.deleteProgram(programRef.current);
        }
      };
    }, [setupGL, renderStaticFrame]);

    // Re-render when props change
    useEffect(() => {
      renderStaticFrame();
    }, [renderStaticFrame, state, intensity, glowHeight, cellSize, shape]);

    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 0,
          display: 'block',
          ...style,
        }}
      />
    );
  }
);

HalftoneAurora.displayName = 'HalftoneAurora';
