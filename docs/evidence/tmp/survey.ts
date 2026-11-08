import { readFileSync } from 'node:fs';
import { loadWorldgen } from '../../../worldgen/js/src/index';
const wg = await loadWorldgen(readFileSync('worldgen/pkg/worldgen.wasm'));
const atlas = wg.buildAtlas(wg.specFromSeed(20261108n));
const d = atlas.data as any;
const H = (x: number, z: number) => wg.collisionHeight(atlas, x, z);
const W = (x: number, z: number) => wg.waterHeight(atlas, x, z);
const sx = d.spawn.x ?? d.spawn[0], sz = d.spawn.z ?? d.spawn[1]; d.seaLevel = d.seaY;
console.log(Object.keys(d));
console.log('spawn', sx, sz, H(sx, sz), 'sea', d.seaLevel);
const g2 = (x: number, z: number) => { const gx = H(x + 0.5, z) - H(x - 0.5, z); const gz = H(x, z + 0.5) - H(x, z - 0.5); return gx * gx + gz * gz; };
const R = 900; const step = 4;
const cliffs: any[] = []; const lakes: any[] = []; const peaks: any[] = [];
for (let z = Math.max(4, sz - R); z < Math.min(4092, sz + R); z += step) for (let x = Math.max(4, sx - R); x < Math.min(4092, sx + R); x += step) {
  const h = H(x, z); const w = W(x, z);
  if (w - h > 3 && w > d.seaLevel + 0.5) lakes.push({ x, z, depth: w - h, w });
  const s = g2(x, z);
  const deg = Math.atan(Math.sqrt(s)) * 180 / Math.PI;
  if (deg > 58 && deg < 85 && w < h) cliffs.push({ x, z, deg, h });
  peaks.push({ x, z, h });
}
peaks.sort((a, b) => b.h - a.h);
console.log('peaks', peaks.slice(0, 5).map(p => [p.x, p.z, p.h.toFixed(1), Math.hypot(p.x - sx, p.z - sz).toFixed(0)]));
console.log('lakes', lakes.length);
lakes.sort((a, b) => Math.hypot(a.x - sx, a.z - sz) - Math.hypot(b.x - sx, b.z - sz));
console.log(lakes.slice(0, 8).map(p => [p.x, p.z, p.depth.toFixed(1), p.w.toFixed(1), Math.hypot(p.x - sx, p.z - sz).toFixed(0)]));
console.log('cliff points', cliffs.length);
const walk = (x: number, z: number, dir: number) => {
  let n = 0;
  while (n < 300) { const gx = H(x + 0.5, z) - H(x - 0.5, z), gz = H(x, z + 0.5) - H(x, z - 0.5); const t = Math.hypot(gx, gz); if (t < 1.19) break; x += dir * gx / t * 0.2; z += dir * gz / t * 0.2; n++; }
  return [x, z];
};
const tall: any[] = [];
for (const c of cliffs) {
  const top = walk(c.x, c.z, 1), base = walk(c.x, c.z, -1);
  tall.push({ ...c, rise: H(top[0], top[1]) - H(base[0], base[1]), top, base, dist: Math.hypot(c.x - sx, c.z - sz) });
}
tall.sort((a, b) => b.rise - a.rise);
const fmt = (c: any) => [c.x, c.z, c.deg.toFixed(0), 'rise', c.rise.toFixed(1), 'base', c.base.map((v: number) => v.toFixed(1)).join(','), 'top', c.top.map((v: number) => v.toFixed(1)).join(','), 'd', c.dist.toFixed(0)].join(' ');
console.log(tall.slice(0, 10).map(fmt).join('\n'));
const near = tall.filter(c => c.rise > 8).sort((a, b) => a.dist - b.dist);
console.log('near tall\n' + near.slice(0, 10).map(fmt).join('\n'));
const towers = d.sites.filter((s: any) => s.kind === 'tower').map((s: any) => [s.x, s.z, H(s.x, s.z).toFixed(0), Math.hypot(s.x - sx, s.z - sz).toFixed(0)]);
console.log('towers', JSON.stringify(towers));
