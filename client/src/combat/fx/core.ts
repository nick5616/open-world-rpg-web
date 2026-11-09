// Shared building blocks for every spell visual (adapted from wizard-wars
// client/src/components/spells/fx/fxCore.ts): one clock, the emission budget
// (quality density x distance x the per-frame cap), cached colours, and
// module-level textures and geometries so a cast never allocates GPU
// resources. Everything handed out here is SHARED: never dispose it.

import * as THREE from 'three';
import { FX_PROFILES, type FxProfile, type FxTier } from './quality';

// ── Clock ───────────────────────────────────────────────────────────────────
// Particle shaders evaluate motion from (now - spawnTime) on the GPU, so the
// CPU side and the shader uniform read the very same clock.
const T0 = typeof performance !== 'undefined' ? performance.now() : 0;
export const fxTime = (): number => (performance.now() - T0) / 1000;

// ── Quality and budget ──────────────────────────────────────────────────────
// The engine sets the live profile each frame (quality.ts currentFxProfile);
// recipes read it through these helpers.
export const budget = {
  tier: 'high' as FxTier,
  profile: FX_PROFILES.high as FxProfile,
  /** Distance/importance scale for the recipe being played (engine sets it around each call). */
  scale: 1,
  /** Particles emitted this frame (ParticlePool.emit counts). */
  emitted: 0,
};

export function setFxTier(t: FxTier): void {
  budget.tier = t;
  budget.profile = FX_PROFILES[t];
}

/**
 * Scales an emission count by quality, distance and the frame budget,
 * keeping at least `min`. Fractions round stochastically so low tiers still
 * emit *something* over time. Pure given `budget` and `rnd` (tested).
 */
export function fxCount(n: number, min = 0, rnd: () => number = Math.random): number {
  const p = budget.profile;
  let v = n * p.density * budget.scale;
  if (budget.emitted > p.frameBudget) v *= Math.max(0.08, p.frameBudget / budget.emitted);
  const whole = Math.floor(v);
  return Math.max(min, whole + (rnd() < v - whole ? 1 : 0));
}

/** HDR multiplier for bright cores (bloom on medium and up). */
export const hdr = (k = 1): number => 1 + (budget.profile.hdr - 1) * k;

// ── Colour ──────────────────────────────────────────────────────────────────
const colorCache = new Map<string, THREE.Color>();
/** Cached linear THREE.Color for a CSS hex. Read-only. */
export function col(hex: string): THREE.Color {
  let c = colorCache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    colorCache.set(hex, c);
  }
  return c;
}

/** Cached HDR copy (hex x k) for additive cores. */
const hotCache = new Map<string, THREE.Color>();
export function hot(hex: string, k: number): THREE.Color {
  const key = `${hex}|${k.toFixed(2)}`;
  let c = hotCache.get(key);
  if (!c) {
    c = new THREE.Color(hex).multiplyScalar(k);
    hotCache.set(key, c);
  }
  return c;
}

// ── Random ──────────────────────────────────────────────────────────────────
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const pick = <T>(arr: readonly T[]): T => arr[(Math.random() * arr.length) | 0];
export const TAU = Math.PI * 2;

// ── Textures ────────────────────────────────────────────────────────────────
function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture();
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let glowTex: THREE.Texture | null = null;
/** Soft radial glow (white, alpha falloff) for additive sprites and halos. */
export function glowTexture(): THREE.Texture {
  glowTex ??= canvasTex(128, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.18, 'rgba(255,255,255,0.75)');
    r.addColorStop(0.45, 'rgba(255,255,255,0.22)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  return glowTex;
}

let scorchTex: THREE.Texture | null = null;
/** Ragged dark burn mark for ground decals (white rgb, alpha = burn). */
export function scorchTexture(): THREE.Texture {
  scorchTex ??= canvasTex(128, (g, s) => {
    const c = s / 2;
    // Overlapping soft blobs give an irregular edge instead of a perfect disc
    // (fixed seed: the same mark every session).
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      const a = rnd() * TAU;
      const r = rnd() * c * 0.45;
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      const rr = c * (0.25 + rnd() * 0.35);
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, 'rgba(10,6,4,0.55)');
      gr.addColorStop(1, 'rgba(10,6,4,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, s, s);
    }
  });
  return scorchTex;
}

// ── Shared geometries (never dispose) ───────────────────────────────────────
function upCone(sides: number): THREE.BufferGeometry {
  // Base at y=0, tip at y=1: scale.y is the spike's height.
  return new THREE.ConeGeometry(1, 1, sides, 1).translate(0, 0.5, 0);
}

export const GEO = {
  sphere: new THREE.SphereGeometry(1, 16, 12),
  sphereLow: new THREE.SphereGeometry(1, 10, 8),
  icosa: new THREE.IcosahedronGeometry(1, 0),
  icosa1: new THREE.IcosahedronGeometry(1, 1),
  octa: new THREE.OctahedronGeometry(1, 0),
  dodeca: new THREE.DodecahedronGeometry(1, 0),
  /** Open-ended unit cylinder from y=0 to y=1 (beams: scale.y = length). */
  beam: new THREE.CylinderGeometry(1, 1, 1, 14, 1, true).translate(0, 0.5, 0),
  /** Flattened torus: the wind crescent. */
  crescent: new THREE.TorusGeometry(1, 0.12, 4, 18, Math.PI * 1.1),
  cone4: upCone(4),
  cone5: upCone(5),
  cone6: upCone(6),
  /** Icicle / thorn: long thin cone along +Y, centred. */
  needle: new THREE.ConeGeometry(0.5, 2, 5, 1),
};
