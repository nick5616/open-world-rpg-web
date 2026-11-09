// One interface, two paths (spec 8: "keep both paths behind one
// interface"). EventSync runs the deterministic simulation from the zone's
// ops (sync events, not results); BitmapSync shows the zone's 2 Hz
// burned-cell bitmaps per chunk (the fallback if spread desyncs ever proved
// noticeable). Renderers, the ground overlay and the updraft field read a
// ChemView and never know which path feeds it.

import { CHEM_CLIENT_DELAY_STEPS, CHEM_INTEREST_M, FIRE_UPDRAFT_LIFT, FIRE_UPDRAFT_TOP_M, PILLAR_STEPS } from '@lodestone/contracts';
import { bitmapState, decodeBaseline, decodeBitmap, decodeOp, EV_BASELINE, EV_BITMAP, isOpEvent, type ChemEvent } from './codec';
import { CHUNK_CELLS, CHUNKS_N, CELL_M, cellAt, cellId, cellX, cellZ, ChemSim, inWorld, ST_BURNING, ST_FROZEN, type ChemSource, type Pillar } from './sim';

export type ChemMode = 'events' | 'bitmap';

export interface ChemView {
  readonly mode: ChemMode;
  /** Step the view shows. */
  readonly step: number;
  /** Advance to the zone step estimate (events: simulate; bitmap: nothing). */
  advanceTo(zoneStep: number): void;
  /** Feed one chemistry Event (520-525). */
  onEvent(e: ChemEvent): void;
  /** Cell state (0 none, 1 burning, 2 burnt, 3 frozen). */
  stateAt(ix: number, iz: number): number;
  /** Every burning or frozen cell: id, state, y (updraft top / ice height). */
  forEachActive(fn: (id: number, st: number, y: number) => void): void;
  /** Every scorched cell (renderers). */
  forEachBurnt(fn: (id: number) => void): void;
  pillars(): readonly Pillar[];
  /** Ice sheet height at a cell, or null. */
  sheet(id: number): number | null;
  /** movement UpdraftField. */
  liftAt(x: number, y: number, z: number): number;
  /** Changes whenever anything visible changes. */
  readonly version: number;
  /** Changes when ice sheets or pillars change (the ground overlay). */
  readonly surfaceVersion: number;
  /** FNV digest of the state (the two-client comparison). */
  hash(): number;
  /** Forget chunks farther than the interest radius (+ margin) from (x, z). */
  prune(x: number, z: number): void;
  readonly stats: { ops: number; late: number; baselines: number; bitmaps: number; deferred: number };
}

function chunkCentre(ch: number): [number, number] {
  const half = (CHUNK_CELLS * CELL_M) / 2;
  return [(ch % CHUNKS_N) * CHUNK_CELLS * CELL_M + half, Math.floor(ch / CHUNKS_N) * CHUNK_CELLS * CELL_M + half];
}

/** The event path: the deterministic simulation, CHEM_CLIENT_DELAY_STEPS behind the zone. */
export class EventSync implements ChemView {
  readonly mode = 'events' as const;
  readonly sim: ChemSim;
  version = 0;
  readonly stats = { ops: 0, late: 0, baselines: 0, bitmaps: 0, deferred: 0 };
  /** Baselines for steps the simulation hasn't reached yet (applied right after that step). */
  private pending: { chunk: number; step: number; cells: { id: number; state: number; until: number }[] }[] = [];
  /** Called after every simulated step (evidence: per-step digests). */
  onStep: ((step: number, sim: ChemSim) => void) | null = null;

  constructor(seed: bigint, windDeg: number, src: ChemSource, step: number) {
    this.sim = new ChemSim(seed, windDeg, src, step);
  }

  get step(): number {
    return this.sim.step;
  }
  get surfaceVersion(): number {
    return this.sim.surfaceVersion;
  }

  advanceTo(zoneStep: number): void {
    const target = zoneStep - CHEM_CLIENT_DELAY_STEPS;
    if (target - this.sim.step > 300) this.sim.step = target - 300; // a long stall: don't grind through minutes
    while (this.sim.step < target) {
      this.sim.advanceTo(this.sim.step + 1);
      if (this.pending.length) this.applyPending();
      if (this.sim.changed) this.version++;
      this.onStep?.(this.sim.step, this.sim);
    }
  }

  private applyPending(): void {
    const s = this.sim.step;
    const keep = [];
    for (const p of this.pending) {
      if (p.step === s) {
        this.sim.loadChunk(p.chunk, p.cells);
        this.version++;
      } else if (p.step > s) keep.push(p);
      else {
        this.sim.loadChunk(p.chunk, p.cells); // behind: best effort (a desync the next baseline heals)
        this.version++;
      }
    }
    this.pending = keep;
  }

  onEvent(e: ChemEvent): void {
    if (isOpEvent(e.kind)) {
      const op = decodeOp(e);
      if (!op) return;
      this.stats.ops++;
      if (op.step <= this.sim.step) this.stats.late++;
      this.sim.schedule(op);
      return;
    }
    if (e.kind === EV_BASELINE) {
      const b = decodeBaseline(e.targetId, e.data);
      if (!b) return;
      this.stats.baselines++;
      if (b.step > this.sim.step) {
        this.stats.deferred++;
        this.pending.push({ chunk: e.targetId, step: b.step, cells: b.cells });
      } else {
        // Our simulation is already at or past the baseline's step: if it is the
        // same step this is exact; otherwise the next baseline heals it.
        this.sim.loadChunk(e.targetId, b.cells);
        this.version++;
      }
    }
  }

  stateAt(ix: number, iz: number): number {
    return inWorld(ix, iz) ? this.sim.state(cellId(ix, iz))[0] : 0;
  }
  forEachActive(fn: (id: number, st: number, y: number) => void): void {
    this.sim.forEachActive(fn);
  }
  forEachBurnt(fn: (id: number) => void): void {
    this.sim.forEach((id, st) => st === 2 && fn(id));
  }
  pillars(): readonly Pillar[] {
    return this.sim.pillars;
  }
  sheet(id: number): number | null {
    return this.sim.sheet(id);
  }
  liftAt(x: number, y: number, z: number): number {
    return this.sim.liftAt(x, y, z);
  }
  hash(): number {
    return this.sim.hash();
  }
  prune(x: number, z: number): void {
    for (const ch of this.sim.activeChunks()) {
      const [cx, cz] = chunkCentre(ch);
      if (Math.hypot(cx - x, cz - z) > CHEM_INTEREST_M + 96) {
        this.sim.dropChunk(ch);
        this.version++;
      }
    }
  }
}

/** The fallback path: show the zone's bitmaps as they come (no local spread). */
export class BitmapSync implements ChemView {
  readonly mode = 'bitmap' as const;
  step = 0;
  version = 0;
  surfaceVersion = 0;
  readonly stats = { ops: 0, late: 0, baselines: 0, bitmaps: 0, deferred: 0 };
  private chunks = new Map<number, Uint8Array>();
  private pillarList: Pillar[] = [];
  /** Ice heights come from the material source (water surface at the cell). */
  constructor(private readonly src: ChemSource) {}

  advanceTo(zoneStep: number): void {
    this.step = Math.max(this.step, zoneStep - CHEM_CLIENT_DELAY_STEPS);
    const keep = this.pillarList.filter((p) => p.until > this.step);
    if (keep.length !== this.pillarList.length) {
      this.pillarList = keep;
      this.surfaceVersion++;
      this.version++;
    }
  }

  onEvent(e: ChemEvent): void {
    if (e.kind === EV_BITMAP) {
      const b = decodeBitmap(e.data);
      if (!b) return;
      this.stats.bitmaps++;
      const old = this.chunks.get(e.targetId);
      const frozenChanged = !old || old.some((v, i) => ((v ^ b.bits[i]) & 0xff) !== 0);
      if (b.bits.every((v) => v === 0)) this.chunks.delete(e.targetId);
      else this.chunks.set(e.targetId, b.bits);
      if (frozenChanged) {
        this.version++;
        this.surfaceVersion++;
      }
      return;
    }
    if (isOpEvent(e.kind)) {
      const op = decodeOp(e);
      if (op?.pillar) {
        // Pillars are ground: they still come as ops; the bitmap carries no geometry.
        this.pillarList = this.pillarList.filter((p) => p.id !== op.pillar!.id);
        this.pillarList.push({ ...op.pillar, until: op.step + PILLAR_STEPS });
        this.surfaceVersion++;
        this.version++;
      }
    }
  }

  stateAt(ix: number, iz: number): number {
    if (!inWorld(ix, iz)) return 0;
    const ch = Math.floor(iz / CHUNK_CELLS) * CHUNKS_N + Math.floor(ix / CHUNK_CELLS);
    const bits = this.chunks.get(ch);
    return bits ? bitmapState(bits, (iz % CHUNK_CELLS) * CHUNK_CELLS + (ix % CHUNK_CELLS)) : 0;
  }

  private each(fn: (id: number, st: number) => void): void {
    for (const [ch, bits] of this.chunks) {
      const cx = (ch % CHUNKS_N) * CHUNK_CELLS;
      const cz = Math.floor(ch / CHUNKS_N) * CHUNK_CELLS;
      for (let l = 0; l < CHUNK_CELLS * CHUNK_CELLS; l++) {
        const st = bitmapState(bits, l);
        if (st) fn(cellId(cx + (l % CHUNK_CELLS), cz + Math.floor(l / CHUNK_CELLS)), st);
      }
    }
  }

  forEachActive(fn: (id: number, st: number, y: number) => void): void {
    this.each((id, st) => {
      if (st === ST_BURNING) fn(id, st, this.src.height(cellX(id), cellZ(id)) + FIRE_UPDRAFT_TOP_M);
      else if (st === ST_FROZEN) fn(id, st, this.src.water(cellX(id), cellZ(id)));
    });
  }
  forEachBurnt(fn: (id: number) => void): void {
    this.each((id, st) => st === 2 && fn(id));
  }
  pillars(): readonly Pillar[] {
    return this.pillarList;
  }
  sheet(id: number): number | null {
    return this.stateAt(cellX(id), cellZ(id)) === ST_FROZEN ? this.src.water(cellX(id), cellZ(id)) : null;
  }
  liftAt(x: number, y: number, z: number): number {
    const ix = cellAt(x);
    const iz = cellAt(z);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (this.stateAt(ix + dx, iz + dz) === ST_BURNING && y <= this.src.height(ix + dx, iz + dz) + FIRE_UPDRAFT_TOP_M) return FIRE_UPDRAFT_LIFT;
      }
    return 0;
  }
  hash(): number {
    let h = 2166136261;
    this.each((id, st) => {
      h = Math.imul(h ^ id, 16777619) >>> 0;
      h = Math.imul(h ^ st, 16777619) >>> 0;
    });
    return h;
  }
  prune(x: number, z: number): void {
    for (const ch of [...this.chunks.keys()]) {
      const [cx, cz] = chunkCentre(ch);
      if (Math.hypot(cx - x, cz - z) > CHEM_INTEREST_M + 96) this.chunks.delete(ch);
    }
  }
}

export function createChemView(mode: ChemMode, seed: bigint, windDeg: number, src: ChemSource, step: number): ChemView {
  return mode === 'bitmap' ? new BitmapSync(src) : new EventSync(seed, windDeg, src, step);
}
