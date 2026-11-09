// Building doors on the movement ground (playtest follow-up to WP20). Wraps
// the town ground: a closed door is pushed out of after the town's push-out
// (worldgen/js doors.ts, bit-identical to the zone's server/pkg/towns
// doors.go). Which doors are closed depends on the movement step being
// simulated (sim/stepClock.ts): the zone stamps every open/close with the
// input seq it applies from, so prediction and replays see each door
// exactly as the zone did for that frame. With every door open (the
// default) the wrapper hands out the town ground's own level views, so
// nothing changes for WP20's walks and goldens.

import type { DoorStates, TownCollideResult, TownDoors } from '@lodestone/worldgen';
import type { CollideResult, GroundQuery } from '../../sim/ground';
import { stepClock } from '../../sim/stepClock';

class DoorLevel implements GroundQuery {
  private readonly tmp: TownCollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };

  constructor(
    readonly lv: GroundQuery,
    readonly doors: TownDoors,
    readonly closed: (d: number) => boolean,
  ) {}

  heightAt(x: number, z: number): number {
    return this.lv.heightAt(x, z);
  }
  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.lv.normalAt ? this.lv.normalAt(x, z) : { x: 0, y: 1, z: 0 };
  }
  waterAt(x: number, z: number): number {
    return this.lv.waterAt ? this.lv.waterAt(x, z) : -Infinity;
  }
  collide(x: number, y: number, z: number, out: CollideResult): CollideResult {
    const r = this.lv.collide!(x, y, z, this.tmp);
    return this.doors.after(r, this.closed, out);
  }
}

export class DoorGround implements GroundQuery {
  /** Closed at the step being simulated (stepClock.seq). */
  readonly closed = (d: number): boolean => !this.states.openAt(d, stepClock.seq);

  constructor(
    readonly inner: GroundQuery,
    readonly doors: TownDoors,
    readonly states: DoorStates,
  ) {
    // Only grounds with walls collide (movement takes "has collide" as "has walls").
    if (!inner.collide) (this as { collide?: unknown }).collide = undefined;
  }

  heightAt(x: number, z: number): number {
    return this.inner.heightAt(x, z);
  }
  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.inner.normalAt ? this.inner.normalAt(x, z) : { x: 0, y: 1, z: 0 };
  }
  waterAt(x: number, z: number): number {
    return this.inner.waterAt ? this.inner.waterAt(x, z) : -Infinity;
  }
  /** The step's view at feet height y: the town ground's, plus closed doors when any door is not open. */
  atLevel(y: number): GroundQuery {
    const lv = this.inner.atLevel ? this.inner.atLevel(y) : this.inner;
    if (this.states.active === 0 || !lv.collide) return lv;
    return new DoorLevel(lv, this.doors, this.closed);
  }
  collide(x: number, y: number, z: number, out: CollideResult): CollideResult {
    return this.atLevel(y).collide!(x, y, z, out);
  }
  /** Ground under feet at height y (spawns, NPC/prop placement): the town ground's. */
  floorAt(x: number, y: number, z: number): number {
    const f = (this.inner as { floorAt?: (x: number, y: number, z: number) => number }).floorAt;
    return f ? f.call(this.inner, x, y, z) : this.inner.heightAt(x, z);
  }
  caveAir(x: number, y: number, z: number): boolean {
    return this.inner.caveAir?.(x, y, z) ?? false;
  }
}
