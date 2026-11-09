// Prints each weapon's triangle count per detail level (the README table).
//   npx vite-node src/combat/weapons/dev/tris.ts      (from client/)
import { buildWeapon, fistGeometry, forearmGeometry, weaponTriangles } from '../models';
import { WEAPON_KINDS } from '../look';

for (const w of WEAPON_KINDS) {
  const row = ([2, 1, 0] as const).map((d) => weaponTriangles(buildWeapon({ weapon: w, material: 'sunsteel', gem: 0 }, d)));
  console.log(`${w.padEnd(6)} fp ${row[0]}  tp ${row[1]}  far ${row[2]}`);
}
console.log(`fist ${fistGeometry().index!.count / 3}  forearm ${forearmGeometry().index!.count / 3}`);
