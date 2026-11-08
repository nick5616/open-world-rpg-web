// Messages between the creator page and its preview worker.
import type { WorldSpec } from '@lodestone/contracts';
import type { PreviewStats } from './render';

export type ToWorker = { type: 'fromSeed'; id: number; seed: string } | { type: 'preview'; id: number; spec: WorldSpec };

export type FromWorker =
  | { type: 'ready'; genVersion: number }
  | { type: 'spec'; id: number; spec: WorldSpec }
  | { type: 'preview'; id: number; bitmap: ImageBitmap; stats: PreviewStats }
  | { type: 'error'; id: number; message: string };
