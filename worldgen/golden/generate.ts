// Regenerate worldgen/golden/golden.json from the current worldgen.wasm:
//   npm run golden:update   (only when genVersion changes; spec 5 rule 6)
// The table pins (seed, spec, genVersion, chunk) -> hash for >= 200 chunks
// spanning every biome, water, sites and several LODs, plus atlas hashes and
// collision heights. Run by vite-node so it can import the TS loader.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { WorldSpec } from '@lodestone/contracts';
import { BIOMES, fnv1a64, hex64, loadWorldgen, type AtlasData } from '../js/src/index';
import { f64Bits, type GoldenChunk, type GoldenFile, type GoldenWorld } from '../js/src/golden';
import { generateCaves } from '../js/src/caveGolden';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, '..', 'pkg', 'worldgen.wasm');
const wg = await loadWorldgen(fs.readFileSync(wasmPath));

/** Deterministic pseudo-random order for picking chunks: hash of the key. */
const rank = (key: string) => fnv1a64(new TextEncoder().encode(key));

function presets(): { label: string; spec: WorldSpec }[] {
  const out: { label: string; spec: WorldSpec }[] = [];
  for (const seed of ['7', '1234', '99']) out.push({ label: `seed-${seed}`, spec: wg.specFromSeed(seed) });
  // Extremes of the schema ranges the seed path never reaches.
  const hi = wg.specFromSeed('2026');
  Object.assign(hi, { name: 'Golden Highmarch', landFraction: 0.9, mountainHeight: 1, roughness: 1, plateaus: 1, riverDensity: 1, seaLevel: 1, temperatureBias: 0.6, moistureBias: -0.6, settlementDensity: 1, structureDensity: 1, enemyDensity: 1, caveDensity: 1 });
  out.push({ label: 'extreme-high', spec: hi });
  const lo = wg.specFromSeed('31337');
  Object.assign(lo, { name: 'Golden Archipelago', landFraction: 0.3, mountainHeight: 0, roughness: 0, plateaus: 0, riverDensity: 0, seaLevel: 0, temperatureBias: -0.2, moistureBias: 0.8, settlementDensity: 0, structureDensity: 0, enemyDensity: 0, caveDensity: 0 });
  lo.biomeWeights = { ...lo.biomeWeights, badlands: 0 };
  out.push({ label: 'extreme-low', spec: lo });
  return out;
}

function pickChunks(a: AtlasData): GoldenChunk[] {
  const n = a.gridN;
  const node = (cx: number, cz: number) => {
    const i = Math.min(n - 1, Math.round((cx * 64 + 32) / a.macroRes));
    const j = Math.min(n - 1, Math.round((cz * 64 + 32) / a.macroRes));
    return j * n + i;
  };
  const all: { cx: number; cz: number; r: bigint }[] = [];
  for (let cz = 0; cz < 64; cz++) for (let cx = 0; cx < 64; cx++) all.push({ cx, cz, r: rank(`${a.seed}:${cx},${cz}`) });
  all.sort((p, q) => (p.r < q.r ? -1 : p.r > q.r ? 1 : 0));
  const picked = new Map<string, GoldenChunk>();
  const add = (cx: number, cz: number, lod: number, tag: string) => {
    const k = `${cx},${cz},${lod}`;
    if (!picked.has(k)) picked.set(k, { cx, cz, lod, tag, hash: '' });
  };
  const take = (tag: string, count: number, pred: (k: number) => boolean) => {
    let c = 0;
    for (const ch of all) {
      if (c >= count) break;
      if (pred(node(ch.cx, ch.cz)) && !picked.has(`${ch.cx},${ch.cz},0`)) {
        add(ch.cx, ch.cz, 0, tag);
        c++;
      }
    }
  };
  const flags = (k: number) => a.nodeParams[k * 4 + 3];
  BIOMES.forEach((b, bi) => take(`biome:${b}`, 6, (k) => (flags(k) & 1) === 0 && a.biome[k] === bi));
  take('lake', 2, (k) => (flags(k) & 2) !== 0);
  take('river', 3, (k) => (flags(k) & 4) !== 0);
  take('sea', 1, (k) => (flags(k) & 1) !== 0);
  let coast = 0;
  for (const ch of all) {
    if (coast >= 2) break;
    const k = node(ch.cx, ch.cz);
    const k2 = node(Math.min(63, ch.cx + 1), ch.cz);
    if ((flags(k) & 1) !== (flags(k2) & 1)) {
      add(ch.cx, ch.cz, 0, 'coast');
      coast++;
    }
  }
  const siteChunk = (want: (s: AtlasData['sites'][number]) => boolean, tag: string, count: number) => {
    let c = 0;
    for (const s of a.sites) {
      if (c >= count) break;
      if (want(s)) {
        add(Math.floor(s.x / 64), Math.floor(s.z / 64), 0, tag);
        c++;
      }
    }
  };
  siteChunk((s) => s.category === 'settlement', 'settlement', 3);
  siteChunk((s) => s.category === 'structure', 'structure', 3);
  siteChunk((s) => s.kind === 'tower', 'tower', 2);
  siteChunk((s) => s.kind === 'cave_mouth', 'cave_mouth', 2);
  siteChunk((s) => s.kind === 'enemy_camp', 'enemy_camp', 1);
  add(16, 16, 1, 'lod1');
  add(40, 22, 1, 'lod1');
  add(8, 48, 2, 'lod2');
  add(32, 32, 2, 'lod2');
  add(24, 8, 3, 'lod3');
  add(0, 0, 6, 'lod6-world');
  add(-2, 5, 0, 'outside');
  add(64, 10, 0, 'outside');
  return [...picked.values()];
}

const worlds: GoldenWorld[] = [];
for (const { label, spec } of presets()) {
  const atlas = wg.buildAtlas(spec);
  const bytes = atlas.bytes();
  const data = atlas.data;
  const chunks = pickChunks(data);
  for (const c of chunks) c.hash = hex64(wg.hash(wg.buildChunkBytes(atlas, c.cx, c.cz, c.lod)));
  const collision: GoldenWorld['collision'] = [];
  for (let i = 0; i < 64; i++) {
    const r = rank(`${label}:col:${i}`);
    // Quarter-meter grid plus odd fractions, so both triangles of a cell are hit.
    const x = Number(r & 0xfffffn) / 0x100000 * 4096;
    const z = Number((r >> 20n) & 0xfffffn) / 0x100000 * 4096;
    const xq = Math.round(x * 1024) / 1024;
    const zq = Math.round(z * 1024) / 1024;
    collision.push({ x: xq, z: zq, h: f64Bits(wg.collisionHeight(atlas, xq, zq)) });
  }
  worlds.push({
    label,
    seed: spec.seed,
    spec,
    atlas: { hash: hex64(atlas.hash), bytes: bytes.length, gzipBytes: zlib.gzipSync(bytes, { level: 9 }).length },
    chunks,
    collision,
    // WP09: cave cells across depth bands, graph, masks, collision vectors.
    caves: generateCaves(wg, atlas),
  });
  const cv = worlds.at(-1)!.caves!;
  console.log(`  caves: ${cv.graph.systems} systems, ${cv.cells.length} cells (${[...new Set(cv.cells.map((c) => c.tag))].join(" ")}), ${cv.floors.length} floors, ${cv.collide.length} collide, ${cv.masks.length} masks`);
  const biomes = BIOMES.map((b) => `${b}:${chunks.filter((c) => c.tag === `biome:${b}`).length}`).join(' ');
  console.log(`${label}: atlas ${bytes.length} B (gzip ${worlds.at(-1)!.atlas.gzipBytes} B), ${chunks.length} chunks [${biomes}]`);
  atlas.free();
}

const golden: GoldenFile = { hashAlgo: 'fnv1a64', genVersion: wg.genVersion, abiVersion: wg.abiVersion, worlds };
// One chunk / collision point per line keeps diffs readable.
const json = JSON.stringify(golden, null, 1)
  .replace(/\{\n\s+"cx": (-?\d+),\n\s+"cz": (-?\d+),\n\s+"lod": (\d+),\n\s+"tag": ("[^"]*"),\n\s+"hash": ("[0-9a-f]+")\n\s+\}/g, '{"cx":$1,"cz":$2,"lod":$3,"tag":$4,"hash":$5}')
  .replace(/\{\n\s+"x": ([-\d.e]+),\n\s+"z": ([-\d.e]+),\n\s+"h": ("[0-9a-f]+")\n\s+\}/g, '{"x":$1,"z":$2,"h":$3}')
  // WP09 cave entries: any object of plain values (cells, floors, masks...) on one line.
  .replace(/\{\n\s+"(?:cx|x|veinId)": (?:"[^"\n]*"|-?[\d.e+-]+),\n(?:\s+"[A-Za-z]+": (?:"[^"\n]*"|-?[\d.e+-]+),?\n)+\s+\}/g, (m) => m.replace(/\n\s*/g, '').replace(/": /g, '":'));
fs.writeFileSync(path.join(here, 'golden.json'), json + '\n');
const total = worlds.reduce((n, w) => n + w.chunks.length, 0);
console.log(`wrote golden.json: ${worlds.length} worlds, ${total} chunks, genVersion ${wg.genVersion}`);
