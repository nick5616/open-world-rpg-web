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

/** CR 041 base building: Events 1820-1839. */
export const BUILD_EV = { info: 1820, missing: 1821 } as const;

export const CAMP_INTERACT = 90;
export const CAMP_ACT = { place: 1, pickup: 2, use: 3, fuel: 4, put: 5, take: 6, label: 7, lock: 8, dev: 9, sync: 10, repair: 11, home: 12, share: 13, buildSync: 14 } as const;

/** Interact 90/1 for a building kind: `arg` = height cm + this (0: the zone picks a foundation's height). */
export const BUILD_Y_BIAS = 1048576;

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
  // CR 041 base building
  24: 'Not on the build grid',
  25: 'Not inside a ruin, shrine or camp',
  26: 'Not on a road',
  27: 'Too high above the ground',
  28: 'Nothing to rest on or hang from',
  29: 'You have placed as many pieces as you may',
  30: 'This stretch of land cannot carry any more pieces',
  31: 'Missing materials',
  32: 'Other pieces rest on it',
  33: 'You have no bed to go home to (rest in one first)',
  34: 'Too soon: wait a little',
};

/** The hammer's wording: refusal 3 reads "Not inside a settlement" for a camp, which says the opposite for a base (playcheck: it showed on a green field 80 m from a town). */
export const BUILD_REFUSAL: Record<number, string> = { ...CAMP_REFUSAL, 3: 'Too close to a settlement (build at least 24 m out)' };

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
  /** Building pieces: bit 0 open (doors, gates). */
  state: number;
  /** Building pieces: condition in percent (100: as new). */
  cond: number;
  /** You may modify it: yours, or shared by a party member (flags bit 16). */
  modify: boolean;
}

/** Decode one piece record at offset o; returns the piece and the next offset. */
/** `version` 2 appends state and condition (CR 041; Event 1101 records are always version 2). */
export function decodePiece(b: Uint8Array, o: number, now = performance.now(), version = 2): [CampPiece, number] {
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
  let state = 0;
  let cond = 100;
  if (version >= 2) {
    state = b[p++];
    cond = b[p++];
  }
  const burning = (fl & 8) !== 0;
  return [
    { id, kind, rot, xCm, yCm, zCm, x: xCm / 100, y: yCm / 100, z: zCm / 100, mine: (fl & 1) !== 0, shared: (fl & 2) !== 0, party: (fl & 4) !== 0, burning, burnEnd: burning ? now + left : 0, used, owner, label, state, cond, modify: (fl & 16) !== 0 },
    p,
  ];
}

/** Event 1100: an area's pieces. */
export function decodeArea(e: ZoneEvent, now = performance.now()): { area: number; pieces: CampPiece[] } {
  const b = e.data;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = b[0];
  const n = dv.getUint16(5, true);
  const pieces: CampPiece[] = [];
  let o = 7;
  for (let i = 0; i < n; i++) {
    const [p, next] = decodePiece(b, o, now, version);
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
  /** CR 041: the bed's comfort score and tier name. */
  comfort?: number;
  tier?: string;
}

/** Event 1820 (CR 041): your base at a glance. */
export interface BuildInfo {
  pieces: number;
  budget: number;
  share: boolean;
  areaUsed: number;
  areaBudget: number;
  comfort: { score: number; max: number; tier: string; next: { score: number; name: string } | null };
  home: { x: number; y: number; z: number } | null;
  homeCdMs: number;
  hearth: { x: number; z: number; r: number } | null;
  /** performance.now() when it arrived (homeCdMs counts down from it). */
  at?: number;
}

/** Event 1821 (CR 041): what a refused piece was missing. */
export interface BuildMissing {
  kind: number;
  items: { item: string; qty: number; have: number }[];
}

const json = <T>(e: ZoneEvent): T => JSON.parse(new TextDecoder().decode(e.data)) as T;
export const decodeMine = (e: ZoneEvent) => json<CampMine>(e);
export const decodeChest = (e: ZoneEvent) => json<ChestView>(e);
export const decodeBuildInfo = (e: ZoneEvent) => json<BuildInfo>(e);
export const decodeBuildMissing = (e: ZoneEvent): BuildMissing => ({ kind: e.targetId, items: json<BuildMissing['items']>(e) });
export const decodeRested = (e: ZoneEvent): RestedInfo | null => (e.value > 0 && e.data.length ? json<RestedInfo>(e) : null);
export const noteText = (e: ZoneEvent) => new TextDecoder().decode(e.data);

/** Interact 90/1 target: kind | rot << 8 | x cm << 16 | z cm << 40 (24 bits each). */
export function placeTarget(kind: number, rot: number, xCm: number, zCm: number): bigint {
  return BigInt(kind & 0xff) | (BigInt(rot & 7) << 8n) | (BigInt(xCm & 0xffffff) << 16n) | (BigInt(zCm & 0xffffff) << 40n);
}

/** Interact 90/1 `arg` for a building piece at height `yCm` (0 for none). */
export const buildArg = (yCm: number | null): number => (yCm === null ? 0 : yCm + BUILD_Y_BIAS);

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
