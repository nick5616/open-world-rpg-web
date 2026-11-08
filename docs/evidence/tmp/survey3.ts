import { readFileSync } from 'node:fs';
import { loadWorldgenGround } from '../../../client/src/sim/worldgenGround';
const g = await loadWorldgenGround(readFileSync('worldgen/pkg/worldgen.wasm'), 20261108n);
const [cx, cz, R] = process.argv.slice(2).map(Number);
const peaks: any[] = [];
const lakes: any[] = [];
for (let z = cz - R; z < cz + R; z += 8) for (let x = cx - R; x < cx + R; x += 8) {
  const h = g.heightAt(x, z);
  const w = g.waterAt(x, z);
  if (w - h > 2.5 && w > 27) lakes.push({ x, z, depth: w - h, w });
  let isPeak = true;
  for (let a = 0; a < 16 && isPeak; a++) for (const r of [8, 16, 32]) if (g.heightAt(x + Math.cos(a * 0.39) * r, z + Math.sin(a * 0.39) * r) > h) { isPeak = false; break; }
  if (!isPeak) continue;
  let drop = 0;
  for (let a = 0; a < 16; a++) drop = Math.max(drop, h - g.heightAt(x + Math.cos(a * 0.39) * 80, z + Math.sin(a * 0.39) * 80));
  peaks.push({ x, z, h, drop, d: Math.hypot(x - cx, z - cz) });
}
peaks.sort((a, b) => b.drop - a.drop);
console.log('peaks by 80 m drop');
for (const p of peaks.slice(0, 10)) console.log(p.x, p.z, p.h.toFixed(1), 'drop80', p.drop.toFixed(1), 'd', p.d.toFixed(0));
lakes.sort((a, b) => b.depth - a.depth);
console.log('lakes', lakes.length);
for (const l of lakes.slice(0, 10)) {
  // distance to shore (dry) along 8 dirs
  let best = 1e9;
  for (let a = 0; a < 8; a++) for (let r = 1; r < 200; r++) { const px = l.x + Math.cos((a * Math.PI) / 4) * r, pz = l.z + Math.sin((a * Math.PI) / 4) * r; if (g.waterAt(px, pz) < g.heightAt(px, pz)) { best = Math.min(best, r); break; } }
  console.log(l.x, l.z, 'depth', l.depth.toFixed(1), 'w', l.w.toFixed(1), 'shore', best);
}
