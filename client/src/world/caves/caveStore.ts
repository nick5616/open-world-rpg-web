// Cave cells on the client (WP09): one store shared by collision (the
// prediction ground) and rendering (CaveManager), so the player walks on
// exactly the triangles drawn. Cells arrive from the generation workers;
// a cell the ground needs but doesn't have yet is built synchronously on the
// main thread (~1-4 ms, the same wasm), because prediction must never guess:
// the zone simulates on these exact triangles (server/pkg/caves).
//
// World edits (mined veins) live here too: every cell is built with the
// active edits that touch it, as the zone does, so carved walls agree.

import {
  CAVE_CELL_H,
  CAVE_CELL_W,
  caveCellBytes,
  caveCellKey,
  caveCellValid,
  parseCaveCell,
  type AtlasHandle,
  type CaveCell,
  type CaveCellSource,
  type CaveEdit,
  type Worldgen,
} from '@lodestone/worldgen';

export interface StoredCell {
  key: number;
  cell: CaveCell;
  /** Bumped on every rebuild (edits): renderers re-upload when it changes. */
  version: number;
  lastUsed: number;
}

/** Does a carve sphere reach cell (cx, cy, cz) including its 2 m low-side padding? (Same rule as the generator and server/pkg/caves.Edit.Touches.) */
export function editTouches(e: CaveEdit, cx: number, cy: number, cz: number): boolean {
  const ox = cx * CAVE_CELL_W;
  const oy = cy * CAVE_CELL_H;
  const oz = cz * CAVE_CELL_W;
  const x = Math.fround(e.x), y = Math.fround(e.y), z = Math.fround(e.z), r = Math.fround(e.r);
  return x + r >= ox - 2 && x - r <= ox + CAVE_CELL_W && y + r >= oy - 2 && y - r <= oy + CAVE_CELL_H && z + r >= oz - 2 && z - r <= oz + CAVE_CELL_W;
}

export class CaveCellStore implements CaveCellSource {
  readonly cells = new Map<number, StoredCell>();
  /** Active edits by vein id. */
  readonly edits = new Map<bigint, CaveEdit>();
  /** Cells built on the main thread because a query needed them first. */
  syncBuilds = 0;
  private frame = 0;
  /** Called when a cell is added or rebuilt (renderer hook). */
  onCell: ((c: StoredCell) => void) | null = null;

  constructor(
    private readonly wg: Worldgen,
    private readonly atlas: AtlasHandle,
    private readonly capacity = 384,
  ) {}

  tick(): void {
    this.frame++;
  }

  /** CaveCellSource: loaded cell, or a synchronous build (collision must be exact). */
  cell(cx: number, cy: number, cz: number): CaveCell | undefined {
    if (!caveCellValid(cx, cy, cz)) return undefined;
    const k = caveCellKey(cx, cy, cz);
    const s = this.cells.get(k);
    if (s) {
      s.lastUsed = this.frame;
      return s.cell;
    }
    this.syncBuilds++;
    const c = parseCaveCell(caveCellBytes(this.wg, this.atlas, cx, cy, cz, this.editsFor(cx, cy, cz)));
    return this.put(c).cell;
  }

  has(cx: number, cy: number, cz: number): boolean {
    return this.cells.has(caveCellKey(cx, cy, cz));
  }

  /** Active edits touching a cell, sorted by vein id (the zone's order, so the encoded list matches). */
  editsFor(cx: number, cy: number, cz: number): CaveEdit[] {
    const out: CaveEdit[] = [];
    for (const e of this.edits.values()) if (editTouches(e, cx, cy, cz)) out.push(e);
    out.sort((a, b) => (a.veinId < b.veinId ? -1 : a.veinId > b.veinId ? 1 : 0));
    return out;
  }

  /** Signature of the edits a cell must be built with (workers' results are checked against it). */
  editSig(cx: number, cy: number, cz: number): string {
    return this.editsFor(cx, cy, cz)
      .map((e) => e.veinId.toString(36))
      .join(',');
  }

  /** Add a built cell (callers check editSig for worker results built before an edit changed). */
  put(c: CaveCell): StoredCell {
    const k = caveCellKey(c.cx, c.cy, c.cz);
    const prev = this.cells.get(k);
    const s: StoredCell = { key: k, cell: c, version: (prev?.version ?? 0) + 1, lastUsed: this.frame };
    this.cells.set(k, s);
    this.onCell?.(s);
    if (this.cells.size > this.capacity) this.evict();
    return s;
  }

  private evict(): void {
    const all = [...this.cells.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const s of all.slice(0, this.cells.size - Math.floor(this.capacity * 0.9))) {
      if (s.lastUsed >= this.frame - 2) break;
      this.cells.delete(s.key);
    }
  }

  /** Activate an edit; touched loaded cells are rebuilt now (collision changes at once). */
  setEdit(e: CaveEdit): void {
    this.edits.set(e.veinId, e);
    this.rebuildTouched(e);
  }

  removeEdit(veinId: bigint): void {
    const e = this.edits.get(veinId);
    if (!e) return;
    this.edits.delete(veinId);
    this.rebuildTouched(e);
  }

  private rebuildTouched(e: CaveEdit): void {
    for (const s of [...this.cells.values()]) {
      const c = s.cell;
      if (!editTouches(e, c.cx, c.cy, c.cz)) continue;
      this.put(parseCaveCell(caveCellBytes(this.wg, this.atlas, c.cx, c.cy, c.cz, this.editsFor(c.cx, c.cy, c.cz))));
    }
  }
}
