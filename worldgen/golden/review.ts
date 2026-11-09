// Review a generator change before `npm run golden:update` (spec 5: an
// output change is a new genVersion; regenerate the table only after
// checking the diff is the intended one):
//
//   npx vite-node worldgen/golden/review.ts [old.wasm] [old-table.json]
//
// Defaults: the newest archived build and its table vs worldgen/pkg/worldgen.wasm.
// For every golden world it compares the site tables (kept / moved / added /
// removed), and for every golden chunk the terrain heights (max |dh|), with
// the chunk tagged by what is near it (walled town, other settlement, none),
// so an unintended terrain change outside settlements stands out. Every
// chunk hash differs anyway (the chunk header carries genVersion).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorldgen, type AtlasData } from '../js/src/index';
import type { GoldenFile } from '../js/src/golden';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'archive', 'manifest.json'), 'utf8')) as { versions: { genVersion: number; file: string; golden: string }[] };
const last = manifest.versions[manifest.versions.length - 1];
const oldWasm = process.argv[2] ?? path.join(here, '..', 'archive', last.file);
const oldTable = process.argv[3] ?? path.join(here, last.golden);
const golden = JSON.parse(fs.readFileSync(oldTable, 'utf8')) as GoldenFile;
const A = await loadWorldgen(fs.readFileSync(oldWasm));
const B = await loadWorldgen(fs.readFileSync(path.join(here, '..', 'pkg', 'worldgen.wasm')));
console.log(`# golden review: genVersion ${A.genVersion} (${path.basename(oldWasm)}) -> ${B.genVersion} (worldgen/pkg/worldgen.wasm), table ${path.basename(oldTable)}`);

const near = (d: AtlasData, x: number, z: number) => {
  let tag = 'open';
  for (const s of d.sites) {
    if (s.category !== 'settlement') continue;
    const r = Math.hypot(s.x - x, s.z - z);
    if (r < s.radius + 140) {
      if (s.size === 2) return 'walled-town';
      tag = 'settlement';
    }
  }
  return tag;
};
let totalChanged = 0;
for (const w of golden.worlds) {
  const a = A.buildAtlas(w.spec);
  const b = B.buildAtlas(w.spec);
  const da = a.data;
  const db = b.data;
  const key = (s: AtlasData['sites'][number]) => `${s.category}:${s.kind}:${s.x}:${s.z}`;
  const kb = new Set(db.sites.map(key));
  const ka = new Set(da.sites.map(key));
  const kept = da.sites.filter((s) => kb.has(key(s))).length;
  const sameIndex = da.sites.filter((s, i) => db.sites[i] && key(db.sites[i]) === key(s) && db.sites[i].id === s.id).length;
  const added = db.sites.filter((s) => !ka.has(key(s)));
  const byKind = new Map<string, number>();
  for (const s of added) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  console.log(`\n## ${w.label}: sites ${da.sites.length} -> ${db.sites.length}; ${kept} kept (${sameIndex} at the same index with the same id), ${da.sites.length - kept} gone, ${added.length} added (${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')})`);
  console.log(`   spawn (${da.spawn.x}, ${da.spawn.z}) -> (${db.spawn.x}, ${db.spawn.z}); coverage ${(da.params[19] * 100).toFixed(2)}% -> ${(db.params[19] * 100).toFixed(2)}%`);
  const rows = new Map<string, { n: number; changed: number; max: number }>();
  for (const c of w.chunks) {
    if (c.cx < 0 || c.cz < 0 || c.cx > 63 || c.cz > 63) continue;
    const ca = A.buildChunk(a, c.cx, c.cz, c.lod);
    const cb = B.buildChunk(b, c.cx, c.cz, c.lod);
    let m = 0;
    for (let i = 0; i < ca.heights.length; i++) m = Math.max(m, Math.abs(ca.heights[i] - cb.heights[i]));
    const span = 64 * 2 ** c.lod;
    const tag = c.lod > 0 ? `lod>0` : near(db, c.cx * 64 + span / 2, c.cz * 64 + span / 2);
    const r = rows.get(tag) ?? { n: 0, changed: 0, max: 0 };
    r.n++;
    if (m > 0) r.changed++;
    r.max = Math.max(r.max, m);
    rows.set(tag, r);
  }
  for (const [tag, r] of rows) {
    console.log(`   chunks near ${tag.padEnd(12)} ${String(r.n).padStart(3)}: heights changed in ${r.changed}, max |dh| ${r.max.toFixed(3)} m`);
    if (tag === 'open' || tag === 'walled-town') totalChanged += r.changed;
  }
  a.free();
  b.free();
}
console.log(`\nchunks away from hamlets/villages (or at walled towns) whose heights changed: ${totalChanged} (intended: 0)`);
