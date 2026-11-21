// CR 040: the arena on the movement ground, the TS twin of the zone's
// riftGround (server/zone/internal/game/rift.go). While you are in a rift,
// at the arena's level the ground is a flat floor with the room's walls,
// pillars and pools (layout.ts collide); everywhere else (and when you are
// not in a rift) it is the world's ground unchanged, so every movement
// golden stays bit-identical.

import type { CollideResult, GroundQuery } from '../sim/ground';
import { collide } from './layout';
import { riftRuntime, type Arena } from './store';

/** Feet heights around the floor that stand on the arena. */
export const BAND_BELOW = 30;
export const BAND_ABOVE = 200;

class RiftLevel implements GroundQuery {
  constructor(private readonly a: Arena) {}
  heightAt(): number {
    return this.a.oy;
  }
  waterAt(): number {
    return -Infinity;
  }
  normalAt() {
    return { x: 0, y: 1, z: 0 };
  }
  collide(x: number, y: number, z: number, out: CollideResult): CollideResult {
    const lx = x - this.a.ox;
    const lz = z - this.a.oz;
    const [cx, cz] = collide(this.a.layout, lx, lz);
    out.y = y;
    out.ceiling = false;
    if (cx === lx && cz === lz) {
      out.x = x;
      out.z = z;
      out.pushX = out.pushZ = 0;
      return out;
    }
    out.x = this.a.ox + cx;
    out.z = this.a.oz + cz;
    out.pushX = cx - lx;
    out.pushZ = cz - lz;
    return out;
  }
}

/** Wraps the world's ground (world/core/runtime.ts). */
export class RiftGround implements GroundQuery {
  private lv: RiftLevel | null = null;
  private lvArena: Arena | null = null;
  constructor(readonly inner: GroundQuery) {
    if (inner.normalAt) this.normalAt = (x, z) => inner.normalAt!(x, z);
    if (inner.caveAir) this.caveAir = (x, y, z) => inner.caveAir!(x, y, z);
    // Only grounds with walls collide (movement takes "has collide" as "has caves", like ChemGround).
    if (!inner.collide) (this as { collide?: unknown }).collide = undefined;
  }
  normalAt?: (x: number, z: number) => { x: number; y: number; z: number };
  caveAir?: (x: number, y: number, z: number) => boolean;
  heightAt(x: number, z: number): number {
    return this.inner.heightAt(x, z);
  }
  waterAt(x: number, z: number): number {
    return this.inner.waterAt ? this.inner.waterAt(x, z) : -Infinity;
  }
  atLevel(y: number): GroundQuery {
    const a = riftRuntime.arena;
    if (a && y > a.oy - BAND_BELOW && y < a.oy + BAND_ABOVE) {
      if (this.lvArena !== a) {
        this.lv = new RiftLevel(a);
        this.lvArena = a;
      }
      return this.lv!;
    }
    return this.inner.atLevel ? this.inner.atLevel(y) : this.inner;
  }
  collide(x: number, y: number, z: number, out: CollideResult): CollideResult {
    if (this.inner.collide) return this.inner.collide(x, y, z, out);
    out.x = x;
    out.y = y;
    out.z = z;
    out.pushX = out.pushZ = 0;
    out.ceiling = false;
    return out;
  }
}
