/**
 * Shader sources for HalftoneAurora (Animated Living Halftone Gradient)
 * GLSL ES 3.00 (WebGL2) with GLSL ES 1.00 (WebGL1) fallback.
 */

// ============================================================================
// WebGL2 (GLSL ES 3.00)
// ============================================================================

export const VERTEX_SHADER_GLSL3 = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER_GLSL3 = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uCell;
uniform float uGlowH;
uniform float uAmp;
uniform float uIntensity;
uniform float uRibbons;
uniform int uShape;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;

out vec4 o;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = (i.xy + vec2(37.0, 17.0) * i.z) + f.xy;
  vec2 rg = vec2(hash(uv), hash(uv + vec2(1.0, 0.0)));
  return mix(rg.x, rg.y, f.z);
}

float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return s;
}

float sdf(int k, vec2 q) {
  if (k == 0) return length(q);
  if (k == 1) return max(abs(q.x), abs(q.y));
  if (k == 2) return abs(q.x) + abs(q.y);
  return max(abs(q.y) * 3.0, abs(q.x) * 0.9);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 id = floor(frag / uCell);
  vec2 q = fract(frag / uCell) - 0.5;
  vec2 cc = (id + 0.5) * uCell / uRes;

  float flow = fbm(vec3(cc.x * aspect * 1.2, cc.y * 1.2 - uTime * 0.05, uTime * 0.12));
  float wave = sin(cc.x * 5.0 + uTime * 0.6 + flow * 3.0) * 0.5 + 0.5;
  float mask = 1.0 - smoothstep(0.0, uGlowH, cc.y + (flow - 0.5) * 0.12 * max(uAmp, 0.5));

  // The side panel uses two traveling bands across its full height.
  float lowerBand = 0.17 + 0.15 * sin(cc.x * 4.4 - uTime * 0.42) + cc.x * 0.16;
  float upperBand = 0.67 + 0.15 * sin(cc.x * 5.2 + uTime * 0.31 + 1.7) - cc.x * 0.20;
  float lower = 1.0 - smoothstep(0.005, 0.20, abs(cc.y - lowerBand));
  float upper = 1.0 - smoothstep(0.008, 0.23, abs(cc.y - upperBand));
  float ribbonMask = clamp(0.11 + lower * 0.55 + upper * 0.49, 0.0, 1.0);
  mask = mix(mask, ribbonMask, uRibbons);

  float inten = clamp(mask * (0.55 + 0.45 * wave) * uIntensity, 0.0, 1.0);
  float r = 0.54 * pow(inten, 0.72);

  float d = sdf(uShape, q);
  float aa = 1.5 / uCell;
  float cover = (1.0 - smoothstep(r - aa, r + aa, d)) * step(0.001, inten);

  float t = clamp(cc.x + 0.25 * sin(uTime * 0.2 + flow * 2.0), 0.0, 1.0);
  vec3 col = t < 0.5 ? mix(uC1, uC2, t * 2.0) : mix(uC2, uC3, (t - 0.5) * 2.0);
  vec3 travelingHue = mix(uC1, uC3, 0.5 + 0.5 * sin(cc.x * 4.0 - cc.y * 2.0 + uTime * 0.45));
  col = mix(col, travelingHue, uRibbons * upper * 0.58);

  vec3 base = vec3(0.015, 0.02, 0.06) * (1.0 - smoothstep(0.0, 0.65, cc.y));
  vec3 haze = col * (mask * mask) * 0.45 * uIntensity;
  vec3 dots = col * (0.75 + 0.85 * inten) * cover;
  float grain = (hash(frag + fract(uTime)) - 0.5) * (2.0 / 255.0);

  float alpha = clamp(cover * 0.95 + mask * 0.85, 0.0, 1.0);
  o = vec4(clamp(base + haze + dots + grain, 0.0, 1.0), alpha);
}
`;

// ============================================================================
// WebGL1 Fallback (GLSL ES 1.00)
// ============================================================================

export const VERTEX_SHADER_GLSL1 = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER_GLSL1 = `
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uCell;
uniform float uGlowH;
uniform float uAmp;
uniform float uIntensity;
uniform float uRibbons;
uniform int uShape;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = (i.xy + vec2(37.0, 17.0) * i.z) + f.xy;
  vec2 rg = vec2(hash(uv), hash(uv + vec2(1.0, 0.0)));
  return mix(rg.x, rg.y, f.z);
}

float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return s;
}

float sdf(int k, vec2 q) {
  if (k == 0) return length(q);
  if (k == 1) return max(abs(q.x), abs(q.y));
  if (k == 2) return abs(q.x) + abs(q.y);
  return max(abs(q.y) * 3.0, abs(q.x) * 0.9);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 id = floor(frag / uCell);
  vec2 q = fract(frag / uCell) - 0.5;
  vec2 cc = (id + 0.5) * uCell / uRes;

  float flow = fbm(vec3(cc.x * aspect * 1.2, cc.y * 1.2 - uTime * 0.05, uTime * 0.12));
  float wave = sin(cc.x * 5.0 + uTime * 0.6 + flow * 3.0) * 0.5 + 0.5;
  float mask = 1.0 - smoothstep(0.0, uGlowH, cc.y + (flow - 0.5) * 0.12 * max(uAmp, 0.5));

  // The side panel uses two traveling bands across its full height.
  float lowerBand = 0.17 + 0.15 * sin(cc.x * 4.4 - uTime * 0.42) + cc.x * 0.16;
  float upperBand = 0.67 + 0.15 * sin(cc.x * 5.2 + uTime * 0.31 + 1.7) - cc.x * 0.20;
  float lower = 1.0 - smoothstep(0.005, 0.20, abs(cc.y - lowerBand));
  float upper = 1.0 - smoothstep(0.008, 0.23, abs(cc.y - upperBand));
  float ribbonMask = clamp(0.11 + lower * 0.55 + upper * 0.49, 0.0, 1.0);
  mask = mix(mask, ribbonMask, uRibbons);

  float inten = clamp(mask * (0.55 + 0.45 * wave) * uIntensity, 0.0, 1.0);
  float r = 0.54 * pow(inten, 0.72);

  float d = sdf(uShape, q);
  float aa = 1.5 / uCell;
  float cover = (1.0 - smoothstep(r - aa, r + aa, d)) * step(0.001, inten);

  float t = clamp(cc.x + 0.25 * sin(uTime * 0.2 + flow * 2.0), 0.0, 1.0);
  vec3 col = t < 0.5 ? mix(uC1, uC2, t * 2.0) : mix(uC2, uC3, (t - 0.5) * 2.0);
  vec3 travelingHue = mix(uC1, uC3, 0.5 + 0.5 * sin(cc.x * 4.0 - cc.y * 2.0 + uTime * 0.45));
  col = mix(col, travelingHue, uRibbons * upper * 0.58);

  vec3 base = vec3(0.015, 0.02, 0.06) * (1.0 - smoothstep(0.0, 0.65, cc.y));
  vec3 haze = col * (mask * mask) * 0.45 * uIntensity;
  vec3 dots = col * (0.75 + 0.85 * inten) * cover;
  float grain = (hash(frag + fract(uTime)) - 0.5) * (2.0 / 255.0);

  float alpha = clamp(cover * 0.95 + mask * 0.85, 0.0, 1.0);
  gl_FragColor = vec4(clamp(base + haze + dots + grain, 0.0, 1.0), alpha);
}
`;
