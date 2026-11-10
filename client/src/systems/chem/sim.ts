// The chemistry engine's deterministic simulation (WP15, spec 8): the
// line-for-line TS twin of server/zone/internal/chem (sim.go, material.go,
// hash.go). Two clients and the zone run it from the same ops (Events
// 520-523) and agree cell for cell; chem.test.ts replays the Go vectors.
// Everything it decides is u32 hashing, integer cell maths and whole steps.

import {
  CHEM_CHUNK_CELLS,
  FIRE_BRUSH_BURN_STEPS,
  FIRE_BRUSH_SPREAD_PERMILLE,
  FIRE_BURN_JITTER_STEPS,
  FIRE_DAMP_SPREAD_PERMILLE,
  FIRE_GRASS_BURN_STEPS,
  FIRE_GRASS_SPREAD_PERMILLE,
  FIRE_MAX_BURNING,
  FIRE_RAIN_OUT_PERMILLE,
  FIRE_REGROW_STEPS,
  FIRE_UPDRAFT_LIFT,
  FIRE_UPDRAFT_TOP_M,
  FREEZE_STEPS,
  MATERIAL_GRID_M,
  PILLAR_STEPS,
  WORLD_SIZE_M,
} from '@lodestone/contracts';
import { seededRainAtStep, windAtStep } from '../clock';
import { CELLS_N, cellOf, Climate, isWet, NUM_STATES, stateAtStep } from '../weather/weather';

export const MAT_NONE = 0;
export const MAT_GRASS = 1;
export const MAT_BRUSH = 2;
export const MAT_DAMP = 3;
export const MAT_WATER = 4;

export const ST_NONE = 0;
export const ST_BURNING = 1;
export const ST_BURNT = 2;
export const ST_FROZEN = 3;

export const OP_EXTINGUISH = 1;
export const OP_FREEZE = 2;
export const OP_IGNITE = 3;
export const OP_PILLAR = 4;

export const GRID_N = WORLD_SIZE_M / MATERIAL_GRID_M;
export const CELL_M = MATERIAL_GRID_M;
export const CHUNK_CELLS = CHEM_CHUNK_CELLS;
export const CHUNKS_N = GRID_N / CHUNK_CELLS;

export const cellId = (ix: number, iz: number): number => iz * GRID_N + ix;
export const cellX = (id: number): number => id % GRID_N;
export const cellZ = (id: number): number => Math.floor(id / GRID_N);
export const inWorld = (ix: number, iz: number): boolean => ix >= 0 && iz >= 0 && ix < GRID_N && iz < GRID_N;
export const cellAt = (v: number): number => Math.floor(v / CELL_M);
export const cellCenter = (i: number): number => i * CELL_M + CELL_M / 2;
export const chunkOf = (id: number): number => Math.floor(cellZ(id) / CHUNK_CELLS) * CHUNKS_N + Math.floor(cellX(id) / CHUNK_CELLS);
export const flammable = (m: number): boolean => m === MAT_GRASS || m === MAT_BRUSH || m === MAT_DAMP;

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** hash4 of chem/hash.go: the world seed mixed with four u32 words. */
export function hash4(seedLo: number, seedHi: number, a: number, b: number, c: number, d: number): number {
  let h = (seedLo ^ Math.imul(seedHi, 0x9e3779b1)) >>> 0;
  h = fmix32(h ^ Math.imul(a >>> 0, 0x85ebca6b));
  h = fmix32(h ^ Math.imul(b >>> 0, 0xc2b2ae35));
  h = fmix32(h ^ Math.imul(c >>> 0, 0x27d4eb2f));
  h = fmix32(h ^ Math.imul(d >>> 0, 0x165667b1));
  return h;
}

export function seedWords(seed: bigint): [number, number] {
  const s = BigInt.asUintN(64, seed);
  return [Number(s & 0xffffffffn) >>> 0, Number(s >> 32n) >>> 0];
}

/** The seeded material of a dry cell in a biome (material.go BiomeMaterial). */
export function biomeMaterial(seed: [number, number], ix: number, iz: number, biome: number): number {
  const r = hash4(seed[0], seed[1], ix, iz, 0x6d617400, 0) % 100;
  switch (biome) {
    case 0:
      return r < 72 ? MAT_GRASS : MAT_NONE;
    case 1:
      return r < 40 ? MAT_BRUSH : r < 80 ? MAT_GRASS : MAT_NONE;
    case 2:
      return r < 50 ? MAT_GRASS : MAT_NONE;
    case 4:
      return r < 38 ? MAT_GRASS : MAT_NONE;
    case 5:
      return r < 55 ? MAT_DAMP : MAT_NONE;
  }
  return MAT_NONE;
}

/** What the simulation reads about the world (material.go Source). */
export interface ChemSource {
  material(ix: number, iz: number): number;
  height(ix: number, iz: number): number;
  water(ix: number, iz: number): number;
}

export interface Pillar {
  id: number;
  x: number;
  z: number;
  baseY: number;
  height: number;
  half: number;
  run: number;
  until: number;
}

export interface Op {
  step: number;
  kind: number;
  cell: number;
  radius: number;
  pillar?: Pillar;
}

interface Cell {
  st: number;
  until: number;
  y: number;
}

function opLess(a: Op, b: Op): boolean {
  if (a.step !== b.step) return a.step < b.step;
  if (a.kind !== b.kind) return a.kind < b.kind;
  if (a.cell !== b.cell) return a.cell < b.cell;
  return a.radius < b.radius;
}

const NEIGHBORS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const WIND_PCT = [0, 35, 65, 95];

export class ChemSim {
  step: number;
  /** Rain override (dev); null = seeded. */
  rain: boolean | null = null;
  /**
   * Playtest 2 weather (CR 030): rain where each cell is (its weather cell's
   * state); null = WP10's global rain windows (Go Sim.Weather).
   */
  weather: { climate: Climate; override: number } | null = null;
  late = 0;
  surfaceVersion = 0;
  changed = false;
  pillars: Pillar[] = [];
  readonly seedW: [number, number];
  private cells = new Map<number, Cell>();
  private active = new Set<number>();
  private timers = new Map<number, number[]>();
  private ops: Op[] = [];
  private burningN = 0;
  /** Chunks changed since the last takeDirty (renderers). */
  private dirty = new Set<number>();

  constructor(
    readonly seed: bigint,
    readonly windDeg: number,
    readonly src: ChemSource,
    step: number,
  ) {
    this.step = step;
    this.seedW = seedWords(seed);
  }

  schedule(op: Op): void {
    if (op.step <= this.step) {
      this.late++;
      op = { ...op, step: this.step + 1 };
    }
    let i = 0;
    while (i < this.ops.length && !opLess(op, this.ops[i])) i++;
    this.ops.splice(i, 0, op);
  }

  burning(): number {
    return this.burningN;
  }

  state(id: number): [number, number] {
    const c = this.cells.get(id);
    return c ? [c.st, c.until] : [ST_NONE, 0];
  }

  forEach(fn: (id: number, st: number, until: number) => void): void {
    for (const [id, c] of this.cells) fn(id, c.st, c.until);
  }

  forEachActive(fn: (id: number, st: number, y: number) => void): void {
    for (const id of this.active) {
      const c = this.cells.get(id)!;
      fn(id, c.st, c.y);
    }
  }

  advanceTo(k: number): void {
    while (this.step < k) this.stepOnce(this.step + 1);
  }

  /** Rain at step k per cell (Go rainFn): the override, the weather where the cell is, or the global windows. */
  private rainFn(k: number): (id: number) => boolean {
    if (this.rain !== null) {
      const r = this.rain;
      return () => r;
    }
    const w = this.weather;
    if (!w) {
      const r = seededRainAtStep(this.seed, k);
      return () => r;
    }
    const memo = new Int8Array(CELLS_N * CELLS_N);
    return (id: number) => {
      const [cx, cz] = cellOf(cellCenter(cellX(id)), cellCenter(cellZ(id)));
      const i = cz * CELLS_N + cx;
      if (memo[i] === 0) {
        const st = w.override >= 0 && w.override < NUM_STATES ? w.override : stateAtStep(this.seed, w.climate, cx, cz, k);
        memo[i] = isWet(st) ? 2 : 1;
      }
      return memo[i] === 2;
    };
  }

  private set(id: number, c: Cell): void {
    const old = this.cells.get(id);
    if (old && old.st === ST_BURNING) this.burningN--;
    if (c.st === ST_NONE) {
      this.cells.delete(id);
      this.active.delete(id);
    } else {
      if (c.until <= this.step) c.until = this.step + 1;
      this.cells.set(id, c);
      if (c.st === ST_BURNING) this.burningN++;
      if (c.st === ST_BURNING || c.st === ST_FROZEN) this.active.add(id);
      else this.active.delete(id);
      if (!old || old.until !== c.until) {
        const b = this.timers.get(c.until);
        if (b) b.push(id);
        else this.timers.set(c.until, [id]);
      }
    }
    if ((old?.st === ST_FROZEN) !== (c.st === ST_FROZEN)) this.surfaceVersion++;
    this.changed = true;
    this.dirty.add(chunkOf(id));
  }

  private stepOnce(k: number): void {
    this.step = k;
    this.changed = false;
    let n = 0;
    while (n < this.ops.length && this.ops[n].step <= k) this.apply(this.ops[n++], k);
    if (n) this.ops.splice(0, n);
    const due = this.timers.get(k);
    if (due) {
      this.timers.delete(k);
      for (const id of due) {
        const c = this.cells.get(id);
        if (!c || c.until !== k) continue;
        if (c.st === ST_BURNING) this.set(id, { st: ST_BURNT, until: k + FIRE_REGROW_STEPS, y: 0 });
        else this.set(id, { st: ST_NONE, until: 0, y: 0 });
      }
    }
    if (this.pillars.length) {
      const keep = this.pillars.filter((p) => p.until > k);
      if (keep.length !== this.pillars.length) this.surfaceVersion += this.pillars.length - keep.length;
      this.pillars = keep;
    }
    if (this.burningN === 0) return;
    const rain = this.rainFn(k);
    const klo = k >>> 0;
    const khi = Math.floor(k / 4294967296) >>> 0;
    const [s0, s1] = this.seedW;
    const melt: number[] = [];
    const doused: number[] = [];
    for (const id of this.active) {
      const c = this.cells.get(id)!;
      if (c.st === ST_FROZEN) {
        if (this.nearBurning(id)) melt.push(id);
      } else if (c.st === ST_BURNING) {
        if (rain(id) && hash4(s0, s1, klo, khi, id, 0x7261696e) % 1000 < FIRE_RAIN_OUT_PERMILLE) doused.push(id);
      }
    }
    for (const id of melt) this.set(id, { st: ST_NONE, until: 0, y: 0 });
    for (const id of doused) this.set(id, { st: ST_BURNT, until: k + FIRE_REGROW_STEPS, y: 0 });
    if (this.burningN === 0 || this.burningN >= FIRE_MAX_BURNING) return;
    const w = windAtStep(this.seed, this.windDeg, k);
    const catchSet = new Set<number>();
    for (const id of this.active) {
      if (this.cells.get(id)!.st !== ST_BURNING) continue;
      const ix = cellX(id);
      const iz = cellZ(id);
      for (const o of NEIGHBORS) {
        const nx = ix + o[0];
        const nz = iz + o[1];
        if (!inWorld(nx, nz)) continue;
        const nid = cellId(nx, nz);
        if (this.cells.has(nid) || catchSet.has(nid)) continue;
        const base = spreadBase(this.src.material(nx, nz));
        if (base === 0) continue;
        let mult = 100 + (o[0] * w.dx + o[1] * w.dz) * WIND_PCT[w.strength];
        mult = Math.min(400, Math.max(15, mult));
        let chance = Math.trunc((base * mult) / 100);
        if (o[0] !== 0 && o[1] !== 0) chance = Math.trunc((chance * 7) / 10);
        if (rain(id)) chance = Math.trunc(chance / 5);
        if (hash4(s0, s1, klo, khi, id, nid) % 1000 < chance) catchSet.add(nid);
      }
    }
    for (const nid of catchSet) this.ignite(nid, k);
  }

  private nearBurning(id: number): boolean {
    const ix = cellX(id);
    const iz = cellZ(id);
    for (const o of NEIGHBORS) {
      const nx = ix + o[0];
      const nz = iz + o[1];
      if (inWorld(nx, nz) && this.cells.get(cellId(nx, nz))?.st === ST_BURNING) return true;
    }
    return false;
  }

  private burnSteps(id: number, m: number): number {
    const base = m === MAT_BRUSH ? FIRE_BRUSH_BURN_STEPS : FIRE_GRASS_BURN_STEPS;
    return base + (hash4(this.seedW[0], this.seedW[1], id, 0x6275726e, 0, 0) % (FIRE_BURN_JITTER_STEPS + 1));
  }

  private ignite(id: number, k: number): void {
    const ix = cellX(id);
    const iz = cellZ(id);
    const m = this.src.material(ix, iz);
    this.set(id, { st: ST_BURNING, until: k + this.burnSteps(id, m), y: this.src.height(ix, iz) + FIRE_UPDRAFT_TOP_M });
  }

  private within(center: number, r: number, fn: (id: number, ix: number, iz: number) => void): void {
    const cx = cellX(center);
    const cz = cellZ(center);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (inWorld(x, z)) fn(cellId(x, z), x, z);
      }
    }
  }

  private apply(op: Op, k: number): void {
    switch (op.kind) {
      case OP_EXTINGUISH:
        this.within(op.cell, op.radius, (id) => {
          if (this.cells.get(id)?.st === ST_BURNING) this.set(id, { st: ST_BURNT, until: k + FIRE_REGROW_STEPS, y: 0 });
        });
        break;
      case OP_FREEZE:
        this.within(op.cell, op.radius, (id, ix, iz) => {
          const st = this.cells.get(id)?.st ?? ST_NONE;
          if (st === ST_BURNING) this.set(id, { st: ST_BURNT, until: k + FIRE_REGROW_STEPS, y: 0 });
          else if ((st === ST_NONE || st === ST_FROZEN) && this.src.material(ix, iz) === MAT_WATER) this.set(id, { st: ST_FROZEN, until: k + FREEZE_STEPS, y: this.src.water(ix, iz) });
        });
        break;
      case OP_IGNITE:
        this.within(op.cell, op.radius, (id, ix, iz) => {
          const st = this.cells.get(id)?.st ?? ST_NONE;
          if (st === ST_FROZEN) this.set(id, { st: ST_NONE, until: 0, y: 0 });
          else if (st === ST_NONE && flammable(this.src.material(ix, iz))) this.ignite(id, k);
        });
        break;
      case OP_PILLAR: {
        if (!op.pillar) break;
        const p = { ...op.pillar, until: k + PILLAR_STEPS };
        this.pillars = this.pillars.filter((q) => q.id !== p.id);
        this.pillars.push(p);
        this.surfaceVersion++;
        break;
      }
    }
  }

  /** Ice sheet height at a cell, or null. */
  sheet(id: number): number | null {
    const c = this.cells.get(id);
    return c && c.st === ST_FROZEN ? c.y : null;
  }

  /** movement UpdraftField: fire's rising heat over the 3 x 3 block under a point. */
  liftAt(x: number, y: number, z: number): number {
    if (this.burningN === 0) return 0;
    const ix = cellAt(x);
    const iz = cellAt(z);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!inWorld(ix + dx, iz + dz)) continue;
        const c = this.cells.get(cellId(ix + dx, iz + dz));
        if (c && c.st === ST_BURNING && y <= c.y) return FIRE_UPDRAFT_LIFT;
      }
    }
    return 0;
  }

  takeDirty(): number[] {
    const out = [...this.dirty].sort((a, b) => a - b);
    this.dirty.clear();
    return out;
  }

  /** FNV-1a over the sorted cells and pillars: chem/sim.go Hash. */
  hash(): number {
    const ids = [...this.cells.keys()].sort((a, b) => a - b);
    let h = 2166136261;
    const put = (v: number) => {
      v >>>= 0;
      for (let i = 0; i < 4; i++) {
        h ^= v & 0xff;
        h = Math.imul(h, 16777619) >>> 0;
        v >>>= 8;
      }
    };
    for (const id of ids) {
      const c = this.cells.get(id)!;
      put(id);
      put(c.st);
      put(c.until - this.step);
    }
    for (const p of this.pillars) {
      put(p.id);
      put(p.until - this.step);
    }
    return h >>> 0;
  }

  /** Replace a chunk's cells with a baseline (Event 524). */
  loadChunk(chunk: number, cells: { id: number; state: number; until: number }[]): void {
    const cx = (chunk % CHUNKS_N) * CHUNK_CELLS;
    const cz = Math.floor(chunk / CHUNKS_N) * CHUNK_CELLS;
    for (let z = cz; z < cz + CHUNK_CELLS; z++) {
      for (let x = cx; x < cx + CHUNK_CELLS; x++) {
        const id = cellId(x, z);
        if (this.cells.has(id)) this.set(id, { st: ST_NONE, until: 0, y: 0 });
      }
    }
    for (const c of cells) {
      const ix = cellX(c.id);
      const iz = cellZ(c.id);
      const y = c.state === ST_BURNING ? this.src.height(ix, iz) + FIRE_UPDRAFT_TOP_M : c.state === ST_FROZEN ? this.src.water(ix, iz) : 0;
      this.set(c.id, { st: c.state, until: c.until, y });
    }
  }

  /** Forget a chunk (left interest). */
  dropChunk(chunk: number): void {
    this.loadChunk(chunk, []);
  }

  /** Chunks with any non-default cell. */
  activeChunks(): number[] {
    const s = new Set<number>();
    for (const id of this.cells.keys()) s.add(chunkOf(id));
    return [...s].sort((a, b) => a - b);
  }

  /** Cells sorted by id as (id, state, until - step) triples (vectors). */
  sortedTriples(): number[] {
    const out: number[] = [];
    for (const id of [...this.cells.keys()].sort((a, b) => a - b)) {
      const c = this.cells.get(id)!;
      out.push(id, c.st, (c.until - this.step) >>> 0);
    }
    return out;
  }
}

function spreadBase(m: number): number {
  return m === MAT_GRASS ? FIRE_GRASS_SPREAD_PERMILLE : m === MAT_BRUSH ? FIRE_BRUSH_SPREAD_PERMILLE : m === MAT_DAMP ? FIRE_DAMP_SPREAD_PERMILLE : 0;
}
