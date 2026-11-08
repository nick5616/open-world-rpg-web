// @lodestone/worldgen: typed wrapper over worldgen.wasm (ABI in
// worldgen/README.md). Works in browsers, Web Workers and Node: the module
// imports nothing, so it instantiates with an empty import object.
//
//   const wg = await loadWorldgen(await (await fetch(wasmUrl)).arrayBuffer());
//   const atlas = wg.buildAtlas(wg.specFromSeed(42n));
//   const chunk = wg.buildChunk(atlas, 32, 32);      // owned typed arrays
//   const y = wg.collisionHeight(atlas, 2050.5, 2047.25);
import type { WorldSpec } from '@lodestone/contracts';
import { parseAtlas, parseChunk, type AtlasData, type ChunkData } from './format';

export * from './format';
export * from './cave';

/** Raw exports of worldgen.wasm (README "Exports"). Pointers are i32 offsets. */
export interface WorldgenExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  free(ptr: number, len: number): void;
  gen_version(): number;
  abi_version(): number;
  result_len(): number;
  error_ptr(): number;
  error_len(): number;
  spec_from_seed(seedLo: number, seedHi: number): number;
  atlas_build(specPtr: number, specLen: number, seedLo: number, seedHi: number): number;
  atlas_check(atlasPtr: number): number;
  chunk_build(atlasPtr: number, cx: number, cz: number, lod: number): number;
  collision_height(atlasPtr: number, x: number, z: number): number;
  ground_normal(atlasPtr: number, x: number, z: number, outPtr: number): number;
  raycast(atlasPtr: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number;
  hash_buffer(ptr: number, len: number): bigint;
}

/** The ABI this loader speaks; loading a wasm with another ABI fails fast. */
export const ABI_VERSION = 1;

export class WorldgenError extends Error {}

function seedParts(seed: bigint | number | string): [number, number, bigint] {
  const s = BigInt.asUintN(64, BigInt(seed));
  return [Number(s & 0xffffffffn) | 0, Number(s >> 32n) | 0, s];
}

/** An atlas living in wasm memory (needed by chunk and collision calls). */
export class AtlasHandle {
  private _data: AtlasData | null = null;
  private _hash: bigint | null = null;
  constructor(
    private readonly wg: Worldgen,
    public ptr: number,
    readonly byteLength: number,
  ) {}
  /** A copy of the atlas bytes (for caching in IndexedDB by hash). */
  bytes(): Uint8Array {
    this.check();
    return new Uint8Array(this.wg.exports.memory.buffer, this.ptr, this.byteLength).slice();
  }
  /** 64-bit content hash: the world's atlasHash. */
  get hash(): bigint {
    this.check();
    if (this._hash === null) this._hash = this.wg.hashRange(this.ptr, this.byteLength);
    return this._hash;
  }
  /** Parsed view (grids, regions, sites, names) over a copy of the bytes. */
  get data(): AtlasData {
    if (!this._data) this._data = parseAtlas(this.bytes());
    return this._data;
  }
  free(): void {
    if (this.ptr) this.wg.exports.free(this.ptr, this.byteLength);
    this.ptr = 0;
  }
  private check() {
    if (!this.ptr) throw new WorldgenError('atlas was freed');
  }
}

export class Worldgen {
  readonly genVersion: number;
  readonly abiVersion: number;
  private readonly outPtr: number;

  constructor(readonly exports: WorldgenExports) {
    this.genVersion = exports.gen_version();
    this.abiVersion = exports.abi_version();
    if (this.abiVersion !== ABI_VERSION) throw new WorldgenError(`worldgen.wasm ABI ${this.abiVersion}, loader expects ${ABI_VERSION}`);
    // 24-byte scratch for ground_normal, allocated once.
    this.outPtr = exports.alloc(24);
  }

  /** Memory may grow during any call; always take a fresh view. */
  private mem(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer);
  }

  private error(what: string): WorldgenError {
    const p = this.exports.error_ptr();
    const n = this.exports.error_len();
    const msg = new TextDecoder().decode(this.mem().slice(p, p + n));
    return new WorldgenError(`${what}: ${msg}`);
  }

  private copyIn(bytes: Uint8Array): number {
    const p = this.exports.alloc(bytes.length);
    if (!p) throw new WorldgenError('alloc failed');
    this.mem().set(bytes, p);
    return p;
  }

  /** @internal */
  hashRange(ptr: number, len: number): bigint {
    return BigInt.asUintN(64, this.exports.hash_buffer(ptr, len));
  }

  /** spec_from_seed: every WorldSpec field chosen from the seed (spec 6). */
  specFromSeed(seed: bigint | number | string): WorldSpec {
    const [lo, hi] = seedParts(seed);
    const p = this.exports.spec_from_seed(lo, hi);
    const n = this.exports.result_len();
    return JSON.parse(new TextDecoder().decode(this.mem().slice(p, p + n))) as WorldSpec;
  }

  /** Build the atlas (pass 1). The seed comes from spec.seed. */
  buildAtlas(spec: WorldSpec): AtlasHandle {
    const json = new TextEncoder().encode(JSON.stringify(spec));
    const [lo, hi] = seedParts(spec.seed);
    const sp = this.copyIn(json);
    try {
      const p = this.exports.atlas_build(sp, json.length, lo, hi);
      if (!p) throw this.error('atlas_build');
      return new AtlasHandle(this, p, this.exports.result_len());
    } finally {
      this.exports.free(sp, json.length);
    }
  }

  /** Load atlas bytes (e.g. from the CDN or IndexedDB) into wasm memory. */
  loadAtlas(bytes: Uint8Array): AtlasHandle {
    const p = this.copyIn(bytes);
    if (!this.exports.atlas_check(p)) {
      const err = this.error('atlas_check');
      this.exports.free(p, bytes.length);
      throw err;
    }
    return new AtlasHandle(this, p, bytes.length);
  }

  /** Raw chunk buffer (pass 2), copied out of wasm scratch. */
  buildChunkBytes(atlas: AtlasHandle, cx: number, cz: number, lod = 0): Uint8Array {
    const p = this.exports.chunk_build(atlas.ptr, cx, cz, lod);
    if (!p) throw this.error(`chunk_build(${cx}, ${cz}, ${lod})`);
    const n = this.exports.result_len();
    return this.mem().slice(p, p + n);
  }

  /** Chunk as typed-array views over an owned copy (transferable via .bytes.buffer). */
  buildChunk(atlas: AtlasHandle, cx: number, cz: number, lod = 0): ChunkData {
    return parseChunk(this.buildChunkBytes(atlas, cx, cz, lod));
  }

  /** Ground height: the surface the server validates movement against. */
  collisionHeight(atlas: AtlasHandle, x: number, z: number): number {
    return this.exports.collision_height(atlas.ptr, x, z);
  }

  groundNormal(atlas: AtlasHandle, x: number, z: number): { normal: [number, number, number]; slopeDeg: number } {
    const slopeDeg = this.exports.ground_normal(atlas.ptr, x, z, this.outPtr);
    const dv = new DataView(this.exports.memory.buffer, this.outPtr, 24);
    return { normal: [dv.getFloat64(0, true), dv.getFloat64(8, true), dv.getFloat64(16, true)], slopeDeg };
  }

  /** Distance along the normalized direction to the ground, or null (max 1024 m). */
  raycast(atlas: AtlasHandle, o: [number, number, number], d: [number, number, number], maxDist: number): number | null {
    const t = this.exports.raycast(atlas.ptr, o[0], o[1], o[2], d[0], d[1], d[2], maxDist);
    return t < 0 ? null : t;
  }

  /** 64-bit FNV-1a content hash, computed inside the module. */
  hash(bytes: Uint8Array): bigint {
    const p = this.copyIn(bytes);
    try {
      return this.hashRange(p, bytes.length);
    } finally {
      this.exports.free(p, bytes.length);
    }
  }
}

/** Instantiate worldgen.wasm from bytes or a compiled module. */
export async function loadWorldgen(source: BufferSource | WebAssembly.Module): Promise<Worldgen> {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const instance = await WebAssembly.instantiate(module, {});
  return new Worldgen(instance.exports as unknown as WorldgenExports);
}
