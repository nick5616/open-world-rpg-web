// The vertical world (genVersion 3, docs/cr/038-vertical-world.md):
// sky archipelagos, the Underground caverns and the Depths. Readers for the
// descriptor (`vertical_build`, LDVT) and layer tiles (`layer_tile`, LDLT),
// and the collision core the movement step stands on (README "Vertical
// world: collision and ground dispatch"). The Go port is
// server/pkg/vertical; both are pinned by the golden table's vertical
// vectors, so keep the two line for line (f64, same operation order).
import type { AtlasHandle, Worldgen } from './index';
import { caveMasked } from './cave';
import { fnv1a64, hex64 } from './format';

export const LAYER_SURFACE = 0;
export const LAYER_SKY = 1;
export const LAYER_UNDER = 2;
export const LAYER_DEPTHS = 3;
export const LAYER_NAMES = ['surface', 'sky', 'underground', 'depths'] as const;

/** Surfaces of `layer_height` (README): 0..2 Underground floor/ceiling/water, 3..5 Depths floor/ceiling/lava, 6..7 island top/bottom. */
export const SURF = { uFloor: 0, uCeil: 1, uWater: 2, dFloor: 3, dCeil: 4, dLava: 5, skyTop: 6, skyBottom: 7 } as const;

export const ISLAND_KINDS = ['grove', 'meadow', 'crag', 'town', 'palace', 'ruin'] as const;
export const CHAMBER_KINDS = ['crystal', 'cenote', 'river', 'fungal', 'inferno', 'ashen'] as const;
export const UPDRAFT_KINDS = ['column', 'lift', 'current', 'geyser'] as const;
export const OPENING_KINDS = ['tunnel', 'cenote', 'gate'] as const;
/** Decoration kinds (worldgen/src/vertical/mod.rs `dk`). */
export const DECO = {
  crystal: 0, spire: 1, mushroom: 2, flora: 3, stalactite: 4, stalagmite: 5, vines: 6, waterfall: 7, lavafall: 8, vent: 9,
  obsidian: 10, embers: 11, campfire: 12, tent: 13, portal: 14, lift: 15, palace: 16, activity: 17, tree: 18, rock: 19,
  pillar: 20, skyfall: 21, cloud: 22, geyser: 23, shrine: 24, gate: 25, lightshaft: 26, lantern: 27,
} as const;
export const DECO_LIGHT = 1;
export const DECO_HANG = 2;
export const NONE16 = 0xffff;
/** Ceiling value inside an opening; water value of "no water". */
export const OPEN_C = 10000;
export const NO_WATER = -10000;

export interface Arch { id: bigint; x: number; z: number; r: number; base: number; cloudY: number; site: number; firstIsland: number; islands: number; town: number }
export interface Island { index: number; id: bigint; x: number; z: number; r: number; reach: number; top: number; thick: number; cliff: number; amp: number; kind: number; arch: number; site: number; biome: number; seed: number; lobes: [number, number, number][] }
export interface Updraft { x: number; z: number; r: number; bottom: number; top: number; lift: number; kind: number; arch: number }
export interface Chamber { index: number; id: bigint; x: number; z: number; rx: number; rz: number; c: number; s: number; floor: number; height: number; lake: number; lakeE: number; lakeDepth: number; reach: number; layer: number; kind: number; tint: number; seed: number; site: number }
export interface Corridor { layer: number; kind: number; lava: boolean; from: number; to: number; hw: number; height: number; water: number; pts: Float32Array }
/** Same shape as a CaveOpening for the mask rule (x, z, rMask). */
export interface VOpening { x: number; z: number; rMask: number; y: number; into: number; kind: number; yaw: number; site: number; target: number }
export interface Shaft { x: number; z: number; r: number; bottom: number; top: number; chamber: number }
export interface Column { x: number; z: number; r: number; y0: number; y1: number; layer: number; chamber: number }
export interface Deco { x: number; y: number; z: number; size: number; kind: number; tint: number; layer: number; flags: number; yaw: number; aux: number }
export interface VVein { id: bigint; x: number; y: number; z: number; nx: number; ny: number; nz: number; kind: number; material: number; element: number; hp: number; size: number; flags: number; band: number; chamber: number }

export interface VerticalWorld {
  genVersion: number;
  baseSites: number;
  archs: Arch[];
  islands: Island[];
  updrafts: Updraft[];
  chambers: Chamber[];
  corridors: Corridor[];
  openings: VOpening[];
  /** Tunnel mouths and cenote tops: holes in the terrain (into the Underground). */
  surfaceOpenings: VOpening[];
  /** Depths gates: holes in the Underground floor. */
  gateOpenings: VOpening[];
  shafts: Shaft[];
  columns: Column[];
  decos: Deco[];
  veins: VVein[];
  /** Per layer (index 0 = sky, 1 = Underground, 2 = Depths): 64 x 64 chunk bits. */
  domain: Uint8Array[];
}

export function parseVertical(bytes: Uint8Array): VerticalWorld {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'LDVT') throw new Error(`not a vertical descriptor (${magic})`);
  const n = (k: number) => dv.getUint32(12 + k * 4, true);
  const off = (k: number) => dv.getUint32(56 + k * 4, true);
  const f = (o: number) => dv.getFloat32(o, true);
  const u16 = (o: number) => dv.getUint16(o, true);
  const archs: Arch[] = [];
  for (let i = 0; i < n(0); i++) {
    const r = off(0) + i * 40;
    archs.push({ id: dv.getBigUint64(r, true), x: f(r + 8), z: f(r + 12), r: f(r + 16), base: f(r + 20), cloudY: f(r + 24), site: u16(r + 28), firstIsland: u16(r + 30), islands: u16(r + 32), town: u16(r + 34) });
  }
  const islands: Island[] = [];
  for (let i = 0; i < n(1); i++) {
    const r = off(1) + i * 104;
    const nl = bytes[r + 41];
    const lobes: [number, number, number][] = [];
    for (let k = 0; k < nl; k++) lobes.push([f(r + 52 + k * 12), f(r + 56 + k * 12), f(r + 60 + k * 12)]);
    islands.push({
      index: i, id: dv.getBigUint64(r, true), x: f(r + 8), z: f(r + 12), r: f(r + 16), reach: f(r + 20), top: f(r + 24), thick: f(r + 28), cliff: f(r + 32), amp: f(r + 36),
      kind: bytes[r + 40], arch: u16(r + 42), site: u16(r + 44), biome: bytes[r + 46], seed: dv.getUint32(r + 48, true), lobes,
    });
  }
  const updrafts: Updraft[] = [];
  for (let i = 0; i < n(2); i++) {
    const r = off(2) + i * 32;
    updrafts.push({ x: f(r), z: f(r + 4), r: f(r + 8), bottom: f(r + 12), top: f(r + 16), lift: f(r + 20), kind: bytes[r + 24], arch: u16(r + 26) });
  }
  const chambers: Chamber[] = [];
  for (let i = 0; i < n(3); i++) {
    const r = off(3) + i * 72;
    chambers.push({
      index: i, id: dv.getBigUint64(r, true), x: f(r + 8), z: f(r + 12), rx: f(r + 16), rz: f(r + 20), c: f(r + 24), s: f(r + 28), floor: f(r + 32), height: f(r + 36),
      lake: f(r + 40), lakeE: f(r + 44), lakeDepth: f(r + 48), reach: f(r + 52), layer: bytes[r + 56], kind: bytes[r + 57], tint: bytes[r + 58], seed: dv.getUint32(r + 60, true), site: u16(r + 64),
    });
  }
  const ptsOff = off(5);
  const corridors: Corridor[] = [];
  for (let i = 0; i < n(4); i++) {
    const r = off(4) + i * 32;
    const first = dv.getUint32(r + 20, true);
    const count = dv.getUint32(r + 24, true);
    const pts = new Float32Array(count * 3);
    for (let k = 0; k < count * 3; k++) pts[k] = f(ptsOff + first * 12 + k * 4);
    corridors.push({ layer: bytes[r], kind: bytes[r + 1], lava: bytes[r + 2] !== 0, from: u16(r + 4), to: u16(r + 6), hw: f(r + 8), height: f(r + 12), water: f(r + 16), pts });
  }
  const openings: VOpening[] = [];
  for (let i = 0; i < n(6); i++) {
    const r = off(6) + i * 32;
    openings.push({ x: f(r), z: f(r + 4), rMask: f(r + 8), y: f(r + 12), into: bytes[r + 16], kind: bytes[r + 17], yaw: u16(r + 18), site: u16(r + 20), target: u16(r + 22) });
  }
  const shafts: Shaft[] = [];
  for (let i = 0; i < n(7); i++) {
    const r = off(7) + i * 32;
    shafts.push({ x: f(r), z: f(r + 4), r: f(r + 8), bottom: f(r + 12), top: f(r + 16), chamber: u16(r + 20) });
  }
  const columns: Column[] = [];
  for (let i = 0; i < n(8); i++) {
    const r = off(8) + i * 32;
    columns.push({ x: f(r), z: f(r + 4), r: f(r + 8), y0: f(r + 12), y1: f(r + 16), layer: bytes[r + 20], chamber: u16(r + 22) });
  }
  const decos: Deco[] = [];
  for (let i = 0; i < n(9); i++) {
    const r = off(9) + i * 24;
    decos.push({ x: f(r), y: f(r + 4), z: f(r + 8), size: f(r + 12), kind: bytes[r + 16], tint: bytes[r + 17], layer: bytes[r + 18], flags: bytes[r + 19], yaw: u16(r + 20), aux: u16(r + 22) });
  }
  const veins: VVein[] = [];
  for (let i = 0; i < n(10); i++) {
    const r = off(10) + i * 32;
    veins.push({
      id: dv.getBigUint64(r, true), x: f(r + 8), y: f(r + 12), z: f(r + 16), nx: dv.getInt8(r + 20) / 127, ny: dv.getInt8(r + 21) / 127, nz: dv.getInt8(r + 22) / 127,
      kind: bytes[r + 23], material: bytes[r + 24], element: bytes[r + 25], hp: u16(r + 26), size: bytes[r + 28], flags: bytes[r + 29], band: bytes[r + 30], chamber: bytes[r + 31],
    });
  }
  const dom = dv.getUint32(100, true);
  const domain = [0, 1, 2].map((k) => bytes.slice(dom + k * 512, dom + (k + 1) * 512));
  return {
    genVersion: dv.getUint16(6, true),
    baseSites: dv.getUint32(104, true),
    archs, islands, updrafts, chambers, corridors, openings,
    surfaceOpenings: openings.filter((o) => o.into === LAYER_UNDER),
    gateOpenings: openings.filter((o) => o.into === LAYER_DEPTHS),
    shafts, columns, decos, veins, domain,
  };
}

/** Is chunk (floor(x/64), floor(z/64)) in layer `layer`'s domain (1..3)? */
export function inDomain(v: VerticalWorld, layer: number, x: number, z: number): boolean {
  const cx = Math.floor(x / 64);
  const cz = Math.floor(z / 64);
  if (cx < 0 || cz < 0 || cx > 63 || cz > 63) return false;
  const k = cz * 64 + cx;
  return (v.domain[layer - 1][k >> 3] & (1 << (k & 7))) !== 0;
}

export interface LayerTile {
  layer: number;
  lod: number;
  cx: number;
  cz: number;
  step: number;
  flags: number;
  minA: number;
  maxA: number;
  minB: number;
  maxB: number;
  /** 65 x 65 lattices (index j * 65 + i): floor / island top, ceiling / island bottom, water / lava. */
  a: Float32Array;
  b: Float32Array;
  w: Float32Array;
}

export const TILE_S = 65;

export function parseLayerTile(bytes: Uint8Array): LayerTile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'LDLT') throw new Error('not a layer tile');
  const S = TILE_S;
  const arr = (o: number) => {
    const out = new Float32Array(S * S);
    for (let k = 0; k < S * S; k++) out[k] = dv.getFloat32(o + k * 4, true);
    return out;
  };
  return {
    layer: bytes[12], lod: bytes[13], cx: dv.getInt32(16, true), cz: dv.getInt32(20, true), step: dv.getFloat32(24, true), flags: dv.getUint32(28, true),
    minA: dv.getFloat32(32, true), maxA: dv.getFloat32(36, true), minB: dv.getFloat32(40, true), maxB: dv.getFloat32(44, true),
    a: arr(dv.getUint32(48, true)), b: arr(dv.getUint32(52, true)), w: arr(dv.getUint32(56, true)),
  };
}

type VExports = {
  vertical_build?(atlasPtr: number): number;
  layer_tile?(atlasPtr: number, layer: number, cx: number, cz: number, lod: number): number;
  layer_height?(atlasPtr: number, surf: number, x: number, z: number): number;
};

function ex(wg: Worldgen): Required<VExports> {
  const e = wg.exports as unknown as VExports;
  if (!e.vertical_build || !e.layer_tile || !e.layer_height) throw new Error('worldgen.wasm has no vertical exports (genVersion < 3?)');
  return e as Required<VExports>;
}

export function hasVertical(wg: Worldgen): boolean {
  return !!(wg.exports as unknown as VExports).vertical_build;
}

function scratch(wg: Worldgen, p: number, what: string): Uint8Array {
  const e = wg.exports;
  if (!p) {
    const msg = new TextDecoder().decode(new Uint8Array(e.memory.buffer).slice(e.error_ptr(), e.error_ptr() + e.error_len()));
    throw new Error(`${what}: ${msg}`);
  }
  return new Uint8Array(e.memory.buffer).slice(p, p + e.result_len());
}

export function verticalBytes(wg: Worldgen, atlas: AtlasHandle): Uint8Array {
  return scratch(wg, ex(wg).vertical_build(atlas.ptr), 'vertical_build');
}

export function layerTileBytes(wg: Worldgen, atlas: AtlasHandle, layer: number, cx: number, cz: number, lod: number): Uint8Array {
  return scratch(wg, ex(wg).layer_tile(atlas.ptr, layer, cx, cz, lod), 'layer_tile');
}

export function layerHeightWasm(wg: Worldgen, atlas: AtlasHandle, surf: number, x: number, z: number): number {
  return ex(wg).layer_height(atlas.ptr, surf, x, z);
}

// ---- collision (README "Vertical world: collision"; Go: server/pkg/vertical)

/** The triangle mesh over a 1 m f32 lattice (worldgen ground::tri_interp, same order). */
export function triInterp(h00: number, h10: number, h01: number, h11: number, fx: number, fz: number): number {
  if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

/** Collision value of a surface at (x, z): the wasm `layer_height`, or the same bits from LOD 0 tiles. */
export interface LayerSource {
  height(surf: number, x: number, z: number): number;
}

export function wasmLayerSource(wg: Worldgen, atlas: AtlasHandle): LayerSource {
  const f = ex(wg).layer_height;
  return { height: (surf, x, z) => f(atlas.ptr, surf, x, z) };
}

/**
 * LOD 0 tiles first (pure TS, bit-identical to the wasm), the fallback for
 * chunks not loaded. `tile(layer, cx, cz)` returns a cached LOD 0 tile or undefined.
 */
export function tileLayerSource(tile: (layer: number, cx: number, cz: number) => LayerTile | undefined, fallback: LayerSource): LayerSource {
  return {
    height(surf, x, z) {
      const layer = surf >= 6 ? LAYER_SKY : surf >= 3 ? LAYER_DEPTHS : LAYER_UNDER;
      const x0 = Math.floor(x);
      const z0 = Math.floor(z);
      const cx = Math.floor(x0 / 64);
      const cz = Math.floor(z0 / 64);
      const t = cx >= 0 && cz >= 0 && cx < 64 && cz < 64 ? tile(layer, cx, cz) : undefined;
      if (!t) return fallback.height(surf, x, z);
      const arr = surf % 3 === 0 ? t.a : surf % 3 === 1 ? t.b : t.w;
      const i = x0 - cx * 64;
      const j = z0 - cz * 64;
      const S = TILE_S;
      return triInterp(arr[j * S + i], arr[j * S + i + 1], arr[(j + 1) * S + i], arr[(j + 1) * S + i + 1], x - x0, z - z0);
    },
  };
}

/** Constants of the dispatch (Go: vertical.go). */
export const VC = {
  /** An island top within this much above the feet is stood on (a ledge you pop onto). */
  skyLedge: 3,
  /** Body height for head checks (ceilings, island undersides). */
  bodyH: 1.8,
  /** A layer holds feet from this much under its floor ... */
  below: 0.5,
  /** ... to this much over its ceiling. */
  above: 1,
  /** Feet up to this far under a floor snap back up to it. */
  ext: 40,
  /** "Underground": this far under the surface (or in a hole). */
  under: 2,
  /** Player capsule radius (columns, shafts, island sides). */
  radius: 0.4,
  solidEps: 0.01,
  /** Ceilings at or above this are open (openings). */
  openHalf: 5000,
  /** Island side push: steps of this length, at most this many. */
  pushStep: 0.5,
  pushSteps: 24,
  /** Shaft walls hold you within this far outside the shaft radius. */
  shaftBand: 2.5,
} as const;

export interface VCollideResult {
  x: number;
  y: number;
  z: number;
  pushX: number;
  pushZ: number;
  ceiling: boolean;
}

/** What the vertical ground wraps (the cave ground, or any surface ground). */
export interface VBase {
  heightAt(x: number, z: number): number;
  waterAt?(x: number, z: number): number;
  atLevel?(y: number): { heightAt(x: number, z: number): number; waterAt?(x: number, z: number): number; collide?(x: number, y: number, z: number, out: VCollideResult): VCollideResult };
  collide?(x: number, y: number, z: number, out: VCollideResult): VCollideResult;
}

/**
 * The movement ground with the vertical world over and under the base
 * (terrain, structures, caves). Dispatch at feet height y (README):
 *  1. sky: inside an island's outline (top > bottom), feet at or over
 *     top - 3 m stand on the top; with the head over the bottom you are
 *     inside the island: floor = y (collide pushes you out sideways or down).
 *  2. underground (in a tunnel / cenote hole, or 2 m under the surface):
 *     the Underground (not in a Depths gate hole) then the Depths, the first
 *     whose [floor - 0.5, max(ceiling, floor) + 1] holds y; else the nearest
 *     floor within 40 m above the feet.
 *  3. else the base ground at that level.
 */
export class VerticalGroundCore {
  /** Layer of the last resolve (0 base, 1 sky, 2 Underground, 3 Depths). */
  private rl = 0;
  private rf = 0;
  private readonly tmp: VCollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };

  constructor(
    readonly base: VBase,
    readonly v: VerticalWorld,
    readonly src: LayerSource,
  ) {}

  heightAt(x: number, z: number): number {
    return this.base.heightAt(x, z);
  }

  waterAt(x: number, z: number): number {
    return this.base.waterAt ? this.base.waterAt(x, z) : -Infinity;
  }

  /** Sets rl / rf; returns the layer. */
  private resolve(x: number, y: number, z: number): number {
    const v = this.v;
    const s = this.src;
    if (inDomain(v, LAYER_SKY, x, z)) {
      const t = s.height(6, x, z);
      const b = s.height(7, x, z);
      if (t - b > VC.solidEps) {
        if (y >= t - VC.skyLedge) {
          this.rl = 1;
          this.rf = t;
          return 1;
        }
        if (y + VC.bodyH > b) {
          this.rl = 1;
          this.rf = y;
          return 1;
        }
      }
    }
    const masked = v.surfaceOpenings.length > 0 && caveMasked(v.surfaceOpenings, x, z);
    if (masked || y < this.base.heightAt(x, z) - VC.under) {
      const gate = v.gateOpenings.length > 0 && caveMasked(v.gateOpenings, x, z);
      const uOK = !gate && inDomain(v, LAYER_UNDER, x, z);
      const dOK = inDomain(v, LAYER_DEPTHS, x, z);
      let uf = 0;
      let df = 0;
      if (uOK) {
        uf = s.height(0, x, z);
        const uc = s.height(1, x, z);
        if (y >= uf - VC.below && y <= (uc > uf ? uc : uf) + VC.above) {
          this.rl = 2;
          this.rf = uf;
          return 2;
        }
      }
      if (dOK) {
        df = s.height(3, x, z);
        const dc = s.height(4, x, z);
        if (y >= df - VC.below && y <= (dc > df ? dc : df) + VC.above) {
          this.rl = 3;
          this.rf = df;
          return 3;
        }
      }
      const gu = uOK && y < uf - VC.below && y >= uf - VC.ext ? uf - y : Infinity;
      const gd = dOK && y < df - VC.below && y >= df - VC.ext ? df - y : Infinity;
      if (gu < Infinity && gu <= gd) {
        this.rl = 2;
        this.rf = uf;
        return 2;
      }
      if (gd < Infinity) {
        this.rl = 3;
        this.rf = df;
        return 3;
      }
    }
    this.rl = 0;
    return 0;
  }

  /** Which layer a point is in (0 base, 1 sky island, 2 Underground, 3 Depths). Gameplay, not movement. */
  layerAt(x: number, y: number, z: number): number {
    return this.resolve(x, y, z);
  }

  /** The ground under feet height y at (x, z). */
  floorAt(x: number, y: number, z: number): number {
    if (this.resolve(x, y, z) !== 0) return this.rf;
    const bv = this.base.atLevel ? this.base.atLevel(y) : this.base;
    return bv.heightAt(x, z);
  }

  /** Water (or lava) at (x, z) for feet at y: the layer's in the Underground / Depths, none on an island. */
  waterAtLevel(x: number, y: number, z: number): number {
    const l = this.resolve(x, y, z);
    if (l === 2) return this.src.height(2, x, z);
    if (l === 3) return this.src.height(5, x, z);
    if (l === 1) return -Infinity;
    const bv = this.base.atLevel ? this.base.atLevel(y) : this.base;
    return bv.waterAt ? bv.waterAt(x, z) : -Infinity;
  }

  atLevel(y: number): { heightAt(x: number, z: number): number; waterAt(x: number, z: number): number; collide(x: number, y: number, z: number, out: VCollideResult): VCollideResult } {
    const bv = this.base.atLevel ? this.base.atLevel(y) : null;
    return {
      heightAt: (x, z) => this.floorAt(x, y, z),
      waterAt: (x, z) => this.waterAtLevel(x, y, z),
      collide: (cx, cy, cz, out) => this.collide(cx, cy, cz, out, bv),
    };
  }

  /** Base push-out, then island sides / undersides, layer ceilings, columns and shaft walls. */
  collide(x0: number, y0: number, z0: number, out: VCollideResult, bv?: ReturnType<NonNullable<VBase['atLevel']>> | null): VCollideResult {
    let x = x0;
    let y = y0;
    let z = z0;
    let px = 0;
    let pz = 0;
    let ceil = false;
    const bc = bv?.collide ?? (this.base.collide ? this.base.collide.bind(this.base) : null);
    if (bc) {
      const r = bc(x0, y0, z0, this.tmp);
      x = r.x;
      y = r.y;
      z = r.z;
      px = r.pushX;
      pz = r.pushZ;
      ceil = r.ceiling;
    }
    const s = this.src;
    const l = this.resolve(x, y, z);
    if (l === 1) {
      const t = s.height(6, x, z);
      const b = s.height(7, x, z);
      if (t - b > VC.solidEps && y < t - VC.skyLedge && y + VC.bodyH > b) {
        if (y < b) {
          y = b - VC.bodyH;
          ceil = true;
        } else {
          const isl = this.islandAt(x, z);
          if (isl) {
            let dx = x - isl.x;
            let dz = z - isl.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > 1e-9) {
              dx = dx / d;
              dz = dz / d;
            } else {
              dx = 1;
              dz = 0;
            }
            for (let k = 1; k <= VC.pushSteps; k++) {
              const qx = x + dx * (VC.pushStep * k);
              const qz = z + dz * (VC.pushStep * k);
              if (s.height(6, qx, qz) - s.height(7, qx, qz) <= VC.solidEps) {
                const mx = dx * (VC.pushStep * k + VC.radius);
                const mz = dz * (VC.pushStep * k + VC.radius);
                x = x + mx;
                z = z + mz;
                px = px + mx;
                pz = pz + mz;
                break;
              }
            }
          }
        }
      }
    } else if (l === 2 || l === 3) {
      const c = s.height(l === 2 ? 1 : 4, x, z);
      const f = s.height(l === 2 ? 0 : 3, x, z);
      if (c < VC.openHalf && c > f && y + VC.bodyH > c && y < c) {
        y = c - VC.bodyH;
        ceil = true;
      }
      for (const col of this.v.columns) {
        if (col.layer !== l || y + VC.bodyH <= col.y0 || y >= col.y1) continue;
        let dx = x - col.x;
        let dz = z - col.z;
        const rr = col.r + VC.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2);
        if (d > 1e-9) {
          dx = dx / d;
          dz = dz / d;
        } else {
          dx = 1;
          dz = 0;
        }
        const m = rr - d;
        x = x + dx * m;
        z = z + dz * m;
        px = px + dx * m;
        pz = pz + dz * m;
      }
    }
    for (const sh of this.v.shafts) {
      let dx = x - sh.x;
      let dz = z - sh.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const inner = sh.r - VC.radius;
      if (d <= inner || d >= sh.r + VC.shaftBand) continue;
      if (y >= this.base.heightAt(x, z) - VC.under) continue;
      if (y + 1 <= s.height(1, x, z)) continue;
      dx = dx / d;
      dz = dz / d;
      const m = d - inner;
      x = x - dx * m;
      z = z - dz * m;
      px = px - dx * m;
      pz = pz - dz * m;
    }
    out.x = x;
    out.y = y;
    out.z = z;
    out.pushX = px;
    out.pushZ = pz;
    out.ceiling = ceil;
    return out;
  }

  /** The island whose reach covers (x, z) most deeply, or null. */
  islandAt(x: number, z: number): Island | null {
    let best: Island | null = null;
    let bestM = Infinity;
    for (const isl of this.v.islands) {
      const dx = x - isl.x;
      const dz = z - isl.z;
      const m = Math.sqrt(dx * dx + dz * dz) - isl.reach;
      if (m < 4 && m < bestM) {
        bestM = m;
        best = isl;
      }
    }
    return best;
  }

  /** Convenience for tools: a fresh result. */
  collideNew(x: number, y: number, z: number): VCollideResult {
    return { ...this.collide(x, y, z, { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false }, this.base.atLevel ? this.base.atLevel(y) : null) };
  }
}

/** Lift (m/s) of the vertical world's wind columns at a point (the movement step's UpdraftField). Go: vertical.Updrafts. */
export class VerticalUpdrafts {
  constructor(readonly cols: readonly Updraft[]) {}
  liftAt(x: number, y: number, z: number): number {
    let best = 0;
    for (const c of this.cols) {
      if (y > c.top || y < c.bottom) continue;
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz <= c.r * c.r && c.lift > best) best = c.lift;
    }
    return best;
  }
}

/** Is (x, y, z) in the sky over an archipelago (above its cloud bank)? Gameplay (light, music, difficulty). */
export function inSkyBand(v: VerticalWorld, x: number, y: number, z: number): boolean {
  for (const a of v.archs) {
    if (y < a.cloudY - 60) continue;
    const dx = x - a.x;
    const dz = z - a.z;
    const r = a.r + 220;
    if (dx * dx + dz * dz <= r * r) return true;
  }
  return false;
}

/** The chamber of a layer whose ellipse (padded) contains (x, z), or null. */
export function chamberAt(v: VerticalWorld, layer: number, x: number, z: number, pad = 1.1): Chamber | null {
  for (const c of v.chambers) {
    if (c.layer !== layer) continue;
    const dx = x - c.x;
    const dz = z - c.z;
    const u = dx * c.c + dz * c.s;
    const w = -dx * c.s + dz * c.c;
    if ((u / c.rx) * (u / c.rx) + (w / c.rz) * (w / c.rz) <= pad * pad) return c;
  }
  return null;
}

// ---- golden (worldgen/golden/README.md "Vertical")

export interface GoldenVertical {
  /** fnv1a64 of the descriptor, its size and section counts. */
  hash: string;
  bytes: number;
  counts: Record<string, number>;
  tiles: { layer: number; cx: number; cz: number; lod: number; hash: string }[];
  /** f64 bits of layer_height(surf, x, z). */
  heights: { surf: number; x: number; z: number; h: string }[];
  /** f64 bits of VerticalGroundCore.floorAt over the plain terrain ground (no caves, structures or towns), and its layer. */
  floors: { x: number; y: number; z: number; h: string; l: number }[];
  /** "x,y,z,pushX,pushZ bits,ceiling" of collide. */
  collide: { x: number; y: number; z: number; out: string }[];
  /** Updraft lift at points (f64 bits). */
  lifts: { x: number; y: number; z: number; v: string }[];
}

function bits(v: number): string {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, v, true);
  return hex64(d.getBigUint64(0, true));
}
const q = (v: number) => Math.round(v * 4096) / 4096;

export function verticalCounts(v: VerticalWorld): Record<string, number> {
  return {
    archs: v.archs.length, islands: v.islands.length, updrafts: v.updrafts.length, chambers: v.chambers.length, corridors: v.corridors.length,
    openings: v.openings.length, shafts: v.shafts.length, columns: v.columns.length, decos: v.decos.length, veins: v.veins.length,
  };
}

/** The plain terrain as the base (golden vectors do not depend on caves or towns). */
export function terrainBase(wg: Worldgen, atlas: AtlasHandle): VBase {
  return { heightAt: (x, z) => wg.collisionHeight(atlas, x, z), waterAt: (x, z) => wg.waterHeight(atlas, x, z) };
}

export function collideStringV(g: VerticalGroundCore, x: number, y: number, z: number): string {
  const o = g.collideNew(x, y, z);
  return `${bits(o.x)},${bits(o.y)},${bits(o.z)},${bits(o.pushX)},${bits(o.pushZ)},${o.ceiling ? 1 : 0}`;
}

/** Points that exercise every rule: islands (top, ledge, inside, under, rim), chambers (floor, ceiling, walls, lakes), corridors, openings, columns, shafts. */
export function goldenPoints(v: VerticalWorld, label: string, src: LayerSource): { x: number; y: number; z: number }[] {
  const rank = (k: string) => fnv1a64(new TextEncoder().encode(`${label}:v:${k}`));
  const u = (k: string) => Number(rank(k) & 0xffffffn) / 0x1000000;
  const pts: { x: number; y: number; z: number }[] = [];
  v.islands.slice(0, 10).forEach((isl, i) => {
    for (let k = 0; k < 8; k++) {
      const ang = u(`i${i}a${k}`) * Math.PI * 2;
      const d = isl.reach * (0.2 + u(`i${i}d${k}`) * 0.95);
      const x = q(isl.x + d * Math.cos(ang));
      const z = q(isl.z + d * Math.sin(ang));
      const t = src.height(6, x, z);
      const b = src.height(7, x, z);
      const ys = [t + 0.3, t - 1.5, t - 6, (t + b) * 0.5, b - 1, b - 30];
      pts.push({ x, y: q(ys[k % ys.length]), z });
    }
  });
  v.chambers.forEach((c, i) => {
    for (let k = 0; k < 8; k++) {
      const ang = u(`c${i}a${k}`) * Math.PI * 2;
      const e = u(`c${i}e${k}`) * 1.15;
      const lu = c.rx * e * Math.cos(ang);
      const lv = c.rz * e * Math.sin(ang);
      const x = q(c.x + lu * c.c - lv * c.s);
      const z = q(c.z + lu * c.s + lv * c.c);
      const fl = src.height(c.layer === LAYER_UNDER ? 0 : 3, x, z);
      const ce = src.height(c.layer === LAYER_UNDER ? 1 : 4, x, z);
      const ys = [fl + 0.2, fl - 0.3, fl - 12, ce - 1, ce + 0.5, (fl + ce) * 0.5, fl + 2.5, ce - 2.2];
      pts.push({ x, y: q(ys[k]), z });
    }
  });
  v.corridors.slice(0, 12).forEach((r, i) => {
    const n = r.pts.length / 3;
    for (let k = 0; k < 4; k++) {
      const j = Math.min(n - 1, Math.floor(u(`r${i}p${k}`) * n));
      const off = (u(`r${i}o${k}`) * 2 - 1) * r.hw * 1.3;
      const x = q(r.pts[j * 3] + off);
      const z = q(r.pts[j * 3 + 2] - off * 0.5);
      pts.push({ x, y: q(r.pts[j * 3 + 1] + (k === 3 ? r.height + 0.5 : 0.4)), z });
    }
  });
  v.openings.forEach((o, i) => {
    for (let k = 0; k < 4; k++) {
      const ang = u(`o${i}a${k}`) * Math.PI * 2;
      const d = o.rMask * (0.3 + u(`o${i}d${k}`) * 1.0);
      pts.push({ x: q(o.x + d * Math.cos(ang)), y: q(o.y + (k - 1) * 4), z: q(o.z + d * Math.sin(ang)) });
    }
  });
  v.columns.slice(0, 12).forEach((c, i) => {
    const ang = u(`col${i}`) * Math.PI * 2;
    pts.push({ x: q(c.x + (c.r + 0.2) * Math.cos(ang)), y: q(c.y0 + 0.5), z: q(c.z + (c.r + 0.2) * Math.sin(ang)) });
  });
  v.shafts.forEach((sh, i) => {
    for (let k = 0; k < 3; k++) {
      const ang = u(`sh${i}a${k}`) * Math.PI * 2;
      const d = sh.r + 0.6 * k - 0.4;
      pts.push({ x: q(sh.x + d * Math.cos(ang)), y: q(sh.bottom + 10 + k * 15), z: q(sh.z + d * Math.sin(ang)) });
    }
  });
  return pts;
}

export function generateVertical(wg: Worldgen, atlas: AtlasHandle, label: string): GoldenVertical {
  const b = verticalBytes(wg, atlas);
  const v = parseVertical(b);
  const src = wasmLayerSource(wg, atlas);
  const g = new VerticalGroundCore(terrainBase(wg, atlas), v, src);
  const tiles: GoldenVertical['tiles'] = [];
  const pick = (layer: number, x: number, z: number, lod: number) => {
    const step = 1 << lod;
    const cx = Math.max(0, Math.min(63, Math.floor(x / 64 / step) * step));
    const cz = Math.max(0, Math.min(63, Math.floor(z / 64 / step) * step));
    if (tiles.some((t) => t.layer === layer && t.cx === cx && t.cz === cz && t.lod === lod)) return;
    tiles.push({ layer, cx, cz, lod, hash: hex64(wg.hash(layerTileBytes(wg, atlas, layer, cx, cz, lod))) });
  };
  v.islands.slice(0, 4).forEach((i) => pick(LAYER_SKY, i.x, i.z, 0));
  if (v.islands[0]) pick(LAYER_SKY, v.islands[0].x, v.islands[0].z, 3);
  v.chambers.slice(0, 6).forEach((c) => pick(c.layer, c.x, c.z, 0));
  v.openings.forEach((o) => pick(o.into, o.x, o.z, 0));
  if (v.chambers[0]) pick(v.chambers[0].layer, v.chambers[0].x, v.chambers[0].z, 2);
  const heights: GoldenVertical['heights'] = [];
  const pts = goldenPoints(v, label, src);
  pts.forEach((p, i) => {
    const surf = i % 8;
    heights.push({ surf, x: p.x, z: p.z, h: bits(src.height(surf, p.x, p.z)) });
  });
  const floors = pts.map((p) => ({ x: p.x, y: p.y, z: p.z, h: bits(g.floorAt(p.x, p.y, p.z)), l: g.layerAt(p.x, p.y, p.z) }));
  const collide = pts.map((p) => ({ x: p.x, y: p.y, z: p.z, out: collideStringV(g, p.x, p.y, p.z) }));
  const up = new VerticalUpdrafts(v.updrafts);
  const lifts = v.updrafts.slice(0, 12).flatMap((c) => [
    { x: q(c.x), y: q((c.bottom + c.top) * 0.5), z: q(c.z) },
    { x: q(c.x + c.r * 0.99), y: q(c.top - 0.5), z: q(c.z) },
    { x: q(c.x + c.r + 0.5), y: q(c.top - 0.5), z: q(c.z) },
  ]).map((p) => ({ ...p, v: bits(up.liftAt(p.x, p.y, p.z)) }));
  return { hash: hex64(wg.hash(b)), bytes: b.length, counts: verticalCounts(v), tiles, heights, floors, collide, lifts };
}

interface VCounters {
  failures: string[];
  verticalQueries: number;
}

export function checkVertical(wg: Worldgen, atlas: AtlasHandle, label: string, gv: GoldenVertical, r: VCounters): void {
  const b = verticalBytes(wg, atlas);
  const h = hex64(wg.hash(b));
  if (h !== gv.hash) r.failures.push(`${label}: vertical ${h} != ${gv.hash}`);
  if (b.length !== gv.bytes) r.failures.push(`${label}: vertical ${b.length} bytes != ${gv.bytes}`);
  const v = parseVertical(b);
  const counts = verticalCounts(v);
  for (const [k, n] of Object.entries(gv.counts)) if (counts[k] !== n) r.failures.push(`${label}: vertical ${k} ${counts[k]} != ${n}`);
  for (const t of gv.tiles) {
    const th = hex64(wg.hash(layerTileBytes(wg, atlas, t.layer, t.cx, t.cz, t.lod)));
    if (th !== t.hash) r.failures.push(`${label}: layer tile (${t.layer},${t.cx},${t.cz},lod${t.lod}) ${th} != ${t.hash}`);
  }
  const src = wasmLayerSource(wg, atlas);
  // Tiles and the wasm must agree to the bit: check through a tile-backed source too.
  const cache = new Map<number, LayerTile>();
  const tsrc = tileLayerSource((layer, cx, cz) => {
    const k = layer * 4096 + cz * 64 + cx;
    let t = cache.get(k);
    if (!t) {
      t = parseLayerTile(layerTileBytes(wg, atlas, layer, cx, cz, 0));
      cache.set(k, t);
    }
    return t;
  }, src);
  for (const p of gv.heights) {
    for (const s of [src, tsrc]) {
      const v2 = bits(s.height(p.surf, p.x, p.z));
      if (v2 !== p.h) r.failures.push(`${label}: layer_height(${p.surf}, ${p.x}, ${p.z}) ${v2} != ${p.h}`);
    }
    r.verticalQueries++;
  }
  const g = new VerticalGroundCore(terrainBase(wg, atlas), v, tsrc);
  for (const p of gv.floors) {
    const v2 = bits(g.floorAt(p.x, p.y, p.z));
    const l = g.layerAt(p.x, p.y, p.z);
    if (v2 !== p.h || l !== p.l) r.failures.push(`${label}: vertical floor (${p.x}, ${p.y}, ${p.z}) ${v2}/${l} != ${p.h}/${p.l}`);
    r.verticalQueries++;
  }
  for (const p of gv.collide) {
    const v2 = collideStringV(g, p.x, p.y, p.z);
    if (v2 !== p.out) r.failures.push(`${label}: vertical collide (${p.x}, ${p.y}, ${p.z}) ${v2} != ${p.out}`);
    r.verticalQueries++;
  }
  const up = new VerticalUpdrafts(v.updrafts);
  for (const p of gv.lifts) {
    const v2 = bits(up.liftAt(p.x, p.y, p.z));
    if (v2 !== p.v) r.failures.push(`${label}: updraft (${p.x}, ${p.y}, ${p.z}) ${v2} != ${p.v}`);
    r.verticalQueries++;
  }
}
