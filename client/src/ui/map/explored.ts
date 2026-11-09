// Where you have walked (playtest 2: "the map is all 'Unexplored' paper until
// you climb a tower"). A coarse per-character, per-world grid of 32 m cells,
// marked in a circle around the player as they move and kept in
// localStorage. The map draws the terrain sketch through it, so the land you
// have seen fills in before its tower reveals the whole region.

export const EXPLORE_CELL_M = 32;
export const EXPLORE_RADIUS_M = 96;

export interface Explored {
  key: string;
  n: number;
  bits: Uint8Array;
  version: number;
  dirty: boolean;
}

let cur: Explored | null = null;

export function storageKey(worldId: string, characterId: string): string {
  return `lodestone_explored:${worldId}:${characterId}`;
}

export function createExplored(key: string, worldSize: number): Explored {
  const n = Math.ceil(worldSize / EXPLORE_CELL_M);
  return { key, n, bits: new Uint8Array(Math.ceil((n * n) / 8)), version: 0, dirty: false };
}

export function isExplored(e: Explored, cx: number, cz: number): boolean {
  if (cx < 0 || cz < 0 || cx >= e.n || cz >= e.n) return false;
  const i = cz * e.n + cx;
  return ((e.bits[i >> 3] >> (i & 7)) & 1) === 1;
}

/** Mark every cell whose centre is within `radius` of (x, z); true when anything new was marked. */
export function markExplored(e: Explored, x: number, z: number, radius = EXPLORE_RADIUS_M): boolean {
  const c = EXPLORE_CELL_M;
  const r = Math.ceil(radius / c);
  const px = Math.floor(x / c);
  const pz = Math.floor(z / c);
  let changed = false;
  for (let dz = -r; dz <= r; dz++)
    for (let dx = -r; dx <= r; dx++) {
      const cx = px + dx;
      const cz = pz + dz;
      if (cx < 0 || cz < 0 || cx >= e.n || cz >= e.n) continue;
      if (Math.hypot((cx + 0.5) * c - x, (cz + 0.5) * c - z) > radius) continue;
      const i = cz * e.n + cx;
      const bit = 1 << (i & 7);
      if (!(e.bits[i >> 3] & bit)) {
        e.bits[i >> 3] |= bit;
        changed = true;
      }
    }
  if (changed) {
    e.version++;
    e.dirty = true;
  }
  return changed;
}

/** Any explored cell inside the square [x0, x0 + size) x [z0, z0 + size) (metres). */
export function anyExploredIn(e: Explored, x0: number, z0: number, size: number): boolean {
  const c = EXPLORE_CELL_M;
  for (let cz = Math.floor(z0 / c); cz < Math.ceil((z0 + size) / c); cz++) for (let cx = Math.floor(x0 / c); cx < Math.ceil((x0 + size) / c); cx++) if (isExplored(e, cx, cz)) return true;
  return false;
}

function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function fromB64(s: string, into: Uint8Array): void {
  const d = atob(s);
  for (let i = 0; i < Math.min(d.length, into.length); i++) into[i] = d.charCodeAt(i);
}

/** The current character's explored grid (loaded from localStorage on first use for this key). */
export function exploredFor(worldId: string, characterId: string, worldSize: number): Explored {
  const key = storageKey(worldId, characterId);
  if (cur && cur.key === key) return cur;
  const e = createExplored(key, worldSize);
  try {
    const s = localStorage.getItem(key);
    if (s) fromB64(s, e.bits);
  } catch {
    /* private mode: explore again next time */
  }
  e.version = 1;
  cur = e;
  return e;
}

export function currentExplored(): Explored | null {
  return cur;
}

export function saveExplored(e: Explored): void {
  if (!e.dirty) return;
  try {
    localStorage.setItem(e.key, toB64(e.bits));
    e.dirty = false;
  } catch {
    /* quota or private mode */
  }
}

/** A 1-pixel-per-cell white-on-transparent mask of the explored cells (for compositing). */
export function exploredMask(e: Explored): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = e.n;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(e.n, e.n);
  for (let i = 0; i < e.n * e.n; i++) if ((e.bits[i >> 3] >> (i & 7)) & 1) img.data[i * 4 + 3] = 255;
  ctx.putImageData(img, 0, 0);
  return c;
}
