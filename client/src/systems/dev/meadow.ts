// Find a meadow near the atlas spawn: the spot with the most dry fuel in a
// 14-cell (28 m) disc, by the same material function the zone and clients
// burn (evidence harnesses only).

import type { WorldgenGround } from '../../sim/worldgenGround';
import { TerrainMaterial } from '../chem/material';
import { cellCenter, MAT_BRUSH, MAT_GRASS } from '../chem/sim';

export function findMeadow(terrain: WorldgenGround, seed: bigint, minR = 80): { x: number; z: number; fuel: number } {
  const d = terrain.atlas.data;
  const src = new TerrainMaterial(terrain, seed, d);
  let best = { x: d.spawn.x, z: d.spawn.z, fuel: -1 };
  for (let r = minR; r <= 600 && best.fuel < 0.62; r += 40) {
    for (let a = 0; a < 16; a++) {
      const x = d.spawn.x + r * Math.cos((a * Math.PI) / 8);
      const z = d.spawn.z + r * Math.sin((a * Math.PI) / 8);
      const cx = Math.floor(x / 2);
      const cz = Math.floor(z / 2);
      let n = 0;
      let f = 0;
      for (let dz = -14; dz <= 14; dz++)
        for (let dx = -14; dx <= 14; dx++) {
          if (dx * dx + dz * dz > 196) continue;
          n++;
          const m = src.material(cx + dx, cz + dz);
          if (m === MAT_GRASS || m === MAT_BRUSH) f++;
        }
      if (f / n > best.fuel) best = { x: cellCenter(cx), z: cellCenter(cz), fuel: f / n };
    }
  }
  return best;
}
