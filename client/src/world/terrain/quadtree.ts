// Terrain quadtree: which chunk tiles (cx, cz, lod) to draw for a camera.
//
// worldgen's chunk_build(cx, cz, lod) returns a 65 x 65 lattice covering
// 64 * 2^lod m with 2^lod m spacing, and every LOD samples the same height
// function, so tiles nest as a quadtree (worldgen/README.md "Chunk buffer").
// Roots are lod-6 tiles (4096 m); the domain is the 3 x 3 roots around the
// world (chunk ids -64..127 are valid: outside 0..63 is sea floor).
//
// Selection is CDLOD-style: a tile splits into its 4 children while the
// camera is within `split * tileSize` of the tile's 3D bounding box, so
// screen-space triangle size stays roughly constant at every level. Then a
// balancing pass makes neighbouring tiles differ by at most one level, which
// is what lets the terrain shader stitch edges exactly (an edge next to a
// coarser tile is morphed onto the coarser lattice; see terrainMaterial.ts).
//
// Pure functions, no three.js: unit-tested in quadtree.test.ts.

export const CHUNK_M = 64;
export const MAX_LOD = 6;
/** Chunk-id domain covered by the 3 x 3 lod-6 roots. */
export const DOMAIN_MIN = -64;
export const DOMAIN_MAX = 128; // exclusive
export const DOMAIN_CHUNKS = DOMAIN_MAX - DOMAIN_MIN; // 192

export interface TileId {
  cx: number;
  cz: number;
  lod: number;
}

/** Stable string key; also the IndexedDB key suffix. */
export const tileKey = (cx: number, cz: number, lod: number): string => `${lod}:${cx}:${cz}`;
export const keyOf = (t: TileId): string => tileKey(t.cx, t.cz, t.lod);
export function parseKey(k: string): TileId {
  const [lod, cx, cz] = k.split(':').map(Number);
  return { cx, cz, lod };
}
export const tileSize = (lod: number): number => CHUNK_M << lod;

export function parentOf(t: TileId): TileId | null {
  if (t.lod >= MAX_LOD) return null;
  const s = 1 << (t.lod + 1);
  return { cx: Math.floor(t.cx / s) * s, cz: Math.floor(t.cz / s) * s, lod: t.lod + 1 };
}

export function childrenOf(t: TileId): TileId[] {
  if (t.lod === 0) return [];
  const h = 1 << (t.lod - 1);
  const l = t.lod - 1;
  return [
    { cx: t.cx, cz: t.cz, lod: l },
    { cx: t.cx + h, cz: t.cz, lod: l },
    { cx: t.cx, cz: t.cz + h, lod: l },
    { cx: t.cx + h, cz: t.cz + h, lod: l },
  ];
}

export const roots = (): TileId[] => {
  const out: TileId[] = [];
  for (let cz = DOMAIN_MIN; cz < DOMAIN_MAX; cz += 64) for (let cx = DOMAIN_MIN; cx < DOMAIN_MAX; cx += 64) out.push({ cx, cz, lod: MAX_LOD });
  return out;
};

/** Height range of a tile's area (any conservative bound). */
export type HeightBounds = (t: TileId) => [number, number];

/** Euclidean distance from p to the tile's axis-aligned box (0 inside). */
export function distToTile(t: TileId, hb: HeightBounds, px: number, py: number, pz: number): number {
  const s = tileSize(t.lod);
  const x0 = t.cx * CHUNK_M;
  const z0 = t.cz * CHUNK_M;
  const [y0, y1] = hb(t);
  const dx = Math.max(x0 - px, 0, px - (x0 + s));
  const dz = Math.max(z0 - pz, 0, pz - (z0 + s));
  const dy = Math.max(y0 - py, 0, py - y1);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Horizontal distance only (view-distance culling ignores altitude). */
export function distToTile2(t: TileId, px: number, pz: number): number {
  const s = tileSize(t.lod);
  const x0 = t.cx * CHUNK_M;
  const z0 = t.cz * CHUNK_M;
  const dx = Math.max(x0 - px, 0, px - (x0 + s));
  const dz = Math.max(z0 - pz, 0, pz - (z0 + s));
  return Math.sqrt(dx * dx + dz * dz);
}

export interface SelectParams {
  x: number;
  y: number;
  z: number;
  /** Split while distance < split * tileSize. Higher = finer terrain. */
  split: number;
  /** Tiles whose nearest point is farther than this (horizontally) are skipped; the horizon mesh draws there. */
  viewDistance: number;
  heightBounds: HeightBounds;
  /** Keys split last time: they merge only past split * hysteresis, so standing on a threshold never flickers. */
  wasSplit?: ReadonlySet<string>;
  hysteresis?: number;
}

export interface Selection {
  /** Leaf tiles to draw, balanced (neighbours differ by <= 1 level). */
  leaves: Map<string, TileId>;
  /** Interior nodes that were split (feed back as wasSplit next time). */
  split: Set<string>;
}

export function selectTiles(p: SelectParams): Selection {
  const leaves = new Map<string, TileId>();
  const split = new Set<string>();
  const hyst = p.hysteresis ?? 1.1;
  const visit = (t: TileId) => {
    if (distToTile2(t, p.x, p.z) > p.viewDistance) return;
    const k = keyOf(t);
    const limit = p.split * tileSize(t.lod) * (p.wasSplit?.has(k) ? hyst : 1);
    if (t.lod > 0 && distToTile(t, p.heightBounds, p.x, p.y, p.z) < limit) {
      split.add(k);
      for (const c of childrenOf(t)) visit(c);
    } else {
      leaves.set(k, t);
    }
  };
  for (const r of roots()) visit(r);
  balance(leaves, split);
  return { leaves, split };
}

/** The leaf of `leaves` that covers chunk-space point (x, z) in chunk units, if any. */
export function leafAt(leaves: ReadonlyMap<string, TileId>, x: number, z: number): TileId | null {
  if (x < DOMAIN_MIN || z < DOMAIN_MIN || x >= DOMAIN_MAX || z >= DOMAIN_MAX) return null;
  for (let lod = 0; lod <= MAX_LOD; lod++) {
    const s = 1 << lod;
    const t = leaves.get(tileKey(Math.floor(x / s) * s, Math.floor(z / s) * s, lod));
    if (t) return t;
  }
  return null;
}

/** Edge midpoints just outside a tile, in chunk units: west, east, north (-z), south (+z). */
function edgeProbes(t: TileId): [number, number][] {
  const s = 1 << t.lod;
  const e = 0.25; // a quarter chunk outside: inside any neighbour, never in t
  return [
    [t.cx - e, t.cz + s / 2],
    [t.cx + s + e, t.cz + s / 2],
    [t.cx + s / 2, t.cz - e],
    [t.cx + s / 2, t.cz + s + e],
  ];
}

/**
 * Restricted quadtree: split any leaf that is more than one level coarser
 * than a neighbour. Probing the edge midpoint is enough, because a neighbour
 * at least as coarse as t covers t's whole edge, and finer neighbours run the
 * same check from their side.
 */
export function balance(leaves: Map<string, TileId>, split?: Set<string>): void {
  const work = [...leaves.values()];
  while (work.length) {
    const t = work.pop()!;
    if (!leaves.has(keyOf(t))) continue;
    for (const [x, z] of edgeProbes(t)) {
      const n = leafAt(leaves, x, z);
      if (n && n.lod > t.lod + 1) {
        leaves.delete(keyOf(n));
        split?.add(keyOf(n));
        for (const c of childrenOf(n)) {
          leaves.set(keyOf(c), c);
          work.push(c);
        }
        work.push(t); // re-check: the probe may now land on a still-too-coarse child
      }
    }
  }
}

/**
 * For each drawn tile, which edges border a coarser drawn tile (bit 0 west,
 * 1 east, 2 north, 3 south). Those edges are morphed onto the coarser
 * lattice so the shared edge matches exactly.
 */
export function coarserEdges(drawn: ReadonlyMap<string, TileId>, t: TileId): number {
  let mask = 0;
  edgeProbes(t).forEach(([x, z], i) => {
    const n = leafAt(drawn, x, z);
    if (n && n.lod > t.lod) mask |= 1 << i;
  });
  return mask;
}

/**
 * What to actually draw given which tiles have meshes: every wanted leaf, or
 * its nearest loaded ancestor while it is still loading, so the ground never
 * has holes. A tile is dropped if one of its ancestors is drawn.
 */
export function resolveDrawn(wanted: ReadonlyMap<string, TileId>, loaded: (k: string) => boolean): Map<string, TileId> {
  const drawn = new Map<string, TileId>();
  for (const t of wanted.values()) {
    let cur: TileId | null = t;
    while (cur && !loaded(keyOf(cur))) cur = parentOf(cur);
    if (cur) drawn.set(keyOf(cur), cur);
  }
  for (const [k, t] of [...drawn]) {
    for (let a = parentOf(t); a; a = parentOf(a)) {
      if (drawn.has(keyOf(a))) {
        drawn.delete(k);
        break;
      }
    }
  }
  return drawn;
}
