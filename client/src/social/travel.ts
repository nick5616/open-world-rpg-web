// Travel to a friend (playtest 2, CR 017): the Friends panel's "Travel"
// button sends Interact 61 to the zone, which runs a 3 s channel (Event
// 980; moving or taking damage cancels it, 981), checks the friendship and
// moves you to the friend (core teleport Event, then 982). The friend is
// named by a 64-bit FNV-1a hash of their character id (Interact has no
// string field); server/zone/internal/game/friendtravel.go hashes the same.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../net/netStore';
import type { ZoneSession } from '../net/zoneSession';

export const INTERACT_FRIEND = 61;
export const FRIEND_ACT = { travel: 1, cancel: 2 } as const;
export const TRAVEL_EV = { channel: 980, refused: 981, arrived: 982 } as const;

export const TRAVEL_REFUSAL: Record<number, string> = {
  1: "isn't online in this world",
  2: "isn't your friend (yet)",
  3: "You can't travel while in combat",
  4: 'is in combat; try again in a moment',
  5: 'Travel is on cooldown (30 s)',
  6: 'Travel cancelled: you moved',
  7: 'Travel cancelled: you were hurt',
  8: 'Travel cancelled',
  9: 'Travel is unavailable on this server',
  10: "That's you",
};

/** FNV-1a 64 of a character id (UTF-8), as the zone's FriendHash. */
export function friendHash(characterId: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(characterId)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

/** The player-facing line for a refusal (friend-specific ones are prefixed with the name). */
export function refusalText(reason: number, name: string): string {
  const t = TRAVEL_REFUSAL[reason] ?? `Travel refused (${reason})`;
  return /^[a-z']/.test(t) ? `${name || 'Your friend'} ${t}` : t;
}

export interface TravelState {
  /** A channel in progress: who, when it started and how long it takes. */
  channel: { name: string; at: number; ms: number } | null;
  /** Last message (refusal or arrival) and when. */
  note: { text: string; at: number } | null;
  /** When the arrival fade started. */
  fadeAt: number;
}

export const useTravel = create<TravelState>(() => ({ channel: null, note: null, fadeAt: 0 }));

const dec = new TextDecoder();

/** Pure: the state change for one zone Event (null = not ours). */
export function reduceTravelEvent(s: TravelState, ev: ZoneEvent, now: number): Partial<TravelState> | null {
  const name = dec.decode(ev.data);
  switch (ev.kind) {
    case TRAVEL_EV.channel:
      return { channel: { name, at: now, ms: ev.value }, note: null };
    case TRAVEL_EV.refused:
      return { channel: null, note: { text: refusalText(ev.value, name || s.channel?.name || ''), at: now } };
    case TRAVEL_EV.arrived:
      return { channel: null, fadeAt: now, note: { text: `You travelled to ${name}`, at: now } };
  }
  return null;
}

const listener = (ev: ZoneEvent) => {
  const p = reduceTravelEvent(useTravel.getState(), ev, performance.now());
  if (p) useTravel.setState(p);
};
let hooked: ZoneSession | null = null;

/** Hook the live zone session (cheap; the overlay calls it on a timer). */
export function ensureTravelHook(): void {
  const s = netRuntime.session;
  if (s === hooked) return;
  hooked?.eventListeners.delete(listener);
  hooked = s;
  s?.eventListeners.add(listener);
}

/** Ask the zone to take us to a friend (a 3 s channel first). */
export function travelToFriend(characterId: string, name: string): void {
  const s = netRuntime.session;
  if (!s) {
    useTravel.setState({ note: { text: 'Connect to a zone to travel', at: performance.now() } });
    return;
  }
  ensureTravelHook();
  useTravel.setState({ note: { text: `Travelling to ${name}…`, at: performance.now() } });
  s.sendInteract(INTERACT_FRIEND, friendHash(characterId), FRIEND_ACT.travel, 0);
}
