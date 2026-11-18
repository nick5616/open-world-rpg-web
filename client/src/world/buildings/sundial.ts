// The sundial (playtest 5, CR 054: "add a sundial style clock"). The maths,
// pure and tested; the stone and its shadow are sundialMesh.ts, the little
// dial on the HUD is hud/SundialClock.tsx.
//
// The world's sun is `sunDirection(timeOfDayS)` (scene/SkyAndSun.ts): it
// rises in +x at 06:00, is highest at 12:00 tilted a little toward +z, and
// sets in -x at 18:00. A vertical gnomon of height h on a level plate casts
// its shadow along -(sun.x, sun.z) with length h * |(sun.x, sun.z)| / sun.y.
// The dial reads the shadow's DIRECTION: the plate angle `phi` runs from PI
// (06:00, the shadow points west) over PI/2 (noon, north) to 0 (18:00, east),
// measured from +x toward north (-z). The hour marks are carved at the angle
// the shadow really has at that hour, so what the stone shows is what the
// sun does, whatever tilt the sky has. At night nothing is readable.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const DIAL_R = 0.95;
export const GNOMON_H = 0.7;
/** The first and last hours carved. */
export const DIAL_FROM = 6;
export const DIAL_TO = 18;
/** Below this sun height (sin of elevation) the shadow is not drawn: dawn, dusk and the night. */
export const SUN_MIN_Y = 0.045;

export interface Shadow {
  /** The sun is high enough to cast a readable shadow. */
  lit: boolean;
  /** Direction of the shadow on the plate (unit, world x and z). */
  dx: number;
  dz: number;
  /** Plate angle: PI at dawn .. PI/2 noon .. 0 dusk (0 when not lit). */
  phi: number;
  /** Length of the shadow (m), clamped to the plate's radius. */
  len: number;
  /** The tip of the unclamped shadow (m): where the hour could also be read from. */
  rawLen: number;
}

/** The gnomon's shadow for a sun direction. */
export function shadowOf(sun: Vec3, h = GNOMON_H, maxLen = DIAL_R): Shadow {
  const hx = Math.hypot(sun.x, sun.z);
  if (sun.y < SUN_MIN_Y || hx < 1e-6) return { lit: false, dx: 0, dz: -1, phi: 0, len: 0, rawLen: 0 };
  const dx = -sun.x / hx;
  const dz = -sun.z / hx;
  const raw = (h * hx) / sun.y;
  return { lit: true, dx, dz, phi: Math.atan2(-dz, dx), len: Math.min(maxLen, raw), rawLen: raw };
}

/** Sun direction at `hour` (0-24), through the renderer's own function. */
export type SunAt = (hour: number) => Vec3;

/** The carved hour marks: hour and plate angle, 06:00 .. 18:00. */
export function hourMarks(sunAt: SunAt): { hour: number; phi: number }[] {
  const out: { hour: number; phi: number }[] = [];
  for (let h = DIAL_FROM; h <= DIAL_TO; h++) {
    const s = shadowOf(sunAt(h));
    out.push({ hour: h, phi: s.lit ? s.phi : Math.PI * (1 - (h - DIAL_FROM) / (DIAL_TO - DIAL_FROM)) });
  }
  return out;
}

/** Read the hour off a shadow's plate angle against the marks (linear between neighbours); null when it is off the dial. */
export function readHour(phi: number, marks: { hour: number; phi: number }[]): number | null {
  for (let i = 0; i + 1 < marks.length; i++) {
    const a = marks[i];
    const b = marks[i + 1];
    // phi decreases with the hour
    if (phi <= a.phi + 1e-9 && phi >= b.phi - 1e-9) return a.hour + ((a.phi - phi) / (a.phi - b.phi || 1)) * (b.hour - a.hour);
  }
  return null;
}

/** The HUD dial: where a sun or moon glyph sits on the half-arc (0 = left end, 1 = right end) at an hour, and whether it is the sun. Day 06:00-18:00 is the upper arc, night wraps over a dim one. */
export function arcAt(hour: number): { t: number; sun: boolean } {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 6 && h < 18) return { t: (h - 6) / 12, sun: true };
  const n = h >= 18 ? h - 18 : h + 6; // 0..12 across the night
  return { t: n / 12, sun: false };
}

/** A 12-hour clock string for a world hour: "6:30 am". */
export function clockText(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const hh = Math.floor(h);
  let mm = Math.floor((h - hh) * 60);
  mm = Math.min(59, mm);
  const ap = hh < 12 ? 'am' : 'pm';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

/** An oriented box of the towns buffer (boxes.f layout: x, z, cos, sin, half x, half z). */
export interface FlatBox {
  x: number;
  z: number;
  c: number;
  s: number;
  hx: number;
  hz: number;
}

/** Does a disc of radius r at (x, z) overlap the oriented box (with a margin)? */
export function discHitsBox(x: number, z: number, r: number, b: FlatBox, margin = 0): boolean {
  const dx = x - b.x;
  const dz = z - b.z;
  const u = dx * b.c + dz * b.s;
  const v = dz * b.c - dx * b.s;
  const qx = Math.max(0, Math.abs(u) - b.hx);
  const qz = Math.max(0, Math.abs(v) - b.hz);
  return Math.hypot(qx, qz) < r + margin;
}

/** The spot for a settlement's sundial: the first free place on rings around the square, in a hash order (so each town's differs). `free(x, z, r)` says the disc is clear of walls, props and roads' middles. */
export function sundialSpot(cx: number, cz: number, seed: number, free: (x: number, z: number, r: number) => boolean): { x: number; z: number; yaw: number } {
  const start = seed % 12;
  for (const ring of [5.5, 7.5, 9.5, 12]) {
    for (let k = 0; k < 12; k++) {
      const a = (((start + k * 5) % 12) / 12) * Math.PI * 2;
      const x = cx + Math.cos(a) * ring;
      const z = cz + Math.sin(a) * ring;
      if (free(x, z, 1.7)) return { x, z, yaw: a };
    }
  }
  return { x: cx + 5.5, z: cz, yaw: 0 };
}
