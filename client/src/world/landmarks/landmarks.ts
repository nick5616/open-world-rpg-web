// Landmarks that call you from afar (CR 052): the cheap, pure half. Which
// places of the atlas get which signal, how far each is shown, and the
// motion of the particles (smoke rising, birds circling, glints). The layer
// (LandmarkLayer.tsx) feeds the numbers into three small Points buffers.
//
//   smoke      a grey plume over bandit and enemy camps, by day and night
//   pillar     a faint light pillar over a crystal tower you have not attuned, at dusk and night
//   lantern    a warm pair of lanterns at each dwarven hall door
//   glow       a soft glow at cave mouths
//   birds      a few dark birds circling a sealed vault or an active world event
//   glint      slow twinkles on sky palaces
//
// Nothing here casts light or adds a three.js light; it is all emissive sprites.

export interface LSite {
  index: number;
  category: 'poi' | 'settlement' | 'structure';
  kind: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  layer?: number;
}

export type LandmarkKind = 'smoke' | 'pillar' | 'lantern' | 'glow' | 'glint';

/** Per kind: the farthest it is shown (m) and the most shown at once. */
export const LANDMARK_RANGE: Record<LandmarkKind | 'birds', { range: number; max: number }> = {
  smoke: { range: 2600, max: 6 },
  pillar: { range: 3600, max: 4 },
  lantern: { range: 520, max: 6 },
  glow: { range: 800, max: 6 },
  glint: { range: 3200, max: 4 },
  birds: { range: 1800, max: 3 },
};

/** The kind of signal a site gives (null: none). Underground, Depths and cavern sites never signal on the surface except sky palaces. */
export function landmarkKindOf(s: LSite): LandmarkKind | null {
  if (s.kind === 'sky_palace') return 'glint';
  if (s.layer && s.layer > 0) return null;
  switch (s.kind) {
    case 'bandit_camp':
    case 'enemy_camp':
      return 'smoke';
    case 'tower':
      return 'pillar';
    case 'dwarf_door':
      return 'lantern';
    case 'cave_mouth':
      return 'glow';
    default:
      return null;
  }
}

export interface Landmarks {
  smoke: LSite[];
  pillar: LSite[];
  lantern: LSite[];
  glow: LSite[];
  glint: LSite[];
}

/** Sort the atlas' sites into the signals they give (by index: deterministic). */
export function partitionLandmarks(sites: LSite[]): Landmarks {
  const out: Landmarks = { smoke: [], pillar: [], lantern: [], glow: [], glint: [] };
  for (const s of sites) {
    const k = landmarkKindOf(s);
    if (k) out[k].push(s);
  }
  return out;
}

/** The nearest `max` sites within `range` of (x, z), nearest first. */
export function nearestSites(list: LSite[], x: number, z: number, range: number, max: number): LSite[] {
  const near: { s: LSite; d: number }[] = [];
  for (const s of list) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d <= range) near.push({ s, d });
  }
  near.sort((a, b) => a.d - b.d || a.s.index - b.s.index);
  return near.slice(0, max).map((n) => n.s);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 1 at night, 0 by day, from the sky's `day` (0 night .. 1 day): the pillar's visibility is high at dusk and night. */
export function duskK(day: number): number {
  return 1 - smooth(0.25, 0.6, day);
}

// ── Smoke ─────────────────────────────────────────────────────────────────

export const PLUME_PUFFS = 12;
export const PLUME_HEIGHT = 95;
/** Seconds a puff takes to rise. */
export const PLUME_LIFE = 16;

export interface Puff {
  /** Offset from the camp at ground (m): x, height above the camp's y, z. */
  x: number;
  h: number;
  z: number;
  size: number;
  alpha: number;
}

/** Puff `i` of a plume at time t (s): rises, widens, thins, leans downwind (wx, wz unit). Deterministic from (seed, i, t). */
export function puffAt(seed: number, i: number, t: number, wx: number, wz: number, out: Puff): Puff {
  const phase = (t / PLUME_LIFE + i / PLUME_PUFFS + seed * 0.37) % 1;
  const k = phase < 0 ? phase + 1 : phase;
  const lean = k * k * 34;
  const wob = Math.sin(k * 9 + seed * 3.1 + i) * 2.2 * k;
  out.x = wx * lean - wz * wob;
  out.z = wz * lean + wx * wob;
  out.h = 2 + k * PLUME_HEIGHT;
  out.size = 4 + 20 * Math.sqrt(k);
  out.alpha = 0.3 * smooth(0, 0.08, k) * (1 - smooth(0.55, 1, k));
  return out;
}

// ── Birds ─────────────────────────────────────────────────────────────────

export const BIRDS_PER_SITE = 6;

export interface BirdPos {
  x: number;
  y: number;
  z: number;
}

/** Bird `i` circling a centre at time t: a wide slow ring, each on its own radius, speed and height. */
export function birdAt(seed: number, i: number, t: number, out: BirdPos): BirdPos {
  const a0 = (i / BIRDS_PER_SITE) * Math.PI * 2 + seed;
  const r = 26 + (i % 3) * 7 + 4 * Math.sin(t * 0.21 + i);
  const w = 0.2 + 0.03 * (i % 2);
  const a = a0 + t * w;
  out.x = Math.cos(a) * r;
  out.z = Math.sin(a) * r;
  out.y = 52 + (i % 3) * 5 + 3 * Math.sin(t * 0.5 + i * 2);
  return out;
}

// ── Glints ────────────────────────────────────────────────────────────────

/** A slow twinkle 0..1: period 3-5 s, never faster (no flashing). */
export function glint(seed: number, i: number, t: number): number {
  const period = 3 + ((seed * 7 + i * 3) % 3);
  const x = Math.sin(((t + i * 1.7 + seed) / period) * Math.PI * 2);
  return Math.max(0, x) ** 3;
}
