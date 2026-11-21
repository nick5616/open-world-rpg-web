// Rift runs (CR 040): every bullet's path from its volley's few numbers,
// the TS twin of server/zone/internal/rift/patterns.go. The zone sends a
// volley once (Event 2002); both sides compute where each shot is at any
// moment, so nothing per bullet ever crosses the wire. Seekers are the one
// stepped kind (30 Hz toward a player): the client steps them toward that
// player as it sees them (a few cm off the zone at most; the zone decides
// hits).

import { HALF_X, HALF_Z, PILLAR, hash, mix, unit, type Layout } from './layout';

export const KIND_RING = 1;
export const KIND_SPIRAL = 2;
export const KIND_FAN = 3;
export const KIND_WALL = 4;
export const KIND_BOUNCE = 5;
export const KIND_LASER = 6;
export const KIND_SEEKER = 7;
export const KIND_RAIN = 8;
export const TICK_HZ = 30;

export interface Volley {
  id: number;
  kind: number;
  /** Tick the bullets leave (the telegraph runs windup ms before). */
  fire: number;
  windup: number;
  ox: number;
  oz: number;
  angle: number;
  count: number;
  speed: number;
  radius: number;
  p1: number;
  p2: number;
  p3: number;
  seed: number;
  life: number;
  src: number;
  /** Lazily filled: per bullet, when it hits a pillar or leaves the room. */
  dead?: number[];
}

/** Event 2002 data (game/rift.go encodeVolley). */
export function decodeVolley(id: number, d: Uint8Array): Volley | null {
  if (d.length < 36) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    id,
    kind: d[0],
    fire: v.getUint32(1, true),
    windup: v.getUint16(5, true),
    ox: v.getInt16(7, true) / 100,
    oz: v.getInt16(9, true) / 100,
    angle: (v.getUint16(11, true) * 2 * Math.PI) / 65536,
    count: d[13],
    speed: v.getUint16(14, true) / 100,
    radius: d[16] / 100,
    p1: v.getInt32(17, true),
    p2: v.getInt32(21, true),
    p3: v.getInt32(25, true),
    seed: v.getUint32(29, true),
    life: v.getUint16(33, true) / 1000,
    src: d.length >= 39 ? v.getUint32(35, true) : 0,
  };
}

/** How many bullets (0 for a laser). */
export function bullets(v: Volley): number {
  if (v.kind === KIND_FAN) return v.count * Math.max(1, v.p2);
  if (v.kind === KIND_LASER) return 0;
  return v.count;
}

function born(v: Volley, i: number): [number, number] {
  switch (v.kind) {
    case KIND_RING:
    case KIND_BOUNCE:
    case KIND_SEEKER:
      return [0, v.angle + (2 * Math.PI * i) / Math.max(1, v.count)];
    case KIND_SPIRAL: {
      const arms = Math.max(1, v.p3);
      const j = Math.trunc(i / arms);
      const arm = i % arms;
      return [(j * v.p1) / 1000, v.angle + (j * v.p2 * Math.PI) / 180000 + (2 * Math.PI * arm) / arms];
    }
    case KIND_FAN: {
      const n = Math.max(1, v.count);
      const w = Math.trunc(i / n);
      const k = i % n;
      const spread = ((v.p1 / 10) * Math.PI) / 180;
      const off = n > 1 ? spread * (k / (n - 1) - 0.5) : 0;
      return [(w * v.p3) / 1000, v.angle + off];
    }
  }
  return [0, v.angle];
}

function wallSkip(v: Volley, i: number): boolean {
  return v.p2 >= 0 && v.p2 < v.count && (i === v.p2 || i === v.p2 + 1);
}

function start(v: Volley, i: number): [number, number] {
  if (v.kind === KIND_WALL) {
    const off = ((i - (v.count - 1) / 2) * v.p1) / 100;
    return [v.ox - Math.sin(v.angle) * off, v.oz + Math.cos(v.angle) * off];
  }
  return [v.ox, v.oz];
}

/** Reflect an unbounded coordinate into [-L, L]; n = walls touched (patterns.go fold). */
export function fold(u: number, L: number): [number, number] {
  const p = u + L;
  const w = 2 * L;
  const k = Math.floor(p / w);
  const r = p - k * w;
  const n = Math.abs(k);
  if (k % 2 !== 0) return [L - r, n];
  return [r - L, n];
}

function rayCircle(x0: number, z0: number, dx: number, dz: number, cx: number, cz: number, r: number): number | null {
  const fx = x0 - cx;
  const fz = z0 - cz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const bb = fx * dx + fz * dz;
  const disc = bb * bb - c;
  if (bb > 0 || disc < 0) return null;
  return -bb - Math.sqrt(disc);
}

function deathTime(v: Volley, i: number, l: Layout): number {
  const [b, a] = born(v, i);
  const [x0, z0] = start(v, i);
  if (v.kind === KIND_BOUNCE) {
    for (let k = 0; ; k++) {
      const t = b + k / TICK_HZ;
      if (t > v.life) return v.life + 1;
      const d = (t - b) * v.speed;
      const ux = x0 + Math.cos(a) * d;
      const uz = z0 + Math.sin(a) * d;
      const [fx, nx] = fold(ux, HALF_X - v.radius);
      const [fz, nz] = fold(uz, HALF_Z - v.radius);
      if (nx + nz > v.p1) return t;
      for (const o of l.obstacles) {
        if (o.kind === PILLAR && (fx - o.x) * (fx - o.x) + (fz - o.z) * (fz - o.z) < (o.r + v.radius) * (o.r + v.radius)) return t;
      }
    }
  }
  const dx = Math.cos(a);
  const dz = Math.sin(a);
  let end = Infinity;
  if (dx > 1e-9) end = Math.min(end, (HALF_X + v.radius - x0) / dx);
  else if (dx < -1e-9) end = Math.min(end, (-HALF_X - v.radius - x0) / dx);
  if (dz > 1e-9) end = Math.min(end, (HALF_Z + v.radius - z0) / dz);
  else if (dz < -1e-9) end = Math.min(end, (-HALF_Z - v.radius - z0) / dz);
  for (const o of l.obstacles) {
    if (o.kind !== PILLAR) continue;
    const s = rayCircle(x0, z0, dx, dz, o.x, o.z, o.r + v.radius);
    if (s !== null && s < end) end = s;
  }
  if (!Number.isFinite(end) || v.speed <= 0) return v.life + 1;
  return b + Math.max(0, end) / v.speed;
}

/**
 * Bullet i at t seconds after the volley fired: where it is (arena-local x,
 * z) or null when it is not flying (not born yet, stopped, a wall's gap).
 */
export function bulletPos(v: Volley, i: number, t: number, l: Layout, out: [number, number] = [0, 0]): [number, number] | null {
  const [b, a] = born(v, i);
  if (t < b || t > v.life || v.kind === KIND_LASER || v.kind === KIND_RAIN || (v.kind === KIND_WALL && wallSkip(v, i))) return null;
  if (!v.dead) v.dead = new Array<number>(bullets(v)).fill(-1);
  if (i < v.dead.length && v.dead[i] < 0) v.dead[i] = deathTime(v, i, l);
  if (i < v.dead.length && t >= v.dead[i]) return null;
  const [x0, z0] = start(v, i);
  const d = (t - b) * v.speed;
  let ux = x0 + Math.cos(a) * d;
  let uz = z0 + Math.sin(a) * d;
  if (v.kind === KIND_BOUNCE) {
    ux = fold(ux, HALF_X - v.radius)[0];
    uz = fold(uz, HALF_Z - v.radius)[0];
  }
  out[0] = ux;
  out[1] = uz;
  return out;
}

/** A laser at t: its yaw, length (to the first pillar or wall) and whether it is live. */
export function laserAt(v: Volley, t: number, l: Layout): { a: number; length: number; live: boolean } {
  const a = v.angle + ((v.p3 * Math.PI) / 180000) * Math.max(0, t);
  const dx = Math.cos(a);
  const dz = Math.sin(a);
  let length = 60;
  if (dx > 1e-9) length = Math.min(length, (HALF_X - v.ox) / dx);
  else if (dx < -1e-9) length = Math.min(length, (-HALF_X - v.ox) / dx);
  if (dz > 1e-9) length = Math.min(length, (HALF_Z - v.oz) / dz);
  else if (dz < -1e-9) length = Math.min(length, (-HALF_Z - v.oz) / dz);
  for (const o of l.obstacles) {
    if (o.kind !== PILLAR) continue;
    const s = rayCircle(v.ox, v.oz, dx, dz, o.x, o.z, o.r);
    if (s !== null && s < length) length = s;
  }
  return { a, length, live: t >= 0 && t <= v.p2 / 1000 };
}

/** Rain impact i: centre, radius, when it lands (s after fire). */
export function rainAt(v: Volley, i: number): { x: number; z: number; r: number; land: number } {
  const h = hash(v.seed, i);
  return { x: (unit(h) * 2 - 1) * (HALF_X - 1), z: (unit(mix(h)) * 2 - 1) * (HALF_Z - 1), r: v.p2 / 100, land: (i * v.p3) / 1000 };
}

export interface Seeker {
  x: number;
  z: number;
  a: number;
  dead: boolean;
}

/** A seeker volley's orbs as they leave. */
export function seekers(v: Volley): Seeker[] {
  const out: Seeker[] = [];
  for (let i = 0; i < v.count; i++) {
    const a = born(v, i)[1];
    out.push({ x: v.ox + Math.cos(a) * 0.6, z: v.oz + Math.sin(a) * 0.6, a, dead: false });
  }
  return out;
}

/** One 30 Hz step of an orb toward (tx, tz) (patterns.go SeekerStep). */
export function seekerStep(v: Volley, s: Seeker, tx: number, tz: number, l: Layout): void {
  if (s.dead) return;
  const want = Math.atan2(tz - s.z, tx - s.x);
  let d = ((want - s.a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const maxTurn = (v.p1 * Math.PI) / 180 / TICK_HZ;
  if (d > maxTurn) d = maxTurn;
  else if (d < -maxTurn) d = -maxTurn;
  s.a += d;
  s.x += (Math.cos(s.a) * v.speed) / TICK_HZ;
  s.z += (Math.sin(s.a) * v.speed) / TICK_HZ;
  if (Math.abs(s.x) > HALF_X || Math.abs(s.z) > HALF_Z) s.dead = true;
  for (const o of l.obstacles) if (o.kind === PILLAR && Math.hypot(s.x - o.x, s.z - o.z) < o.r + v.radius) s.dead = true;
}

/** The last second after fire anything of the volley can still hit. */
export function ends(v: Volley): number {
  if (v.kind === KIND_LASER) return v.p2 / 1000;
  if (v.kind === KIND_RAIN) return (Math.max(0, v.count - 1) * v.p3) / 1000 + 0.3;
  return v.life;
}
