// CR 056: the zone ended an enemy shot against a wall, rock or the ground
// (Event 1990 at the impact). The client draws the shot on its own clock
// (interpolation delay, no collision with walls), so the event tells it which
// drawn shot that was: the enemy shot nearest to the impact, within `maxM`.

export interface ShotLike {
  on: boolean;
  local: boolean;
  collide: 'none' | 'enemies' | 'players';
  /** Where the shot is drawn now. */
  x: number;
  y: number;
  z: number;
}

/** Index of the drawn enemy shot nearest to (x, y, z) within maxM, or -1. */
export function shotAtWall(shots: readonly ShotLike[], x: number, y: number, z: number, maxM = 12): number {
  let best = -1;
  let bd = maxM;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (!s.on || s.local || s.collide !== 'players') continue;
    const d = Math.hypot(s.x - x, s.y - y, s.z - z);
    if (d <= bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}
