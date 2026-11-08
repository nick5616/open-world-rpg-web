// Terrain chunk manager: a plain three.js object graph with its own update,
// not one React component per chunk (spec 12: reconciliation per chunk is
// too slow at this scale).
//
// Per frame:
//  1. Re-select tiles (every ~100 ms or 2 m of movement): the quadtree for
//     the camera, plus prefetch sets for where the camera will be (along its
//     velocity, more when fast) and where it looks, plus a wider "next ring"
//     for idle workers (spec 12 predictive streaming).
//  2. Queue missing tiles in the worker pool by priority; cancel queued work
//     that no longer matters.
//  3. Upload finished tiles: at most `uploadsPerFrame` and `uploadBudgetMs`
//     per frame (time-sliced uploads, so traversal never hitches).
//  4. Decide what to draw: wanted tiles, or a loaded ancestor while a tile
//     loads (no holes); animate geomorphs (a split eases children out of the
//     parent's shape, a merge eases children into it before swapping) and
//     edge stitching toward coarser neighbours.
//  5. Update the coverage texture the horizon mesh uses to stay out of the
//     way, and evict tiles nobody wanted for a while.

import * as THREE from 'three';
import type { AtlasData } from '@lodestone/worldgen';
import type { WorkerPool } from '../core/workerPool';
import type { ResultMsg } from '../core/protocol';
import { coarserEdges, DOMAIN_CHUNKS, DOMAIN_MIN, keyOf, MAX_LOD, parentOf, resolveDrawn, selectTiles, tileSize, distToTile, type HeightBounds, type TileId } from './quadtree';
import { tileGrid, tileIndex, TILE_TRIS, type TileMeshData } from './tileMesh';
import { createTerrainMaterial, type TerrainMaterial, type TerrainShared } from './terrainMaterial';

const MORPH_SECONDS = 0.6;
const RESELECT_MS = 100;
const RESELECT_MOVE_M = 2;
/** Tiles kept in GPU memory; ~170 KB each with water, so ~100 MB at the cap. */
const MAX_TILES = 700;
const EVICT_AFTER_MS = 8000;
/** Detail margin over the macro heightmap (NODEP amplitude is at most 25.5 m). */
const DETAIL_MARGIN = 26;
const SHADOW_CAST_M = 80;
/** Pool keys of tile jobs ("lod:cx:cz"); scatter/grass jobs use "s:"/"g:" prefixes. */
const TILE_KEY = /^\d+:-?\d+:-?\d+$/;

interface Tile {
  id: TileId;
  key: string;
  mesh: THREE.Mesh;
  material: TerrainMaterial;
  water: THREE.Mesh | null;
  /** Morph factor now and target (1 = parent's shape). */
  k: number;
  kTarget: number;
  edge: THREE.Vector4;
  edgeTarget: THREE.Vector4;
  drawn: boolean;
  lastWanted: number;
  chunkHash: string;
  bytes: number;
}

export interface TerrainStats {
  queued: number;
  inFlight: number;
  loaded: number;
  drawn: number;
  drawnTris: number;
  wanted: number;
  missingWanted: number;
  uploadsLastFrame: number;
  /** Worker-side generation times (ms) of tiles built this session (cache hits excluded). */
  genMs: number[];
  meshMs: number[];
  cacheHits: number;
  uploadMsMax: number;
}

export interface TerrainParams {
  lodSplit: number;
  viewDistance: number;
  uploadsPerFrame: number;
  uploadBudgetMs: number;
  normalMaps: boolean;
}

/** Min/max height per tile from the atlas: a pyramid over 64 m chunks, conservative by the detail margin. */
export function atlasHeightBounds(d: AtlasData): HeightBounds {
  const N = d.gridN;
  const levels: Float32Array[] = [];
  const n0 = DOMAIN_CHUNKS;
  const l0 = new Float32Array(n0 * n0 * 2);
  const seaFloor: [number, number] = [d.minHeight - DETAIL_MARGIN, d.seaY + 1];
  for (let j = 0; j < n0; j++) {
    for (let i = 0; i < n0; i++) {
      const cx = i + DOMAIN_MIN;
      const cz = j + DOMAIN_MIN;
      let lo = Infinity;
      let hi = -Infinity;
      if (cx >= 0 && cz >= 0 && cx < 64 && cz < 64) {
        for (let gj = cz * 2; gj <= cz * 2 + 2; gj++) {
          for (let gi = cx * 2; gi <= cx * 2 + 2; gi++) {
            const h = d.height[Math.min(gj, N - 1) * N + Math.min(gi, N - 1)];
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
        }
        lo -= DETAIL_MARGIN;
        hi += DETAIL_MARGIN;
      } else {
        [lo, hi] = seaFloor;
      }
      l0[(j * n0 + i) * 2] = lo;
      l0[(j * n0 + i) * 2 + 1] = hi;
    }
  }
  levels.push(l0);
  for (let l = 1, n = n0; l <= MAX_LOD; l++) {
    const prev = levels[l - 1];
    const m = n >> 1;
    const cur = new Float32Array(m * m * 2);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const o = ((j * 2 + dj) * n + i * 2 + di) * 2;
          lo = Math.min(lo, prev[o]);
          hi = Math.max(hi, prev[o + 1]);
        }
        cur[(j * m + i) * 2] = lo;
        cur[(j * m + i) * 2 + 1] = hi;
      }
    }
    levels.push(cur);
    n = m;
  }
  return (t: TileId) => {
    const n = n0 >> t.lod;
    const i = (t.cx - DOMAIN_MIN) >> t.lod;
    const j = (t.cz - DOMAIN_MIN) >> t.lod;
    const o = (j * n + i) * 2;
    const lv = levels[t.lod];
    return [lv[o], lv[o + 1]];
  };
}

export class TerrainManager {
  readonly group = new THREE.Group();
  readonly heightBounds: HeightBounds;
  /** 1 texel per chunk over the quadtree domain: 255 where a tile is drawn (horizon mesh discards there). */
  readonly coverage: THREE.DataTexture;
  readonly stats: TerrainStats = { queued: 0, inFlight: 0, loaded: 0, drawn: 0, drawnTris: 0, wanted: 0, missingWanted: 0, uploadsLastFrame: 0, genMs: [], meshMs: [], cacheHits: 0, uploadMsMax: 0 };
  /** Called for every new tile mesh (sun shadows opt it in to cascades). */
  onMaterial: ((m: THREE.Material) => void) | null = null;
  onMaterialDisposed: ((m: THREE.Material) => void) | null = null;

  private tiles = new Map<string, Tile>();
  private ready: TileMeshData[] = [];
  private requested = new Set<string>();
  private wanted = new Map<string, TileId>();
  private wasSplit = new Set<string>();
  private drawnSet = new Map<string, TileId>();
  private lastSelectAt = -1e9;
  private lastSelectPos = new THREE.Vector3(1e9, 0, 0);
  private index: THREE.BufferAttribute;
  private grid: THREE.BufferAttribute;
  private coverageData: Uint8Array;
  private coverageDirty = true;
  private disposed = false;

  constructor(
    private readonly pool: WorkerPool,
    data: AtlasData,
    private readonly shared: TerrainShared,
    private readonly waterMaterial: THREE.Material,
    private params: TerrainParams,
  ) {
    this.group.name = 'terrain';
    this.heightBounds = atlasHeightBounds(data);
    this.index = new THREE.BufferAttribute(tileIndex(), 1);
    this.grid = new THREE.BufferAttribute(tileGrid(), 2);
    this.coverageData = new Uint8Array(DOMAIN_CHUNKS * DOMAIN_CHUNKS);
    this.coverage = new THREE.DataTexture(this.coverageData, DOMAIN_CHUNKS, DOMAIN_CHUNKS, THREE.RedFormat, THREE.UnsignedByteType);
    this.coverage.magFilter = THREE.NearestFilter;
    this.coverage.minFilter = THREE.NearestFilter;
    this.coverage.needsUpdate = true;
  }

  setParams(p: TerrainParams): void {
    const normalsChanged = p.normalMaps !== this.params.normalMaps;
    this.params = p;
    this.lastSelectAt = -1e9;
    if (normalsChanged) {
      for (const t of this.tiles.values()) {
        const m = createTerrainMaterial(this.shared, p.normalMaps);
        m.userData.tile.uK.value = t.k;
        m.userData.tile.uEdge.value.copy(t.edge);
        this.onMaterialDisposed?.(t.material);
        t.material.dispose();
        t.material = m;
        t.mesh.material = m;
        this.onMaterial?.(m);
      }
    }
  }

  /** Chunk hash of a loaded tile (debug: compare with a fresh regeneration). */
  chunkHashOf(key: string): string | null {
    return this.tiles.get(key)?.chunkHash ?? null;
  }
  drawnTiles(): TileId[] {
    return [...this.drawnSet.values()];
  }
  isLoaded(key: string): boolean {
    return this.tiles.has(key);
  }

  update(camera: THREE.Camera, velocity: THREE.Vector3, dt: number, nowMs: number): void {
    if (this.disposed) return;
    const p = camera.position;
    if (nowMs - this.lastSelectAt > RESELECT_MS || p.distanceTo(this.lastSelectPos) > RESELECT_MOVE_M) {
      this.reselect(camera, velocity, nowMs);
      this.lastSelectAt = nowMs;
      this.lastSelectPos.copy(p);
    }
    this.upload(nowMs);
    this.resolve(nowMs);
    this.animate(dt);
    if (this.coverageDirty) {
      this.coverage.needsUpdate = true;
      this.coverageDirty = false;
    }
    this.stats.queued = this.pool.queued;
    this.stats.inFlight = this.pool.inFlight;
    this.stats.loaded = this.tiles.size;
  }

  private reselect(camera: THREE.Camera, velocity: THREE.Vector3, nowMs: number): void {
    const p = camera.position;
    const base = { split: this.params.lodSplit, viewDistance: this.params.viewDistance, heightBounds: this.heightBounds };
    const sel = selectTiles({ ...base, x: p.x, y: p.y, z: p.z, wasSplit: this.wasSplit });
    this.wasSplit = sel.split;
    this.wanted = sel.leaves;

    // Prefetch: where we'll be in ~2.5 s (sprinting/gliding goes further ahead
    // automatically, it is velocity times time), and 60 m along the view.
    const speed = Math.hypot(velocity.x, velocity.z);
    const ahead = new THREE.Vector3(p.x + velocity.x * 2.5, p.y + velocity.y * 2.5, p.z + velocity.z * 2.5);
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const lookAt = new THREE.Vector3(p.x + look.x * 60, p.y, p.z + look.z * 60);
    const prefetch = new Map<string, TileId>();
    if (speed > 0.5) for (const [k, t] of selectTiles({ ...base, x: ahead.x, y: ahead.y, z: ahead.z }).leaves) prefetch.set(k, t);
    for (const [k, t] of selectTiles({ ...base, x: lookAt.x, y: lookAt.y, z: lookAt.z }).leaves) prefetch.set(k, t);
    // Idle work: the next ring out, at a 30% larger split distance.
    const ring = selectTiles({ ...base, split: base.split * 1.3, x: p.x, y: p.y, z: p.z }).leaves;

    const want = (t: TileId, prio: number) => {
      const k = keyOf(t);
      if (this.tiles.has(k)) {
        this.tiles.get(k)!.lastWanted = nowMs;
        return;
      }
      if (this.requested.has(k)) {
        this.pool.setPriority(k, prio); // queued: re-rank; in flight: no-op
        return;
      }
      this.requested.add(k);
      this.pool
        .submit(k, { type: 'tile', cx: t.cx, cz: t.cz, lod: t.lod }, prio)
        .then((r) => this.onResult(k, r))
        .catch((err) => {
          this.requested.delete(k);
          console.warn('[terrain] tile failed', k, err);
        });
    };
    const prio = (t: TileId, bias: number) => bias + (distToTile(t, this.heightBounds, p.x, p.y, p.z) / tileSize(t.lod)) * 100;
    // Loaded ancestors of wanted tiles stay resident: they are what gets drawn
    // while a child loads (where nothing is loaded, the horizon mesh shows).
    const keep = new Set<string>();
    for (const t of this.wanted.values()) {
      want(t, prio(t, 0));
      keep.add(keyOf(t));
      for (let a = parentOf(t); a; a = parentOf(a)) {
        keep.add(keyOf(a));
        const at = this.tiles.get(keyOf(a));
        if (at) at.lastWanted = nowMs;
      }
    }
    for (const t of prefetch.values()) {
      want(t, prio(t, 200));
      keep.add(keyOf(t));
    }
    for (const t of ring.values()) {
      want(t, prio(t, 400));
      keep.add(keyOf(t));
    }
    // Cancel queued tiles nobody wants now (other job kinds use other key shapes).
    this.pool.retain((k) => !TILE_KEY.test(k) || keep.has(k)); // cancelled jobs resolve null -> onResult clears `requested`
    // Terrain casts shadows only from lod-0 tiles near the camera: every
    // cascade redraws every caster, and 50+ lod-0 tiles in three cascades
    // were a million shadow triangles for self-shadowing that only shows up
    // close (a hill's shade at dusk); far terrain is in fog by then.
    for (const tile of this.tiles.values()) tile.mesh.castShadow = tile.id.lod === 0 && distToTile(tile.id, this.heightBounds, p.x, p.y, p.z) < SHADOW_CAST_M;
    this.stats.wanted = this.wanted.size;
    let missing = 0;
    for (const k of this.wanted.keys()) if (!this.tiles.has(k)) missing++;
    this.stats.missingWanted = missing;
  }

  private onResult(key: string, r: ResultMsg | null): void {
    this.requested.delete(key);
    if (!r || r.type !== 'tile' || this.disposed) return;
    if (r.cached) this.stats.cacheHits++;
    else {
      this.stats.genMs.push(r.genMs);
      this.stats.meshMs.push(r.meshMs);
      if (this.stats.genMs.length > 4096) {
        this.stats.genMs.splice(0, 2048);
        this.stats.meshMs.splice(0, 2048);
      }
    }
    this.ready.push(r.tile);
  }

  private upload(nowMs: number): void {
    const t0 = performance.now();
    let n = 0;
    // Nearest-first among what's ready: cheap sort, the list is short.
    while (this.ready.length && n < this.params.uploadsPerFrame && performance.now() - t0 < this.params.uploadBudgetMs) {
      const d = this.ready.shift()!;
      const key = keyOf(d);
      if (this.tiles.has(key)) continue;
      this.tiles.set(key, this.makeTile(d, nowMs));
      n++;
    }
    this.stats.uploadsLastFrame = n;
    this.stats.uploadMsMax = Math.max(this.stats.uploadMsMax * 0.995, performance.now() - t0);
  }

  private makeTile(d: TileMeshData, nowMs: number): Tile {
    const g = new THREE.BufferGeometry();
    g.setIndex(this.index);
    g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
    g.setAttribute('aMorph', new THREE.BufferAttribute(d.morph, 1));
    g.setAttribute('aNrm', new THREE.BufferAttribute(d.normal, 4, true));
    g.setAttribute('aNrmC', new THREE.BufferAttribute(d.normalC, 4, true));
    g.setAttribute('aSplatA', new THREE.BufferAttribute(d.splatA, 4, true));
    g.setAttribute('aSplatB', new THREE.BufferAttribute(d.splatB, 4, true));
    g.setAttribute('aBiome', new THREE.BufferAttribute(d.biome, 4, true));
    g.setAttribute('aGrid', this.grid);
    const s = tileSize(d.lod);
    const x0 = d.cx * 64;
    const z0 = d.cz * 64;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, d.minY, z0), new THREE.Vector3(x0 + s, d.maxY, z0 + s));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const material = createTerrainMaterial(this.shared, this.params.normalMaps);
    this.onMaterial?.(material);
    const mesh = new THREE.Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false; // set by distance in reselect()
    mesh.name = `tile ${keyOf(d)}`;
    this.group.add(mesh);
    let water: THREE.Mesh | null = null;
    if (d.water) {
      const wg = new THREE.BufferGeometry();
      wg.setIndex(new THREE.BufferAttribute(d.water.index, 1));
      wg.setAttribute('position', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(d.water.vertices, 4), 3, 0));
      wg.setAttribute('aDepth', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(d.water.vertices, 4), 1, 3));
      wg.boundingBox = g.boundingBox.clone();
      wg.boundingSphere = g.boundingSphere.clone();
      water = new THREE.Mesh(wg, this.waterMaterial);
      water.matrixAutoUpdate = false;
      water.visible = false;
      water.renderOrder = 1;
      water.name = `water ${keyOf(d)}`;
      this.group.add(water);
    }
    const bytes = d.position.byteLength * 2 + d.normal.byteLength * 5 + (d.water ? d.water.vertices.byteLength + d.water.index.byteLength : 0);
    return { id: { cx: d.cx, cz: d.cz, lod: d.lod }, key: keyOf(d), mesh, material, water, k: 0, kTarget: 0, edge: new THREE.Vector4(), edgeTarget: new THREE.Vector4(), drawn: false, lastWanted: nowMs, chunkHash: d.chunkHash, bytes };
  }

  private resolve(nowMs: number): void {
    const loaded = (k: string) => this.tiles.has(k);
    const next = resolveDrawn(this.wanted, loaded);
    // Merge: a parent replacing drawn children waits until the children have
    // morphed into its shape, so the swap itself changes no pixel.
    for (const [k, t] of [...next]) {
      if (t.lod === 0) continue;
      const kids = [...this.drawnSet.values()].filter((c) => c.lod === t.lod - 1 && parentOf(c) && keyOf(parentOf(c)!) === k);
      if (!kids.length) continue;
      const kidTiles = kids.map((c) => this.tiles.get(keyOf(c))).filter((x): x is Tile => !!x);
      if (kidTiles.length !== kids.length) continue;
      if (kidTiles.every((x) => x.k >= 0.999)) continue; // done: let the parent in
      next.delete(k);
      for (const x of kidTiles) {
        x.kTarget = 1;
        next.set(x.key, x.id);
      }
    }
    // Starting state of newly drawn tiles: a tile replacing an ancestor starts in its parent's shape.
    let changed = next.size !== this.drawnSet.size;
    const fresh: Tile[] = [];
    for (const [k, t] of next) {
      const tile = this.tiles.get(k)!;
      if (!this.drawnSet.has(k)) {
        changed = true;
        let replacesAncestor = false;
        for (let a = parentOf(t); a; a = parentOf(a)) if (this.drawnSet.has(keyOf(a))) replacesAncestor = true;
        tile.k = replacesAncestor ? 1 : 0;
        tile.kTarget = 0;
        fresh.push(tile);
      } else if (tile.kTarget === 1 && !this.isMergingChild(t, next)) {
        tile.kTarget = 0; // a merge was abandoned (camera came back)
      }
    }
    for (const [k] of this.drawnSet) if (!next.has(k)) changed = true;
    if (changed) {
      for (const tile of this.tiles.values()) {
        const on = next.has(tile.key);
        tile.drawn = on;
        tile.mesh.visible = on;
        if (tile.water) tile.water.visible = on;
        if (on) tile.lastWanted = nowMs;
      }
      for (const t of next.values()) {
        const tile = this.tiles.get(keyOf(t))!;
        const m = coarserEdges(next, t);
        tile.edgeTarget.set(m & 1 ? 1 : 0, m & 2 ? 1 : 0, m & 4 ? 1 : 0, m & 8 ? 1 : 0);
      }
      // A tile that just appeared stitches to its coarser neighbours at once;
      // only tiles whose neighbour changed animate their edges (in step with
      // that neighbour's morph).
      for (const tile of fresh) tile.edge.copy(tile.edgeTarget);
      this.drawnSet = next;
      this.markCoverage();
      this.evict(nowMs);
    }
    let tris = 0;
    for (const t of this.drawnSet.values()) {
      const w = this.tiles.get(keyOf(t))?.water;
      tris += TILE_TRIS + (w ? (w.geometry.index?.count ?? 0) / 3 : 0);
    }
    this.stats.drawn = this.drawnSet.size;
    this.stats.drawnTris = tris;
  }

  private isMergingChild(t: TileId, next: Map<string, TileId>): boolean {
    const p = parentOf(t);
    return !!p && this.wanted.has(keyOf(p)) && !next.has(keyOf(p));
  }

  private animate(dt: number): void {
    const step = dt / MORPH_SECONDS;
    for (const t of this.drawnSet.values()) {
      const tile = this.tiles.get(keyOf(t));
      if (!tile) continue;
      tile.k += Math.sign(tile.kTarget - tile.k) * Math.min(step, Math.abs(tile.kTarget - tile.k));
      const e = tile.edge;
      const et = tile.edgeTarget;
      // Edges move with the same speed as morphs, so a neighbour that splits
      // (its children start in the coarse shape) and our edge release in step.
      e.x += Math.sign(et.x - e.x) * Math.min(step, Math.abs(et.x - e.x));
      e.y += Math.sign(et.y - e.y) * Math.min(step, Math.abs(et.y - e.y));
      e.z += Math.sign(et.z - e.z) * Math.min(step, Math.abs(et.z - e.z));
      e.w += Math.sign(et.w - e.w) * Math.min(step, Math.abs(et.w - e.w));
      const u = tile.material.userData.tile;
      u.uK.value = tile.k;
      u.uEdge.value.copy(e);
    }
  }

  private markCoverage(): void {
    this.coverageData.fill(0);
    for (const t of this.drawnSet.values()) {
      const n = 1 << t.lod;
      const i0 = t.cx - DOMAIN_MIN;
      const j0 = t.cz - DOMAIN_MIN;
      for (let j = j0; j < j0 + n; j++) this.coverageData.fill(255, j * DOMAIN_CHUNKS + i0, j * DOMAIN_CHUNKS + i0 + n);
    }
    this.coverageDirty = true;
  }

  private evict(nowMs: number): void {
    if (this.tiles.size <= MAX_TILES) return;
    const idle = [...this.tiles.values()].filter((t) => !t.drawn && !this.wanted.has(t.key) && nowMs - t.lastWanted > EVICT_AFTER_MS).sort((a, b) => a.lastWanted - b.lastWanted);
    for (const t of idle) {
      if (this.tiles.size <= MAX_TILES * 0.85) break;
      this.disposeTile(t);
    }
  }

  private disposeTile(t: Tile): void {
    this.tiles.delete(t.key);
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    this.onMaterialDisposed?.(t.material);
    t.material.dispose();
    if (t.water) {
      this.group.remove(t.water);
      t.water.geometry.dispose();
    }
  }

  /** Bytes of tile vertex data resident on the GPU (approximate). */
  gpuBytes(): number {
    let b = 0;
    for (const t of this.tiles.values()) b += t.bytes;
    return b;
  }

  dispose(): void {
    this.disposed = true;
    for (const t of [...this.tiles.values()]) this.disposeTile(t);
    this.coverage.dispose();
  }
}
