// Instanced scatter (spec 12): trees, rocks, bushes and grass tufts from the
// generator's scatter records, plus dense grass blades around the camera.
//
// Layout: one InstancedMesh per (archetype, LOD) for the whole world, not per
// chunk group: the CPU re-bins instances into those meshes every few meters
// of camera movement, so the draw-call count is fixed (~16 + shadows) no
// matter how far the forest goes, and per-instance distance fades on the GPU
// keep LOD swaps smooth between re-bins.
//
//   trees:  mesh LOD0 (< 60 m), mesh LOD1 (< treeMeshDistance), impostor
//           billboards beyond, shrinking in at scatterDistance;
//   rocks:  one mesh, out to half the scatter distance;
//   bushes, tufts: out to smallScatterDistance;
//   grass:  clumps from a worker per lod-0 chunk, out to grassDistance.
//
// Stable ids: every instance keeps its record's 64-bit id (spec 5: "tree
// 0x9f3a burned"); `idAt(mesh, instanceIndex)` answers raycasts, and
// `hide(id)` removes one object (world edits will use it).

import * as THREE from 'three';
import type { WorkerPool } from '../core/workerPool';
import { SCATTER_STRIDE, type GrassData, type ScatterData } from '../core/protocol';
import { bush, grassClump, rock, treeGeometry, TREE_ARCHETYPES, triCount, type TreeArchetype } from './archetypes';
import { createBillboardMaterial, createScatterMaterial, type ScatterMaterial } from './scatterMaterials';
import { billboardQuad, renderImpostorAtlas } from './impostors';
import { unpackGrass } from './grassGen';
import type { WorldTier } from '../config';

const LAYER_TREE = 1;
const LAYER_ROCK = 2;
const LAYER_BUSH = 3;
const LAYER_TUFT = 4;
const LOD0_M = 60;
/** Half-width of the dithered cross-fade between LODs (m): wide bands read as screen-door noise. */
const BAND = 5;
const REBIN_MOVE_M = 6;
const GRASS_REBIN_MOVE_M = 2;
/** Rocks and bushes cast shadows only this close (tree LODs cast to treeMeshDistance). */
const SHADOW_NEAR_M = 70;
const TREE_SHADOW_M = 100;
/** Re-binning is O(records in range): at most this often, however fast the camera moves. */
const REBIN_MIN_MS = 150;

interface KindStyle {
  arch: number;
  /** Width and height multipliers. */
  w: number;
  h: number;
  tint: THREE.Color;
}
const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

/** Tree kinds (worldgen TREE_KINDS order). Heights in meters at scale byte 128. */
const TREE_STYLE: KindStyle[] = [
  { arch: 0, w: 6.5, h: 7.5, tint: C(0.95, 1.05, 0.8) }, // oak
  { arch: 0, w: 4.2, h: 8.5, tint: C(1.25, 1.3, 0.7) }, // birch
  { arch: 0, w: 7.5, h: 9, tint: C(0.85, 1.0, 0.75) }, // broadleaf
  { arch: 1, w: 5, h: 11, tint: C(0.9, 1.0, 0.9) }, // pine
  { arch: 1, w: 4.6, h: 9.5, tint: C(1.7, 1.8, 1.9) }, // snow fir
  { arch: 2, w: 5, h: 6.5, tint: C(1, 1, 1) }, // dead tree
  { arch: 0, w: 9, h: 5.5, tint: C(1.2, 1.1, 0.6) }, // acacia
  { arch: 0, w: 7.5, h: 8, tint: C(1.1, 1.25, 0.7) }, // willow
  { arch: 1, w: 2.6, h: 10, tint: C(0.75, 0.9, 0.75) }, // cypress
];
const ROCK_STYLE: KindStyle[] = [
  { arch: 0, w: 1.8, h: 1.6, tint: C(1, 1, 1) }, // boulder
  { arch: 0, w: 3.2, h: 0.9, tint: C(0.95, 0.93, 0.9) }, // slab
  { arch: 0, w: 1.4, h: 4.5, tint: C(0.9, 0.9, 0.92) }, // spire
  { arch: 0, w: 2.0, h: 1.4, tint: C(0.6, 0.85, 0.5) }, // mossy
  { arch: 0, w: 1.9, h: 1.5, tint: C(1.6, 1.65, 1.75) }, // snowy
];
const BUSH_STYLE: KindStyle[] = [
  { arch: 0, w: 1.6, h: 1.3, tint: C(1, 1, 1) }, // shrub
  { arch: 0, w: 1.5, h: 1.2, tint: C(1.15, 0.75, 0.6) }, // berry bush
  { arch: 0, w: 1.4, h: 0.7, tint: C(0.8, 1.2, 0.7) }, // fern
  { arch: 0, w: 1.3, h: 0.9, tint: C(1.5, 1.2, 0.6) }, // dry scrub
  { arch: 0, w: 0.8, h: 1.8, tint: C(0.9, 1.1, 0.6) }, // reeds
  { arch: 0, w: 1.2, h: 0.6, tint: C(1.3, 0.8, 1.3) }, // heather
];
const TUFT_STYLE: KindStyle[] = [
  { arch: 0, w: 1.2, h: 0.7, tint: C(1, 1, 1) }, // tuft
  { arch: 0, w: 1.0, h: 1.3, tint: C(1.05, 1.1, 0.85) }, // tall grass
  { arch: 0, w: 1.1, h: 0.6, tint: C(1.6, 1.3, 1.5) }, // flowers
  { arch: 0, w: 1.1, h: 0.75, tint: C(1.8, 1.45, 0.75) }, // dry grass
  { arch: 0, w: 1.0, h: 0.5, tint: C(1.7, 1.75, 1.8) }, // snow grass
  { arch: 0, w: 1.0, h: 1.4, tint: C(0.75, 1.0, 0.7) }, // marsh grass
];
const FLOWER_TINTS = [C(2.2, 1.9, 0.6), C(2.0, 1.0, 1.4), C(1.3, 1.3, 2.2), C(2.2, 2.2, 2.0)];

interface Bin {
  mesh: THREE.InstancedMesh;
  capacity: number;
  count: number;
  ids: BigUint64Array;
  make: (cap: number) => THREE.InstancedMesh;
}

export interface ScatterStats {
  chunks: number;
  instances: number;
  grassClumps: number;
  rebinMs: number;
  genMs: number[];
  tris: number;
}

export interface LightUniforms {
  uSunDir: { value: THREE.Vector3 };
  uLightColor: { value: THREE.Color };
  uAmbient: { value: THREE.Color };
}

export class ScatterManager {
  readonly group = new THREE.Group();
  readonly stats: ScatterStats = { chunks: 0, instances: 0, grassClumps: 0, rebinMs: 0, genMs: [], tris: 0 };
  onMaterial: ((m: THREE.Material) => void) | null = null;

  private chunks = new Map<string, ScatterData>();
  private grass = new Map<string, GrassData>();
  private pending = new Set<string>();
  private bins: Bin[] = [];
  private treeBins: Bin[][] = []; // [arch][0 = lod0, 1 = lod1, 2 = billboard]
  private rockBin!: Bin;
  private bushBin!: Bin;
  /** Same meshes beyond SHADOW_NEAR_M, without shadow casting: each cascade redraws every caster, and far rocks were most of the shadow triangles. */
  private rockFarBin!: Bin;
  private bushFarBin!: Bin;
  private tuftBin!: Bin;
  private grassMesh: THREE.Mesh;
  private grassGeom: THREE.InstancedBufferGeometry;
  private grassCapacity = 0;
  private lastRebin = new THREE.Vector3(1e9, 0, 0);
  private lastGrassRebin = new THREE.Vector3(1e9, 0, 0);
  private dirty = true;
  private lastRebinAt = -1e9;
  private lastGrassAt = -1e9;
  private grassDirty = true;
  private lastRequestAt = -1e9;
  private hidden = new Set<bigint>();
  private impostors: THREE.WebGLRenderTarget;
  private materials: THREE.Material[] = [];
  private disposed = false;

  constructor(
    private readonly pool: WorkerPool,
    renderer: THREE.WebGLRenderer,
    private tier: WorldTier,
    private readonly light: LightUniforms,
  ) {
    this.group.name = 'scatter';
    const lod0 = TREE_ARCHETYPES.map((a) => treeGeometry(a, 0));
    const lod1 = TREE_ARCHETYPES.map((a) => treeGeometry(a, 1));
    this.impostors = renderImpostorAtlas(renderer, lod0);
    const quad = billboardQuad();
    TREE_ARCHETYPES.forEach((a: TreeArchetype, i) => {
      const m0 = this.mat({ fade: new THREE.Vector4(-1, 0, LOD0_M - BAND, LOD0_M + BAND), sway: 0.006, flutter: 0.004 });
      const m1 = this.mat({ fade: new THREE.Vector4(LOD0_M - BAND, LOD0_M + BAND, 0, 0), sway: 0.006, flutter: 0.002 });
      const bb = createBillboardMaterial(this.impostors.texture, i, TREE_ARCHETYPES.length, new THREE.Vector4(0, 0, 0, 0), light);
      this.materials.push(bb);
      // [lod0, lod1 (casts shadows), impostor, lod1 far (no shadows: past
      // TREE_SHADOW_M a tree's shadow is a few texels of the last cascade,
      // and every caster is redrawn once per cascade)]
      this.treeBins[i] = [
        this.bin(lod0[i], m0, true, `tree ${a} lod0`),
        this.bin(lod1[i], m1, true, `tree ${a} lod1`),
        this.bin(quad, bb, false, `tree ${a} impostor`),
        this.bin(lod1[i], m1, false, `tree ${a} lod1 far`),
      ];
    });
    const rockGeom = rock();
    const rockMat = this.mat({ fade: new THREE.Vector4(-1, 0, 0, 0), sway: 0, flutter: 0, roughness: 0.95 });
    this.rockBin = this.bin(rockGeom, rockMat, true, 'rocks');
    this.rockFarBin = this.bin(rockGeom, rockMat, false, 'rocks far');
    const bushGeom = bush();
    const bushMat = this.mat({ fade: new THREE.Vector4(-1, 0, 0, 0), sway: 0.02, flutter: 0.01 });
    this.bushBin = this.bin(bushGeom, bushMat, true, 'bushes');
    this.bushFarBin = this.bin(bushGeom, bushMat, false, 'bushes far');
    this.tuftBin = this.bin(grassClump(9, 3), this.mat({ fade: new THREE.Vector4(-1, 0, 0, 0), sway: 0.06, flutter: 0.01, doubleSided: true }), false, 'tufts');

    // Dense grass: instanced geometry with a per-clump vec4 (x, y, z, packed yaw/scale/tint).
    const clump = grassClump(8, 9);
    this.grassGeom = new THREE.InstancedBufferGeometry();
    this.grassGeom.index = clump.index;
    for (const [k, v] of Object.entries(clump.attributes)) this.grassGeom.setAttribute(k, v);
    this.grassGeom.instanceCount = 0;
    this.grassMesh = new THREE.Mesh(this.grassGeom, this.grassMaterial());
    this.grassMesh.frustumCulled = false;
    this.grassMesh.receiveShadow = true;
    this.grassMesh.name = 'grass';
    this.group.add(this.grassMesh);
    this.applyTier(tier);
  }

  private mat(o: Parameters<typeof createScatterMaterial>[0]): ScatterMaterial {
    const m = createScatterMaterial(o);
    this.materials.push(m);
    this.onMaterial?.(m);
    return m;
  }

  /** Materials created before onMaterial was attached (call once after wiring). */
  allMaterials(): THREE.Material[] {
    return this.materials;
  }

  private bin(geom: THREE.BufferGeometry, material: THREE.Material, shadows: boolean, name: string): Bin {
    const make = (cap: number) => {
      const m = new THREE.InstancedMesh(geom, material, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = shadows;
      m.receiveShadow = true;
      m.name = name;
      return m;
    };
    const b: Bin = { mesh: make(256), capacity: 256, count: 0, ids: new BigUint64Array(256), make };
    this.group.add(b.mesh);
    this.bins.push(b);
    return b;
  }

  private grassMaterial(): THREE.MeshStandardMaterial {
    const m = this.mat({ fade: new THREE.Vector4(-1, 0, 0, 0), sway: 0, flutter: 0, doubleSided: true });
    const base = m.onBeforeCompile;
    const grassRange = { value: new THREE.Vector2(30, 40) };
    (m.userData as Record<string, unknown>).grassRange = grassRange;
    m.onBeforeCompile = (shader, r) => {
      base.call(m, shader, r);
      shader.uniforms.uGrassRange = grassRange;
      // Not an InstancedMesh: place each clump from its vec4 instead of instanceMatrix.
      shader.vertexShader = shader.vertexShader
        .replace('attribute float aFoliage;', 'attribute float aFoliage;\nattribute vec4 aClump;\nuniform vec2 uGrassRange;')
        .replace(
          /vec3 iPos = vec3\(instanceMatrix\[3\]\);[\s\S]*?gl_Position = projectionMatrix \* mvPosition;/,
          `vec3 iPos = aClump.xyz;
          float packed = aClump.w;
          float yaw = mod(packed, 256.0) / 255.0 * 6.2831853;
          float sc = mod(floor(packed / 256.0), 256.0) / 255.0;
          float tint = floor(packed / 65536.0) / 255.0;
          float iDist = distance(iPos, cameraPosition);
          float shrink = 1.0 - smoothstep(uGrassRange.x, uGrassRange.y, iDist);
          float h = sc * shrink;
          vec3 p = transformed;
          float cs = cos(yaw), sn = sin(yaw);
          // Clumps ~0.5 m across, blades 0.25-0.55 m: knee-high meadow, not reeds.
          p.xz = vec2(p.x * cs - p.z * sn, p.x * sn + p.z * cs) * (1.2 + 0.8 * sc);
          p.y *= h * 0.55;
          float hk = transformed.y;
          vec2 w = windAt(iPos.xz);
          // Playtest 2 styles: uWindSweep.x leans the meadow further, .y adds a
          // bright sheen where a gust front rolls through (the wind made visible).
          float gust = windGust(iPos.xz);
          p.xz += w * 0.035 * uWindSweep.x * hk * hk * h * (0.7 + 0.3 * sin(uWindTime * 3.3 + iPos.x * 0.7 + iPos.z * 0.9));
          p.y -= dot(w, w) * 0.0006 * uWindSweep.x * hk * h;
          vFade = 1.0;
          // Dry (low moisture) grass is straw, wet grass deep green.
          vColor.rgb *= mix(vec3(1.25, 1.05, 0.55), vec3(0.85, 1.1, 0.7), smoothstep(0.15, 0.6, tint));
          vColor.rgb *= 1.0 + uWindSweep.y * max(gust - 0.75, 0.0) * hk;
          transformed = iPos + p; // worldpos_vertex (shadow lookups) reads this
          vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
          gl_Position = projectionMatrix * mvPosition;`,
        );
    };
    m.customProgramCacheKey = () => 'lodestone-grass-2';
    return m;
  }

  applyTier(t: WorldTier): void {
    this.tier = t;
    const treeM = t.treeMeshDistance;
    TREE_ARCHETYPES.forEach((_, i) => {
      const [, l1, bb] = this.treeBins[i];
      (l1.mesh.material as ScatterMaterial).userData.fade.value.set(LOD0_M - BAND, LOD0_M + BAND, treeM - BAND * 2, treeM + BAND * 2);
      (bb.mesh.material as ScatterMaterial).userData.fade.value.set(treeM - BAND * 2, treeM + BAND * 2, t.scatterDistance * 0.88, t.scatterDistance);
    });
    const rockFar = Math.min(400, t.scatterDistance * 0.5);
    (this.rockBin.mesh.material as ScatterMaterial).userData.fade.value.set(-1, 0, rockFar * 0.85, rockFar);
    (this.bushBin.mesh.material as ScatterMaterial).userData.fade.value.set(-1, 0, t.smallScatterDistance * 0.8, t.smallScatterDistance);
    (this.tuftBin.mesh.material as ScatterMaterial).userData.fade.value.set(-1, 0, t.smallScatterDistance * 0.6, t.smallScatterDistance * 0.75);
    (this.grassMesh.material as THREE.Material).userData.grassRange.value.set(t.grassDistance * 0.7, t.grassDistance);
    this.grassMesh.visible = t.grassDistance > 0;
    for (const b of this.bins) b.mesh.castShadow = t.shadowDistance > 0 && b !== this.tuftBin && !b.mesh.name.includes('impostor') && !b.mesh.name.endsWith('far');
    this.dirty = true;
    this.grassDirty = true;
  }

  /** Stable id of an instance (raycast hit -> world object). */
  idAt(mesh: THREE.Object3D, instance: number): bigint | null {
    const b = this.bins.find((x) => x.mesh === mesh);
    return b && instance < b.count ? b.ids[instance] : null;
  }

  /** Hide one object by stable id (world edits: "tree 0x9f3a burned"). */
  hide(id: bigint): void {
    this.hidden.add(id);
    this.dirty = true;
  }

  /** CR 040: bring a regrown object back. */
  unhide(id: bigint): void {
    if (this.hidden.delete(id)) this.dirty = true;
  }

  /** CR 040 world edits (targeting): visits the live trees, rocks and bushes within r m of (x, z). Kind and scale are the record's bytes. */
  forEachObject(x: number, z: number, r: number, cb: (o: { id: bigint; layer: number; kind: number; scale: number; yaw: number; x: number; y: number; z: number }) => void): void {
    for (const c of this.chunks.values()) {
      if (Math.hypot(c.cx * 64 + 32 - x, c.cz * 64 + 32 - z) > r + 46) continue;
      const rec = c.records;
      const n = rec.length / SCATTER_STRIDE;
      for (let i = 0; i < n; i++) {
        const o = i * SCATTER_STRIDE;
        const layer = rec[o];
        if (layer > LAYER_BUSH) break; // records are ordered trees, rocks, bushes, tufts
        if (Math.hypot(rec[o + 3] - x, rec[o + 5] - z) > r || this.hidden.has(c.ids[i])) continue;
        cb({ id: c.ids[i], layer, kind: rec[o + 1], scale: rec[o + 7], yaw: rec[o + 6], x: rec[o + 3], y: rec[o + 4], z: rec[o + 5] });
      }
    }
  }

  /** CR 040: how an object is drawn: its LOD 0 geometry and material (a falling tree reuses them: no new shader program mid-game) and style. */
  propOf(layer: number, kind: number): { geometry: THREE.BufferGeometry; material: THREE.Material; w: number; h: number; tint: THREE.Color } | null {
    const pick = (b: Bin, st: KindStyle) => ({ geometry: b.mesh.geometry, material: b.mesh.material as THREE.Material, w: st.w, h: st.h, tint: st.tint });
    if (layer === LAYER_TREE) {
      const st = TREE_STYLE[kind] ?? TREE_STYLE[0];
      return pick(this.treeBins[st.arch][0], st);
    }
    if (layer === LAYER_ROCK) return pick(this.rockBin, ROCK_STYLE[kind] ?? ROCK_STYLE[0]);
    if (layer === LAYER_BUSH) return pick(this.bushBin, BUSH_STYLE[kind] ?? BUSH_STYLE[0]);
    return null;
  }

  update(camera: THREE.Camera, nowMs: number): void {
    if (this.disposed) return;
    const p = camera.position;
    if (nowMs - this.lastRequestAt > 250) {
      this.lastRequestAt = nowMs;
      this.request(p);
    }
    if ((this.dirty || p.distanceTo(this.lastRebin) > REBIN_MOVE_M) && nowMs - this.lastRebinAt > REBIN_MIN_MS) {
      this.lastRebinAt = nowMs;
      this.rebin(p);
    }
    if (this.tier.grassDistance > 0 && (this.grassDirty || p.distanceTo(this.lastGrassRebin) > GRASS_REBIN_MOVE_M) && nowMs - this.lastGrassAt > 60) {
      this.lastGrassAt = nowMs;
      this.rebinGrass(p);
    }
  }

  private request(p: THREE.Vector3): void {
    const R = this.tier.scatterDistance + 64;
    const pcx = Math.floor(p.x / 64);
    const pcz = Math.floor(p.z / 64);
    const r = Math.ceil(R / 64);
    const keep = new Set<string>();
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (cx < 0 || cz < 0 || cx > 63 || cz > 63) continue; // scatter exists only inside the world
        const d = Math.hypot(Math.max(0, Math.abs(cx * 64 + 32 - p.x) - 32), Math.max(0, Math.abs(cz * 64 + 32 - p.z) - 32));
        if (d > R) continue;
        const k = `s:${cx}:${cz}`;
        keep.add(k);
        if (!this.chunks.has(k) && !this.pending.has(k)) this.submit(k, { type: 'scatter', cx, cz }, 120 + d * 0.4);
        if (this.tier.grassDistance > 0 && d < this.tier.grassDistance + 24) {
          const g = `g:${cx}:${cz}`;
          keep.add(g);
          if (!this.grass.has(g) && !this.pending.has(g)) this.submit(g, { type: 'grass', cx, cz, density: this.tier.grassDensity }, 20 + d);
        }
      }
    }
    this.pool.retain((k) => !(k.startsWith('s:') || k.startsWith('g:')) || keep.has(k));
    // Drop data well outside range (hysteresis: keep a ring so turning back is free).
    const far = R + 256;
    for (const [k, c] of this.chunks) {
      if (Math.hypot(c.cx * 64 + 32 - p.x, c.cz * 64 + 32 - p.z) > far) {
        this.chunks.delete(k);
        this.dirty = true;
      }
    }
    for (const [k, g] of this.grass) {
      if (Math.hypot(g.cx * 64 + 32 - p.x, g.cz * 64 + 32 - p.z) > this.tier.grassDistance + 128) {
        this.grass.delete(k);
        this.grassDirty = true;
      }
    }
    this.stats.chunks = this.chunks.size;
  }

  private submit(k: string, job: { type: 'scatter'; cx: number; cz: number } | { type: 'grass'; cx: number; cz: number; density: number }, prio: number): void {
    this.pending.add(k);
    this.pool
      .submit(k, job, prio)
      .then((r) => {
        this.pending.delete(k);
        if (!r || this.disposed) return;
        if (r.type === 'scatter') {
          this.chunks.set(k, r.scatter);
          this.stats.genMs.push(r.genMs);
          if (this.stats.genMs.length > 4096) this.stats.genMs.splice(0, 2048);
          this.dirty = true;
        } else if (r.type === 'grass') {
          this.grass.set(k, r.grass);
          this.grassDirty = true;
        }
      })
      .catch((err) => {
        this.pending.delete(k);
        console.warn('[scatter] job failed', k, err);
      });
  }

  private rebin(p: THREE.Vector3): void {
    const t0 = performance.now();
    this.dirty = false;
    this.lastRebin.copy(p);
    for (const b of this.bins) b.count = 0;
    const t = this.tier;
    const treeM = t.treeMeshDistance;
    const rockFar = Math.min(400, t.scatterDistance * 0.5);
    const R2 = (t.scatterDistance + 10) ** 2;
    const smallFar = Math.max(rockFar, t.smallScatterDistance) + 8;
    for (const c of this.chunks.values()) {
      const cdx = Math.max(0, Math.abs(c.cx * 64 + 32 - p.x) - 32);
      const cdz = Math.max(0, Math.abs(c.cz * 64 + 32 - p.z) - 32);
      const cd2 = cdx * cdx + cdz * cdz;
      if (cd2 > R2) continue;
      // Records are ordered trees, rocks, bushes, tufts (worldgen README). A
      // chunk beyond every small-scatter range only needs its trees, so stop
      // at the first non-tree record: most records are tufts.
      const treesOnly = cd2 > smallFar * smallFar;
      const rec = c.records;
      const n = rec.length / SCATTER_STRIDE;
      for (let i = 0; i < n; i++) {
        const o = i * SCATTER_STRIDE;
        const layer = rec[o];
        if (treesOnly && layer !== LAYER_TREE) break;
        const x = rec[o + 3];
        const z = rec[o + 5];
        const dx = x - p.x;
        const dy = rec[o + 4] - p.y;
        const dz = z - p.z;
        // 3D, like the shader's fades: flying over a forest must not bin
        // trees 50 m below into the near LOD the shader then fades out.
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (this.hidden.size && this.hidden.has(c.ids[i])) continue;
        if (layer === LAYER_TREE) {
          if (d > t.scatterDistance + 10) continue;
          const st = TREE_STYLE[rec[o + 1]] ?? TREE_STYLE[0];
          const lods = this.treeBins[st.arch];
          if (d < LOD0_M + BAND + 2) this.put(lods[0], c, i, st);
          if (d > LOD0_M - BAND - 2 && d < treeM + BAND * 2 + 2) this.put(d < TREE_SHADOW_M ? lods[1] : lods[3], c, i, st);
          if (d > treeM - BAND * 2 - 2) this.put(lods[2], c, i, st);
        } else if (layer === LAYER_ROCK) {
          if (d < rockFar + 4) this.put(d < SHADOW_NEAR_M ? this.rockBin : this.rockFarBin, c, i, ROCK_STYLE[rec[o + 1]] ?? ROCK_STYLE[0]);
        } else if (layer === LAYER_BUSH) {
          if (d < t.smallScatterDistance + 4) this.put(d < SHADOW_NEAR_M ? this.bushBin : this.bushFarBin, c, i, BUSH_STYLE[rec[o + 1]] ?? BUSH_STYLE[0]);
        } else if (layer === LAYER_TUFT) {
          if (d < t.smallScatterDistance * 0.75 + 4) this.put(this.tuftBin, c, i, TUFT_STYLE[rec[o + 1]] ?? TUFT_STYLE[0]);
        }
      }
    }
    let instances = 0;
    let tris = 0;
    for (const b of this.bins) {
      b.mesh.count = b.count;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      instances += b.count;
      tris += b.count * triCount(b.mesh.geometry);
    }
    this.stats.instances = instances;
    this.stats.tris = tris + this.stats.grassClumps * triCount(this.grassGeom);
    this.stats.rebinMs = performance.now() - t0;
  }

  private put(b: Bin, c: ScatterData, i: number, st: KindStyle): void {
    if (b.count >= b.capacity) this.grow(b);
    const rec = c.records;
    const o = i * SCATTER_STRIDE;
    const kind = rec[o + 1];
    const variant = rec[o + 2];
    // Scale byte -> 0.7..1.3 of the kind's size (worldgen leaves the mapping to the renderer).
    const s = 0.7 + (rec[o + 7] / 255) * 0.6;
    const yaw = rec[o + 6];
    const w = st.w * s;
    const h = st.h * s;
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const e = b.mesh.instanceMatrix.array as Float32Array;
    const m = b.count * 16;
    // Column-major: rotation about y times diag(w, h, w), then translation.
    // Sunk a little so bases sit in the ground on slopes.
    e[m] = cs * w;
    e[m + 1] = 0;
    e[m + 2] = -sn * w;
    e[m + 3] = 0;
    e[m + 4] = 0;
    e[m + 5] = h;
    e[m + 6] = 0;
    e[m + 7] = 0;
    e[m + 8] = sn * w;
    e[m + 9] = 0;
    e[m + 10] = cs * w;
    e[m + 11] = 0;
    e[m + 12] = rec[o + 3];
    e[m + 13] = rec[o + 4] - 0.15 * Math.min(h, 2);
    e[m + 14] = rec[o + 5];
    e[m + 15] = 1;
    let tint = st.tint;
    if (b === this.tuftBin && kind === 2) tint = FLOWER_TINTS[variant % FLOWER_TINTS.length];
    // Per-instance variation so a stand of oaks isn't one colour.
    const v = 0.88 + ((variant * 37) % 25) / 100;
    const ca = b.mesh.instanceColor!.array as Float32Array;
    ca[b.count * 3] = tint.r * v;
    ca[b.count * 3 + 1] = tint.g * v;
    ca[b.count * 3 + 2] = tint.b * v;
    b.ids[b.count] = c.ids[i];
    b.count++;
  }

  private grow(b: Bin): void {
    const cap = b.capacity * 2;
    const old = b.mesh;
    const m = b.make(cap);
    (m.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    (m.instanceColor!.array as Float32Array).set(old.instanceColor!.array as Float32Array);
    m.castShadow = old.castShadow;
    const ids = new BigUint64Array(cap);
    ids.set(b.ids);
    this.group.remove(old);
    old.dispose();
    this.group.add(m);
    b.mesh = m;
    b.ids = ids;
    b.capacity = cap;
  }

  private rebinGrass(p: THREE.Vector3): void {
    this.grassDirty = false;
    this.lastGrassRebin.copy(p);
    const R = this.tier.grassDistance + 2;
    const R2 = R * R;
    let n = 0;
    const lists: Float32Array[] = [];
    for (const g of this.grass.values()) {
      const cdx = Math.max(0, Math.abs(g.cx * 64 + 32 - p.x) - 32);
      const cdz = Math.max(0, Math.abs(g.cz * 64 + 32 - p.z) - 32);
      if (cdx * cdx + cdz * cdz > R2) continue;
      lists.push(g.instances);
      n += g.instances.length / 4;
    }
    if (n > this.grassCapacity) {
      this.grassCapacity = Math.max(1024, 1 << Math.ceil(Math.log2(n)));
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(this.grassCapacity * 4), 4);
      attr.setUsage(THREE.DynamicDrawUsage);
      this.grassGeom.setAttribute('aClump', attr);
    }
    const attr = this.grassGeom.getAttribute('aClump') as THREE.InstancedBufferAttribute | undefined;
    if (!attr) return;
    const out = attr.array as Float32Array;
    let k = 0;
    for (const l of lists) {
      for (let i = 0; i < l.length; i += 4) {
        const dx = l[i] - p.x;
        const dz = l[i + 2] - p.z;
        if (dx * dx + dz * dz > R2) continue;
        out[k * 4] = l[i];
        out[k * 4 + 1] = l[i + 1];
        out[k * 4 + 2] = l[i + 2];
        out[k * 4 + 3] = l[i + 3];
        k++;
      }
    }
    attr.needsUpdate = true;
    attr.addUpdateRange(0, k * 4);
    this.grassGeom.instanceCount = k;
    this.stats.grassClumps = k;
    void unpackGrass; // packing format documented in grassGen.ts
  }

  dispose(): void {
    this.disposed = true;
    for (const b of this.bins) b.mesh.dispose();
    for (const m of this.materials) m.dispose();
    this.grassGeom.dispose();
    this.impostors.dispose();
  }
}
