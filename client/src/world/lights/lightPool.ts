// Which light sources get one of the pooled point lights (CR 042).
//
// three.js compiles every lit material for the number of lights in the scene,
// so lights are never added or removed in play (a light count change would
// recompile the world: a hitch and a flash). A fixed pool is created with the
// world, all at intensity 0; each frame the sources that matter most take the
// slots and the rest keep only their emissive glow (a sprite halo).
//
// Priority: your own lights first, then the nearest to the camera, nothing
// beyond `MAX_REACH_M`. Pure, so the choice is tested.

export interface LightSource {
  /** Stable identity (`self:torch`, `12:familiar`): a slot that changes owner fades in again. */
  key: string;
  x: number;
  y: number;
  z: number;
  color: string;
  /** Candela and reach (m) at full strength. */
  intensity: number;
  range: number;
  /** 0 = your own (always first), 1 = another player's. */
  priority: number;
  /** Squared distance to the camera, filled by `rank`. */
  d2: number;
  /** Decorrelates this source's flicker. */
  seed: number;
  /** A torch (flickers like a flame) or a magical light (breathes). */
  flame: boolean;
}

/** Beyond this a light reaches nothing the camera sees: not worth a slot. */
export const MAX_REACH_M = 48;

/** Pool size by shader tier (stores/qualityStore.ts maxLights: low 3, medium 6, high and ultra 10). */
export function poolSizeFor(maxLights: number): number {
  return maxLights >= 10 ? 4 : maxLights >= 6 ? 3 : 2;
}

/**
 * Fills `out` (cleared first) with the `n` sources that take the pooled lights,
 * best first, and returns it. `all` is not modified.
 */
export function rank(all: readonly LightSource[], n: number, camX: number, camY: number, camZ: number, out: LightSource[] = []): LightSource[] {
  out.length = 0;
  for (const s of all) {
    s.d2 = (s.x - camX) ** 2 + (s.y - camY) ** 2 + (s.z - camZ) ** 2;
    if (s.priority > 0 && s.d2 > MAX_REACH_M * MAX_REACH_M) continue;
    out.push(s);
  }
  out.sort((a, b) => a.priority - b.priority || a.d2 - b.d2);
  if (out.length > n) out.length = n;
  return out;
}
