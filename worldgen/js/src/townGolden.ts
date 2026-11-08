// Towns part of the golden table (WP20): the towns buffer hash and counts,
// the "every region has a settlement" rule, and building collision vectors
// (TownCollision.floorAt / collide around real boxes). Shared by Node
// (vitest) and the Chromium worker through runGolden; the Go/wazero host
// checks the buffer hash (worldgen/harness/go) and the Go port of the
// queries replays the vectors (server/pkg/towns TestGoldenTownQueries).
import { fnv1a64, hex64 } from './format';
import type { AtlasHandle, Worldgen } from './index';
import { parseTowns, TownCollision, townsBytes, type Towns } from './town';

export interface GoldenTowns {
  hash: string;
  bytes: number;
  counts: Record<string, number>;
  /** f64 bits of TownCollision.floorAt(x, y, z) (fff0000000000000 = -Infinity: no floor). */
  floors: { x: number; y: number; z: number; h: string }[];
  /** "xbits,ybits,zbits,pushXbits,pushZbits,ceiling" of TownCollision.collide(x, y, z). */
  collide: { x: number; y: number; z: number; out: string }[];
}

interface Counters {
  failures: string[];
  townQueries: number;
  townMs: number[];
}

function bits(v: number): string {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, v, true);
  return hex64(d.getBigUint64(0, true));
}

/** Quarter-millimetre grid so coordinates survive JSON in every host exactly. */
const q = (v: number) => Math.round(v * 4096) / 4096;

export function townCounts(t: Towns): Record<string, number> {
  return {
    settlements: t.settlements.length,
    buildings: t.buildings.length,
    boxes: t.boxes.count,
    props: t.props.length,
    npcs: t.npcs.length,
    roads: t.roads.length,
    bridges: t.bridges.length,
    signs: t.signs.length,
    structures: t.structures.length,
    pieces: t.pieces.length,
    veins: t.veins.length,
  };
}

/** Regions (0..15) without a settlement; spec 5: every region gets one. */
export function regionsWithoutSettlement(t: Towns): number[] {
  const have = new Set(t.settlements.map((s) => s.region));
  return [...Array(16).keys()].filter((r) => !have.has(r));
}

export function collideString(c: TownCollision, x: number, y: number, z: number): string {
  const o = c.collideNew(x, y, z);
  return `${bits(o.x)},${bits(o.y)},${bits(o.z)},${bits(o.pushX)},${bits(o.pushZ)},${o.ceiling ? 1 : 0}`;
}

export function generateTowns(wg: Worldgen, atlas: AtlasHandle, label: string): GoldenTowns {
  const b = townsBytes(wg, atlas);
  const t = parseTowns(b);
  const col = new TownCollision(t.boxes);
  const floors: GoldenTowns['floors'] = [];
  const collide: GoldenTowns['collide'] = [];
  const rank = (k: string) => fnv1a64(new TextEncoder().encode(`${label}:${k}`));
  const u = (k: string) => Number(rank(k) & 0xffffffn) / 0x1000000;
  // ~70 boxes per world spread over every kind, 5 points each, at heights
  // that hit floors, steps, walls, ceilings and roofs.
  const n = t.boxes.count;
  const picks: number[] = [];
  for (let k = 0; picks.length < Math.min(70, n) && k < 4000; k++) {
    const i = Math.floor(u(`box:${k}`) * n);
    if (!picks.includes(i)) picks.push(i);
  }
  const f = t.boxes.f;
  for (const i of picks) {
    const o = i * 9;
    const [cx, cz, c, s, hx, hz, y0, y1, y2] = [f[o], f[o + 1], f[o + 2], f[o + 3], f[o + 4], f[o + 5], f[o + 6], f[o + 7], f[o + 8]];
    const top = Math.max(y1, y2);
    const ys = [top - 0.3, top + 0.2, top - 1.0, Math.max(y0, top - 4) + 0.5, (y1 + y2) * 0.5 - 0.59];
    for (let k = 0; k < 5; k++) {
      const a = (u(`p:${i}:${k}:u`) * 2 - 1) * (hx + 0.8);
      const bb = (u(`p:${i}:${k}:v`) * 2 - 1) * (hz + 0.8);
      const x = q(cx + a * c - bb * s);
      const z = q(cz + a * s + bb * c);
      const y = q(ys[k]);
      floors.push({ x, y, z, h: bits(col.floorAt(x, y, z)) });
      collide.push({ x, y, z, out: collideString(col, x, y, z) });
    }
  }
  return { hash: hex64(wg.hash(b)), bytes: b.length, counts: townCounts(t), floors, collide };
}

export function checkTowns(wg: Worldgen, atlas: AtlasHandle, label: string, g: GoldenTowns, now: () => number, r: Counters): void {
  const t0 = now();
  const b = townsBytes(wg, atlas);
  r.townMs.push(now() - t0);
  const h = hex64(wg.hash(b));
  if (h !== g.hash) r.failures.push(`${label}: towns ${h} != ${g.hash}`);
  if (b.length !== g.bytes) r.failures.push(`${label}: towns ${b.length} bytes != ${g.bytes}`);
  const t = parseTowns(b);
  const counts = townCounts(t);
  for (const [k, v] of Object.entries(g.counts)) if (counts[k] !== v) r.failures.push(`${label}: towns ${k} ${counts[k]} != ${v}`);
  const missing = regionsWithoutSettlement(t);
  if (missing.length) r.failures.push(`${label}: regions without a settlement: ${missing.join(',')}`);
  const col = new TownCollision(t.boxes);
  for (const p of g.floors) {
    const v = bits(col.floorAt(p.x, p.y, p.z));
    if (v !== p.h) r.failures.push(`${label}: town floor (${p.x}, ${p.y}, ${p.z}) ${v} != ${p.h}`);
    r.townQueries++;
  }
  for (const p of g.collide) {
    const v = collideString(col, p.x, p.y, p.z);
    if (v !== p.out) r.failures.push(`${label}: town collide (${p.x}, ${p.y}, ${p.z}) ${v} != ${p.out}`);
    r.townQueries++;
  }
}
