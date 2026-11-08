// Pure-TS readers for the atlas and chunk buffers produced by worldgen.wasm.
// The layouts are specified byte for byte in worldgen/README.md; this file is
// the reference reader. Everything is little-endian. No wasm needed here, so
// a client can parse a cached atlas or a chunk received from a worker.
import type { WorldSpec } from '@lodestone/contracts';

export const BIOMES = ['meadow', 'forest', 'highlands', 'snowpeak', 'badlands', 'wetland'] as const;
export type Biome = (typeof BIOMES)[number];
export const ELEMENTS = ['fire', 'ice', 'lightning', 'earth', 'wind', 'light', 'dark', 'void'] as const;
export type Element = (typeof ELEMENTS)[number];
/** Splat material order: plane A = [grass, dirt, rock, snow], plane B = [sand, mud, dominantBiome, moisture]. */
export const MATERIALS = ['grass', 'dirt', 'rock', 'snow', 'sand', 'mud'] as const;

export const SITE_CATEGORY = { poi: 0, settlement: 1, structure: 2 } as const;
export const POI_KINDS = ['tower', 'cave_mouth', 'waypoint', 'landmark', 'enemy_camp'] as const;
export const SETTLEMENT_SIZES = ['hamlet', 'village', 'town'] as const;
export const STRUCTURE_KINDS = ['ruin', 'watchtower', 'mineshaft', 'shrine', 'bandit_camp', 'wizard_tower', 'meteor_crater', 'sunken_temple', 'demon_lair'] as const;
export const LANDMARK_VARIANTS = ['standing_stones', 'great_tree', 'stone_arch', 'monolith', 'giant_bones', 'crystal_outcrop', 'statue', 'hot_spring'] as const;

/** Record kinds per layer (record byte 20). */
export const TREE_KINDS = ['oak', 'birch', 'broadleaf', 'pine', 'snow_fir', 'dead_tree', 'acacia', 'willow', 'cypress'] as const;
export const ROCK_KINDS = ['boulder', 'slab', 'spire', 'mossy', 'snowy'] as const;
export const BUSH_KINDS = ['shrub', 'berry_bush', 'fern', 'dry_scrub', 'reeds', 'heather'] as const;
export const GRASS_KINDS = ['tuft', 'tall_grass', 'flowers', 'dry_grass', 'snow_grass', 'marsh_grass'] as const;
export const CONTAINER_KINDS = ['chest', 'buried_cache', 'urn', 'crate'] as const;
/** Spawn-anchor enemy tables: 0..5 are the biome tables (BIOMES order). */
export const ENEMY_TABLES = [...BIOMES, 'bandit', 'demon', 'guardian'] as const;
/** Layer byte of stable ids (top byte of the packed id before mixing). */
export const LAYER = { tree: 1, rock: 2, bush: 3, grass: 4, container: 5, spawn: 6 } as const;

/** PARAMS section slots (f64). */
export const PARAM = {
  seaY: 0, peakH: 1, roughness: 2, plateaus: 3, enemyDensity: 4, dangerCurve: 5, flammability: 6, caveDensity: 7,
  oreAbundance: 8, structureDensity: 9, settlementDensity: 10, temperatureBias: 11, moistureBias: 12, windDirDeg: 13,
  stormFrequency: 14, demonIntensity: 15, lootThemeMask: 16, palette: 17, nameGrammar: 18, coverage800: 19,
  spawnX: 20, spawnZ: 21, spawnY: 22, landFractionActual: 23,
} as const;

export const ATLAS_MAGIC = 0x5441444c; // "LDAT"
export const CHUNK_MAGIC = 0x4b43444c; // "LDCK"
export const ATLAS_FORMAT = 1;
export const CHUNK_FORMAT = 1;
export const SEC = { spec: 0, params: 1, height: 2, water: 3, flow: 4, river: 5, biome: 6, temp: 7, moist: 8, nodeParams: 9, regions: 10, sites: 11, names: 12, coverage: 13 } as const;
export const CHUNK_SAMPLES = 65;
export const RECORD_SIZE = 24;
const NONE16 = 0xffff;

export interface Region {
  index: number;
  biome: Biome;
  element: Element;
  element2: Element;
  name: string;
  /** Site index of the region's tower, or -1. */
  tower: number;
  danger: number;
  landFraction: number;
  /** Biome mix over the region's land, fractions in BIOMES order. */
  biomeMix: number[];
  settlements: number;
  sites: number;
}

export interface Site {
  /** Dense index in the atlas site table (stable for the world; bitsets use it). */
  index: number;
  /** Stable 64-bit id (bijective mix of the packed tuple). */
  id: bigint;
  category: 'poi' | 'settlement' | 'structure';
  /** POI kind, 'settlement', or structure kind. */
  kind: string;
  /** Settlement size, landmark variant, structure/camp tier as a number. */
  size: number;
  region: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  score: number;
  name: string | null;
  biome: Biome;
  element: Element | null;
  visHeight: number;
  /** Walkable macro nodes that see this site within 800 m. */
  visCount: number;
  seed: number;
  /** Facing in radians, 0 = +x, increasing toward +z. */
  yaw: number;
  /** Linked site index (a settlement's waypoint), or -1. */
  link: number;
}

export interface AtlasData {
  formatVersion: number;
  genVersion: number;
  byteLength: number;
  seed: bigint;
  worldSize: number;
  macroRes: number;
  gridN: number;
  regionsPerEdge: number;
  regionChunks: number;
  seaY: number;
  spawn: { x: number; z: number };
  minHeight: number;
  maxHeight: number;
  spec: WorldSpec;
  params: Float64Array;
  /** Macro grids, gridN x gridN, row-major (index = j * gridN + i, node at x = i * macroRes, z = j * macroRes). */
  height: Float32Array;
  water: Float32Array;
  flow: Uint8Array;
  river: Uint8Array;
  biome: Uint8Array;
  temp: Uint8Array;
  moist: Uint8Array;
  /** 4 bytes per node: detail amp (0.1 m), terrace /255, ridge /255, flags (1 sea, 2 lake, 4 river, 8 settlement). */
  nodeParams: Uint8Array;
  coverage: Uint8Array;
  regions: Region[];
  sites: Site[];
  names: string[];
}

/** Ensure 8-byte alignment so typed-array views can sit on section offsets. */
function aligned(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
}

export function parseAtlas(input: Uint8Array): AtlasData {
  const b = aligned(input);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.byteLength < 192 || dv.getUint32(0, true) !== ATLAS_MAGIC) throw new Error('not an atlas (bad magic)');
  const formatVersion = dv.getUint16(4, true);
  if (formatVersion !== ATLAS_FORMAT) throw new Error(`atlas format ${formatVersion}, reader supports ${ATLAS_FORMAT}`);
  const byteLength = dv.getUint32(8, true);
  if (byteLength > b.byteLength) throw new Error('atlas truncated');
  const sec = (k: number) => ({ off: dv.getUint32(64 + k * 8, true), len: dv.getUint32(68 + k * 8, true) });
  const u8 = (k: number) => {
    const s = sec(k);
    return new Uint8Array(b.buffer, b.byteOffset + s.off, s.len);
  };
  const f32 = (k: number) => {
    const s = sec(k);
    return new Float32Array(b.buffer, b.byteOffset + s.off, s.len / 4);
  };
  const td = new TextDecoder();
  const spec = JSON.parse(td.decode(u8(SEC.spec))) as WorldSpec;
  const pr = sec(SEC.params);
  const params = new Float64Array(b.buffer, b.byteOffset + pr.off, pr.len / 8);

  const ns = sec(SEC.names);
  const names: string[] = [];
  {
    let o = ns.off;
    const n = dv.getUint32(o, true);
    o += 4;
    for (let i = 0; i < n; i++) {
      const len = dv.getUint16(o, true);
      names.push(td.decode(new Uint8Array(b.buffer, b.byteOffset + o + 2, len)));
      o += 2 + len;
    }
  }
  const name = (i: number) => (i === NONE16 ? null : names[i] ?? null);

  const ss = sec(SEC.sites);
  const sites: Site[] = [];
  {
    const n = dv.getUint32(ss.off, true);
    const rec = dv.getUint32(ss.off + 4, true);
    for (let i = 0; i < n; i++) {
      const o = ss.off + 8 + i * rec;
      const cat = dv.getUint8(o + 8);
      const kind = dv.getUint8(o + 9);
      const el = dv.getUint8(o + 35);
      const link = dv.getUint16(o + 46, true);
      sites.push({
        index: i,
        id: dv.getBigUint64(o, true),
        category: cat === 0 ? 'poi' : cat === 1 ? 'settlement' : 'structure',
        kind: cat === 0 ? POI_KINDS[kind] : cat === 1 ? 'settlement' : STRUCTURE_KINDS[kind],
        size: dv.getUint8(o + 11),
        region: dv.getUint8(o + 10),
        x: dv.getFloat32(o + 12, true),
        y: dv.getFloat32(o + 16, true),
        z: dv.getFloat32(o + 20, true),
        radius: dv.getFloat32(o + 24, true),
        score: dv.getFloat32(o + 28, true),
        name: name(dv.getUint16(o + 32, true)),
        biome: BIOMES[dv.getUint8(o + 34)],
        element: el === 255 ? null : ELEMENTS[el],
        visHeight: dv.getUint8(o + 36),
        visCount: dv.getUint16(o + 38, true),
        seed: dv.getUint32(o + 40, true),
        yaw: (dv.getUint16(o + 44, true) / 65536) * Math.PI * 2,
        link: link === NONE16 ? -1 : link,
      });
    }
  }

  const rs = sec(SEC.regions);
  const regions: Region[] = [];
  for (let r = 0; r < rs.len / 32; r++) {
    const o = rs.off + r * 32;
    const tower = dv.getUint16(o + 6, true);
    regions.push({
      index: r,
      biome: BIOMES[dv.getUint8(o + 1)],
      element: ELEMENTS[dv.getUint8(o + 2)],
      element2: ELEMENTS[dv.getUint8(o + 3)],
      name: name(dv.getUint16(o + 4, true)) ?? '',
      tower: tower === NONE16 ? -1 : tower,
      danger: dv.getFloat32(o + 8, true),
      landFraction: dv.getFloat32(o + 12, true),
      biomeMix: Array.from({ length: 6 }, (_, k) => dv.getUint8(o + 16 + k) / 255),
      settlements: dv.getUint8(o + 22),
      sites: dv.getUint8(o + 23),
    });
  }

  return {
    formatVersion,
    genVersion: dv.getUint16(6, true),
    byteLength,
    seed: dv.getBigUint64(16, true),
    worldSize: dv.getUint16(24, true),
    macroRes: dv.getUint16(26, true),
    gridN: dv.getUint16(28, true),
    regionsPerEdge: dv.getUint8(30),
    regionChunks: dv.getUint8(31),
    seaY: dv.getFloat32(32, true),
    spawn: { x: dv.getFloat32(36, true), z: dv.getFloat32(40, true) },
    minHeight: dv.getFloat32(44, true),
    maxHeight: dv.getFloat32(48, true),
    spec,
    params,
    height: f32(SEC.height),
    water: f32(SEC.water),
    flow: u8(SEC.flow),
    river: u8(SEC.river),
    biome: u8(SEC.biome),
    temp: u8(SEC.temp),
    moist: u8(SEC.moist),
    nodeParams: u8(SEC.nodeParams),
    coverage: u8(SEC.coverage),
    regions,
    sites,
    names,
  };
}

export interface ChunkRecord {
  id: bigint;
  x: number;
  y: number;
  z: number;
  kind: number;
  variant: number;
  /** Raw byte; scatter: renderer scale factor 0..255; anchors: danger * 255. */
  scale: number;
  /** Radians, 0 = +x toward +z. */
  yaw: number;
}

/** Zero-copy accessor over a run of 24-byte records. */
export class RecordList {
  constructor(
    private readonly dv: DataView,
    private readonly offset: number,
    readonly count: number,
  ) {}
  private o(i: number) {
    return this.offset + i * RECORD_SIZE;
  }
  id(i: number): bigint {
    return this.dv.getBigUint64(this.o(i), true);
  }
  x(i: number): number {
    return this.dv.getFloat32(this.o(i) + 8, true);
  }
  y(i: number): number {
    return this.dv.getFloat32(this.o(i) + 12, true);
  }
  z(i: number): number {
    return this.dv.getFloat32(this.o(i) + 16, true);
  }
  kind(i: number): number {
    return this.dv.getUint8(this.o(i) + 20);
  }
  variant(i: number): number {
    return this.dv.getUint8(this.o(i) + 21);
  }
  scale(i: number): number {
    return this.dv.getUint8(this.o(i) + 22);
  }
  yaw(i: number): number {
    return (this.dv.getUint8(this.o(i) + 23) / 256) * Math.PI * 2;
  }
  get(i: number): ChunkRecord {
    return { id: this.id(i), x: this.x(i), y: this.y(i), z: this.z(i), kind: this.kind(i), variant: this.variant(i), scale: this.scale(i), yaw: this.yaw(i) };
  }
  toArray(): ChunkRecord[] {
    return Array.from({ length: this.count }, (_, i) => this.get(i));
  }
}

export interface ChunkData {
  bytes: Uint8Array;
  cx: number;
  cz: number;
  lod: number;
  samples: number;
  /** Lattice spacing in meters (2^lod). Sample (i, j) is at (cx*64 + i*step, cz*64 + j*step). */
  step: number;
  minHeight: number;
  maxHeight: number;
  /** Some water surface lies above the ground in this chunk. */
  hasWater: boolean;
  /** samples^2 f32, index j * samples + i. */
  heights: Float32Array;
  water: Float32Array;
  /** samples^2 RGBA8: grass, dirt, rock, snow. */
  splatA: Uint8Array;
  /** samples^2 RGBA8: sand, mud, dominant biome id, moisture * 255. */
  splatB: Uint8Array;
  scatter: RecordList;
  containers: RecordList;
  spawns: RecordList;
}

export function parseChunk(input: Uint8Array): ChunkData {
  const b = aligned(input);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.byteLength < 64 || dv.getUint32(0, true) !== CHUNK_MAGIC) throw new Error('not a chunk (bad magic)');
  const fmt = dv.getUint16(4, true);
  if (fmt !== CHUNK_FORMAT) throw new Error(`chunk format ${fmt}, reader supports ${CHUNK_FORMAT}`);
  const s = dv.getUint16(22, true);
  const ss = s * s;
  const offH = dv.getUint32(36, true);
  const offW = dv.getUint32(40, true);
  const offA = dv.getUint32(44, true);
  const offB = dv.getUint32(48, true);
  const offR = dv.getUint32(52, true);
  const nS = dv.getUint16(56, true);
  const nC = dv.getUint16(58, true);
  const nP = dv.getUint16(60, true);
  const rec = dv.getUint16(62, true);
  if (rec !== RECORD_SIZE) throw new Error(`record size ${rec}`);
  const flags = dv.getUint8(21);
  return {
    bytes: b,
    cx: dv.getInt32(12, true),
    cz: dv.getInt32(16, true),
    lod: dv.getUint8(20),
    samples: s,
    step: dv.getFloat32(24, true),
    minHeight: dv.getFloat32(28, true),
    maxHeight: dv.getFloat32(32, true),
    hasWater: (flags & 1) !== 0,
    heights: new Float32Array(b.buffer, b.byteOffset + offH, ss),
    water: new Float32Array(b.buffer, b.byteOffset + offW, ss),
    splatA: new Uint8Array(b.buffer, b.byteOffset + offA, ss * 4),
    splatB: new Uint8Array(b.buffer, b.byteOffset + offB, ss * 4),
    scatter: new RecordList(dv, offR, nS),
    containers: new RecordList(dv, offR + nS * RECORD_SIZE, nC),
    spawns: new RecordList(dv, offR + (nS + nC) * RECORD_SIZE, nP),
  };
}

/**
 * Surface height at (x, z) from a LOD-0 chunk's own lattice: the exact
 * formula of the wasm `collision_height` (README "Collision"), so a client
 * can query ground without a wasm call and still match the server bit for bit.
 * (x, z) must lie inside the chunk.
 */
export function chunkSurfaceHeight(c: ChunkData, x: number, z: number): number {
  if (c.lod !== 0) throw new Error('chunkSurfaceHeight needs a LOD 0 chunk');
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const i = x0 - c.cx * 64;
  const j = z0 - c.cz * 64;
  if (i < 0 || j < 0 || i > 64 || j > 64) throw new RangeError('point outside chunk');
  const s = c.samples;
  const at = (ii: number, jj: number) => c.heights[jj * s + ii];
  const h00 = at(i, j);
  const h10 = at(Math.min(i + 1, 64), j);
  const h01 = at(i, Math.min(j + 1, 64));
  const h11 = at(Math.min(i + 1, 64), Math.min(j + 1, 64));
  const fx = x - x0;
  const fz = z - z0;
  if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

/** FNV-1a 64, identical to the wasm `hash_buffer`. */
export function fnv1a64(bytes: Uint8Array): bigint {
  // Two 32-bit halves keep this fast without BigInt in the loop.
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < bytes.length; i++) {
    lo ^= bytes[i];
    // h *= 0x100000001b3 = h * (2^40 + 0x1b3)
    const lLo = (lo & 0xffff) * 0x1b3;
    const lHi = (lo >>> 16) * 0x1b3 + (lLo >>> 16);
    const newLo = ((lHi & 0xffff) << 16) | (lLo & 0xffff);
    const carry = Math.floor(lHi / 0x10000);
    hi = (Math.imul(hi, 0x1b3) + carry + (lo << 8)) >>> 0;
    lo = newLo >>> 0;
  }
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

export function hex64(v: bigint): string {
  return v.toString(16).padStart(16, '0');
}
