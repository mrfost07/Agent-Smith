/**
 * Playground - Test & Tune HalftoneAurora (Phase A: Static Halftone Gradient)
 */

import React, { useState, useRef } from 'react';
import { HalftoneAurora, HalftoneAuroraHandle, Shape, BgState } from './HalftoneAurora';

export const Playground: React.FC = () => {
  const auroraRef = useRef<HalftoneAuroraHandle | null>(null);

  const [intensity, setIntensity] = useState<number>(0.8);
  const [glowHeight, setGlowHeight] = useState<number>(0.34);
  const [cellSize, setCellSize] = useState<number>(8);
  const [shape, setShape] = useState<Shape>('diamond');
  const [state, setState] = useState<BgState>('idle');

  return (
    <div
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        backgroundColor: '#000000',
        overflow: 'hidden',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#ffffff',
      }}
    >
      {/* Background Component: HalftoneAurora */}
      <HalftoneAurora
        ref={auroraRef}
        state={state}
        intensity={intensity}
        glowHeight={glowHeight}
        cellSize={cellSize}
        shape={shape}
      />

      {/* Foreground Content (Matching Reference Image) */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '60%',
          textAlign: 'center',
          padding: '0 20px',
          pointerEvents: 'none',
        }}
      >
        {/* Gemini Sparkle Logo */}
        <div style={{ marginBottom: 20 }}>
          <svg width="42" height="42" viewBox="0 0 28 28" fill="none">
            <path
              d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z"
              fill="url(#aurora_gemini_spark)"
            />
            <defs>
              <radialGradient
                id="aurora_gemini_spark"
                cx="0"
                cy="0"
                r="1"
                gradientUnits="userSpaceOnUse"
                gradientTransform="translate(2.77876 11.3795) rotate(18.6832) scale(29.8025 238.737)"
              >
                <stop offset="0.067" stopColor="#2dd4bf" />
                <stop offset="0.342" stopColor="#38bdf8" />
                <stop offset="0.672" stopColor="#c084fc" />
              </radialGradient>
            </defs>
          </svg>
        </div>

        <h1
          style={{
            fontSize: 28,
            fontWeight: 400,
            margin: 0,
            letterSpacing: '-0.3px',
            color: '#ffffff',
            lineHeight: 1.3,
          }}
        >
          Let’s jump in, Mark Renier
        </h1>
      </div>

      {/* Floating Tuning Controls Panel */}
      <div
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          zIndex: 10,
          background: 'rgba(18, 20, 29, 0.88)',
          backdropFilter: 'blur(16px)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 12,
          padding: '14px 16px',
          width: 270,
          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.7)',
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: '#f1f5f9' }}>
          HalftoneAurora — Phase A
        </div>

        {/* Shape Picker */}
        <div style={{ marginBottom: 10 }}>
          <label style={{ display: 'block', color: '#94a3b8', marginBottom: 5 }}>Shape</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
            {(['diamond', 'circle', 'square', 'bars'] as Shape[]).map((s) => (
              <button
                key={s}
                onClick={() => setShape(s)}
                style={{
                  background: shape === s ? '#3b82f6' : 'rgba(255,255,255,0.06)',
                  color: shape === s ? '#fff' : '#cbd5e1',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 5,
                  padding: '4px 0',
                  fontSize: 11,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Intensity Slider */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
            <span>Intensity</span>
            <span>{intensity.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0.1"
            max="1.0"
            step="0.02"
            value={intensity}
            onChange={(e) => setIntensity(parseFloat(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>

        {/* Glow Height Slider */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
            <span>Glow Height</span>
            <span>{glowHeight.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0.15"
            max="0.6"
            step="0.02"
            value={glowHeight}
            onChange={(e) => setGlowHeight(parseFloat(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>

        {/* Cell Size Slider */}
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
            <span>Cell Size</span>
            <span>{cellSize}px</span>
          </div>
          <input
            type="range"
            min="5"
            max="16"
            step="1"
            value={cellSize}
            onChange={(e) => setCellSize(parseInt(e.target.value, 10))}
            style={{ width: '100%' }}
          />
        </div>
      </div>
    </div>
  );
};
