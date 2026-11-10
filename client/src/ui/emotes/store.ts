// Playtest 2 emotes: one record per player (yours under SELF), read every
// frame by the avatars (net/avatarAnim.ts followEmote) and, for the zone's
// fishing pose (id 20), by the fishing lines (ui/fishing/FishingLayer.tsx:
// x/y/z is then the bobber). Plain module state, no React: the scene reads
// it per frame.

import { CONTENT, type Event as ZoneEvent } from '@lodestone/contracts';
import type { EmoteView } from '../../net/avatarAnim';
import { EV_EMOTE, TokenBucket } from './emotes';

export const SELF = -1;

export interface EmoteRecord extends EmoteView {
  /** performance.now() when it started. */
  at: number;
  x: number;
  y: number;
  z: number;
}

const records = new Map<number, EmoteRecord>();
let counter = 0;

export function emoteOf(entity: number): EmoteRecord | undefined {
  return records.get(entity);
}

/** Every record (the fishing lines read id 20 ones). */
export function emoteRecords(): ReadonlyMap<number, EmoteRecord> {
  return records;
}

export function setEmote(entity: number, id: number, value: number, x: number, y: number, z: number, now = performance.now()): EmoteRecord {
  const r: EmoteRecord = { id, value, n: ++counter, at: now, x, y, z };
  records.set(entity, r);
  return r;
}

export function clearEmotes(): void {
  records.clear();
}

/** Event 1090 from the zone: another player's emote (0 stops it). */
export function applyEmoteEvent(e: ZoneEvent, now = performance.now()): boolean {
  if (e.kind !== EV_EMOTE) return false;
  setEmote(e.entityId, e.targetId, e.value, e.x / 100, e.y / 100, e.z / 100, now);
  return true;
}

/** Your own emotes: the same limit as the zone, so a spam is cut here, not refused there. */
export const localLimiter = new TokenBucket(CONTENT.emotes.burst, CONTENT.emotes.everyS);

/** First-person feedback reads this: the newest emote you played. */
export const localEmote = { id: 0, n: 0, at: -1e9 };
