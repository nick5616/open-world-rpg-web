// The title/character-stage cavern (pt3 title + creation, CR 047), as pure
// functions: a seeded value noise, the cavern's surface, and where the gem
// clusters stand. No three.js here, so it is unit-tested and the same
// cavern comes back every launch.

/** Game gem colours (world/caves/caveVisuals.ts GEM table: [body, glow]). */
export const GEMS = [
  { name: 'sapphire', body: 0x1f5fd6, glow: 0x4d8cff },
  { name: 'amethyst', body: 0x9b5de5, glow: 0xc38bff },
  { name: 'emerald', body: 0x2fbf68, glow: 0x4dff98 },
  { name: 'ruby', body: 0xe0115f, glow: 0xff3a6e },
  { name: 'topaz', body: 0xffc23d, glow: 0xffd36b },
] as const;

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [0,1). */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

export function fbm3(x: number, y: number, z: number, oct = 4): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x * f, y * f, z * f);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

export const CAVE_RADIUS = 26;
export const CAVE_SQUASH = 0.72;
export const FLOOR_Y = -5;

/** Floor height at x,z (gentle, so the figure and the fire stand on near-level rock). */
export function floorY(x: number, z: number): number {
  // flat plateau around the origin (the figure), rolling further out
  const d = Math.hypot(x, z);
  const roll = (fbm3(x * 0.16, 0.5, z * 0.16, 3) - 0.5) * 3.2;
  return FLOOR_Y + roll * Math.min(1, Math.max(0, (d - 3) / 8)) + (fbm3(x * 0.9, 1.5, z * 0.9, 2) - 0.5) * 0.18;
}

/** The cavern wall in direction `d` (unit vector): the point on the surface, floor clamped. */
export function caveSurface(dx: number, dy: number, dz: number, out: [number, number, number] = [0, 0, 0]): { p: [number, number, number]; floor: boolean } {
  const r = CAVE_RADIUS * (0.78 + 0.5 * fbm3(dx * 1.5 + 7, dy * 1.5, dz * 1.5, 4) + 0.12 * fbm3(dx * 5, dy * 5 + 3, dz * 5, 2));
  const x = dx * r;
  let y = dy * r * CAVE_SQUASH;
  const z = dz * r;
  const fy = floorY(x, z);
  let floor = false;
  if (y < fy) {
    y = fy;
    floor = true;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;

  return { p: out, floor };
}

export interface ClusterSpec {
  /** Position on the cavern surface. */
  x: number;
  y: number;
  z: number;
  /** Surface normal pointing into the cavern. */
  nx: number;
  ny: number;
  nz: number;
  gem: number;
  /** Largest crystal height (m). */
  size: number;
  floor: boolean;
  crystals: CrystalSpec[];
}

export interface CrystalSpec {
  /** Offset in the cluster's tangent plane (m). */
  ox: number;
  oz: number;
  /** Tilt away from the normal (rad) and its heading. */
  tilt: number;
  heading: number;
  height: number;
  width: number;
  gem: number;
}

export type StageVariant = 'title' | 'stage';

const HERO_TITLE: [number, number, number, number][] = [
  // x, z, gem, size (floor heroes the title camera sees)
  [-7.5, -9, 0, 3.4],
  [6.5, -11, 1, 4.2],
  [-2, -17, 2, 3.6],
  [11, -3, 3, 2.6],
  [-11.5, -2, 4, 2.4],
  [2.5, -7, 0, 1.5],
];
const HERO_STAGE: [number, number, number, number][] = [
  [-5.8, -6.2, 1, 3.0],
  [5.6, -6.8, 0, 3.6],
  [0.8, -11.5, 2, 4.2],
  [-9, -1.5, 3, 2.2],
  [9.5, -1.0, 4, 2.2],
  [-3.2, -9.0, 0, 1.4],
  [3.4, -9.4, 3, 1.3],
];

function makeCluster(rand: () => number, x: number, y: number, z: number, nx: number, ny: number, nz: number, gem: number, size: number, floor: boolean): ClusterSpec {
  const count = 4 + Math.floor(rand() * 4) + (size > 2.5 ? 3 : 0);
  const crystals: CrystalSpec[] = [];
  for (let i = 0; i < count; i++) {
    const main = i === 0;
    const a = rand() * Math.PI * 2;
    const rr = main ? 0 : (0.25 + rand() * 0.75) * size * 0.32;
    const h = main ? size : size * (0.28 + rand() * 0.5);
    crystals.push({
      ox: Math.cos(a) * rr,
      oz: Math.sin(a) * rr,
      tilt: main ? rand() * 0.12 : 0.18 + rand() * 0.55,
      heading: a + (rand() - 0.5) * 0.6,
      height: h,
      width: Math.max(0.09, h * (0.17 + rand() * 0.08)),
      // a crystal now and then takes another gem: mixed seams like the real caves
      gem: rand() < 0.12 ? Math.floor(rand() * GEMS.length) : gem,
    });
  }
  return { x, y, z, nx, ny, nz, gem, size, floor, crystals };
}

/** The clusters of a variant: hero floor clusters where the camera looks, then walls and ceiling by seed. */
export function layoutClusters(variant: StageVariant, seed: number, density = 1): ClusterSpec[] {
  const rand = rng(seed + (variant === 'title' ? 11 : 97));
  const out: ClusterSpec[] = [];
  for (const [x, z, gem, size] of variant === 'title' ? HERO_TITLE : HERO_STAGE) {
    out.push(makeCluster(rand, x, floorY(x, z), z, 0, 1, 0, gem, size, true));
  }
  const want = Math.round((variant === 'title' ? 30 : 24) * density);
  const tmp: [number, number, number] = [0, 0, 0];
  let guard = 0;
  while (out.length < want + HERO_TITLE.length && guard++ < 600) {
    const az = rand() * Math.PI * 2;
    // walls and ceiling mostly, a few more floor clusters at the cavern's edge
    const el = (rand() * 1.55 - 0.18) * 1.0;
    const dx = Math.cos(el) * Math.cos(az);
    const dy = Math.sin(el);
    const dz = Math.cos(el) * Math.sin(az);
    const { p, floor } = caveSurface(dx, dy, dz, tmp);
    // stay out of the camera's near field and the character's circle
    if (Math.hypot(p[0], p[2]) < 9) continue;
    const len = Math.hypot(p[0], p[1] - FLOOR_Y - 4, p[2]) || 1;
    const nx = floor ? 0 : -p[0] / len;
    const ny = floor ? 1 : -(p[1] - FLOOR_Y - 4) / len;
    const nz = floor ? 0 : -p[2] / len;
    const gem = Math.floor(rand() * GEMS.length);
    const size = (floor ? 0.9 : 0.8) + rand() * (floor ? 1.6 : 2.0);
    out.push(makeCluster(rand, p[0], p[1], p[2], nx, ny, nz, gem, size, floor));
  }
  return out;
}

/** Stalactite / stalagmite positions: [x, y, z, height, radius, up(1)|down(-1)]. */
export function layoutStalactites(seed: number, count = 46): [number, number, number, number, number, number][] {
  const rand = rng(seed + 5);
  const out: [number, number, number, number, number, number][] = [];
  const tmp: [number, number, number] = [0, 0, 0];
  let guard = 0;
  while (out.length < count && guard++ < 400) {
    const az = rand() * Math.PI * 2;
    const el = 0.55 + rand() * 0.8;
    const { p } = caveSurface(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az), tmp);
    out.push([p[0] * 0.98, p[1] - 0.2, p[2] * 0.98, 1.2 + rand() * 4.2, 0.22 + rand() * 0.45, -1]);
  }
  return out;
}
