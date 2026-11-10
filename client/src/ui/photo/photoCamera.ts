// Playtest 2 photo mode's free camera (pure: photo.test.ts). It flies from
// where the view was, within PHOTO.radius of your character (a sphere
// around the eye), never under the terrain or the water surface (a margin
// above both; in a cave, where the terrain's top is overhead, only the
// radius holds, smaller), with mouse look and an optional roll.

export interface PhotoGround {
  heightAt(x: number, z: number): number;
  waterAt?(x: number, z: number): number;
}

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const PHOTO = {
  /** Metres from the eye the camera may fly. */
  radius: 30,
  /** In a cave. */
  caveRadius: 8,
  /** Above the ground and water. */
  clearance: 0.4,
  speed: 6,
  fast: 16,
  slow: 1.5,
  /** rad per pixel (the game's look). */
  sensitivity: 0.002,
} as const;

/** Is the anchor (the eye) under the terrain's top surface: a cave. */
export function underground(anchor: V3, g: PhotoGround): boolean {
  return anchor.y < g.heightAt(anchor.x, anchor.z) - 2;
}

/**
 * Keep p within `radius` of anchor and above the ground and water (in place).
 * Returns true when it moved p.
 */
export function clampPhotoPos(p: V3, anchor: V3, g: PhotoGround, radius: number = PHOTO.radius, clearance: number = PHOTO.clearance): boolean {
  let moved = false;
  const cave = underground(anchor, g);
  const r = cave ? Math.min(radius, PHOTO.caveRadius) : radius;
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const dz = p.z - anchor.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > r) {
    const k = r / d;
    p.x = anchor.x + dx * k;
    p.y = anchor.y + dy * k;
    p.z = anchor.z + dz * k;
    moved = true;
  }
  if (!cave) {
    let floor = g.heightAt(p.x, p.z) + clearance;
    const w = g.waterAt ? g.waterAt(p.x, p.z) : -Infinity;
    if (Number.isFinite(w)) floor = Math.max(floor, w + clearance * 0.5);
    if (p.y < floor) {
      p.y = floor;
      moved = true;
    }
  }
  return moved;
}

export interface FlyInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  fast: boolean;
  slow: boolean;
}

export class PhotoCam {
  readonly pos: V3 = { x: 0, y: 0, z: 0 };
  readonly anchor: V3 = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  roll = 0;

  reset(pos: V3, yaw: number, pitch: number, anchor: V3): void {
    this.pos.x = pos.x;
    this.pos.y = pos.y;
    this.pos.z = pos.z;
    this.anchor.x = anchor.x;
    this.anchor.y = anchor.y;
    this.anchor.z = anchor.z;
    this.yaw = yaw;
    this.pitch = pitch;
    this.roll = 0;
  }

  /** Mouse look (pixels). */
  look(dx: number, dy: number): void {
    this.yaw -= dx * PHOTO.sensitivity;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * PHOTO.sensitivity));
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
  }

  /** Fly dt seconds (along the view, the camera convention: yaw 0 looks down -Z), then clamp. */
  step(dt: number, inp: FlyInput, g: PhotoGround): void {
    const sp = inp.fast ? PHOTO.fast : inp.slow ? PHOTO.slow : PHOTO.speed;
    const cp = Math.cos(this.pitch);
    const fx = -Math.sin(this.yaw) * cp;
    const fy = Math.sin(this.pitch);
    const fz = -Math.cos(this.yaw) * cp;
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const f = (inp.forward ? 1 : 0) - (inp.back ? 1 : 0);
    const r = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    const u = (inp.up ? 1 : 0) - (inp.down ? 1 : 0);
    const s = sp * Math.min(dt, 0.1);
    this.pos.x += (fx * f + rx * r) * s;
    this.pos.y += (fy * f + u) * s;
    this.pos.z += (fz * f + rz * r) * s;
    clampPhotoPos(this.pos, this.anchor, g);
  }
}

/** A file name for a shot: lodestone-2026-11-10-21-04-33.png. */
export function shotName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `lodestone-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.png`;
}

/** March the view ray over the terrain for the auto focus (m; `max` when it hits nothing). */
export function focusDistance(from: V3, yaw: number, pitch: number, g: PhotoGround, max = 150): number {
  const cp = Math.cos(pitch);
  const fx = -Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = -Math.cos(yaw) * cp;
  let t = 0.5;
  while (t < max) {
    const x = from.x + fx * t;
    const y = from.y + fy * t;
    const z = from.z + fz * t;
    if (y <= g.heightAt(x, z)) return t;
    t += t < 20 ? 0.5 : t * 0.04;
  }
  return max;
}
