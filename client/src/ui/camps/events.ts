// Camp wire glue (playtest 2 camps, CR 025): Event kinds 1100-1119 and
// Interact 90 (contracts/events.md). Piece records are binary (a player
// walking about gets every new area's pieces); the rare, wordy ones (your
// camp, a chest's contents, Rested) are JSON.

import { CAMPS, type Event as ZoneEvent } from '@lodestone/contracts';
import type { WireItem } from '../inventory/items';

export const CAMP_EV = {
  area: 1100,
  piece: 1101,
  removed: 1102,
  refused: 1103,
  chest: 1104,
  rested: 1105,
  mine: 1106,
  note: 1107,
} as const;

export const CAMP_INTERACT = 90;
export const CAMP_ACT = { place: 1, pickup: 2, use: 3, fuel: 4, put: 5, take: 6, label: 7, lock: 8, dev: 9, sync: 10 } as const;

/** Refusal texts (Event 1103 value; server/pkg/camps Refuse*). */
export const CAMP_REFUSAL: Record<number, string> = {
  1: 'Nothing to do there',
  2: 'Too far away',
  3: 'Not inside a settlement',
  4: 'The ground is too steep or uneven',
  5: 'Not in water',
  6: 'Something is in the way',
  7: "Too close to someone else's camp",
  8: 'Your camp has all its pieces (pick one up first)',
  9: 'You have enough of those',
  10: 'Keep your camp together (too far from your other pieces)',
  11: 'You need a kit for that (craft one: P)',
  12: 'Someone is standing there',
  13: 'Not underground',
  14: 'That is not yours',
  15: 'Empty the chest first',
  16: 'No room',
  17: 'It is locked',
  18: 'You have no firewood',
  19: 'The fire is already well fed',
  20: 'Step closer (another zone holds that ground)',
  21: 'You cannot rest right after a fight',
  22: 'No camps here',
  23: 'Sign in to keep items in a chest (local profiles keep them in the pack)',
};

export interface CampPiece {
  id: number;
  kind: number;
  rot: number;
  xCm: number;
  yCm: number;
  zCm: number;
  x: number;
  y: number;
  z: number;
  mine: boolean;
  shared: boolean;
  party: boolean;
  burning: boolean;
  /** performance.now() ms when the fire goes out (0: not burning). */
  burnEnd: number;
  /** Chest slots in use. */
  used: number;
  owner: string;
  label: string;
}

/** Decode one piece record at offset o; returns the piece and the next offset. */
export function decodePiece(b: Uint8Array, o: number, now = performance.now()): [CampPiece, number] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const lo = dv.getUint32(o, true);
  const hi = dv.getUint32(o + 4, true);
  const id = hi * 4294967296 + lo; // 40-bit ids: exact as numbers
  const kind = b[o + 8];
  const rot = b[o + 9] & 7;
  const xCm = dv.getInt32(o + 10, true);
  const yCm = dv.getInt32(o + 14, true);
  const zCm = dv.getInt32(o + 18, true);
  const fl = b[o + 22];
  const left = dv.getUint32(o + 23, true);
  const used = b[o + 27];
  let p = o + 28;
  const nOwner = b[p++];
  const owner = new TextDecoder().decode(b.subarray(p, p + nOwner));
  p += nOwner;
  const nLabel = b[p++];
  const label = new TextDecoder().decode(b.subarray(p, p + nLabel));
  p += nLabel;
  const burning = (fl & 8) !== 0;
  return [
    { id, kind, rot, xCm, yCm, zCm, x: xCm / 100, y: yCm / 100, z: zCm / 100, mine: (fl & 1) !== 0, shared: (fl & 2) !== 0, party: (fl & 4) !== 0, burning, burnEnd: burning ? now + left : 0, used, owner, label },
    p,
  ];
}

/** Event 1100: an area's pieces. */
export function decodeArea(e: ZoneEvent, now = performance.now()): { area: number; pieces: CampPiece[] } {
  const b = e.data;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint16(5, true);
  const pieces: CampPiece[] = [];
  let o = 7;
  for (let i = 0; i < n; i++) {
    const [p, next] = decodePiece(b, o, now);
    pieces.push(p);
    o = next;
  }
  return { area: e.targetId, pieces };
}

export function decodeRemoved(e: ZoneEvent): number {
  const dv = new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength);
  return dv.getUint32(4, true) * 4294967296 + dv.getUint32(0, true);
}

export interface CampMine {
  pieces: { id: number; kind: number; x: number; z: number }[];
  markers: { id: number; x: number; z: number; label: string; owner: string; mine: boolean }[];
  spawn: [number, number] | null;
  max: number;
  restedS: number;
}

export interface ChestView {
  piece: number;
  lock: number;
  owner: string;
  mine: boolean;
  open: boolean;
  slots: (WireItem | null)[];
  label?: string;
  shared: boolean;
}

export interface RestedInfo {
  staminaBonus: number;
  regenMult: number;
  manaRegenMult: number;
  fire: boolean;
}

const json = <T>(e: ZoneEvent): T => JSON.parse(new TextDecoder().decode(e.data)) as T;
export const decodeMine = (e: ZoneEvent) => json<CampMine>(e);
export const decodeChest = (e: ZoneEvent) => json<ChestView>(e);
export const decodeRested = (e: ZoneEvent): RestedInfo | null => (e.value > 0 && e.data.length ? json<RestedInfo>(e) : null);
export const noteText = (e: ZoneEvent) => new TextDecoder().decode(e.data);

/** Interact 90/1 target: kind | rot << 8 | x cm << 16 | z cm << 40 (24 bits each). */
export function placeTarget(kind: number, rot: number, xCm: number, zCm: number): bigint {
  return BigInt(kind & 0xff) | (BigInt(rot & 7) << 8n) | (BigInt(xCm & 0xffffff) << 16n) | (BigInt(zCm & 0xffffff) << 40n);
}

/** Piece kind ids by key (camps.yaml order). */
export const PIECE = {
  campfire: CAMPS.pieces.find((p) => p.key === 'campfire')!.id,
  bedroll: CAMPS.pieces.find((p) => p.key === 'bedroll')!.id,
  chest: CAMPS.pieces.find((p) => p.key === 'chest')!.id,
  workbench: CAMPS.pieces.find((p) => p.key === 'workbench')!.id,
  signpost: CAMPS.pieces.find((p) => p.key === 'signpost')!.id,
} as const;

/** A label as Interact 90/7 chunks (4 ASCII bytes each, 0-terminated). */
export function labelChunks(label: string): number[] {
  const bytes = [...label]
    .map((c) => c.charCodeAt(0))
    .filter((c) => c >= 32 && c < 127)
    .slice(0, 24);
  bytes.push(0);
  while (bytes.length % 4) bytes.push(0);
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) out.push((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0);
  return out;
}
