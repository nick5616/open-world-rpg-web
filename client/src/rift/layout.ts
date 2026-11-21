// Rift runs (playtest 2, CR 040): the TS twin of the zone's arena layout
// (server/zone/internal/rift/layout.go). Same integers in, same rooms out:
// 32-bit hashing with Math.imul, the same templates and themes, the same
// collision arithmetic (rift.test.ts replays the Go golden vectors).
// Arena-local coordinates: the origin is the room's centre on its floor,
// +z the entrance (south), -z the door (north).

export const HALF_X = 10;
export const HALF_Z = 14;
export const PLAYER_R = 0.4;
export const HIT_R = 0.28;
export const BULLET_Y = 1.0;
export const DOOR_Z = -HALF_Z + 0.6;
export const DOOR_REACH = 1.8;
export const START_Z = HALF_Z - 2.5;
export const EXIT_X = -4.5;
export const STAGES = 50;

export const PILLAR = 0;
export const POOL = 1;
export const SPIKES = 2;

export interface Obstacle {
  kind: number;
  x: number;
  z: number;
  r: number;
  h: number;
  phase: number;
}

export interface Layout {
  chapter: number;
  stage: number;
  template: number;
  obstacles: Obstacle[];
  slots: [number, number][];
}

// ---- hashing ----

/** lowbias32 (layout.go Mix). */
export function mix(a: number): number {
  a = (a ^ (a >>> 16)) >>> 0;
  a = Math.imul(a, 0x7feb352d) >>> 0;
  a = (a ^ (a >>> 15)) >>> 0;
  a = Math.imul(a, 0x846ca68b) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0;
  return a;
}

/** layout.go Hash. */
export function hash(...vals: number[]): number {
  let h = 0x9e3779b9;
  for (const v of vals) {
    const s = ((v >>> 0) + 0x632be5ab + ((h << 6) >>> 0) + (h >>> 2)) >>> 0;
    h = mix((h ^ s) >>> 0);
  }
  return h;
}

/** A hash as a fraction in [0, 1). */
export const unit = (h: number): number => (h >>> 0) / 4294967296;

/** Go's math.Round (half away from zero). */
export const roundGo = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

// ---- templates ----

type T = [number, number, number, boolean]; // x, z, r, mirror
const TEMPLATES: T[][] = [
  [],
  [[0.5, -0.1, 1.1, true], [0.5, 0.35, 1.1, true]],
  [[0, 0.05, 1.8, false]],
  [[0.55, -0.35, 0.9, true], [0, 0.1, 1.2, false], [0.55, 0.45, 0.9, true]],
  [[0.3, -0.2, 0.8, true], [0.75, 0.1, 0.8, true], [0.3, 0.4, 0.8, true]],
  [[0.65, -0.45, 1.0, true], [0.65, 0.05, 1.0, true], [0.65, 0.5, 1.0, true]],
  [[0.35, 0.1, 1.4, true]],
  [[0, -0.25, 1.0, false], [0.6, 0.2, 1.0, true]],
];

const THEMES: { pools: boolean; spikes: number }[] = [
  { pools: false, spikes: 1 },
  { pools: true, spikes: 0 },
  { pools: false, spikes: 2 },
  { pools: true, spikes: 1 },
  { pools: true, spikes: 2 },
];

const ENEMY_SLOTS: [number, number][] = [
  [0, -0.55], [-0.55, -0.4], [0.55, -0.4], [-0.3, -0.75], [0.3, -0.75],
  [-0.75, -0.1], [0.75, -0.1], [0, -0.2], [-0.45, 0.05], [0.45, 0.05],
];

/** The arena of chapter c, stage s (layout.go StageLayout). */
export function stageLayout(c: number, s: number): Layout {
  const h = hash(0x5a17, c, s);
  let t = h % TEMPLATES.length;
  if (s % 10 === 0) t = 0;
  const th = THEMES[(((c - 1) % THEMES.length) + THEMES.length) % THEMES.length];
  const l: Layout = { chapter: c, stage: s, template: t, obstacles: [], slots: [] };
  let k = 0;
  for (const [ox, oz, r, mirror] of TEMPLATES[t]) {
    const xs = mirror && ox !== 0 ? [-ox, ox] : [ox];
    const kind = th.pools && k % 2 === 1 ? POOL : PILLAR;
    k++;
    for (const x of xs) l.obstacles.push({ kind, x: x * HALF_X, z: oz * HALF_Z, r, h: 0, phase: 0 });
  }
  if (s % 10 !== 0) {
    for (let i = 0; i < th.spikes; i++) {
      const hz = hash(0x5b1e, c, s, i);
      let z = (-0.3 + 0.55 * unit(hz)) * HALF_Z;
      if (i === 1) z = -z * 0.7;
      l.obstacles.push({ kind: SPIKES, x: 0, z: roundGo(z * 10) / 10, r: HALF_X * 0.55, h: 0.7, phase: i * 1.5 });
    }
  }
  for (const [fx, fz] of ENEMY_SLOTS) {
    const x = fx * HALF_X;
    const z = fz * HALF_Z;
    if (blocked(l, x, z, 1.2)) continue;
    l.slots.push([x, z]);
  }
  return l;
}

function blocked(l: Layout, x: number, z: number, m: number): boolean {
  for (const o of l.obstacles) {
    const dx = x - o.x;
    const dz = z - o.z;
    if (o.kind !== SPIKES && Math.sqrt(dx * dx + dz * dz) < o.r + m) return true;
  }
  return false;
}

export const solid = (o: Obstacle): boolean => o.kind === PILLAR || o.kind === POOL;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Push a body at arena-local (x, z) out of the walls and solid obstacles (layout.go Collide). */
export function collide(l: Layout, x: number, z: number): [number, number] {
  const r = PLAYER_R;
  for (let pass = 0; pass < 2; pass++) {
    for (const o of l.obstacles) {
      if (!solid(o)) continue;
      const dx = x - o.x;
      const dz = z - o.z;
      const d2 = dx * dx + dz * dz;
      const m = o.r + r;
      if (d2 >= m * m) continue;
      if (d2 === 0) {
        x = o.x + m;
        continue;
      }
      const d = Math.sqrt(d2);
      const k = m / d;
      x = o.x + dx * k;
      z = o.z + dz * k;
    }
    x = clamp(x, -HALF_X + r, HALF_X - r);
    z = clamp(z, -HALF_Z + r, HALF_Z - r);
  }
  return [x, z];
}

/** Go's math.Mod (the sign of x). */
export const modGo = (x: number, y: number): number => x % y;

/** A spike strip t seconds into the room: raised, or glowing before it rises (layout.go SpikesUp). */
export function spikesUp(o: Obstacle, t: number): { up: boolean; warn: boolean } {
  let c = modGo(t + o.phase, 3.2);
  if (c < 0) c += 3.2;
  return { up: c >= 2.2, warn: c >= 1.2 && c < 2.2 };
}
