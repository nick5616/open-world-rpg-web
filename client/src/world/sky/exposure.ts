// "Shouldn't see weather effects inside a building" (playtest 5, CR 054).
// How much of the weather reaches the camera: 1 in the open, 0 inside walls
// and a roof, partly under a porch, 0 in caves and underground. It scales the
// rain streaks, snow and sand particles, the ambient leaves, the fog and haze
// the weather adds, the storm's darkening of the sky and lightning's brightness
// (a bolt through a window is dim), and it eases over about half a second so
// stepping through a door never pops.
//
// The source is the audio shelter probe (audio/shelter.ts: the same towns
// buffer boxes the movement collides with, `indoors` and `roof`), plus the
// roofs of player-built bases (CR 041 pieces from ui/camps) over your head.
// Pure functions here; WorldScene feeds them at 10 Hz and steps the ease
// every frame.

/** Seconds for a full change (0 to 1 or back). */
export const EXPOSURE_FADE_S = 0.5;
/** How much of a lightning flash comes through when fully covered. */
export const LIGHTNING_INDOORS = 0.22;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** What a shelter probe says (audio/shelter.ts ShelterProbe: roof 0..1, indoors 0..1). */
export interface Cover {
  roof: number;
  indoors: number;
}

/**
 * The exposure the surroundings ask for: 1 outdoors .. 0 closed in. A roof
 * overhead alone (a porch, a gate arch) hides most of what falls straight
 * down; closed walls hide it all; underground (0..1) takes it away entirely.
 */
export function exposureTarget(c: Cover, underground = 0, baseCover = 0): number {
  const cover = Math.max(c.indoors, c.roof * 0.9, baseCover * 0.9);
  return clamp01(1 - cover) * (1 - clamp01(underground));
}

/** One frame of the ease: move `cur` toward `target` at 1 / EXPOSURE_FADE_S per second. */
export function stepExposure(cur: number, target: number, dt: number): number {
  const d = target - cur;
  const m = Math.max(0, dt) / EXPOSURE_FADE_S;
  return Math.abs(d) <= m ? target : cur + Math.sign(d) * m;
}

/** Lightning's strength through the walls: 1 outside, LIGHTNING_INDOORS when fully covered. */
export function lightningThrough(exposure: number): number {
  return LIGHTNING_INDOORS + (1 - LIGHTNING_INDOORS) * clamp01(exposure);
}

/** A placed building piece, as far as the roof test needs. */
export interface PlacedPiece {
  x: number;
  y: number;
  z: number;
  /** The piece is a roof tile, roof cap or gable (ui/build/defs.ts). */
  roof: boolean;
}

/** Half the width of a roof tile plus a little slack (m), and the reach above the head (m). */
export const TILE_HALF_M = 1.3;
export const BASE_ROOF_REACH_M = 7;

/**
 * Cover from the roofs of player-built bases over a point (CR 041): 1 with a
 * roof tile straight above (within a tile's half width), 0.45 with one next
 * to it (within two tile widths), 0 with none within BASE_ROOF_REACH_M above the head.
 */
export function baseRoofCover(x: number, headY: number, z: number, pieces: Iterable<PlacedPiece>): number {
  let best = 0;
  for (const p of pieces) {
    if (!p.roof || p.y < headY - 0.2 || p.y > headY + BASE_ROOF_REACH_M) continue;
    const d = Math.max(Math.abs(p.x - x), Math.abs(p.z - z));
    if (d <= TILE_HALF_M) return 1;
    if (d <= TILE_HALF_M * 2.2) best = Math.max(best, 0.45);
  }
  return best;
}

/** The renderer's current exposure (debug handle, evidence scripts and other systems read it). */
export const liveExposure = { value: 1 };

/** The smoothed exposure the renderer reads every frame. */
export class WeatherExposure {
  value = 1;
  private target = 1;
  private acc = 1e9;

  /** Per frame; `probe` is called at most every 100 ms and returns the target. */
  update(dt: number, probe: () => number): number {
    this.acc += dt;
    if (this.acc >= 0.1) {
      this.acc = 0;
      this.target = probe();
    }
    this.value = stepExposure(this.value, this.target, dt);
    return this.value;
  }

  /** Jump (a teleport, a new world). */
  snap(v: number): void {
    this.value = this.target = v;
  }
}
