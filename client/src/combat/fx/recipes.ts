// Spell "recipes": what every cast, trail, impact, area, rune, beam, dash,
// shield and status looks like, per family (adapted from wizard-wars
// client/src/components/spells/fx/recipes.ts, extended to Lodestone's
// lightning, wind, light and void trees and its set pieces). A recipe only
// composes the cheap primitives: GPU particles (particles.ts) and pooled
// transients (transients.ts), so it is CPU bookkeeping, a few dozen ring
// buffer writes, no allocation, no new GPU resources. Emission counts go
// through fxCount() (quality density x distance x the frame budget).

import * as THREE from 'three';
import { glowPool, smokePool, SHAPE_GLOW, SHAPE_SPARK, SHAPE_STAR, SHAPE_PUFF } from './particles';
import { budget, col, fxCount, hdr, hot, pick, rand, TAU } from './core';
import type { FxPrims } from './transients';
import { PALETTES, type Palette, type SpellVisual } from './spellVisual';
import { screenFlash, screenKick, screenShake } from './screen';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

const tmpV = new THREE.Vector3();

// ── Primitive emitters ──────────────────────────────────────────────────────

interface BurstOpts {
  life?: [number, number];
  size?: [number, number];
  speed?: [number, number];
  gravity?: number;
  drag?: number;
  shape?: number;
  /** 0 = full sphere, 1 = upper hemisphere only. */
  up?: number;
  dir?: V3 | null;
  bias?: number;
  jitter?: number;
  delay?: [number, number];
}

function randomDir(up: number, out: THREE.Vector3): THREE.Vector3 {
  const u = Math.random() * TAU;
  const v = up >= 1 ? Math.random() : Math.random() * (1 + up) - up;
  const s = Math.sqrt(Math.max(0, 1 - v * v));
  return out.set(Math.cos(u) * s, v, Math.sin(u) * s);
}

const poolFor = (shape: number | undefined) => (shape === SHAPE_PUFF ? smokePool : glowPool);
const smokeN = (n: number) => n * budget.profile.smoke;

/** Radial burst of particles from a point; `colors` are picked at random. */
export function burst(x: number, y: number, z: number, colors: THREE.Color[], count: number, o: BurstOpts = {}): void {
  const n = fxCount(o.shape === SHAPE_PUFF ? smokeN(count) : count, count > 0 ? 1 : 0);
  const [l0, l1] = o.life ?? [0.3, 0.7];
  const [s0, s1] = o.size ?? [0.1, 0.2];
  const [v0, v1] = o.speed ?? [2, 6];
  const pool = poolFor(o.shape);
  const j = o.jitter ?? 0;
  for (let i = 0; i < n; i++) {
    randomDir(o.up ?? 0.2, tmpV);
    if (o.dir && o.bias) {
      tmpV.x = tmpV.x * (1 - o.bias) + o.dir.x * o.bias;
      tmpV.y = tmpV.y * (1 - o.bias) + o.dir.y * o.bias;
      tmpV.z = tmpV.z * (1 - o.bias) + o.dir.z * o.bias;
      tmpV.normalize();
    }
    const sp = rand(v0, v1);
    pool.emit(x + (j ? rand(-j, j) : 0), y + (j ? rand(-j, j) * 0.5 : 0), z + (j ? rand(-j, j) : 0), tmpV.x * sp, tmpV.y * sp, tmpV.z * sp, colors[(Math.random() * colors.length) | 0], rand(l0, l1), rand(s0, s1), o.gravity ?? 0, o.drag ?? 0, o.shape ?? SHAPE_GLOW, o.delay ? rand(o.delay[0], o.delay[1]) : 0);
  }
}

/** Particles born on a horizontal ring, flying outward (speed > 0) or converging (speed < 0). */
export function ringBurst(x: number, y: number, z: number, radius: number, colors: THREE.Color[], count: number, speed: number, o: BurstOpts = {}): void {
  const n = fxCount(o.shape === SHAPE_PUFF ? smokeN(count) : count, 1);
  const [l0, l1] = o.life ?? [0.35, 0.6];
  const [s0, s1] = o.size ?? [0.12, 0.24];
  const pool = poolFor(o.shape);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const life = rand(l0, l1);
    const sp = speed < 0 ? -(radius / life) * rand(0.85, 1.05) : speed * rand(0.7, 1.2);
    pool.emit(x + c * radius, y + rand(0, 0.25), z + s * radius, c * sp, (o.up ?? 0) * rand(0.5, 1.2), s * sp, colors[(Math.random() * colors.length) | 0], life, rand(s0, s1), o.gravity ?? 0, o.drag ?? 0, o.shape ?? SHAPE_GLOW, o.delay ? rand(o.delay[0], o.delay[1]) : 0);
  }
}

/** Particles scattered over a disc at height y (zones, dust). */
export function discEmit(x: number, z: number, radius: number, y: number, colors: THREE.Color[], count: number, vy: [number, number], o: BurstOpts = {}): void {
  const n = fxCount(o.shape === SHAPE_PUFF ? smokeN(count) : count);
  const [l0, l1] = o.life ?? [0.6, 1.2];
  const [s0, s1] = o.size ?? [0.1, 0.2];
  const pool = poolFor(o.shape);
  const lateral = o.speed ? o.speed[1] : 0;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const r = radius * Math.sqrt(Math.random());
    pool.emit(x + Math.cos(a) * r, y + rand(0, 0.15), z + Math.sin(a) * r, rand(-lateral, lateral), rand(vy[0], vy[1]), rand(-lateral, lateral), colors[(Math.random() * colors.length) | 0], rand(l0, l1), rand(s0, s1), o.gravity ?? 0, o.drag ?? 0, o.shape ?? SHAPE_GLOW);
  }
}

/** Particles along a segment a -> b (streaks, dash trails, beams). */
export function lineEmit(a: V3, b: V3, colors: THREE.Color[], perUnit: number, o: BurstOpts = {}): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const n = Math.min(240, fxCount(o.shape === SHAPE_PUFF ? smokeN(len * perUnit) : len * perUnit, 1));
  const [l0, l1] = o.life ?? [0.3, 0.6];
  const [s0, s1] = o.size ?? [0.1, 0.2];
  const [v0, v1] = o.speed ?? [0, 0.6];
  const j = o.jitter ?? 0.05;
  const pool = poolFor(o.shape);
  for (let i = 0; i < n; i++) {
    const t = Math.random();
    randomDir(o.up ?? 0, tmpV);
    const sp = rand(v0, v1);
    pool.emit(a.x + dx * t + rand(-j, j), a.y + dy * t + rand(-j, j), a.z + dz * t + rand(-j, j), tmpV.x * sp, tmpV.y * sp, tmpV.z * sp, colors[(Math.random() * colors.length) | 0], rand(l0, l1), rand(s0, s1), o.gravity ?? 0, o.drag ?? 0, o.shape ?? SHAPE_GLOW, o.delay ? rand(o.delay[0], o.delay[1]) * t : 0);
  }
}

// ── Colours ─────────────────────────────────────────────────────────────────

const DUST = '#5a4630';
const SOIL = '#c09a60';
const GOLD = '#ffd27a';

/** One palette's colours at one HDR level, with cached colour sets (recipes never allocate). */
export class Cols {
  readonly hot: THREE.Color;
  readonly main: THREE.Color;
  readonly deep: THREE.Color;
  readonly accent: THREE.Color;
  readonly smoke: THREE.Color;
  /** HDR copies for cores (bloom). */
  readonly hotH: THREE.Color;
  readonly mainH: THREE.Color;
  private readonly sets = new Map<string, THREE.Color[]>();
  constructor(p: Palette, k: number) {
    this.hot = col(p.hot);
    this.main = col(p.main);
    this.deep = col(p.deep);
    this.accent = col(p.accent);
    this.smoke = col(p.smoke);
    this.hotH = hot(p.hot, k);
    this.mainH = hot(p.main, (k + 1) / 2);
  }
  /**
   * A colour set by role letters: h hot, m main, d deep, a accent, s smoke;
   * D dust, S soil, G gold (e.g. 'hma', 'sD'). Built once, then cached.
   */
  k(code: string): THREE.Color[] {
    let a = this.sets.get(code);
    if (!a) {
      a = [];
      for (const ch of code) a.push(ch === 'h' ? this.hot : ch === 'm' ? this.main : ch === 'd' ? this.deep : ch === 'a' ? this.accent : ch === 's' ? this.smoke : ch === 'D' ? col(DUST) : ch === 'S' ? col(SOIL) : col(GOLD));
      this.sets.set(code, a);
    }
    return a;
  }
}
const colsCache = new Map<Palette, Map<number, Cols>>();
/** Cached colour set per palette and HDR level. */
export function cols(p: Palette): Cols {
  const k = Math.round(hdr() * 100);
  let byK = colsCache.get(p);
  if (!byK) colsCache.set(p, (byK = new Map()));
  let c = byK.get(k);
  if (!c) {
    c = new Cols(p, k / 100);
    byK.set(k, c);
  }
  return c;
}

const K0 = [col('#4a3a22')];
const K1 = [col('#d8b27a'), col('#8a6a40')];
const K2 = [col(DUST)];
const K3 = [col(DUST), col('#3e3020')];
const K4 = [col('#3a4a22')];
const K5 = [col('#cfe4ff'), col('#a8c8ff')];
const K6 = [col('#b8cce0'), col('#dde8f5')];
const K7 = [col('#4a5070'), col('#6a7090')];
const K8 = [col('#050005')];
const K9 = [col('#8a8a8a'), col('#b8b8b8')];

// Hoisted options of the per-frame emitters (zones, domains, statuses, trails: no per-frame allocation).
const R47: [number, number] = [1, 4];
const R59: [number, number] = [0, 0.3];
const O60: BurstOpts = { life: [1.4, 2.2], size: [1.4, 2.4], shape: SHAPE_PUFF, speed: [0, 1], drag: 0.5 };
const R61: [number, number] = [-0.1, 0.1];
const O62: BurstOpts = { life: [2, 2.8], size: [1.8, 2.6], shape: SHAPE_PUFF, speed: [0, 0.8] };
const R63: [number, number] = [1.5, 4];
const O64: BurstOpts = { life: [0.6, 1.2], size: [0.04, 0.08], shape: SHAPE_SPARK, speed: [0, 1.2], gravity: 1 };
const R65: [number, number] = [0, 0.6];
const O66: BurstOpts = { life: [1, 1.6], size: [1, 1.8], shape: SHAPE_PUFF, speed: [0, 0.5] };
const R67: [number, number] = [0.5, 2];
const O68: BurstOpts = { life: [0.8, 1.4], size: [0.8, 1.4], shape: SHAPE_PUFF, speed: [0, 2] };
const R69: [number, number] = [1, 3];
const O70: BurstOpts = { life: [0.4, 0.8], size: [0.15, 0.3], drag: 1 };
const R71: [number, number] = [0.1, 0.8];
const O72: BurstOpts = { life: [0.7, 1.3], size: [0.08, 0.15], shape: SHAPE_STAR, drag: 1 };
const R73: [number, number] = [0, 0.2];
const O74: BurstOpts = { life: [1.2, 2], size: [0.8, 1.4], shape: SHAPE_PUFF, speed: [0, 0.4] };
const O75: BurstOpts = { life: [0.2, 0.4], size: [0.03, 0.06], shape: SHAPE_SPARK };
const R76: [number, number] = [0.6, 2.2];
const O77: BurstOpts = { life: [0.6, 1.1], size: [0.08, 0.18], drag: 1 };
const O78: BurstOpts = { life: [0.6, 0.9], size: [0.06, 0.12] };
const O79: BurstOpts = { life: [0.8, 1.4], size: [0.06, 0.12], shape: SHAPE_STAR, drag: 1 };
const O80: BurstOpts = { life: [0.3, 0.5], size: [0.04, 0.07], shape: SHAPE_SPARK, up: 2 };
const R81: [number, number] = [0.4, 1.4];
const O82: BurstOpts = { life: [0.6, 1.2], size: [0.08, 0.16], drag: 1 };
const R83: [number, number] = [2, 6];
const O84: BurstOpts = { life: [0.4, 0.9], size: [0.2, 0.5], drag: 1, gravity: 1 };
const R85: [number, number] = [3, 8];
const O86: BurstOpts = { life: [0.8, 1.6], size: [0.04, 0.08], shape: SHAPE_SPARK, gravity: 1 };
const R87: [number, number] = [1, 2];
const O88: BurstOpts = { life: [1.5, 2.5], size: [1.5, 2.5], shape: SHAPE_PUFF, drag: 0.6 };
const R89: [number, number] = [-4, -2];
const O90: BurstOpts = { life: [1.5, 2.2], size: [0.07, 0.14], drag: 0.2 };
const R91: [number, number] = [0.1, 0.6];
const O92: BurstOpts = { life: [1, 1.8], size: [0.1, 0.2], shape: SHAPE_STAR, drag: 1 };
const O93: BurstOpts = { life: [2, 3], size: [2.5, 3.5], shape: SHAPE_PUFF, speed: [0, 1] };
const R94: [number, number] = [0.3, 1.5];
const O95: BurstOpts = { life: [1, 2], size: [0.06, 0.14], shape: SHAPE_STAR, drag: 0.8 };
const O96: BurstOpts = { life: [0.3, 0.6], size: [0.15, 0.3], speed: [0, 0.5] };
const O97: BurstOpts = { life: [1.2, 2], size: [1.4, 2.4], shape: SHAPE_PUFF, speed: [0, 0.6] };
const R106: [number, number] = [0.3, 0.8];
const O119: BurstOpts = { life: [0.4, 0.8], size: [0.05, 0.1], shape: SHAPE_SPARK, drag: 1 };
const O128: BurstOpts = { life: [0.3, 0.7], size: [0.25, 0.5], speed: [0.5, 2], up: 0.8, drag: 2 };
const O129: BurstOpts = { life: [0.9, 1.5], size: [0.5, 0.9], shape: SHAPE_PUFF, speed: [0.3, 1], up: 1 };
const O130: BurstOpts = { life: [0.4, 0.8], size: [0.06, 0.12], shape: SHAPE_STAR, jitter: 0.4 };
const O131: BurstOpts = { life: [1, 1.6], size: [0.6, 1], shape: SHAPE_PUFF };
const O132: BurstOpts = { life: [0.1, 0.25], size: [0.03, 0.05], shape: SHAPE_SPARK, speed: [1, 3] };
const O133: BurstOpts = { life: [0.2, 0.4], size: [0.04, 0.07], shape: SHAPE_SPARK, speed: [1, 3], jitter: 0.6 };
const O134: BurstOpts = { life: [0.4, 0.8], size: [0.1, 0.2], jitter: 0.4 };
const O135: BurstOpts = { life: [0.8, 1.2], size: [0.5, 0.9], shape: SHAPE_PUFF };
const O136: BurstOpts = { life: [0.3, 0.6], size: [0.08, 0.16], shape: SHAPE_STAR, jitter: 0.4 };
const O137: BurstOpts = { life: [0.4, 0.8], size: [0.06, 0.12], gravity: -4, speed: [0.5, 2], up: 1 };
const O140: BurstOpts = { life: [0.8, 1.4], size: [0.05, 0.1], up: 1.5, shape: SHAPE_STAR };
const R141: [number, number] = [1.2, 2.5];
const O142: BurstOpts = { life: [0.3, 0.6], size: [0.12, 0.25], drag: 1, speed: [0, 0.3] };
const R143: [number, number] = [0.8, 1.5];
const O144: BurstOpts = { life: [0.8, 1.2], size: [0.3, 0.5], shape: SHAPE_PUFF };
const R145: [number, number] = [1, 2.2];
const O146: BurstOpts = { life: [0.5, 0.9], size: [0.25, 0.45], shape: SHAPE_PUFF, drag: 1 };
const O147: BurstOpts = { life: [0.3, 0.6], size: [0.06, 0.12], drag: 1 };
const O148: BurstOpts = { life: [0.6, 1], size: [0.05, 0.1], up: 0.6, shape: SHAPE_STAR };
const R149: [number, number] = [-0.2, 0.3];
const O150: BurstOpts = { life: [0.6, 1.2], size: [0.08, 0.16], shape: SHAPE_STAR, drag: 1 };
const R151: [number, number] = [0.3, 1];
const O152: BurstOpts = { life: [0.6, 1], size: [0.06, 0.1], shape: SHAPE_SPARK, gravity: -3 };
const O153: BurstOpts = { life: [0.25, 0.4], size: [0.04, 0.07], up: 4, shape: SHAPE_SPARK };
const R154: [number, number] = [-1.5, -0.6];
const O155: BurstOpts = { life: [0.6, 1], size: [0.06, 0.12] };
const O156: BurstOpts = { life: [0.25, 0.35], size: [0.05, 0.1] };

// ── Cast flourishes ─────────────────────────────────────────────────────────

/** Burst where a spell leaves the hand (a little ahead of it in first person). */
export function muzzle(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, dir: V3 | null, scale = 1): void {
  const c = cols(v.palette);
  fx.flash(x, y, z, c.mainH, { size: 0.7 * scale, duration: 0.12 });
  burst(x, y, z, c.k('hm'), 7 * scale, { speed: [1, 4], life: [0.12, 0.28], size: [0.03, 0.06], shape: SHAPE_SPARK, dir, bias: dir ? 0.7 : 0 });
  if (v.family === 'lightning') fx.bolt(x, y, z, x + (dir?.x ?? 0) * 1.2 + rand(-0.3, 0.3), y + (dir?.y ?? 0) * 1.2 + rand(-0.2, 0.3), z + (dir?.z ?? 0) * 1.2 + rand(-0.3, 0.3), c.main, { width: 0.03, duration: 0.12, forks: 1, segs: 5, jitter: 0.25 });
}

/** Windup: particles converging on a charging point (big spells). */
export function charge(v: SpellVisual, x: number, y: number, z: number, radius: number, rate: number): void {
  const c = cols(v.palette);
  ringBurst(x, y - 0.2, z, radius, c.k('hma'), rate, -1, { life: [0.25, 0.4], size: [0.04, 0.08], shape: v.family === 'lightning' || v.family === 'light' ? SHAPE_SPARK : SHAPE_GLOW, up: 0.6 });
}

// ── Projectile trails ───────────────────────────────────────────────────────

/** Trail particles along this frame's travel a -> b; `size` is the core radius. */
export function trail(v: SpellVisual, a: V3, b: V3, size: number, light = 1): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-4) return;
  const c = cols(v.palette);
  const big = size > 0.3;
  const bx = -dx / dist;
  const by = -dy / dist;
  const bz = -dz / dist;
  const steps = Math.min(16, fxCount(dist * (big ? 7 : 4.5) * light, 1));
  for (let i = 0; i < steps; i++) {
    const t = Math.random();
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const z = a.z + dz * t;
    switch (v.family) {
      case 'fire':
        glowPool.emit(x, y, z, bx * 0.6 + rand(-0.4, 0.4), rand(0.2, 1.2), bz * 0.6 + rand(-0.4, 0.4), Math.random() < 0.5 ? c.main : c.deep, rand(0.18, 0.38), size * rand(1.0, 1.7), 1.5, 2.2, SHAPE_GLOW);
        if (Math.random() < 0.35) glowPool.emit(x, y, z, rand(-1.5, 1.5), rand(0.5, 2.5), rand(-1.5, 1.5), c.accent, rand(0.4, 0.9), rand(0.04, 0.08), 2.5, 1.2, SHAPE_SPARK);
        if (big && Math.random() < 0.12 * budget.profile.smoke) smokePool.emit(x, y, z, rand(-0.3, 0.3), rand(0.6, 1.4), rand(-0.3, 0.3), c.smoke, rand(0.6, 1.0), size * rand(1.4, 2.2), 0.4, 1.2, SHAPE_PUFF);
        break;
      case 'ice':
        glowPool.emit(x, y, z, bx * 0.4, by * 0.4, bz * 0.4, c.main, rand(0.15, 0.3), size * rand(1.1, 1.8), 0, 2, SHAPE_GLOW);
        if (Math.random() < 0.5) glowPool.emit(x + rand(-0.15, 0.15), y + rand(-0.15, 0.15), z + rand(-0.15, 0.15), rand(-0.4, 0.4), rand(-0.6, 0.2), rand(-0.4, 0.4), Math.random() < 0.5 ? c.hot : c.accent, rand(0.5, 1.0), rand(0.06, 0.14), -1.2, 1.5, SHAPE_STAR);
        if (big && Math.random() < 0.25 * budget.profile.smoke) smokePool.emit(x, y, z, rand(-0.2, 0.2), rand(-0.1, 0.2), rand(-0.2, 0.2), c.smoke, rand(0.5, 0.9), size * rand(1.5, 2.4), 0, 1.5, SHAPE_PUFF);
        break;
      case 'lightning':
        glowPool.emit(x, y, z, bx * 0.5, by * 0.5, bz * 0.5, c.main, rand(0.08, 0.18), size * rand(1.0, 1.6), 0, 3, SHAPE_GLOW);
        if (Math.random() < 0.5) glowPool.emit(x, y, z, rand(-4, 4), rand(-2, 4), rand(-4, 4), c.hot, rand(0.1, 0.25), rand(0.03, 0.05), 0, 4, SHAPE_SPARK);
        break;
      case 'void':
      case 'dark': {
        const sx = rand(-1, 1);
        const sz = rand(-1, 1);
        glowPool.emit(x, y, z, sx * 1.2, rand(-0.3, 0.6), sz * 1.2, Math.random() < 0.6 ? c.main : c.accent, rand(0.25, 0.5), size * rand(1.2, 2.0), 0, 3, SHAPE_GLOW);
        if (Math.random() < 0.12 * budget.profile.smoke) smokePool.emit(x, y, z, sx * 0.4, rand(0, 0.4), sz * 0.4, c.smoke, rand(0.5, 0.9), size * rand(1.6, 2.6), 0, 2, SHAPE_PUFF);
        break;
      }
      case 'blood':
        glowPool.emit(x, y, z, bx * 0.5, by * 0.5, bz * 0.5, c.main, rand(0.15, 0.3), size * rand(1.2, 1.8), 0, 2, SHAPE_GLOW);
        if (Math.random() < 0.4) glowPool.emit(x, y, z, rand(-0.8, 0.8), rand(0, 1), rand(-0.8, 0.8), c.deep, rand(0.4, 0.7), rand(0.05, 0.09), -14, 0.5, SHAPE_SPARK);
        break;
      case 'nature':
        glowPool.emit(x, y, z, bx * 0.3, by * 0.3, bz * 0.3, c.main, rand(0.15, 0.28), size * rand(1.0, 1.6), 0, 2, SHAPE_GLOW);
        if (Math.random() < 0.35) glowPool.emit(x, y, z, rand(-1, 1), rand(0, 1.2), rand(-1, 1), Math.random() < 0.5 ? c.accent : c.deep, rand(0.6, 1.2), rand(0.05, 0.1), -2.2, 2.2, SHAPE_GLOW);
        break;
      case 'stone':
        smokePool.emit(x + rand(-size, size), y - size * 0.8, z + rand(-size, size), rand(-0.5, 0.5), rand(0.3, 1.2), rand(-0.5, 0.5), col(DUST), rand(0.8, 1.5), size * rand(0.9, 1.5), 0.2, 1.5, SHAPE_PUFF);
        if (Math.random() < 0.3) glowPool.emit(x, y, z, rand(-2, 2), rand(1, 3), rand(-2, 2), col(SOIL), rand(0.4, 0.7), rand(0.05, 0.09), -12, 0.5, SHAPE_SPARK);
        break;
      case 'crystal':
        glowPool.emit(x, y, z, bx * 0.3, by * 0.3, bz * 0.3, c.main, rand(0.12, 0.22), size * rand(0.9, 1.4), 0, 2, SHAPE_GLOW);
        if (Math.random() < 0.55) glowPool.emit(x + rand(-0.12, 0.12), y + rand(-0.12, 0.12), z + rand(-0.12, 0.12), rand(-0.3, 0.3), rand(-0.3, 0.3), rand(-0.3, 0.3), pick([c.hot, c.main, c.accent]), rand(0.35, 0.7), rand(0.07, 0.15), -0.6, 1.5, SHAPE_STAR);
        break;
      case 'wind': {
        // air streaks curling around the flight line
        const a0 = Math.random() * TAU;
        glowPool.emit(x + Math.cos(a0) * size, y + Math.sin(a0) * size * 0.6, z + Math.sin(a0) * size, bx * 3 + Math.cos(a0 + 1.6) * 2, by * 3 + rand(-0.5, 0.5), bz * 3 + Math.sin(a0 + 1.6) * 2, Math.random() < 0.6 ? c.main : c.hot, rand(0.12, 0.25), rand(0.04, 0.07), 0, 5, SHAPE_SPARK);
        break;
      }
      case 'light':
        glowPool.emit(x, y, z, bx * 0.3, by * 0.3, bz * 0.3, c.mainH, rand(0.12, 0.25), size * rand(1.0, 1.6), 0, 2, SHAPE_GLOW);
        if (Math.random() < 0.4) glowPool.emit(x, y, z, rand(-0.6, 0.6), rand(-0.2, 0.8), rand(-0.6, 0.6), c.hot, rand(0.4, 0.8), rand(0.06, 0.12), 0.4, 1.5, SHAPE_STAR);
        break;
      default:
        if (Math.random() < 0.7) glowPool.emit(x, y, z, bx * 3, by * 3, bz * 3, c.main, rand(0.08, 0.16), rand(0.03, 0.06), 0, 6, SHAPE_SPARK);
    }
  }
}

// ── Impacts ─────────────────────────────────────────────────────────────────

export type ImpactKind = 'hit' | 'ground' | 'expire';

/** A projectile struck something (or a hitscan / chain landed). `weight` ~0.5 (spread) .. 1.6 (heavy). */
export function impact(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, dir: V3 | null, weight: number, kind: ImpactKind, cam: THREE.Vector3 | null): void {
  const c = cols(v.palette);
  const back = dir ? { x: -dir.x, y: -dir.y, z: -dir.z } : null;
  if (kind === 'expire') {
    burst(x, y, z, c.k('ma'), 6, { speed: [0.3, 1.2], life: [0.2, 0.5], size: [0.06, 0.12], drag: 2 });
    return;
  }
  fx.flash(x, y, z, c.mainH, { size: 0.8 + weight * 0.9, duration: 0.14 });
  if (weight >= 0.9) fx.light(x, y + 0.3, z, c.main, 18 * weight, 7, 0.18);
  if (kind === 'ground') fx.ring(x, y, z, c.main, { radius: 0.6 + weight * 0.5, duration: 0.3, width: 0.1 });
  if (weight > 1.2) screenKick(x, y, z, 0.25 * weight, cam, 0.2, 0.35);
  const n = Math.round(12 * weight);
  switch (v.family) {
    case 'fire':
      burst(x, y, z, c.k('hma'), n, { speed: [3, 8], life: [0.2, 0.5], size: [0.04, 0.08], gravity: -10, drag: 1.5, shape: SHAPE_SPARK, dir: back, bias: 0.45 });
      burst(x, y, z, c.k('md'), Math.ceil(n * 0.6), { speed: [0.5, 2], life: [0.2, 0.4], size: [0.2, 0.4], drag: 3 });
      burst(x, y, z, c.k('s'), Math.ceil(n * 0.25), { speed: [0.3, 1], life: [0.6, 1.1], size: [0.3, 0.5], gravity: 0.6, drag: 1, shape: SHAPE_PUFF, up: 0.6 });
      if (kind === 'ground' && weight > 1) fx.scorch(x, y, z, 0.6 + weight * 0.3, 4);
      break;
    case 'ice':
      burst(x, y, z, c.k('hm'), n, { speed: [3, 7], life: [0.2, 0.45], size: [0.04, 0.07], gravity: -12, drag: 1, shape: SHAPE_SPARK, dir: back, bias: 0.4 });
      burst(x, y, z, c.k('ha'), n, { speed: [0.4, 1.6], life: [0.5, 1.0], size: [0.08, 0.16], gravity: -1, drag: 2, shape: SHAPE_STAR });
      if (weight > 1) {
        burst(x, y, z, c.k('s'), 4, { speed: [0.3, 1], life: [0.5, 0.9], size: [0.4, 0.7], drag: 2, shape: SHAPE_PUFF });
        fx.spikeCluster('ice', x, z, y, 0.4, 4, 0.7 + weight * 0.3, { hold: 0.5 });
      }
      break;
    case 'lightning':
      burst(x, y, z, c.k('hma'), n * 1.4, { speed: [4, 11], life: [0.12, 0.3], size: [0.03, 0.06], gravity: -8, drag: 1, shape: SHAPE_SPARK, dir: back, bias: 0.3 });
      for (let i = 0; i < 2 + Math.round(weight * 2); i++) {
        const a = Math.random() * TAU;
        const r = rand(0.6, 1.4) * weight;
        fx.bolt(x, y, z, x + Math.cos(a) * r, y + rand(-0.6, 0.6), z + Math.sin(a) * r, c.main, { width: 0.03, duration: 0.2, forks: 0, segs: 5, jitter: 0.35 });
      }
      break;
    case 'void':
    case 'dark':
      ringBurst(x, y, z, 0.9, c.k('ma'), n, -1, { life: [0.18, 0.3], size: [0.08, 0.16] });
      burst(x, y, z, c.k('hm'), n, { speed: [1, 4], life: [0.3, 0.6], size: [0.1, 0.2], drag: 3, delay: [0.15, 0.22] });
      burst(x, y, z, c.k('s'), 5, { speed: [0.3, 1.2], life: [0.6, 1.0], size: [0.4, 0.7], drag: 2, shape: SHAPE_PUFF });
      break;
    case 'blood':
      burst(x, y, z, c.k('md'), n * 1.4, { speed: [2, 6], life: [0.3, 0.6], size: [0.05, 0.09], gravity: -14, drag: 0.6, shape: SHAPE_SPARK, dir: back, bias: 0.5 });
      burst(x, y, z, c.k('m'), 6, { speed: [0.5, 1.5], life: [0.2, 0.35], size: [0.2, 0.35], drag: 3 });
      break;
    case 'nature':
      burst(x, y, z, c.k('mda'), n, { speed: [1.5, 4.5], life: [0.4, 0.9], size: [0.05, 0.1], gravity: -6, drag: 2, dir: back, bias: 0.3 });
      burst(x, y, z, K0, 3, { speed: [0.3, 1], life: [0.5, 0.9], size: [0.3, 0.5], drag: 2, shape: SHAPE_PUFF });
      break;
    case 'stone':
      burst(x, y, z, K1, n * 1.5, { speed: [3, 8], life: [0.4, 0.8], size: [0.06, 0.12], gravity: -14, drag: 0.5, shape: SHAPE_SPARK });
      burst(x, y, z, K2, 8, { speed: [0.5, 2], life: [0.9, 1.6], size: [0.6, 1.1], drag: 1.5, shape: SHAPE_PUFF, up: 0.5 });
      break;
    case 'crystal':
      burst(x, y, z, c.k('hma'), n * 1.3, { speed: [1.5, 5], life: [0.35, 0.8], size: [0.08, 0.16], gravity: -4, drag: 2, shape: SHAPE_STAR, dir: back, bias: 0.35 });
      burst(x, y, z, c.k('hm'), n * 0.6, { speed: [4, 9], life: [0.15, 0.3], size: [0.03, 0.06], gravity: -10, drag: 1, shape: SHAPE_SPARK });
      break;
    case 'wind':
      ringBurst(x, y, z, 0.3, c.k('hm'), n * 1.3, 6, { life: [0.2, 0.35], size: [0.04, 0.07], drag: 3, shape: SHAPE_SPARK, up: 1 });
      burst(x, y, z, c.k('s'), 3, { speed: [1, 3], life: [0.4, 0.7], size: [0.4, 0.7], drag: 3, shape: SHAPE_PUFF });
      break;
    case 'light':
      fx.flash(x, y, z, c.hotH, { size: 1.2 + weight, duration: 0.2, grow: 1.8 });
      burst(x, y, z, c.k('hma'), n * 1.2, { speed: [2, 6], life: [0.3, 0.7], size: [0.08, 0.16], drag: 2, shape: SHAPE_STAR });
      burst(x, y, z, c.k('h'), n * 0.6, { speed: [5, 10], life: [0.12, 0.25], size: [0.03, 0.05], shape: SHAPE_SPARK, drag: 1 });
      break;
    default:
      burst(x, y, z, c.k('hG'), n * 1.6, { speed: [5, 13], life: [0.15, 0.4], size: [0.03, 0.06], gravity: -16, drag: 0.8, shape: SHAPE_SPARK, dir: back, bias: 0.55 });
  }
}

/** A channelled beam biting into something (per frame): sparks and glow, no smoke. */
export function beamBite(v: SpellVisual, x: number, y: number, z: number): void {
  const c = cols(v.palette);
  burst(x, y, z, c.k('hma'), 3, BITE_SPARK);
  burst(x, y, z, c.k('md'), 1, BITE_GLOW);
}
const BITE_SPARK: BurstOpts = { speed: [2, 6], life: [0.12, 0.3], size: [0.03, 0.06], gravity: -8, drag: 1, shape: SHAPE_SPARK, up: 0.3 };
const BITE_GLOW: BurstOpts = { speed: [0.3, 1], life: [0.15, 0.3], size: [0.2, 0.35], drag: 3 };

/** Melee / weapon hit: steel sparks (with the gem's element tint when it has one). */
export function meleeHit(fx: FxPrims, x: number, y: number, z: number, tint: THREE.Color | null, heavy: boolean): void {
  const s = cols(PALETTES.steel);
  fx.flash(x, y, z, tint ?? s.hotH, { size: heavy ? 1.6 : 1.0, duration: 0.1 });
  burst(x, y, z, s.k('haG'), heavy ? 26 : 14, { speed: [4, 11], life: [0.12, 0.35], size: [0.025, 0.05], gravity: -16, drag: 0.8, shape: SHAPE_SPARK, up: 0.3 });
  if (tint) burst(x, y, z, [tint], 8, { speed: [1, 3], life: [0.2, 0.4], size: [0.06, 0.12], drag: 3 });
}

/** Explosive projectile (fireball, geode bomb, hex bomb, avalanche, void bloom...). */
export function explosion(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, r: number, cam: THREE.Vector3 | null): void {
  const c = cols(v.palette);
  const gy = fx.heightAt(x, z, y);
  fx.ring(x, gy, z, c.main, { radius: r * 1.25, duration: 0.55, width: 0.07 });
  fx.flash(x, y + 0.3, z, c.hotH, { size: r * 1.6, duration: 0.18, grow: 1.4 });
  fx.flash(x, y + 0.3, z, c.main, { size: r * 2.4, duration: 0.4, opacity: 0.7, grow: 1.3 });
  fx.light(x, y + 0.8, z, c.main, 45 + r * 10, r * 5 + 6, 0.45);
  screenKick(x, y, z, 0.35 + r * 0.12, cam, 0.25 + r * 0.03);
  switch (v.family) {
    case 'fire':
      burst(x, y, z, c.k('md'), 46, { speed: [1.5, r * 2.6], life: [0.3, 0.6], size: [r * 0.18, r * 0.34], drag: 3.2, up: 0.2, jitter: r * 0.15 });
      burst(x, y, z, c.k('ha'), 36, { speed: [6, 16], life: [0.3, 0.8], size: [0.05, 0.1], gravity: -12, drag: 1, shape: SHAPE_SPARK, up: 0.3 });
      burst(x, y, z, c.k('ma'), 18, { speed: [0.5, 2.5], life: [1.0, 2.0], size: [0.05, 0.09], gravity: 1.8, drag: 1, up: 0.6, jitter: r * 0.5 });
      burst(x, y + 0.3, z, c.k('s'), 14, { speed: [0.5, 2.2], life: [1.4, 2.4], size: [r * 0.35, r * 0.6], gravity: 0.9, drag: 1.4, shape: SHAPE_PUFF, up: 0.6, jitter: r * 0.3, delay: [0.05, 0.2] });
      fx.scorch(x, gy, z, r * 0.95, 6);
      break;
    case 'ice':
      fx.spikeRing('ice', x, z, gy, r * 0.55, 12, 1.1 + r * 0.25, { hold: 0.7 });
      fx.spikeCluster('ice', x, z, gy, r * 0.2, 3, 1.2 + r * 0.3, { hold: 0.7 });
      burst(x, y, z, c.k('hm'), 40, { speed: [4, 11], life: [0.25, 0.6], size: [0.05, 0.09], gravity: -12, drag: 0.8, shape: SHAPE_SPARK, up: 0.3 });
      burst(x, y, z, c.k('ha'), 30, { speed: [0.5, 3], life: [0.7, 1.4], size: [0.1, 0.2], gravity: -0.8, drag: 1.8, shape: SHAPE_STAR, jitter: r * 0.4 });
      burst(x, gy + 0.2, z, c.k('s'), 12, { speed: [1, 3], life: [0.8, 1.4], size: [r * 0.3, r * 0.5], drag: 2, shape: SHAPE_PUFF, up: 0.1 });
      break;
    case 'void':
    case 'dark':
    case 'blood':
      ringBurst(x, y, z, r, c.k('ma'), 40, -1, { life: [0.22, 0.32], size: [0.12, 0.24] });
      burst(x, y, z, c.k('hma'), 40, { speed: [2, r * 3], life: [0.35, 0.7], size: [0.12, 0.28], drag: 2.5, delay: [0.25, 0.3] });
      burst(x, y, z, c.k('s'), 14, { speed: [0.5, 2], life: [1, 1.8], size: [r * 0.3, r * 0.5], drag: 1.6, shape: SHAPE_PUFF, delay: [0.25, 0.35] });
      fx.ring(x, gy, z, c.accent, { radius: r, duration: 0.45, width: 0.1 });
      fx.spikeRing('void', x, z, gy, r * 0.6, 7, 1.3, { delay: 0.25, hold: 0.5 });
      break;
    case 'stone':
      fx.spikeRing('stone', x, z, gy, r * 0.45, 10, 1.4, { hold: 0.8 });
      burst(x, y, z, K1, 44, { speed: [4, 12], life: [0.5, 1.0], size: [0.07, 0.14], gravity: -15, drag: 0.4, shape: SHAPE_SPARK, up: 0.4 });
      burst(x, gy + 0.3, z, K3, 22, { speed: [1, 4], life: [1.3, 2.4], size: [r * 0.3, r * 0.55], gravity: 0.4, drag: 1.5, shape: SHAPE_PUFF, up: 0.3, jitter: r * 0.3 });
      fx.scorch(x, gy, z, r * 0.7, 5, 0.5);
      screenShake(0.5);
      break;
    case 'nature':
      fx.spikeRing('bramble', x, z, gy, r * 0.5, 9, 1.4, { hold: 1.4 });
      fx.spikeCluster('bramble', x, z, gy, r * 0.35, 5, 1.1, { hold: 1.4 });
      burst(x, y, z, c.k('md'), 30, { speed: [2, 6], life: [0.5, 1.1], size: [0.06, 0.12], gravity: -5, drag: 2 });
      burst(x, y, z, c.k('ha'), 26, { speed: [0.2, 1.2], life: [1.5, 2.8], size: [0.05, 0.1], gravity: 0.25, drag: 1.2, jitter: r * 0.6 });
      burst(x, gy + 0.3, z, K4, 10, { speed: [0.5, 2], life: [1, 1.8], size: [r * 0.3, r * 0.5], drag: 2, shape: SHAPE_PUFF });
      break;
    case 'crystal':
      fx.spikeCluster('crystal', x, z, gy, r * 0.45, 8, 1.4 + r * 0.3, { hold: 0.8 });
      burst(x, y, z, c.k('hma'), 50, { speed: [3, 10], life: [0.4, 0.9], size: [0.08, 0.18], gravity: -7, drag: 1.2, shape: SHAPE_STAR, up: 0.25 });
      burst(x, y, z, c.k('hm'), 30, { speed: [6, 14], life: [0.2, 0.4], size: [0.04, 0.07], gravity: -12, drag: 0.8, shape: SHAPE_SPARK });
      break;
    case 'lightning':
      for (let i = 0; i < 5; i++) {
        const a = Math.random() * TAU;
        fx.bolt(x, y, z, x + Math.cos(a) * r * rand(0.6, 1.2), gy + 0.05, z + Math.sin(a) * r * rand(0.6, 1.2), c.main, { width: 0.05, duration: 0.35, forks: 1 });
      }
      burst(x, y, z, c.k('hma'), 50, { speed: [5, 14], life: [0.15, 0.4], size: [0.03, 0.06], gravity: -10, shape: SHAPE_SPARK, up: 0.3 });
      fx.scorch(x, gy, z, r * 0.6, 5, 0.6);
      break;
    default:
      burst(x, y, z, c.k('hma'), 50, { speed: [3, 10], life: [0.3, 0.7], size: [0.06, 0.14], drag: 2, up: 0.3 });
  }
}

// ── Areas ───────────────────────────────────────────────────────────────────

export interface AreaShape {
  radius: number;
  /** Cone arc in degrees (from the caster, facing yaw), 0 = none. */
  cone: number;
  /** Strip length (from the caster, along yaw), 0 = none. */
  line: number;
  yaw: number;
}

/** Spikes / debris racing out along a line (fissure, shard fracture, earth form). */
function lineEruption(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, a: AreaShape): void {
  const c = cols(v.palette);
  const ux = -Math.sin(a.yaw);
  const uz = -Math.cos(a.yaw);
  const px = -uz;
  const pz = ux;
  const steps = Math.ceil(a.line / 0.8);
  for (let i = 0; i < steps; i++) {
    const d = (i + 0.5) * (a.line / steps);
    const delay = d / 26;
    for (let k = 0; k < 2; k++) {
      const off = rand(-a.radius * 0.6, a.radius * 0.6);
      const sx = x + ux * d + px * off;
      const sz = z + uz * d + pz * off;
      const h = rand(1.1, 2.0);
      fx.spike(v.spike, sx, sz, y, { height: h, width: h * 0.2, tiltX: rand(-0.35, 0.35), tiltZ: rand(-0.35, 0.35), delay, hold: 0.45, sink: 0.4 });
    }
    if (i % 2 === 0) {
      const sx = x + ux * d;
      const sz = z + uz * d;
      const gy = fx.heightAt(sx, sz, y);
      burst(sx, gy + 0.3, sz, c.k('hmS'), 6, { speed: [2, 5], life: [0.4, 0.8], size: [0.06, 0.12], gravity: -12, shape: v.family === 'crystal' ? SHAPE_STAR : SHAPE_SPARK, up: 0.7, delay: [delay, delay + 0.02] });
      burst(sx, gy + 0.2, sz, v.family === 'crystal' ? c.k('s') : K2, 2, { speed: [0.3, 1], life: [0.8, 1.4], size: [0.6, 1.0], drag: 2, shape: SHAPE_PUFF, delay: [delay, delay + 0.02] });
    }
  }
  screenShake(0.35);
}

/** Particles sprayed through a cone from the caster (frost bite, gust, cone forms). */
function coneSpray(v: SpellVisual, x: number, y: number, z: number, a: AreaShape): void {
  const c = cols(v.palette);
  const half = ((a.cone / 2) * Math.PI) / 180;
  const n = fxCount(60 * Math.min(2, a.radius / 3));
  for (let i = 0; i < n; i++) {
    const ang = a.yaw + rand(-half, half);
    const dx = -Math.sin(ang);
    const dz = -Math.cos(ang);
    const sp = (a.radius / 0.45) * rand(0.6, 1.05);
    const shape = v.family === 'ice' || v.family === 'crystal' ? SHAPE_STAR : v.family === 'wind' || v.family === 'lightning' ? SHAPE_SPARK : SHAPE_GLOW;
    glowPool.emit(x + dx * 0.6, y + rand(0.6, 1.5), z + dz * 0.6, dx * sp, rand(-0.5, 1.2), dz * sp, pick([c.hot, c.main, c.accent]), rand(0.35, 0.5), shape === SHAPE_GLOW ? rand(0.15, 0.3) : rand(0.05, 0.1), 0, 2.2, shape);
  }
  if (v.family === 'wind' || v.family === 'ice') {
    for (let i = 0, m = fxCount(smokeN(10)); i < m; i++) {
      const ang = a.yaw + rand(-half, half);
      const sp = (a.radius / 0.9) * rand(0.6, 1);
      smokePool.emit(x, y + rand(0.4, 1.2), z, -Math.sin(ang) * sp, rand(0, 0.5), -Math.cos(ang) * sp, c.smoke, rand(0.6, 0.9), rand(0.5, 0.9), 0, 2, SHAPE_PUFF);
    }
  }
}

/**
 * The instant an area spell resolves. (x, y, z) is the centre on the ground
 * (or the caster for cones and lines).
 */
export function areaBurst(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, a: AreaShape, cam: THREE.Vector3 | null): void {
  const c = cols(v.palette);
  const r = a.radius;
  if (a.line > 0) {
    lineEruption(fx, v, x, y, z, a);
    return;
  }
  if (a.cone > 0) {
    coneSpray(v, x, y, z, a);
    if (v.family === 'ice') {
      const half = ((a.cone / 2) * Math.PI) / 180;
      for (let i = 0; i < 7; i++) {
        const ang = a.yaw + rand(-half, half) * 0.9;
        const d = rand(Math.min(2.2, r * 0.5), r); // (not at the caster's feet: first-person readability)
        fx.spike('ice', x - Math.sin(ang) * d, z - Math.cos(ang) * d, y, { height: rand(0.6, 1.1), width: 0.16, yaw: ang, tiltX: 0.4, delay: d / 20, hold: 0.35 });
      }
    }
    return;
  }
  switch (v.setPiece) {
    case 'frost_nova':
      fx.ring(x, y, z, c.hot, { radius: r * 1.1, duration: 0.5, width: 0.05 });
      fx.ring(x, y, z, c.main, { radius: r * 0.8, duration: 0.7, width: 0.12, opacity: 0.6 });
      fx.flash(x, y + 1, z, c.mainH, { size: r * 1.4, duration: 0.3 });
      fx.light(x, y + 1.5, z, c.main, 50, r * 3, 0.5);
      fx.spikeRing('ice', x, z, y, r * 0.82, 20, 1.7, { hold: 0.9, sink: 0.5 });
      // (the inner crown only when you are not standing in it: first-person readability)
      if (!cam || Math.hypot(cam.x - x, cam.z - z) > r * 0.6) fx.spikeRing('ice', x, z, y, r * 0.45, 11, 1.2, { delay: 0.06, hold: 0.8 });
      ringBurst(x, y + 0.3, z, 0.4, c.k('hm'), 70, r * 2.2, { life: [0.35, 0.6], size: [0.05, 0.1], drag: 2, shape: SHAPE_SPARK, up: 1.5 });
      discEmit(x, z, r, y + 0.4, c.k('ha'), 50, [0.2, 1.5], { life: [0.8, 1.6], size: [0.1, 0.2], shape: SHAPE_STAR, drag: 1, gravity: -0.6 });
      ringBurst(x, y + 0.2, z, r * 0.5, c.k('s'), 16, r * 0.8, { life: [0.9, 1.5], size: [1, 1.6], shape: SHAPE_PUFF, drag: 1.5 });
      screenKick(x, y, z, 0.6, cam, 0.4);
      return;
    case 'eruption':
    case 'dawnbreak':
      fx.flash(x, y + 1.5, z, c.hotH, { size: r * 1.8, duration: 0.3 });
      fx.light(x, y + 2, z, c.main, 80, r * 4, 0.7);
      fx.ring(x, y, z, c.main, { radius: r * 1.3, duration: 0.6 });
      fx.scorch(x, y, z, r * 0.9, 7);
      discEmit(x, z, r * 0.45, y + 0.2, c.k('md'), 120, [8, 18], { life: [0.4, 0.9], size: [0.3, 0.65], gravity: -10, drag: 1.2 });
      discEmit(x, z, r * 0.6, y + 0.2, c.k('ha'), 60, [6, 15], { life: [0.6, 1.4], size: [0.05, 0.1], gravity: -12, shape: SHAPE_SPARK, speed: [0, 3] });
      discEmit(x, z, r * 0.6, y + 1.5, c.k('s'), 20, [2, 5], { life: [1.6, 2.6], size: [1, 1.8], gravity: 0.5, drag: 1, shape: SHAPE_PUFF, speed: [0, 1] });
      if (v.setPiece === 'eruption') fx.spikeRing('stone', x, z, y, r * 0.6, 8, 1.2, { hold: 0.6 });
      else fx.spikeRing('light', x, z, y, r * 0.6, 8, 1.4, { hold: 0.6 });
      screenKick(x, y, z, 0.8, cam, 0.45);
      return;
    case 'lightning_strike':
    case 'act_of_god':
      lightningStrike(fx, v, x, y, z, r, v.setPiece === 'act_of_god', cam);
      return;
    case 'downburst':
      fx.ring(x, y, z, c.hot, { radius: r * 1.6, duration: 0.5, width: 0.06 });
      lineEmit({ x, y: y + 14, z }, { x, y, z }, c.k('hm'), 10, { life: [0.15, 0.3], size: [0.06, 0.12], shape: SHAPE_SPARK, speed: [0, 1] });
      ringBurst(x, y + 0.2, z, 0.5, c.k('s'), 22, r * 3, { life: [0.6, 1], size: [0.8, 1.4], shape: SHAPE_PUFF, drag: 2.5 });
      ringBurst(x, y + 0.3, z, 0.4, c.k('hm'), 60, r * 4, { life: [0.3, 0.5], size: [0.04, 0.08], shape: SHAPE_SPARK, drag: 2, up: 0.4 });
      screenKick(x, y, z, 0.7, cam, 0.4);
      return;
    case 'collapse':
    case 'null_field':
      ringBurst(x, y + 0.8, z, r, c.k('ma'), 80, -1, { life: [0.3, 0.45], size: [0.1, 0.22] });
      fx.ring(x, y, z, c.accent, { radius: r, duration: 0.6, width: 0.05 });
      fx.flash(x, y + 1, z, c.mainH, { size: r, duration: 0.35, grow: 0.4 });
      burst(x, y + 0.8, z, c.k('hm'), 50, { speed: [2, 8], life: [0.3, 0.6], size: [0.1, 0.2], drag: 2.5, delay: [0.32, 0.38] });
      burst(x, y + 0.6, z, c.k('s'), 12, { speed: [0.5, 2], life: [0.9, 1.4], size: [0.8, 1.4], drag: 2, shape: SHAPE_PUFF, delay: [0.3, 0.4] });
      fx.spikeRing('void', x, z, y, r * 0.5, 9, 1.4, { delay: 0.32, hold: 0.4 });
      screenKick(x, y, z, 0.6, cam, 0.35);
      return;
    case 'blood_nova':
      fx.ring(x, y, z, c.main, { radius: r * 1.05, duration: 0.55, width: 0.06 });
      fx.ring(x, y + 1, z, c.deep, { radius: r * 0.9, duration: 0.7, width: 0.12, opacity: 0.6 });
      fx.flash(x, y + 1, z, c.mainH, { size: r * 1.2, duration: 0.3 });
      fx.light(x, y + 1.5, z, c.main, 55, r * 3, 0.6);
      ringBurst(x, y + 1, z, 0.5, c.k('hmd'), 90, r * 2, { life: [0.35, 0.55], size: [0.06, 0.12], drag: 1.5, shape: SHAPE_SPARK, up: 0.8 });
      ringBurst(x, y + 1, z, r * 0.9, c.k('ma'), 50, -1, { life: [0.5, 0.7], size: [0.12, 0.22], delay: [0.35, 0.6] });
      screenKick(x, y, z, 0.5, cam, 0.35);
      return;
    case 'sunburst':
    case 'let_there_be_light': {
      const big = v.setPiece === 'let_there_be_light';
      fx.flash(x, y + 1.2, z, c.hotH, { size: r * (big ? 1.4 : 1.8), duration: big ? 0.5 : 0.3, grow: 1.3 });
      fx.light(x, y + 2.5, z, c.main, big ? 150 : 70, r * 3, big ? 1.2 : 0.6);
      fx.ring(x, y, z, c.hot, { radius: r, duration: big ? 0.9 : 0.5, width: 0.04 });
      fx.ring(x, y, z, c.main, { radius: r * 0.7, duration: big ? 1.1 : 0.7, width: 0.1, opacity: 0.7 });
      fx.spikeRing('light', x, z, y, r * 0.55, big ? 18 : 10, big ? 2.4 : 1.3, { hold: big ? 1.0 : 0.5 });
      ringBurst(x, y + 0.5, z, 0.5, c.k('hma'), big ? 160 : 70, r * 2, { life: [0.4, 0.7], size: [0.06, 0.12], drag: 1.5, shape: SHAPE_SPARK, up: 2 });
      discEmit(x, z, r * 0.8, y + 0.3, c.k('ha'), big ? 120 : 40, [1, 4], { life: [1, 2], size: [0.08, 0.16], shape: SHAPE_STAR, drag: 1 });
      if (big) {
        lineEmit({ x, y: y + 30, z }, { x, y, z }, c.k('hm'), 6, { life: [0.4, 0.9], size: [0.3, 0.6], speed: [0, 1] });
        screenFlash(c.hot, 0.6);
      } else screenFlash(c.main, 0.25);
      screenKick(x, y, z, big ? 1.1 : 0.5, cam, big ? 0.6 : 0.35, big ? 0.8 : 0.5);
      return;
    }
    case 'thunderclap':
      fx.flash(x, y + 1, z, c.hotH, { size: r * 1.4, duration: 0.2 });
      fx.light(x, y + 1.5, z, c.main, 70, r * 3, 0.35);
      fx.ring(x, y, z, c.hot, { radius: r * 1.3, duration: 0.4, width: 0.05 });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + rand(-0.2, 0.2);
        fx.bolt(x, y + 1, z, x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r, c.main, { width: 0.06, duration: 0.3, forks: 1 });
      }
      ringBurst(x, y + 0.3, z, 0.4, c.k('hm'), 60, r * 3, { life: [0.2, 0.4], size: [0.04, 0.07], shape: SHAPE_SPARK, drag: 2, up: 0.5 });
      screenKick(x, y, z, 0.7, cam, 0.4);
      return;
    case 'gem_plop':
      fx.spikeCluster('crystal', x, z, y, 0.3, 4, 1.4, { hold: 4, sink: 0.3 });
      fx.ring(x, y, z, c.main, { radius: r, duration: 0.8, width: 0.04 });
      burst(x, y + 0.8, z, c.k('hma'), 40, { speed: [1, 4], life: [0.5, 1], size: [0.08, 0.16], shape: SHAPE_STAR, drag: 2 });
      return;
  }
  // Generic per family.
  fx.ring(x, y, z, c.main, { radius: r * 1.1, duration: 0.45 });
  fx.flash(x, y + 0.8, z, c.mainH, { size: r, duration: 0.2 });
  if (v.weight !== 'minor') fx.light(x, y + 1.2, z, c.main, 35, r * 3, 0.35);
  burst(x, y + 0.6, z, c.k('hma'), 30, { speed: [2, 6], life: [0.3, 0.7], size: [0.08, 0.16], drag: 2, up: 0.5, shape: v.family === 'ice' || v.family === 'crystal' || v.family === 'light' ? SHAPE_STAR : v.family === 'lightning' ? SHAPE_SPARK : SHAPE_GLOW });
  switch (v.family) {
    case 'void':
    case 'dark':
    case 'blood':
      ringBurst(x, y + 0.8, z, r, c.k('ma'), 40, -1, { life: [0.18, 0.28], size: [0.1, 0.2] });
      burst(x, y + 0.5, z, c.k('s'), 8, { speed: [0.5, 1.5], life: [0.7, 1.2], size: [0.6, 1.0], drag: 2, shape: SHAPE_PUFF });
      if (v.weight !== 'minor') fx.spikeRing('void', x, z, y, r * 0.5, 6, 1.1, { delay: 0.18, hold: 0.25 });
      break;
    case 'fire':
      ringBurst(x, y + 0.2, z, 0.3, c.k('hm'), 40, r * 3, { life: [0.3, 0.5], size: [0.2, 0.35], drag: 3, up: 1 });
      if (r > 2) fx.scorch(x, y, z, r * 0.8, 5);
      break;
    case 'ice':
      fx.spikeRing('ice', x, z, y, r * 0.6, 9, 1.0, { hold: 0.35 });
      break;
    case 'nature':
      fx.spikeCluster('bramble', x, z, y, r * 0.6, 9, 2.2, { hold: 0.55 });
      burst(x, y + 0.3, z, K0, 8, { speed: [0.5, 2], life: [0.8, 1.4], size: [0.5, 0.9], drag: 2, shape: SHAPE_PUFF, up: 0.4 });
      break;
    case 'crystal':
      fx.spikeCluster('crystal', x, z, y, r * 0.5, 7, 2.6, { hold: 0.55 });
      break;
    case 'stone':
      fx.spikeRing('stone', x, z, y, r * 0.5, 8, 1.2, { hold: 0.5 });
      break;
    case 'wind':
      ringBurst(x, y + 0.3, z, 0.4, c.k('s'), 14, r * 2.5, { life: [0.5, 0.8], size: [0.6, 1], shape: SHAPE_PUFF, drag: 2 });
      break;
    case 'lightning':
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * TAU;
        fx.bolt(x, y + 1.2, z, x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r, c.main, { width: 0.05, duration: 0.25, forks: 1 });
      }
      break;
    case 'light':
      fx.spikeRing('light', x, z, y, r * 0.5, 7, 1.0, { hold: 0.4 });
      break;
  }
  if (v.weight !== 'minor') screenKick(x, y, z, 0.35, cam, 0.3);
}

/** Lightning Strike / Act of God: a thunderbolt from the sky with forks, flash, light, scorch. */
export function lightningStrike(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, r: number, huge: boolean, cam: THREE.Vector3 | null): void {
  const c = cols(v.palette.main === PALETTES.lightning.main ? v.palette : PALETTES.lightning);
  const top = y + (huge ? 30 : 18);
  fx.bolt(x + rand(-1, 1), top, z + rand(-1, 1), x, y + 0.05, z, c.main, { width: huge ? 0.35 : 0.18, duration: huge ? 0.7 : 0.5, forks: 4, segs: 16, jitter: huge ? 2.2 : 1.4 });
  for (let i = 0; i < (huge ? 5 : 2); i++) {
    const a = Math.random() * TAU;
    const rr = r * rand(0.3, 0.9);
    fx.bolt(x + rand(-2, 2), top * rand(0.5, 0.7), z + rand(-2, 2), x + Math.cos(a) * rr, y + 0.05, z + Math.sin(a) * rr, c.main, { width: huge ? 0.12 : 0.07, duration: 0.4, forks: 1, segs: 8 });
  }
  fx.flash(x, y + 1.2, z, c.hotH, { size: r * 4, duration: 0.18, grow: 1.2 });
  fx.flash(x, y + 6, z, c.main, { size: huge ? 16 : 9, duration: 0.3, opacity: 0.6 });
  fx.light(x, y + 3, z, col('#e8f0ff'), huge ? 220 : 140, huge ? 40 : 30, 0.5);
  fx.ring(x, y, z, c.main, { radius: r * 2.2, duration: 0.5, width: 0.05 });
  fx.ring(x, y, z, c.hot, { radius: r * 1.2, duration: 0.3, width: 0.12 });
  fx.scorch(x, y, z, r * 0.8, 6);
  burst(x, y + 0.3, z, c.k('hma'), huge ? 120 : 60, { speed: [5, 14], life: [0.25, 0.6], size: [0.04, 0.08], gravity: -14, drag: 0.6, shape: SHAPE_SPARK, up: 0.4 });
  burst(x, y + 0.4, z, K5, 8, { speed: [1, 3], life: [0.5, 0.9], size: [0.5, 0.9], drag: 2, shape: SHAPE_PUFF, up: 0.5 });
  screenFlash(col('#dfe8ff'), huge ? 0.7 : 0.35);
  screenKick(x, y, z, huge ? 1.2 : 0.7, cam, huge ? 0.5 : 0.35);
}

// ── Lingering zones and domains (per frame while active) ────────────────────

/** Per-frame emission for a lingering area. `dt` in seconds. */
export function zoneEmit(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, r: number, dt: number): void {
  const c = cols(v.palette);
  const rate = (perSec: number) => perSec * dt;
  switch (v.key) {
    case 'blizzard': {
      const swirl = performance.now() / 1000;
      for (let i = 0, n = fxCount(rate(150)); i < n; i++) {
        const a = Math.random() * TAU;
        const rr = r * Math.sqrt(Math.random());
        glowPool.emit(x + Math.cos(a) * rr, y + rand(5, 8), z + Math.sin(a) * rr, Math.cos(swirl + a) * 2.2, rand(-5, -3), Math.sin(swirl + a) * 2.2, Math.random() < 0.7 ? c.hot : c.main, rand(1.2, 1.8), rand(0.07, 0.14), 0, 0.2, Math.random() < 0.3 ? SHAPE_STAR : SHAPE_GLOW);
      }
      discEmit(x, z, r, y + 0.3, c.k('s'), rate(8), R59, O60);
      discEmit(x, z, r * 0.9, y + 9, K6, rate(5), R61, O62);
      return;
    }
    case 'immolate':
      for (let i = 0, n = fxCount(rate(110)); i < n; i++) {
        const a = Math.random() * TAU;
        const rr = r * rand(0.35, 0.9);
        glowPool.emit(x + Math.cos(a) * rr, y + rand(0.05, 0.4), z + Math.sin(a) * rr, Math.cos(a) * 0.3, rand(2, 4.5), Math.sin(a) * 0.3, pick([c.hot, c.main, c.deep]), rand(0.35, 0.65), rand(0.22, 0.42), 1, 1.2, SHAPE_GLOW);
      }
      discEmit(x, z, r, y + 0.3, c.k('a'), rate(18), R63, O64);
      return;
    case 'singularity':
      for (let i = 0, n = fxCount(rate(120)); i < n; i++) {
        const a = Math.random() * TAU;
        const rr = r * rand(0.6, 1.0);
        const life = rand(0.7, 1.2);
        const inward = rr / life;
        const tang = rand(1.5, 3.5);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        glowPool.emit(x + ca * rr, y + rand(0.1, 2.2), z + sa * rr, -ca * inward - sa * tang, rand(-0.3, 0.3), -sa * inward + ca * tang, pick([c.main, c.accent, c.hot]), life, rand(0.06, 0.16), 0, 0, Math.random() < 0.4 ? SHAPE_SPARK : SHAPE_GLOW);
      }
      discEmit(x, z, r * 0.8, y + 0.2, c.k('s'), rate(10), R65, O66);
      return;
    case 'cyclone': {
      // a funnel: particles spiralling up
      const t = performance.now() / 1000;
      for (let i = 0, n = fxCount(rate(140)); i < n; i++) {
        const h = rand(0, 5);
        const a = Math.random() * TAU + t * 4;
        const rr = r * (0.25 + (h / 5) * 0.75);
        glowPool.emit(x + Math.cos(a) * rr, y + h, z + Math.sin(a) * rr, -Math.sin(a) * 7, rand(2, 4), Math.cos(a) * 7, pick([c.main, c.hot, c.accent]), rand(0.2, 0.4), rand(0.04, 0.08), 0, 1.5, SHAPE_SPARK);
      }
      discEmit(x, z, r, y + 0.4, c.k('sD'), rate(10), R67, O68);
      return;
    }
  }
  switch (v.family) {
    case 'fire':
      discEmit(x, z, r, y + 0.1, c.k('hmd'), rate(60), R69, O70);
      return;
    case 'ice':
      discEmit(x, z, r, y + 0.2, c.k('ha'), rate(30), R71, O72);
      discEmit(x, z, r * 0.8, y + 0.1, c.k('s'), rate(4), R73, O74);
      return;
    case 'lightning':
      if (Math.random() < rate(10)) {
        const a = Math.random() * TAU;
        const rr = r * Math.random();
        fx.bolt(x + Math.cos(a) * rr, y + 0.1, z + Math.sin(a) * rr, x + Math.cos(a + 1) * rr * 0.6, y + rand(0.5, 2), z + Math.sin(a + 1) * rr * 0.6, c.main, { width: 0.04, duration: 0.15, forks: 1, segs: 5 });
      }
      discEmit(x, z, r, y + 0.1, c.k('hm'), rate(30), R67, O75);
      return;
    case 'void':
    case 'dark':
    case 'blood':
      discEmit(x, z, r, y + 0.1, c.k('ma'), rate(40), R76, O77);
      ringBurst(x, y + 0.4, z, r, c.k('m'), rate(25), -1, O78);
      return;
    case 'light':
      discEmit(x, z, r, y + 0.1, c.k('ha'), rate(40), R69, O79);
      return;
    case 'wind':
      ringBurst(x, y + 0.3, z, r * 0.8, c.k('hm'), rate(60), 0, O80);
      return;
  }
  discEmit(x, z, r, y + 0.1, c.k('ma'), rate(20), R81, O82);
}

/** Domain set pieces: per-frame emission inside the dome (radius r). `age` seconds. */
export function domainEmit(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, r: number, dt: number, age: number): void {
  const c = cols(v.palette);
  const rate = (n: number) => n * dt;
  switch (v.family) {
    case 'fire':
      discEmit(x, z, r, y + 0.1, c.k('hmd'), rate(180), R83, O84);
      discEmit(x, z, r, y + 0.2, c.k('a'), rate(60), R85, O86);
      discEmit(x, z, r * 0.8, y + 2, c.k('s'), rate(10), R87, O88);
      break;
    case 'ice':
      discEmit(x, z, r, y + 7, c.k('hm'), rate(220), R89, O90);
      discEmit(x, z, r, y + 0.3, c.k('ha'), rate(60), R91, O92);
      if (Math.random() < rate(6)) {
        const a = Math.random() * TAU;
        const rr = r * Math.sqrt(Math.random());
        fx.spikeCluster('ice', x + Math.cos(a) * rr, z + Math.sin(a) * rr, y, 0.4, 4, rand(1, 2), { hold: 1.2 });
      }
      break;
    case 'lightning': {
      if (Math.random() < rate(5)) {
        const a = Math.random() * TAU;
        const rr = r * Math.sqrt(Math.random()) * 0.9;
        lightningStrike(fx, v, x + Math.cos(a) * rr, fx.heightAt(x + Math.cos(a) * rr, z + Math.sin(a) * rr, y), z + Math.sin(a) * rr, 1.2, false, null);
      }
      discEmit(x, z, r * 0.9, y + 11, K7, rate(10), R61, O93);
      break;
    }
    case 'nature':
    case 'crystal':
      if (Math.random() < rate(4)) {
        const a = Math.random() * TAU;
        const rr = r * Math.sqrt(Math.random()) * 0.9;
        fx.spikeCluster(v.spike, x + Math.cos(a) * rr, z + Math.sin(a) * rr, y, 0.6, 6, rand(2, 3), { hold: 0.8 });
      }
      discEmit(x, z, r, y + 0.3, c.k('hma'), rate(70), R94, { life: [1.2, 2.2], size: [0.06, 0.12], shape: v.family === 'crystal' ? SHAPE_STAR : SHAPE_GLOW, drag: 1 });
      break;
    case 'wind': {
      const t = performance.now() / 1000;
      for (let i = 0, n = fxCount(rate(200)); i < n; i++) {
        const a = Math.random() * TAU + t * 2;
        const rr = r * rand(0.3, 1);
        glowPool.emit(x + Math.cos(a) * rr, y + rand(0.3, 4), z + Math.sin(a) * rr, -Math.sin(a) * 12, rand(-0.5, 1), Math.cos(a) * 12, pick([c.main, c.hot]), rand(0.2, 0.35), rand(0.04, 0.07), 0, 1, SHAPE_SPARK);
      }
      break;
    }
    case 'light':
      discEmit(x, z, r, y + 0.2, c.k('hma'), rate(120), R47, O95);
      if (Math.random() < rate(3)) {
        const a = Math.random() * TAU;
        const rr = r * Math.sqrt(Math.random()) * 0.9;
        const px = x + Math.cos(a) * rr;
        const pz = z + Math.sin(a) * rr;
        const gy = fx.heightAt(px, pz, y);
        lineEmit({ x: px, y: gy + 16, z: pz }, { x: px, y: gy, z: pz }, c.k('hm'), 5, O96);
        fx.ring(px, gy, pz, c.main, { radius: 1.2, duration: 0.4 });
      }
      break;
    default:
      // void / dark: matter spiralling into the centre, tendrils of shadow
      for (let i = 0, n = fxCount(rate(160)); i < n; i++) {
        const a = Math.random() * TAU;
        const rr = r * rand(0.5, 1.0);
        const life = rand(0.9, 1.5);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        glowPool.emit(x + ca * rr, y + rand(0.1, 3), z + sa * rr, -ca * (rr / life) - sa * 3, rand(-0.2, 0.5), -sa * (rr / life) + ca * 3, pick([c.main, c.accent, c.hot]), life, rand(0.06, 0.16), 0, 0, Math.random() < 0.4 ? SHAPE_SPARK : SHAPE_GLOW);
      }
      discEmit(x, z, r * 0.7, y + 0.2, c.k('s'), rate(12), R65, O97);
  }
  void age;
}

/** The moment a domain opens: a ring of light racing outward, a flash and a shockwave. */
export function domainOpen(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, r: number, cam: THREE.Vector3 | null): void {
  const c = cols(v.palette);
  fx.ring(x, y, z, c.hot, { radius: r, duration: 0.9, width: 0.03 });
  fx.ring(x, y, z, c.main, { radius: r * 0.6, duration: 1.1, width: 0.08, opacity: 0.7 });
  fx.flash(x, y + 1.5, z, c.hotH, { size: 8, duration: 0.45, grow: 1.5 });
  fx.light(x, y + 3, z, c.main, 120, r * 3, 1.2);
  ringBurst(x, y + 0.3, z, 0.5, c.k('hma'), 140, r * 1.6, { life: [0.6, 0.9], size: [0.06, 0.12], drag: 1, shape: SHAPE_SPARK, up: 1 });
  screenFlash(c.main, 0.4);
  screenKick(x, y, z, 1, cam, 0.55, 0.8);
}

// ── Runes ───────────────────────────────────────────────────────────────────

export function runeTrigger(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, r: number, cam: THREE.Vector3 | null): void {
  const c = cols(v.palette);
  const big = r >= 2.5;
  fx.ring(x, y, z, c.hot, { radius: r * 1.3, duration: 0.5, width: 0.05 });
  fx.flash(x, y + 0.8, z, c.mainH, { size: r * 1.4, duration: 0.25 });
  fx.light(x, y + 1.2, z, c.main, big ? 60 : 35, r * 4, 0.45);
  switch (v.family) {
    case 'fire':
      explosion(fx, v, x, y + 0.6, z, r, cam);
      if (big) discEmit(x, z, r * 0.5, y + 0.2, c.k('hm'), 70, [6, 14], { life: [0.4, 0.8], size: [0.3, 0.6], gravity: -10, drag: 1 });
      return;
    case 'ice':
      fx.spikeRing('ice', x, z, y, r * 0.75, big ? 16 : 10, big ? 1.8 : 1.2, { hold: big ? 1.4 : 0.6 });
      burst(x, y + 0.6, z, c.k('ha'), 50, { speed: [1, 5], life: [0.6, 1.2], size: [0.1, 0.2], shape: SHAPE_STAR, drag: 1.5, up: 0.5 });
      break;
    case 'nature':
    case 'stone':
      fx.spikeRing('bramble', x, z, y, r * 0.6, 10, big ? 1.8 : 1.4, { hold: 0.8 });
      burst(x, y + 0.5, z, c.k('mda'), 36, { speed: [2, 6], life: [0.5, 1], size: [0.06, 0.12], gravity: -6, drag: 2, up: 0.5 });
      break;
    case 'crystal':
      fx.spikeCluster('crystal', x, z, y, r * 0.55, big ? 12 : 7, big ? 2.6 : 1.8, { hold: 0.8 });
      burst(x, y + 0.8, z, c.k('hma'), 60, { speed: [2, 8], life: [0.4, 0.9], size: [0.08, 0.18], gravity: -5, drag: 1.4, shape: SHAPE_STAR, up: 0.4 });
      break;
    default:
      ringBurst(x, y + 0.8, z, r, c.k('ma'), 50, -1, { life: [0.2, 0.3], size: [0.12, 0.24] });
      burst(x, y + 0.8, z, c.k('hm'), 40, { speed: [2, 7], life: [0.3, 0.7], size: [0.1, 0.24], drag: 2.5, delay: [0.2, 0.25] });
      fx.spikeRing('void', x, z, y, r * 0.6, big ? 10 : 6, big ? 1.6 : 1.1, { delay: 0.2 });
  }
  screenKick(x, y, z, big ? 0.6 : 0.35, cam, 0.3);
}

/** Idle rune: a few motes rising off the sigil. */
export function runeIdle(v: SpellVisual, x: number, y: number, z: number, r: number, dt: number): void {
  const c = cols(v.palette);
  discEmit(x, z, r * 0.9, y + 0.05, c.k('ma'), 6 * dt, R106, { life: [0.6, 1.1], size: [0.05, 0.1], drag: 1, shape: v.family === 'ice' || v.family === 'crystal' ? SHAPE_STAR : SHAPE_GLOW });
}

// ── Target spells (direct) ──────────────────────────────────────────────────

/** A direct spell lands on its target (feet at x, y, z; h = target height). */
export function targetHit(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, h: number, cam: THREE.Vector3 | null): void {
  const c = cols(v.palette);
  const cy = y + h * 0.6;
  switch (v.key) {
    case 'shatter':
      fx.flash(x, cy, z, c.hotH, { size: 5, duration: 0.25 });
      fx.light(x, cy, z, c.main, 70, 12, 0.5);
      fx.ring(x, y, z, c.main, { radius: 3.5, duration: 0.5 });
      fx.spikeRing('ice', x, z, y, 1.0, 12, 1.4, { hold: 0.3, sink: 0.25 });
      burst(x, cy, z, c.k('hm'), 80, { speed: [5, 14], life: [0.3, 0.7], size: [0.05, 0.1], gravity: -12, drag: 0.6, shape: SHAPE_SPARK, up: 0.1 });
      burst(x, cy, z, c.k('ha'), 50, { speed: [1, 5], life: [0.7, 1.4], size: [0.1, 0.22], gravity: -1.5, drag: 1.5, shape: SHAPE_STAR });
      screenKick(x, cy, z, 0.6, cam, 0.3);
      return;
    case 'petrify':
      fx.spikeRing('crystal', x, z, y, 0.65, 10, 2.0, { hold: 2.3, sink: 0.3 });
      burst(x, cy, z, c.k('hma'), 50, { speed: [1, 5], life: [0.5, 1.0], size: [0.08, 0.18], drag: 2, shape: SHAPE_STAR });
      fx.flash(x, cy, z, c.mainH, { size: 3, duration: 0.3 });
      return;
    case 'root_snare':
      fx.spikeRing('bramble', x, z, y, 0.6, 12, 1.9, { hold: 2.3, sink: 0.4 });
      burst(x, y + 0.3, z, c.k('mda'), 40, { speed: [1, 4], life: [0.6, 1.2], size: [0.06, 0.12], gravity: -4, drag: 2, up: 0.6 });
      return;
    case 'death_note':
    case 'unwritten': {
      const blood = cols(v.key === 'death_note' ? PALETTES.blood : PALETTES.void);
      fx.flash(x, cy, z, blood.mainH, { size: 6, duration: 0.5, grow: 1.1 });
      fx.light(x, cy, z, blood.main, 80, 14, 1);
      fx.ring(x, y, z, blood.main, { radius: 4, duration: 0.9, width: 0.04 });
      lineEmit({ x, y: y + 14, z }, { x, y, z }, blood.k('hm'), 12, { life: [0.2, 0.5], size: [0.1, 0.25] });
      burst(x, cy, z, K8, 26, { speed: [1, 4], life: [1.2, 2.2], size: [0.6, 1.2], drag: 1.6, shape: SHAPE_PUFF, gravity: 0.5 });
      burst(x, cy, z, blood.k('md'), 50, { speed: [3, 9], life: [0.4, 0.9], size: [0.05, 0.1], gravity: -10, shape: SHAPE_SPARK });
      screenFlash(blood.deep, 0.5);
      screenKick(x, cy, z, 0.8, cam, 0.4);
      return;
    }
    case 'amaterasu': {
      const b = cols(PALETTES.blackflame);
      burst(x, cy, z, b.k('s'), 30, { speed: [0.5, 2.5], life: [0.8, 1.4], size: [0.5, 0.9], drag: 1.5, shape: SHAPE_PUFF, gravity: 1.5, up: 0.5 });
      fx.flash(x, cy, z, b.main, { size: 3, duration: 0.3 });
      burst(x, cy, z, b.k('hm'), 30, { speed: [2, 6], life: [0.3, 0.6], size: [0.04, 0.08], gravity: -6, shape: SHAPE_SPARK });
      return;
    }
    case 'unmake':
      ringBurst(x, cy, z, 2, c.k('ma'), 60, -1, { life: [0.25, 0.35], size: [0.08, 0.16] });
      fx.flash(x, cy, z, c.mainH, { size: 3.5, duration: 0.3, grow: 0.3 });
      burst(x, cy, z, c.k('hm'), 50, { speed: [3, 9], life: [0.3, 0.6], size: [0.06, 0.12], drag: 2, delay: [0.25, 0.3] });
      screenKick(x, cy, z, 0.5, cam, 0.3);
      return;
  }
  fx.flash(x, cy, z, c.mainH, { size: 2.5, duration: 0.25 });
  burst(x, cy, z, c.k('hm'), 30, { speed: [1, 5], life: [0.3, 0.7], size: [0.08, 0.16], drag: 2 });
}

/** Windup sigil companions (the long-charge ultimates): ink / light gathering above the target. */
export function targetWindup(v: SpellVisual, x: number, y: number, z: number, k: number, dt: number): void {
  const c = cols(v.key === 'death_note' ? PALETTES.blood : v.palette);
  discEmit(x, z, 1.4 * (1 - k * 0.6), y + 0.1, c.k('ma'), 50 * dt * (0.5 + k), [1, 3 + k * 4], O119);
}

// ── Mobility, shields, forms ────────────────────────────────────────────────

/** Dash start (the spot you left) and end. */
export function dashBurst(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, end: boolean): void {
  const c = cols(v.palette);
  const cy = y + 0.9;
  fx.flash(x, cy, z, c.mainH, { size: end ? 2.2 : 2.8, duration: 0.2 });
  switch (v.family) {
    case 'ice':
    case 'crystal':
      burst(x, cy, z, c.k('hm'), 26, { speed: [1, 4], life: [0.5, 1.0], size: [0.08, 0.16], shape: SHAPE_STAR, drag: 2 });
      if (!end) fx.spikeRing(v.spike, x, z, y, 0.7, 6, 0.8, { hold: 0.6 });
      break;
    case 'void':
    case 'dark':
      burst(x, cy, z, c.k('s'), 16, { speed: [0.5, 2], life: [0.8, 1.4], size: [0.6, 1.1], drag: 2, shape: SHAPE_PUFF });
      burst(x, cy, z, c.k('ma'), 30, { speed: [1, 4], life: [0.4, 0.8], size: [0.08, 0.16], drag: 2 });
      break;
    case 'lightning':
      burst(x, cy, z, c.k('hm'), 30, { speed: [3, 9], life: [0.15, 0.35], size: [0.03, 0.06], shape: SHAPE_SPARK, gravity: -8 });
      fx.bolt(x, y + 2.5, z, x, y, z, c.main, { width: 0.06, duration: 0.2, forks: 2 });
      break;
    case 'wind':
      ringBurst(x, y + 0.2, z, 0.4, c.k('s'), 10, 4, { life: [0.4, 0.7], size: [0.5, 0.9], shape: SHAPE_PUFF, drag: 2 });
      ringBurst(x, y + 0.2, z, 0.4, c.k('hm'), 30, 6, { life: [0.25, 0.4], size: [0.04, 0.07], shape: SHAPE_SPARK, drag: 2, up: 3 });
      break;
    case 'nature':
    case 'stone':
      fx.ring(x, y, z, c.main, { radius: 1.6, duration: 0.45, width: 0.08 });
      fx.spikeRing(end ? 'stone' : 'bramble', x, z, y, 0.6, 7, 0.9, { hold: 0.3 });
      ringBurst(x, y + 0.15, z, 0.5, K2, 12, 3, { life: [0.7, 1.2], size: [0.5, 0.9], shape: SHAPE_PUFF, drag: 2 });
      break;
    default:
      burst(x, cy, z, c.k('hma'), 28, { speed: [2, 6], life: [0.25, 0.5], size: [0.06, 0.12], drag: 2 });
  }
}

/** Dash trail segment a -> b (feet), emitted per frame while dashing. */
const SHOCK_BOLT = { width: 0.045, duration: 0.14, forks: 1, segs: 5, jitter: 0.35 };
const R_SHOCK: [number, number] = [-1, 1.5];
const O_SHOCK: BurstOpts = { life: [0.1, 0.25], size: [0.03, 0.05], shape: SHAPE_SPARK, speed: [0, 3] };
const sA = { x: 0, y: 0, z: 0 };
const sB = { x: 0, y: 0, z: 0 };
const sC = { x: 0, y: 0, z: 0 };
const sD = { x: 0, y: 0, z: 0 };
const up = (o: V3, p: V3, dy: number): V3 => ((o.x = p.x), (o.y = p.y + dy), (o.z = p.z), o);
const DASH_BOLT = { width: 0.05, duration: 0.18, forks: 1, segs: 4, jitter: 0.4 };

export function dashTrail(fx: FxPrims, v: SpellVisual, a: V3, b: V3): void {
  const c = cols(v.palette);
  const a1 = up(sA, a, 0.9);
  const b1 = up(sB, b, 0.9);
  switch (v.family) {
    case 'fire':
      lineEmit(up(sC, a, 0.15), up(sD, b, 0.15), c.k('hmd'), 14, O128);
      lineEmit(a1, b1, c.k('s'), 1.5, O129);
      break;
    case 'ice':
      lineEmit(a1, b1, c.k('ha'), 8, O130);
      lineEmit(up(sC, a, 0.1), up(sD, b, 0.1), c.k('s'), 1.5, O131);
      break;
    case 'lightning':
      fx.bolt(a1.x, a1.y, a1.z, b1.x, b1.y, b1.z, c.main, DASH_BOLT);
      lineEmit(a1, b1, c.k('h'), 6, O132);
      break;
    case 'wind':
      lineEmit(a1, b1, c.k('hm'), 10, O133);
      break;
    case 'void':
    case 'dark':
      lineEmit(a1, b1, c.k('ma'), 6, O134);
      lineEmit(a1, b1, c.k('s'), 2, O135);
      break;
    case 'light':
      lineEmit(a1, b1, c.k('hm'), 10, O136);
      break;
    default:
      lineEmit(up(sC, a, 0.2), up(sD, b, 0.2), c.k('md'), 8, O137);
  }
}

/** A shield going up around (x, y, z) (feet) / breaking. */
export function shieldBurst(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, broken: boolean): void {
  const c = cols(v.palette);
  const cy = y + 1;
  if (broken) {
    fx.flash(x, cy, z, c.hotH, { size: 3, duration: 0.25 });
    burst(x, cy, z, c.k('hma'), 60, { speed: [3, 8], life: [0.4, 0.9], size: [0.08, 0.16], gravity: -8, drag: 1, shape: SHAPE_STAR });
    fx.spikeRing(v.spike, x, z, y, 1.1, 8, 0.6, { hold: 0.15, sink: 0.3 });
    return;
  }
  fx.ring(x, y, z, c.main, { radius: 2.2, duration: 0.45 });
  ringBurst(x, cy, z, 1.3, c.k('ha'), 50, -0.0001, { life: [0.6, 1.1], size: [0.1, 0.2], shape: SHAPE_STAR, up: 1 });
  if (v.spike === 'crystal' || v.spike === 'ice') fx.spikeRing(v.spike, x, z, y, 1.1, 8, 0.9, { hold: 0.35 });
}

/** Halo (light, defensive heal): motes rising around the healed. */
export function haloEmit(v: SpellVisual, x: number, y: number, z: number, dt: number): void {
  const c = cols(v.palette);
  ringBurst(x, y + 0.1, z, 0.8, c.k('ha'), 30 * dt, 0, O140);
}

// ── Statuses on targets ─────────────────────────────────────────────────────

const STATUS_PAL: Record<string, Palette> = {
  burn: PALETTES.fire,
  slow: PALETTES.ice,
  freeze: PALETTES.ice,
  stun: PALETTES.lightning,
  petrify: PALETTES.stone,
  airborne: PALETTES.wind,
  curse: PALETTES.dark,
  shock: PALETTES.lightning,
  pull: PALETTES.void,
  knockback: PALETTES.wind,
  taunt: PALETTES.crystal,
  black_flame: PALETTES.blackflame,
};

/** The status order for the one shell an enemy wears (the most telling first). */
export const STATUS_PRIORITY = ['freeze', 'petrify', 'black_flame', 'burn', 'shock', 'stun', 'curse', 'slow', 'pull', 'airborne', 'knockback', 'taunt'];

/** A status's shell colour (HDR main of its palette). */
export function statusColor(status: string): THREE.Color | null {
  const p = STATUS_PAL[status];
  return p ? (status === 'petrify' ? col('#9a9a9a') : cols(p).mainH) : null;
}

/** Per-frame emission for one status on a target (feet x, y, z; height h; size s). */
export function statusEmit(fx: FxPrims, status: string, x: number, y: number, z: number, h: number, s: number, dt: number, t: number): void {
  const p = STATUS_PAL[status];
  if (!p) return;
  const c = cols(p);
  const rate = (n: number) => n * dt;
  const r = 0.45 * s;
  switch (status) {
    case 'burn':
      discEmit(x, z, r, y + h * 0.3, c.k('hmd'), rate(75), R141, O142);
      discEmit(x, z, r, y + h * 0.6, c.k('s'), rate(3), R143, O144);
      return;
    case 'black_flame':
      discEmit(x, z, r, y + h * 0.2, c.k('s'), rate(30), R145, O146);
      discEmit(x, z, r * 0.8, y + h * 0.3, c.k('hm'), rate(20), R87, O147);
      return;
    case 'slow':
      ringBurst(x, y + 0.1, z, r * 1.3, c.k('ma'), rate(14), 0, O148);
      return;
    case 'freeze':
      discEmit(x, z, r * 1.1, y + h * 0.5, c.k('ha'), rate(20), R149, O150);
      discEmit(x, z, r, y + 0.1, c.k('s'), rate(2), R73, O131);
      return;
    case 'stun': {
      // stars circling the head
      for (let i = 0; i < 3; i++) {
        const a = t * 5 + (i * TAU) / 3;
        if (Math.random() < rate(30)) glowPool.emit(x + Math.cos(a) * r, y + h + 0.25, z + Math.sin(a) * r, -Math.sin(a) * 1.5, 0, Math.cos(a) * 1.5, c.hot, 0.3, 0.16, 0, 0, SHAPE_STAR);
      }
      return;
    }
    case 'shock':
      if (Math.random() < rate(16)) {
        const a = Math.random() * TAU;
        fx.bolt(x + Math.cos(a) * r * 1.2, y + rand(0.2, h), z + Math.sin(a) * r * 1.2, x - Math.cos(a) * r * 1.2, y + rand(0.2, h), z - Math.sin(a) * r * 1.2, c.main, SHOCK_BOLT);
      }
      discEmit(x, z, r, y + h * 0.5, c.k('hm'), rate(25), R_SHOCK, O_SHOCK);
      return;
    case 'petrify':
      discEmit(x, z, r, y + 0.1, K9, rate(10), R151, O152);
      return;
    case 'airborne':
    case 'knockback':
      ringBurst(x, y + 0.2, z, r * 1.5, c.k('hm'), rate(30), 0, O153);
      return;
    case 'curse':
      discEmit(x, z, r, y + h + 0.1, c.k('md'), rate(30), R154, O155);
      return;
    case 'pull':
      ringBurst(x, y + h * 0.5, z, r * 2.5, c.k('ma'), rate(90), -1, O156);
      return;
    case 'taunt':
      if (Math.random() < rate(4)) glowPool.emit(x, y + h + 0.5, z, 0, 0.6, 0, c.main, 0.5, 0.25, 0, 1, SHAPE_STAR);
      return;
  }
}
