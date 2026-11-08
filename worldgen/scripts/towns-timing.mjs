// WP20 evidence: how long a full v1 world's settlements, roads and
// structures take to generate (spec 5 budget: under 60 s at mint), in the
// wasm on Node (same module the zone runs via wazero and browsers run in
// workers). Worlds: the official world (seed 20261108), the five golden
// worlds (incl. both schema extremes) and a few more seeds. Each towns_build
// runs on a fresh instance so nothing is cached.
//   node worldgen/scripts/towns-timing.mjs [out.txt]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = fs.readFileSync(path.join(here, '..', 'pkg', 'worldgen.wasm'));
const golden = JSON.parse(fs.readFileSync(path.join(here, '..', 'golden', 'golden.json'), 'utf8'));
const mod = await WebAssembly.compile(wasm);

async function instance() {
  return (await WebAssembly.instantiate(mod, {})).exports;
}
const enc = new TextEncoder();
const dec = new TextDecoder();

function put(e, bytes) {
  const p = e.alloc(bytes.length);
  new Uint8Array(e.memory.buffer, p, bytes.length).set(bytes);
  return p;
}

async function specFromSeed(seed) {
  const e = await instance();
  const s = BigInt(seed);
  const p = e.spec_from_seed(Number(s & 0xffffffffn) | 0, Number(s >> 32n) | 0);
  return JSON.parse(dec.decode(new Uint8Array(e.memory.buffer, p, e.result_len()).slice()));
}

async function run(label, spec) {
  const e = await instance();
  const s = BigInt(spec.seed);
  const json = enc.encode(JSON.stringify(spec));
  const sp = put(e, json);
  const t0 = performance.now();
  const ap = e.atlas_build(sp, json.length, Number(s & 0xffffffffn) | 0, Number(s >> 32n) | 0);
  const alen = e.result_len();
  const t1 = performance.now();
  if (!ap) throw new Error(`${label}: atlas_build failed`);
  const tp = e.towns_build(ap);
  const t2 = performance.now();
  const n = e.result_len();
  if (!tp) throw new Error(`${label}: towns_build failed`);
  const b = new Uint8Array(e.memory.buffer, tp, n).slice();
  const dv = new DataView(b.buffer);
  const count = (id) => dv.getUint32(64 + id * 16 + 4, true);
  const hash = BigInt.asUintN(64, e.hash_buffer(tp, n)).toString(16).padStart(16, '0');
  return {
    label,
    seed: spec.seed,
    atlasMs: t1 - t0,
    townsMs: t2 - t1,
    bytes: n,
    hash,
    settlements: count(0),
    buildings: count(1),
    boxes: count(2),
    props: count(3),
    npcs: count(4),
    roads: count(5),
    bridges: count(7),
    signs: count(8),
    structures: count(9),
    pieces: count(10),
    alen,
  };
}

const worlds = [{ label: 'official', spec: await specFromSeed('20261108') }, ...golden.worlds.map((w) => ({ label: w.label, spec: w.spec }))];
for (const seed of ['42', '2026', '31337', '777']) worlds.push({ label: `seed-${seed}`, spec: await specFromSeed(seed) });
const lines = [
  `# WP20 generation timing: settlements, roads, buildings, structures and NPCs of a full v1 world (towns_build), wasm on Node ${process.version}, ${new Date().toISOString()}`,
  `# budget (spec 5): all settlements, roads and structure placements for a v1 world in under 60 s at mint`,
  '',
  'world            seed        atlas ms  towns ms   bytes   sett  bldg  boxes  props  npcs  roads  bridges  signs  structs  pieces  hash',
];
let worst = 0;
for (const w of worlds) {
  const r = await run(w.label, w.spec);
  worst = Math.max(worst, r.townsMs);
  lines.push(
    `${r.label.padEnd(16)} ${String(r.seed).padEnd(10)} ${r.atlasMs.toFixed(0).padStart(8)} ${r.townsMs.toFixed(0).padStart(9)} ${String(r.bytes).padStart(7)} ${String(r.settlements).padStart(6)} ${String(r.buildings).padStart(5)} ${String(r.boxes).padStart(6)} ${String(r.props).padStart(6)} ${String(r.npcs).padStart(5)} ${String(r.roads).padStart(6)} ${String(r.bridges).padStart(8)} ${String(r.signs).padStart(6)} ${String(r.structures).padStart(8)} ${String(r.pieces).padStart(7)}  ${r.hash}`,
  );
}
lines.push('', `worst towns_build ${worst.toFixed(0)} ms (atlas + towns together stay well under the 60 s mint budget): ${worst < 60000 ? 'PASS' : 'FAIL'}`);
const out = process.argv[2];
if (out) fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(lines.join('\n'));
