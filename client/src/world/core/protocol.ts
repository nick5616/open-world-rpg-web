// Messages between the main thread and the generation workers. Every result
// carries its job id; big payloads travel as transferred ArrayBuffers.

import type { TileMeshData } from '../terrain/tileMesh';

export interface InitMsg {
  type: 'init';
  /** Compiled once on the main thread; structured-cloning a Module is free. */
  module: WebAssembly.Module;
  /** Atlas bytes to load (absent: the worker only builds atlases). */
  atlas?: Uint8Array;
  atlasHash?: string;
  /** Use the IndexedDB mesh cache (off in benchmarks that measure generation). */
  meshCache: boolean;
}

export type JobMsg =
  | { type: 'atlas'; id: number; seed: string }
  | { type: 'tile'; id: number; cx: number; cz: number; lod: number }
  | { type: 'scatter'; id: number; cx: number; cz: number }
  | { type: 'grass'; id: number; cx: number; cz: number; density: number }
  | { type: 'hash'; id: number; cx: number; cz: number; lod: number }
  | { type: 'evict'; id: number; cap: number };

export type JobType = JobMsg['type'];

/** Scatter of one lod-0 chunk, flattened for instancing. */
export interface ScatterData {
  cx: number;
  cz: number;
  /** Per record: layer, kind, variant, x, y, z, yaw (rad), scale byte. */
  records: Float32Array;
  /** Stable ids, same order (spec 5: world edits name objects by id). */
  ids: BigUint64Array;
}
export const SCATTER_STRIDE = 8;

/** Grass blade clumps of one lod-0 chunk: x, y, z, packed (yaw, scale, tint). */
export interface GrassData {
  cx: number;
  cz: number;
  instances: Float32Array;
}

export type ResultMsg =
  | { type: 'ready'; genVersion: number }
  | { type: 'atlas'; id: number; bytes: Uint8Array; hash: string; ms: number }
  | { type: 'tile'; id: number; tile: TileMeshData; genMs: number; meshMs: number; cached: boolean }
  | { type: 'scatter'; id: number; scatter: ScatterData; genMs: number }
  | { type: 'grass'; id: number; grass: GrassData; genMs: number }
  | { type: 'hash'; id: number; hash: string; ms: number }
  | { type: 'evict'; id: number; bytes: number; deleted: number }
  | { type: 'error'; id: number; message: string };
