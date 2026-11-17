// Messages between the main thread (TownsManager) and the buildings worker.

import type { SettlementMesh } from './kit';
import type { CellMesh } from './roads';
import type { StructureMesh } from './structures';

export type BuildingsIn =
  /** wasmUrl: the world's generator (WorldRuntime.wasmUrl; archived builds for older genVersions). */
  | { type: 'init'; atlas: Uint8Array; wasmUrl: string; /** Art detail 0-2 (detail.ts). */ detail: 0 | 1 | 2 }
  | { type: 'settlement'; id: number; index: number }
  | { type: 'structure'; id: number; index: number }
  /** Find scatter to hide in the not-yet-checked chunks within `radius` of (x, z), at most `max` chunks per reply. */
  | { type: 'clear'; x: number; z: number; radius: number; max: number };

export type BuildingsOut =
  | { type: 'ready'; textures: Uint8Array; size: number; layers: number; cells: CellMesh[]; ms: { towns: number; textures: number; roads: number } }
  | { type: 'settlement'; id: number; index: number; mesh: SettlementMesh; ms: number }
  | { type: 'structure'; id: number; index: number; mesh: StructureMesh; ms: number }
  | { type: 'clear'; ids: BigUint64Array; chunks: number; ms: number; more: boolean }
  | { type: 'error'; id: number; message: string };
