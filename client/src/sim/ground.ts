// Pluggable ground query. Movement only ever asks "how high is the ground
// here", so the flat placeholder below and WP05's generated chunks (backed by
// the wasm collision queries, spec 8) are interchangeable behind this one
// interface. Keep it synchronous and allocation-free: it is called at least
// twice per 1/60 s movement step, and again for every replayed step when
// prediction reconciles (WP06).

export interface GroundQuery {
  /** Ground height (feet y) at world (x, z), meters. Must be deterministic. */
  heightAt(x: number, z: number): number;
  /** Optional unit surface normal at (x, z); climbing/sliding (later) will need it. */
  normalAt?(x: number, z: number): { x: number; y: number; z: number };
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
