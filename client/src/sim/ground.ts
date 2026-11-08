// Pluggable ground query. Movement only ever asks "how high is the ground
// here", so the flat placeholder below and WP05's generated chunks (backed by
// the wasm collision queries, spec 8) are interchangeable behind this one
// interface. Keep it synchronous and allocation-free: it is called at least
// twice per 1/60 s movement step, and again for every replayed step when
// prediction reconciles (WP06).

export interface GroundQuery {
  /** Ground height (feet y) at world (x, z), meters. Must be deterministic. */
  heightAt(x: number, z: number): number;
  /** Optional unit surface normal at (x, z). Movement does NOT use it (slopes come from heightAt, see movement.ts slopeAt), it is for rendering/tools. */
  normalAt?(x: number, z: number): { x: number; y: number; z: number };
  /**
   * Optional water surface height at (x, z) (WP10: swimming). Must be the wasm
   * `water_height` (or `chunkWaterHeight` on the LOD 0 chunk, same bits), the
   * function the zone swims on. Absent = no water anywhere.
   */
  waterAt?(x: number, z: number): number;
  /**
   * Caves (WP09): this ground viewed at feet height y. In a cave the view's
   * heightAt is the cave floor under that level (see ./caves.ts); grounds
   * without caves omit it. Go twin: movement.LevelGround.
   */
  atLevel?(y: number): GroundQuery;
  /** Caves (WP09): push a player (feet at x, y, z) out of walls and ceilings; writes into out. Go twin: movement.Collider. */
  collide?(x: number, y: number, z: number, out: CollideResult): CollideResult;
  /**
   * Caves (WP09), not used by movement: is (x, y, z) open cave air (below the
   * surface but not inside rock)? Voice occlusion (WP11) asks it so the
   * terrain overhead doesn't muffle two people talking in a cave. Only
   * already-loaded cave cells answer (no synchronous builds); unknown is false.
   */
  caveAir?(x: number, y: number, z: number): boolean;
}

/** Result of GroundQuery.collide: pushed feet position, horizontal push, ceiling hit. */
export interface CollideResult {
  x: number;
  y: number;
  z: number;
  pushX: number;
  pushZ: number;
  ceiling: boolean;
}

/** Infinite flat plane at a fixed height: the WP02 placeholder world. */
export class FlatGround implements GroundQuery {
  constructor(readonly height = 0) {}
  heightAt(): number {
    return this.height;
  }
  normalAt() {
    return { x: 0, y: 1, z: 0 };
  }
}

/**
 * Tilted plane h = base + sx * x + sz * z. Not used in the game; it exists so
 * the golden trajectory (and its Go replay) exercises ground snapping on a
 * slope with a ground function trivial to reproduce in another language.
 */
export class PlaneGround implements GroundQuery {
  constructor(readonly base: number, readonly sx: number, readonly sz: number) {}
  heightAt(x: number, z: number): number {
    return this.base + this.sx * x + this.sz * z;
  }
  normalAt() {
    const len = Math.sqrt(this.sx * this.sx + 1 + this.sz * this.sz);
    return { x: -this.sx / len, y: 1 / len, z: -this.sz / len };
  }
}
