// Event payloads of the chemistry engine (contracts/events.md 520-525):
// TS twin of chem/codec.go.

import { CHUNK_CELLS, CHUNKS_N, cellId, OP_EXTINGUISH, OP_FREEZE, OP_IGNITE, OP_PILLAR, type Op } from './sim';

export const EV_IGNITE = 520;
export const EV_EXTINGUISH = 521;
export const EV_FREEZE = 522;
export const EV_PILLAR = 523;
export const EV_BASELINE = 524;
export const EV_BITMAP = 525;

export interface ChemEvent {
  kind: number;
  targetId: number;
  value: number;
  x: number;
  y: number;
  z: number;
  data: Uint8Array;
}

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function i64(v: DataView, o: number): number {
  return Number(v.getBigInt64(o, true));
}

const OP_OF: Record<number, number> = { [EV_IGNITE]: OP_IGNITE, [EV_EXTINGUISH]: OP_EXTINGUISH, [EV_FREEZE]: OP_FREEZE, [EV_PILLAR]: OP_PILLAR };

export function isOpEvent(kind: number): boolean {
  return kind in OP_OF;
}

/** Decode an op Event (520-523); null when malformed. */
export function decodeOp(e: ChemEvent): Op | null {
  const kind = OP_OF[e.kind];
  if (!kind || e.data.length < 8) return null;
  const v = dv(e.data);
  const step = i64(v, 0);
  if (kind === OP_PILLAR) {
    if (e.data.length < 12) return null;
    return {
      step,
      kind,
      cell: 0,
      radius: 0,
      pillar: { id: e.targetId, x: e.x / 100, baseY: e.y / 100, z: e.z / 100, height: e.value / 100, half: v.getUint16(8, true) / 100, run: v.getUint16(10, true) / 100, until: 0 },
    };
  }
  return { step, kind, cell: e.targetId, radius: e.value };
}

export interface Baseline {
  step: number;
  cells: { id: number; state: number; until: number }[];
}

export function decodeBaseline(chunk: number, b: Uint8Array): Baseline | null {
  if (b.length < 10) return null;
  const v = dv(b);
  const step = i64(v, 0);
  const n = v.getUint16(8, true);
  if (b.length < 10 + 7 * n) return null;
  const cx = (chunk % CHUNKS_N) * CHUNK_CELLS;
  const cz = Math.floor(chunk / CHUNKS_N) * CHUNK_CELLS;
  const cells = [];
  for (let i = 0; i < n; i++) {
    const o = 10 + 7 * i;
    const l = v.getUint16(o, true);
    cells.push({ id: cellId(cx + (l % CHUNK_CELLS), cz + Math.floor(l / CHUNK_CELLS)), state: b[o + 2], until: step + v.getInt32(o + 3, true) });
  }
  return { step, cells };
}

export interface Bitmap {
  step: number;
  /** 2 bits per cell (chunk-local index), 0 none, 1 burning, 2 burnt, 3 frozen. */
  bits: Uint8Array;
}

export function decodeBitmap(b: Uint8Array): Bitmap | null {
  if (b.length < 8 + (CHUNK_CELLS * CHUNK_CELLS) / 4) return null;
  return { step: i64(dv(b), 0), bits: b.slice(8, 8 + (CHUNK_CELLS * CHUNK_CELLS) / 4) };
}

export function bitmapState(bits: Uint8Array, local: number): number {
  return (bits[local >> 2] >> (2 * (local & 3))) & 3;
}
