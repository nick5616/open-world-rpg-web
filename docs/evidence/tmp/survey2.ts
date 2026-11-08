import { readFileSync } from 'node:fs';
import { loadWorldgenGround } from '../../../client/src/sim/worldgenGround';
import { slopeAt } from '../../../client/src/sim/movement';
const g = await loadWorldgenGround(readFileSync('worldgen/pkg/worldgen.wasm'), 20261108n);
const TW2 = 1.4202766254612063;
const [cx, cz, R] = process.argv.slice(2).map(Number);
const res: any[] = [];
for (let z = cz - R; z < cz + R; z += 5) for (let x = cx - R; x < cx + R; x += 5) {
  const s = slopeAt(g, x, z);
  if (s.t2 < 2.4) continue; // > 57 deg
  // march down to the base, then up to the top along the gradient
  let bx = x, bz = z, n = 0;
  for (; n < 400; n++) { const q = slopeAt(g, bx, bz); if (q.t2 <= TW2) break; const t = Math.sqrt(q.t2); bx -= (q.gx / t) * 0.25; bz -= (q.gz / t) * 0.25; }
  if (n >= 400) continue;
  let tx = bx, tz = bz, minT2 = 1e9, steps = 0, flat = 0;
  // step up from base
  { const q = slopeAt(g, bx, bz); const t = Math.sqrt(Math.max(q.t2, 1e-9)); tx += (q.gx / t) * 0.5; tz += (q.gz / t) * 0.5; }
  for (; steps < 600; steps++) {
    const q = slopeAt(g, tx, tz);
    if (q.t2 <= TW2) { // top? check it stays walkable for 3 m
      let ok = true; let px = tx, pz = tz; const t0 = Math.sqrt(Math.max(q.t2, 1e-9));
      for (let k = 1; k <= 6; k++) { if (slopeAt(g, px + (q.gx / t0) * 0.5 * k, pz + (q.gz / t0) * 0.5 * k).t2 > TW2) ok = false; }
      if (ok) break; flat++;
    }
    minT2 = Math.min(minT2, q.t2);
    const t = Math.sqrt(q.t2); tx += (q.gx / t) * 0.25; tz += (q.gz / t) * 0.25;
  }
  const rise = g.heightAt(tx, tz) - g.heightAt(bx, bz);
  if (steps >= 600 || flat > 0) continue;
  const minDeg = (Math.atan(Math.sqrt(minT2)) * 180) / Math.PI;
  const wet = g.waterAt(bx, bz) > g.heightAt(bx, bz);
  if (rise >= 7 && rise <= 15 && minDeg >= 51 && !wet) res.push({ base: [bx, bz], top: [tx, tz], rise, minDeg, d: Math.hypot(bx - cx, bz - cz) });
}
res.sort((a, b) => a.d - b.d);
const seen: any[] = [];
for (const r of res) { if (seen.some((s) => Math.hypot(s.base[0] - r.base[0], s.base[1] - r.base[1]) < 30)) continue; seen.push(r); }
for (const r of seen.slice(0, 15)) console.log('base', r.base.map((v: number) => v.toFixed(2)).join(','), 'top', r.top.map((v: number) => v.toFixed(2)).join(','), 'rise', r.rise.toFixed(1), 'min', r.minDeg.toFixed(1), 'd', r.d.toFixed(0), 'hb', g.heightAt(r.base[0], r.base[1]).toFixed(1));
