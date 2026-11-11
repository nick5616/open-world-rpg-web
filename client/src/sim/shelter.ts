// Dry discs (playtest 2 co-op): the crystal towers' walls stay dry to climb
// in any weather. In rain a climber goes at half speed and slips every 3 s,
// so the wheel ran out 10 m short of a tower's ledge and a main story step
// waited out a 13-minute storm. The crystal hums the rain off its stone (the
// rain still falls; wind and snow still apply). Same as Go
// server/pkg/weather/shelter.go (Sheltered): the zone applies the same discs.

import type { MoveField, MoveWeather } from './movement';

export interface Disc {
  x: number;
  z: number;
  r: number;
}

/** How far past a tower's footprint the stone stays dry (Go TowerShelterPad). */
export const TOWER_SHELTER_PAD = 2;

let discs: readonly Disc[] = [];

/** The towers of the world being played (set with the map world). */
export function setTowerShelters(towers: readonly { cx: number; cz: number; maxR: number }[]): void {
  discs = towers.map((t) => ({ x: t.cx, z: t.cz, r: t.maxR + TOWER_SHELTER_PAD }));
}

export function towerShelters(): readonly Disc[] {
  return discs;
}

/** A move field with no rain inside any disc. */
export function shelteredField(f: MoveField, ds: readonly Disc[] = discs): MoveField {
  if (ds.length === 0) return f;
  return {
    moveWeatherAt(x: number, z: number): MoveWeather {
      const w = f.moveWeatherAt(x, z);
      if (!w.rain) return w;
      for (const d of ds) {
        const dx = x - d.x;
        const dz = z - d.z;
        if (dx * dx + dz * dz <= d.r * d.r) return { ...w, rain: false };
      }
      return w;
    },
  };
}
