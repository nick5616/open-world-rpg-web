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
import { applyRichShader, createBillboardMaterial, createRichMaterial, createScatterMaterial, type RichOptions, type ScatterMaterial } from './scatterMaterials';
import { billboardQuad, createBakeMaterial, renderImpostorAtlas } from './impostors';
import { barkTexture, leafAtlas, stoneTexture } from './natureTextures';
import { disposeTreeCache, richTree, TREE_SPECIES, TREE_VARIANTS } from './treeGen';
import { disposeGroundcoverCache, richBush, richGrassClump, richRock, richTuft, type BushType, type RockShape } from './groundcoverGen';
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
  /** May cast shadows (the tier decides whether it does). */
  shadows: boolean;
  mesh: THREE.InstancedMesh;
  capacity: number;
  count: number;
  ids: BigUint64Array;
  make: (cap: number) => THREE.InstancedMesh;
}

/** The rich vegetation set (WorldTier.vegetation >= 1): bins per species, variant and LOD. */
interface Kit {
  level: number;
  bins: Bin[];
  materials: THREE.Material[];
  /** Per tree kind: variants x [lod0, lod1 (shadows), lod1 far] and the impostor bin. */
  trees: { variants: Bin[][]; imp: Bin; lod0: ScatterMaterial; lod1: ScatterMaterial; bb: ScatterMaterial }[];
  rocks: { near: Bin; far: Bin; nearMat: ScatterMaterial; farMat: ScatterMaterial }[];
  bushes: { near: Bin; far: Bin; nearMat: ScatterMaterial; farMat: ScatterMaterial }[];
  tuft: Bin;
  flowers: Bin;
  tuftMats: ScatterMaterial[];
  grassGeom: THREE.InstancedBufferGeometry;
  grassMat: THREE.MeshStandardMaterial;
  impostors: THREE.WebGLRenderTarget;
}
const BUSH_TYPE_BY_KIND: BushType[] = ['shrub', 'shrub', 'fern', 'scrub', 'reeds', 'heather'];
const BUSH_TYPES_ORDER: BushType[] = ['shrub', 'scrub', 'heather', 'fern', 'reeds'];
/** Rock kinds (worldgen order): shape, seed, moss, snow. */
const ROCK_KITS: { shape: RockShape; seed: number; moss: number; snow: number }[] = [
  { shape: 'boulder', seed: 0, moss: 0.25, snow: 0 }, // boulder
  { shape: 'slab', seed: 1, moss: 0.2, snow: 0 }, // slab
  { shape: 'spire', seed: 2, moss: 0.06, snow: 0 }, // spire
  { shape: 'boulder', seed: 3, moss: 1, snow: 0 }, // mossy
  { shape: 'boulder', seed: 4, moss: 0, snow: 1 }, // snowy
];
const ROCK_NEAR_M = 70;
const BUSH_NEAR_M = 48;

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
  private legacyBins: Bin[] = [];
  private kit: Kit | null = null;
  private vegLevel = 0;
  private legacyGrassMat!: THREE.Material;
  private renderer: THREE.WebGLRenderer;
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
  private kitApplyTier: ((t: WorldTier) => void) | null = null;
  private disposed = false;

  constructor(
    private readonly pool: WorkerPool,
    renderer: THREE.WebGLRenderer,
    private tier: WorldTier,
    private readonly light: LightUniforms,
  ) {
    this.group.name = 'scatter';
    this.renderer = renderer;
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
    this.legacyGrassMat = this.grassMaterial();
    this.grassMesh = new THREE.Mesh(this.grassGeom, this.legacyGrassMat);
    this.grassMesh.frustumCulled = false;
    this.grassMesh.receiveShadow = true;
    this.grassMesh.name = 'grass';
    this.group.add(this.grassMesh);
    this.legacyBins = [...this.bins];
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
    const b: Bin = { shadows, mesh: make(256), capacity: 256, count: 0, ids: new BigUint64Array(256), make };
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
    (this.legacyGrassMat as THREE.Material).userData.grassRange.value.set(t.grassDistance * 0.7, t.grassDistance);
    if (this.kit) (this.kit.grassMat as THREE.Material).userData.grassRange.value.set(t.grassDistance * 0.7, t.grassDistance);
    this.grassMesh.visible = t.grassDistance > 0;
    this.kitApplyTier?.(t);
    for (const b of this.bins) b.mesh.castShadow = t.shadowDistance > 0 && b.shadows;
    this.dirty = true;
    this.grassDirty = true;
  }

  /**
   * Switch the vegetation art: 0 = the original low-poly set (Low keeps its
   * cost), 1..3 = the rich set (card-leaf trees with bark, bushes and ferns,
   * bent-blade grass with flowers, fractured rocks) at increasing card
   * counts. Follows the *shader* tier (explicit quality choice), because it
   * brings new shader programs: auto-quality steps never swap it mid-play.
   */
  setVegetation(level: number): void {
    if (this.disposed) return;
    const lv = Math.max(0, Math.min(3, Math.round(level)));
    if (lv === this.vegLevel && (lv === 0 || this.kit)) return;
    this.vegLevel = lv;
    this.disposeKit();
    for (const b of this.legacyBins) b.mesh.visible = lv === 0;
    if (lv > 0) this.kit = this.buildKit(lv);
    this.grassMesh.geometry = this.kit ? this.kit.grassGeom : this.grassGeom;
    this.grassMesh.material = this.kit ? this.kit.grassMat : this.legacyGrassMat;
    this.applyTier(this.tier);
    this.dirty = true;
    this.grassDirty = true;
  }

  private richMat(o: RichOptions, into: THREE.Material[]): ScatterMaterial {
    const m = createRichMaterial(o);
    this.materials.push(m);
    into.push(m);
    this.onMaterial?.(m);
    return m;
  }

  private buildKit(level: number): Kit {
    const scale = level === 1 ? 0.6 : level === 2 ? 1 : 1.3;
    const atlas = leafAtlas();
    const stone = stoneTexture();
    const light = this.light;
    const mats: THREE.Material[] = [];
    const first = this.bins.length;
    const off = new THREE.Vector4(-1, 0, 0, 0);
    // Trees.
    const lod0 = TREE_SPECIES.map((_, si) => richTree(si, 0, { lod: 0, scale }));
    const barks = TREE_SPECIES.map((sp) => barkTexture(sp.bark));
    const impostors = renderImpostorAtlas(
      this.renderer,
      lod0,
      barks.map((b) => createBakeMaterial(atlas, b)),
    );
    const quad = billboardQuad();
    const trees: Kit['trees'] = TREE_SPECIES.map((sp, si) => {
      const base = { light, mode: 'tree' as const, atlas, bark: barks[si], translucency: 0.55, bump: 1.4 };
      const m0 = this.richMat({ ...base, fade: new THREE.Vector4(-1, 0, LOD0_M - BAND, LOD0_M + BAND), sway: 0.006, flutter: 0.004, branch: sp.habit === 'conifer' ? 0.006 : 0.012 }, mats);
      const m1 = this.richMat({ ...base, bump: 0, translucency: 0.45, fade: new THREE.Vector4(LOD0_M - BAND, LOD0_M + BAND, 0, 0), sway: 0.006, flutter: 0.002, branch: 0.008 }, mats);
      const bb = createBillboardMaterial(impostors.texture, si, TREE_SPECIES.length, new THREE.Vector4(0, 0, 0, 0), light);
      this.materials.push(bb);
      mats.push(bb);
      // Variants differ only in the near mesh: past 60 m one grown shape per species is enough
      // (and halves the bins, so the shadow passes stay cheap).
      const g1 = richTree(si, 0, { lod: 1, scale });
      const lod1 = this.bin(g1, m1, true, `tree ${sp.name} lod1`);
      const lod1Far = this.bin(g1, m1, false, `tree ${sp.name} lod1 far`);
      const variants: Bin[][] = [];
      for (let v = 0; v < TREE_VARIANTS; v++) variants.push([this.bin(richTree(si, v, { lod: 0, scale }), m0, true, `tree ${sp.name}${v} lod0`), lod1, lod1Far]);
      return { variants, imp: this.bin(quad, bb, false, `tree ${sp.name} impostor`), lod0: m0, lod1: m1, bb };
    });
    // Rocks: a near fractured mesh and a low far mesh per kind, cross-faded.
    const rocks: Kit['rocks'] = ROCK_KITS.map((rk, i) => {
      const o = { light, mode: 'rock' as const, stone, bump: 2.2, moss: rk.moss, snow: rk.snow, sway: 0, flutter: 0, roughness: 0.95 };
      const nearMat = this.richMat({ ...o, fade: new THREE.Vector4(-1, 0, ROCK_NEAR_M - BAND * 3, ROCK_NEAR_M + BAND * 3) }, mats);
      const farMat = this.richMat({ ...o, bump: 0, fade: new THREE.Vector4(ROCK_NEAR_M - BAND * 3, ROCK_NEAR_M + BAND * 3, 0, 0) }, mats);
      return { nearMat, farMat, near: this.bin(richRock(rk.shape, rk.seed, 3), nearMat, true, `rock ${i}`), far: this.bin(richRock(rk.shape, rk.seed, 1), farMat, false, `rock ${i} far`) };
    });
    // Bushes by type: leaf-card shrubs, scrub, heather, fronds, reeds.
    const bushes: Kit['bushes'] = BUSH_TYPES_ORDER.map((type) => {
      const reed = type === 'reeds';
      const o = { light, mode: 'tree' as const, atlas, translucency: 0.8, sway: reed ? 0.05 : type === 'fern' ? 0.015 : 0.02, flutter: 0.01, branch: reed ? 0 : 0.01, doubleSided: true };
      const nearMat = this.richMat({ ...o, fade: new THREE.Vector4(-1, 0, BUSH_NEAR_M - BAND * 2, BUSH_NEAR_M + BAND * 2) }, mats);
      const farMat = this.richMat({ ...o, fade: new THREE.Vector4(BUSH_NEAR_M - BAND * 2, BUSH_NEAR_M + BAND * 2, 0, 0) }, mats);
      return { nearMat, farMat, near: this.bin(richBush(type, 0, scale), nearMat, true, `bush ${type}`), far: this.bin(richBush(type, 1, scale), farMat, false, `bush ${type} far`) };
    });
    // Tufts and flower clumps (sparse scatter layer); fade like the legacy tufts.
    const tuftMats: ScatterMaterial[] = [];
    const to = { light, mode: 'tree' as const, atlas, translucency: 0.8, sway: 0.06, flutter: 0.01, doubleSided: true, fade: off };
    const tuft = this.bin(richTuft(false), this.richMat(to, mats), false, 'tufts');
    const flowers = this.bin(richTuft(true), this.richMat(to, mats), false, 'flower tufts');
    tuftMats.push(tuft.mesh.material as ScatterMaterial, flowers.mesh.material as ScatterMaterial);
    // Dense meadow clumps with bent blades and flower heads.
    const clump = richGrassClump(9, true);
    const grassGeom = new THREE.InstancedBufferGeometry();
    grassGeom.index = clump.index;
    for (const [k, v] of Object.entries(clump.attributes)) grassGeom.setAttribute(k, v);
    grassGeom.instanceCount = 0;
    const existing = this.grassGeom.getAttribute('aClump');
    if (existing) grassGeom.setAttribute('aClump', existing);
    const grassMat = this.richGrassMaterial(light, atlas, mats);
    const kit: Kit = { level, bins: this.bins.slice(first), materials: mats, trees, rocks, bushes, tuft, flowers, tuftMats, grassGeom, grassMat, impostors };
    this.kitApplyTier = (t) => {
      const treeM = t.treeMeshDistance;
      for (const tk of trees) {
        tk.lod1.userData.fade.value.set(LOD0_M - BAND, LOD0_M + BAND, treeM - BAND * 2, treeM + BAND * 2);
        tk.bb.userData.fade.value.set(treeM - BAND * 2, treeM + BAND * 2, t.scatterDistance * 0.88, t.scatterDistance);
      }
      const rockFar = Math.min(400, t.scatterDistance * 0.5);
      for (const rk of rocks) rk.farMat.userData.fade.value.set(ROCK_NEAR_M - BAND * 3, ROCK_NEAR_M + BAND * 3, rockFar * 0.85, rockFar);
      for (const bk of bushes) bk.farMat.userData.fade.value.set(BUSH_NEAR_M - BAND * 2, BUSH_NEAR_M + BAND * 2, t.smallScatterDistance * 0.8, t.smallScatterDistance);
      for (const m of tuftMats) m.userData.fade.value.set(-1, 0, t.smallScatterDistance * 0.6, t.smallScatterDistance * 0.75);
    };
    return kit;
  }

  /** The dense-grass material of the rich set: bent blades, flower heads on a hashed subset of clumps, back-lit like leaves. */
  private richGrassMaterial(light: RichOptions['light'], atlas: THREE.Texture, into: THREE.Material[]): THREE.MeshStandardMaterial {
    const m = this.grassMaterial() as THREE.MeshStandardMaterial;
    this.materials.push(m);
    into.push(m);
    m.map = atlas;
    m.alphaTest = 0.42;
    const base = m.onBeforeCompile;
    m.onBeforeCompile = (shader, r) => {
      base.call(m, shader, r);
      shader.vertexShader = shader.vertexShader.replace(
        'vec3 p = transformed;',
        `vec3 p = transformed;
          // Flower heads (aFoliage 2) show on ~7 % of clumps, in a hashed palette; elsewhere they collapse to a point.
          float hh = fract(sin(dot(iPos.xz, vec2(12.9898, 78.233))) * 43758.5453);
          float isHead = step(1.5, aFoliage);
          float showHead = step(hh, 0.07);
          p *= mix(1.0, showHead, isHead);
          float pal = fract(hh * 97.13);
          vec3 headCol = pal < 0.3 ? vec3(1.1, 1.05, 0.9) : (pal < 0.55 ? vec3(1.2, 0.85, 0.2) : (pal < 0.8 ? vec3(1.1, 0.45, 0.65) : vec3(0.55, 0.6, 1.2)));
          vColor.rgb = mix(vColor.rgb, headCol * color.rgb, isHead);`,
      );
      applyRichShader(shader as never, { light, mode: 'grass', atlas, fade: new THREE.Vector4(), sway: 0, flutter: 0, translucency: 0.9 });
    };
    m.customProgramCacheKey = () => 'lodestone-grass-rich-1';
    return m;
  }

  private disposeKit(): void {
    const kit = this.kit;
    if (!kit) return;
    this.kit = null;
    this.kitApplyTier = null;
    for (const b of kit.bins) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
      const i = this.bins.indexOf(b);
      if (i >= 0) this.bins.splice(i, 1);
    }
    for (const m of kit.materials) {
      const i = this.materials.indexOf(m);
      if (i >= 0) this.materials.splice(i, 1);
      m.dispose();
    }
    kit.grassGeom.dispose();
    kit.impostors.dispose();
    disposeTreeCache();
    disposeGroundcoverCache();
  }

  /** Stable id of an instance (raycast hit -> world object). */
  idAt(mesh: THREE.Object3D, instance: number): bigint | null {
    const b = this.bins.find((x) => x.mesh === mesh);
    return b && instance < b.count ? b.ids[instance] : null;
  }

  /** Dev: instances and triangles per bin (what the frame is spending on). */
  binReport(): { name: string; count: number; tris: number }[] {
    return this.bins.filter((b) => b.count > 0).map((b) => ({ name: b.mesh.name, count: b.count, tris: b.count * triCount(b.mesh.geometry) })).sort((a, b) => b.tris - a.tris);
  }

  /** Nearest loaded scatter record of a layer (and kind, if >= 0) to a point: dev tooling (evidence shots). */
  findNear(layer: number, kind: number, x: number, z: number): { x: number; y: number; z: number; kind: number } | null {
    let best: { x: number; y: number; z: number; kind: number } | null = null;
    let bd = Infinity;
    for (const c of this.chunks.values()) {
      const rec = c.records;
      for (let o = 0; o < rec.length; o += SCATTER_STRIDE) {
        if (rec[o] !== layer || (kind >= 0 && rec[o + 1] !== kind)) continue;
        const d = (rec[o + 3] - x) ** 2 + (rec[o + 5] - z) ** 2;
        if (d < bd) {
          bd = d;
          best = { x: rec[o + 3], y: rec[o + 4], z: rec[o + 5], kind: rec[o + 1] };
        }
      }
    }
    return best;
  }

  /** Hide one object by stable id (world edits: "tree 0x9f3a burned"). */
  hide(id: bigint): void {
    this.hidden.add(id);
    this.dirty = true;
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
    const kit = this.kit;
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
          const kind = TREE_STYLE[rec[o + 1]] ? rec[o + 1] : 0;
          const st = TREE_STYLE[kind];
          if (kit) {
            // Rich: per species, variant (grown from another seed) and LOD; the instance keeps its id in every bin.
            const tk = kit.trees[kind];
            const vb = tk.variants[rec[o + 2] % TREE_VARIANTS];
            if (d < LOD0_M + BAND + 2) this.put(vb[0], c, i, st);
            if (d > LOD0_M - BAND - 2 && d < treeM + BAND * 2 + 2) this.put(d < TREE_SHADOW_M ? vb[1] : vb[2], c, i, st);
            if (d > treeM - BAND * 2 - 2) this.put(tk.imp, c, i, st);
          } else {
            const lods = this.treeBins[st.arch];
            if (d < LOD0_M + BAND + 2) this.put(lods[0], c, i, st);
            if (d > LOD0_M - BAND - 2 && d < treeM + BAND * 2 + 2) this.put(d < TREE_SHADOW_M ? lods[1] : lods[3], c, i, st);
            if (d > treeM - BAND * 2 - 2) this.put(lods[2], c, i, st);
          }
        } else if (layer === LAYER_ROCK) {
          if (d < rockFar + 4) {
            const kind = ROCK_STYLE[rec[o + 1]] ? rec[o + 1] : 0;
            if (kit) {
              const rk = kit.rocks[kind];
              if (d < ROCK_NEAR_M + BAND * 3 + 2) this.put(rk.near, c, i, ROCK_STYLE[kind]);
              if (d > ROCK_NEAR_M - BAND * 3 - 2) this.put(rk.far, c, i, ROCK_STYLE[kind]);
            } else this.put(d < SHADOW_NEAR_M ? this.rockBin : this.rockFarBin, c, i, ROCK_STYLE[kind]);
          }
        } else if (layer === LAYER_BUSH) {
          if (d < t.smallScatterDistance + 4) {
            const kind = BUSH_STYLE[rec[o + 1]] ? rec[o + 1] : 0;
            if (kit) {
              const bk = kit.bushes[BUSH_TYPES_ORDER.indexOf(BUSH_TYPE_BY_KIND[kind])];
              if (d < BUSH_NEAR_M + BAND * 2 + 2) this.put(bk.near, c, i, BUSH_STYLE[kind]);
              if (d > BUSH_NEAR_M - BAND * 2 - 2) this.put(bk.far, c, i, BUSH_STYLE[kind]);
            } else this.put(d < SHADOW_NEAR_M ? this.bushBin : this.bushFarBin, c, i, BUSH_STYLE[kind]);
          }
        } else if (layer === LAYER_TUFT) {
          if (d < t.smallScatterDistance * 0.75 + 4) {
            const kind = TUFT_STYLE[rec[o + 1]] ? rec[o + 1] : 0;
            this.put(kit ? (kind === 2 ? kit.flowers : kit.tuft) : this.tuftBin, c, i, TUFT_STYLE[kind]);
          }
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
    this.stats.tris = tris + this.stats.grassClumps * triCount(this.kit ? this.kit.grassGeom : this.grassGeom);
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
    if ((b === this.tuftBin || b === this.kit?.flowers) && kind === 2) tint = FLOWER_TINTS[variant % FLOWER_TINTS.length];
    // Per-instance variation so a stand of oaks isn't one colour.
    const v = 0.88 + ((variant * 37) % 25) / 100;
    const ca = b.mesh.instanceColor!.array as Float32Array;
    // Rich: also a per-instance hue drift (a stand of oaks is never one green).
    const hue = this.kit ? (((variant * 53) % 31) / 31 - 0.5) * 0.2 : 0;
    ca[b.count * 3] = tint.r * v * (1 + hue);
    ca[b.count * 3 + 1] = tint.g * v;
    ca[b.count * 3 + 2] = tint.b * v * (1 - hue);
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
    m.visible = old.visible;
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
    const geoms = this.kit ? [this.grassGeom, this.kit.grassGeom] : [this.grassGeom];
    if (n > this.grassCapacity) {
      this.grassCapacity = Math.max(1024, 1 << Math.ceil(Math.log2(n)));
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(this.grassCapacity * 4), 4);
      attr.setUsage(THREE.DynamicDrawUsage);
      for (const g of geoms) g.setAttribute('aClump', attr);
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
    for (const g of geoms) g.instanceCount = k;
    this.stats.grassClumps = k;
    void unpackGrass; // packing format documented in grassGen.ts
  }

  dispose(): void {
    this.disposed = true;
    for (const b of this.bins) b.mesh.dispose();
    for (const m of this.materials) m.dispose();
    this.grassGeom.dispose();
    this.impostors.dispose();
    this.disposeKit();
  }
}
