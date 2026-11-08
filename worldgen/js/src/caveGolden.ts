// Cave part of the golden table (WP09): picking, checking and benchmarking
// cave cells, the cave graph, mouth masks and the cave collision vectors.
// Shared by Node (vitest) and the Chromium worker through runGolden; the Go
// host checks the same entries in worldgen/harness/go (hashes) and
// server/pkg/caves (collision vectors, with the Go port of the queries).
import { CaveGroundCore, caveCellBytes, caveCellKey, caveCellValid, caveGraphBytes, caveMaskBytes, caveSystemAt, parseCaveGraph, wasmCellSource, type CaveGraph } from './cave';
import { hex64 } from './format';
import type { AtlasHandle, Worldgen } from './index';

export interface GoldenCaveCell {
  cx: number;
  cy: number;
  cz: number;
  tag: string;
  hash: string;
}

export interface GoldenCaves {
  graph: { hash: string; bytes: number; systems: number };
  cells: GoldenCaveCell[];
  edited: { cx: number; cy: number; cz: number; edits: { veinId: string; x: number; y: number; z: number; r: number }[]; hash: string }[];
  masks: { cx: number; cz: number; hash: string }[];
  /** f64 bits of CaveGroundCore.floorAt(x, y, z). */
  floors: { x: number; y: number; z: number; h: string }[];
  /** "xbits,ybits,zbits,ceiling" of CaveGroundCore.collide(x, y, z). */
  collide: { x: number; y: number; z: number; out: string }[];
  systemAt: { x: number; y: number; z: number; s: number }[];
}

interface Counters {
  failures: string[];
  caveCells: number;
  caveQueries: number;
  caveMs: number[];
}

function bits(v: number): string {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, v, true);
  return hex64(d.getBigUint64(0, true));
}

/** Quarter-millimeter grid so coordinates survive JSON in every host exactly. */
const q = (v: number) => Math.round(v * 4096) / 4096;

export function checkCaves(wg: Worldgen, atlas: AtlasHandle, label: string, g: GoldenCaves, now: () => number, r: Counters): void {
  const gb = caveGraphBytes(wg, atlas);
  const gh = hex64(wg.hash(gb));
  if (gh !== g.graph.hash) r.failures.push(`${label}: cave graph ${gh} != ${g.graph.hash}`);
  for (const c of g.cells) {
    const t0 = now();
    const b = caveCellBytes(wg, atlas, c.cx, c.cy, c.cz);
    r.caveMs.push(now() - t0);
    const h = hex64(wg.hash(b));
    if (h !== c.hash) r.failures.push(`${label}: cave (${c.cx},${c.cy},${c.cz}) ${c.tag} ${h} != ${c.hash}`);
    r.caveCells++;
  }
  for (const e of g.edited) {
    const edits = e.edits.map((x) => ({ veinId: BigInt(x.veinId), x: x.x, y: x.y, z: x.z, r: x.r }));
    const h = hex64(wg.hash(caveCellBytes(wg, atlas, e.cx, e.cy, e.cz, edits)));
    if (h !== e.hash) r.failures.push(`${label}: edited cave (${e.cx},${e.cy},${e.cz}) ${h} != ${e.hash}`);
    r.caveCells++;
  }
  for (const m of g.masks) {
    const h = hex64(wg.hash(caveMaskBytes(wg, atlas, m.cx, m.cz)));
    if (h !== m.hash) r.failures.push(`${label}: cave mask (${m.cx},${m.cz}) ${h} != ${m.hash}`);
  }
  const graph = parseCaveGraph(gb);
  const ground = new CaveGroundCore((x, z) => wg.collisionHeight(atlas, x, z), graph.openings, wasmCellSource(wg, atlas));
  for (const f of g.floors) {
    const h = bits(ground.floorAt(f.x, f.y, f.z));
    if (h !== f.h) r.failures.push(`${label}: cave floor (${f.x}, ${f.y}, ${f.z}) ${h} != ${f.h}`);
    r.caveQueries++;
  }
  for (const c of g.collide) {
    const o = ground.collideNew(c.x, c.y, c.z);
    const s = `${bits(o.x)},${bits(o.y)},${bits(o.z)},${o.ceiling ? 1 : 0}`;
    if (s !== c.out) r.failures.push(`${label}: cave collide (${c.x}, ${c.y}, ${c.z}) ${s} != ${c.out}`);
    r.caveQueries++;
  }
  for (const p of g.systemAt) {
    const s = caveSystemAt(graph, p.x, p.y, p.z);
    if (s !== p.s) r.failures.push(`${label}: cave system at (${p.x}, ${p.y}, ${p.z}) ${s} != ${p.s}`);
    r.caveQueries++;
  }
}

/** Build the cave entries of one golden world (used by worldgen/golden/generate.ts). */
export function generateCaves(wg: Worldgen, atlas: AtlasHandle): GoldenCaves {
  const gb = caveGraphBytes(wg, atlas);
  const graph = parseCaveGraph(gb);
  const cells = new Map<string, GoldenCaveCell>();
  const add = (cx: number, cy: number, cz: number, tag: string) => {
    const k = `${cx},${cy},${cz}`;
    if (caveCellValid(cx, cy, cz) && !cells.has(k)) cells.set(k, { cx, cy, cz, tag, hash: '' });
  };
  const cellOf = (x: number, y: number, z: number): [number, number, number] => [Math.floor(x / 64), Math.floor(y / 32), Math.floor(z / 64)];
  const systems = graph.systems.slice(0, 5);
  for (const s of systems) {
    for (let k = 0; k < s.openingCount; k++) {
      const o = graph.openings[s.firstOpening + k];
      const [cx, cy, cz] = cellOf(o.x, o.y, o.z);
      add(cx, cy, cz, o.kind);
      add(cx, cy - 1, cz, `${o.kind}-below`);
    }
    for (let k = 0; k < s.chamberCount; k++) {
      const c = graph.chambers[s.firstChamber + k];
      const [cx, cy, cz] = cellOf(c.x, c.floor + 1, c.z);
      add(cx, cy, cz, k === s.deepest ? 'deepest' : `band:${['shallow', 'mid', 'deep'][c.band]}`);
    }
  }
  add(0, -8, 0, 'empty');
  add(63, 23, 63, 'empty');
  const outCells = [...cells.values()];
  for (const c of outCells) c.hash = hex64(wg.hash(caveCellBytes(wg, atlas, c.cx, c.cy, c.cz)));

  const edited: GoldenCaves['edited'] = [];
  for (const s of systems.slice(0, 2)) {
    const v = graph.veins[s.firstVein];
    if (!v) continue;
    const [cx, cy, cz] = cellOf(v.x, v.y, v.z);
    const edits = [{ veinId: v.id.toString(), x: v.x, y: v.y, z: v.z, r: 1.5 }];
    const hash = hex64(wg.hash(caveCellBytes(wg, atlas, cx, cy, cz, [{ veinId: v.id, x: v.x, y: v.y, z: v.z, r: 1.5 }])));
    edited.push({ cx, cy, cz, edits, hash });
  }

  const masks = graph.openings.slice(0, 6).map((o) => {
    const cx = Math.floor(o.x / 64);
    const cz = Math.floor(o.z / 64);
    return { cx, cz, hash: hex64(wg.hash(caveMaskBytes(wg, atlas, cx, cz))) };
  });

  const ground = new CaveGroundCore((x, z) => wg.collisionHeight(atlas, x, z), graph.openings, wasmCellSource(wg, atlas));
  const floors: GoldenCaves['floors'] = [];
  const collide: GoldenCaves['collide'] = [];
  const systemAt: GoldenCaves['systemAt'] = [];
  for (const s of systems.slice(0, 3)) {
    const o = graph.openings[s.firstOpening];
    for (const [dx, dz] of [[0, 0], [1.3, -0.7], [-2.1, 1.9]]) {
      const x = q(o.x + dx), z = q(o.z + dz), y = q(wg.collisionHeight(atlas, x, z) + 0.4);
      floors.push({ x, y, z, h: bits(ground.floorAt(x, y, z)) });
    }
    for (let k = 0; k < s.chamberCount; k++) {
      const c = graph.chambers[s.firstChamber + k];
      for (let a = 0; a < 4; a++) {
        const ang = a * 1.7 + k;
        const x = q(c.x + Math.cos(ang) * c.rx * 0.4), z = q(c.z + Math.sin(ang) * c.rx * 0.4), y = q(c.floor + 0.9);
        floors.push({ x, y, z, h: bits(ground.floorAt(x, y, z)) });
        // Near the wall: these push.
        const wx = q(c.x + Math.cos(ang) * (c.rx - 0.3)), wz = q(c.z + Math.sin(ang) * (c.rx - 0.3)), wy = q(c.floor + 0.05);
        const r = ground.collideNew(wx, wy, wz);
        collide.push({ x: wx, y: wy, z: wz, out: `${bits(r.x)},${bits(r.y)},${bits(r.z)},${r.ceiling ? 1 : 0}` });
      }
      systemAt.push({ x: q(c.x), y: q(c.floor + 1), z: q(c.z), s: caveSystemAt(graph, q(c.x), q(c.floor + 1), q(c.z)) });
    }
    systemAt.push({ x: q(o.x), y: q(o.y + 40), z: q(o.z), s: caveSystemAt(graph, q(o.x), q(o.y + 40), q(o.z)) });
  }
  return {
    graph: { hash: hex64(wg.hash(gb)), bytes: gb.length, systems: graph.systems.length },
    cells: outCells,
    edited,
    masks,
    floors,
    collide,
    systemAt,
  };
}

/** Cave cell budget benchmark (spec 5: <= 12 ms per cell in a worker): every cell around the first systems' chambers. */
export function benchmarkCaves(wg: Worldgen, atlas: AtlasHandle, now: () => number): { graphMs: number; cells: number; withMesh: number; ms: number[] } {
  const t0 = now();
  const graph: CaveGraph = parseCaveGraph(caveGraphBytes(wg, atlas));
  const graphMs = now() - t0;
  const ms: number[] = [];
  let withMesh = 0;
  const seen = new Set<number>();
  for (const s of graph.systems.slice(0, 6)) {
    for (let k = 0; k < s.chamberCount; k++) {
      const c = graph.chambers[s.firstChamber + k];
      for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [-1, 0, 0], [0, -1, 0]]) {
        const cx = Math.floor(c.x / 64) + dx, cy = Math.floor(c.y / 32) + dy, cz = Math.floor(c.z / 64) + dz;
        const key = caveCellKey(cx, cy, cz);
        if (!caveCellValid(cx, cy, cz) || seen.has(key)) continue;
        seen.add(key);
        const t1 = now();
        const b = caveCellBytes(wg, atlas, cx, cy, cz);
        ms.push(now() - t1);
        if (new DataView(b.buffer).getUint32(32, true) > 0) withMesh++;
      }
    }
  }
  return { graphMs, cells: ms.length, withMesh, ms };
}
