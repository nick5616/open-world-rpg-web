// Shared seam for playtest 4 (dialog CR 049, lively townsfolk CR 050, the
// first hour CR 051): who the local player is talking to, and what each
// townsperson is saying out loud right now.
//
// - Dialog sets `talkingTo` while a conversation is open; npcs.ts turns that
//   NPC to face the player, holds its walk and plays talk gestures (and a
//   mouth/head motion while `speaking`).
// - Anyone can `say` a line for an NPC: Event 1930 barks from the zone
//   (server/zone/internal/game/npc_bark.go), client-side ambient chatter,
//   dialog lines. The townsfolk renderer draws the live line as an in-world
//   speech bubble over that NPC's head.
//
// Keys are NPC view keys (npcs.ts NpcView.key): the entity id online,
// -1 - record index offline. Plain module state, no React: read it from
// frame loops.

export const EV_NPC_BARK = 1930;

export interface NpcLine {
  text: string;
  /** performance.now() ms when the line started. */
  from: number;
  /** performance.now() ms when it stops showing. */
  until: number;
  /** True when the line is addressed to the local player. */
  toYou: boolean;
}

const lines = new Map<number, NpcLine>();
let talking: number | null = null;
let speaking = false;

/** Default on-screen time for a line: reading speed, clamped. */
export function lineMs(text: string): number {
  return Math.min(9000, Math.max(2200, 900 + text.length * 55));
}

/**
 * What players say aloud in a conversation (playtest 5, CR 053, Event 1960):
 * the answer you chose is a bubble over your own character and over you for
 * the players near you. Keys are entity ids. `toYou` here means "this is the
 * local player's own line".
 */
const playerLines = new Map<number, NpcLine>();

export const playerFocus = {
  say(id: number, text: string, mine = false, ms = 0, now = performance.now()): void {
    playerLines.set(id, { text, from: now, until: now + (ms > 0 ? ms : Math.min(5200, Math.max(2200, 1000 + text.length * 50))), toYou: mine });
  },
  live(now = performance.now()): [number, NpcLine][] {
    const out: [number, NpcLine][] = [];
    for (const [k, l] of playerLines) {
      if (now >= l.until) playerLines.delete(k);
      else out.push([k, l]);
    }
    return out;
  },
  reset(): void {
    playerLines.clear();
  },
};

export const npcFocus = {
  /** The NPC the local player is in a conversation with (null none). */
  get talkingTo(): number | null {
    return talking;
  },
  /** True while that NPC's current dialog line is being revealed. */
  get speaking(): boolean {
    return speaking;
  },
  setTalkingTo(key: number | null): void {
    talking = key;
    if (key === null) speaking = false;
  },
  setSpeaking(on: boolean): void {
    speaking = on;
  },
  /** NPC `key` says `text` aloud for `ms` (0: lineMs). */
  say(key: number, text: string, ms = 0, toYou = false, now = performance.now()): void {
    lines.set(key, { text, from: now, until: now + (ms > 0 ? ms : lineMs(text)), toYou });
  },
  /** The line NPC `key` is saying now, if any. */
  lineOf(key: number, now = performance.now()): NpcLine | null {
    const l = lines.get(key);
    if (!l) return null;
    if (now >= l.until) {
      lines.delete(key);
      return null;
    }
    return l;
  },
  /** Every live line (renderers iterate this; expired lines are dropped). */
  live(now = performance.now()): [number, NpcLine][] {
    const out: [number, NpcLine][] = [];
    for (const [k, l] of lines) {
      if (now >= l.until) lines.delete(k);
      else out.push([k, l]);
    }
    return out;
  },
  /** Tests. */
  reset(): void {
    lines.clear();
    talking = null;
    speaking = false;
  },
};
