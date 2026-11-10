// Playtest 2 instruments (CR 028): what travels. Pure, unit-tested
// (music.test.ts); the Go twin is server/zone/internal/game/music.go.
//
// A note event is 16 bits: MIDI note (7), velocity (3: 0 = the note-off of
// a held note, 1-7), ms into its batch (6). The player's client batches
// them: the first note after a quiet spell goes out at once (no added
// latency for a phrase's first note), the ones that follow within batchMs
// ride the next message, so a fast run costs at most 1000 / batchMs
// messages a second. Five events fit one Interact 120/2 (four in targetId,
// one in arg's low half; arg's high half is the batch clock: performance
// time in ms, wrapping at 65536). Listeners rebuild the timing with a small
// jitter buffer (Playout): notes keep their spacing inside a batch and
// between batches, delayed by the least latency seen lately plus a margin.

import { CONTENT } from '@lodestone/contracts';

export const MUSIC_INTERACT = 120;
export const MUSIC_ACT = { start: 1, notes: 2, stop: 3, tempo: 4, devKit: 9 } as const;
export const EV_MUSIC_NOTES = 1120;
export const EV_MUSIC_REFUSED = 1121;
export const EV_MUSIC_SONG = 1122;
export const EV_JAM_TEMPO = 1123;
export const EMOTE_PLAYING = 22;

export const MUSIC_REFUSAL: Record<number, string> = {
  1: 'You need an instrument in your pack (general stores and tool merchants sell them, or make one at a camp workbench)',
  2: 'Not now',
  3: 'Pick up your instrument first',
  4: 'Too many notes: some were not heard',
  5: 'That is not something you can play',
};

export const BATCH_MS = CONTENT.instruments.batchMs;
export const NOTES_PER_BATCH = 5;
const OFFSET_MAX = 63;

export interface NoteEvent {
  /** MIDI note 0-127. */
  note: number;
  /** 0 = note-off of a held note, 1-7 velocity. */
  vel: number;
  /** ms into its batch (0-63). */
  offsetMs: number;
}

export function encodeNote(n: NoteEvent): number {
  return (n.note & 0x7f) | ((n.vel & 7) << 7) | ((Math.max(0, Math.min(OFFSET_MAX, Math.round(n.offsetMs))) & 63) << 10);
}

/** 0 is an empty slot (null). */
export function decodeNote(v: number): NoteEvent | null {
  if (!v) return null;
  return { note: v & 0x7f, vel: (v >> 7) & 7, offsetMs: (v >> 10) & 63 };
}

/** Pack up to 5 events and the batch clock into Interact 120/2's targetId and arg. */
export function packBatch(events: readonly NoteEvent[], clockMs: number): { targetId: bigint; arg: number } {
  let tid = 0n;
  for (let i = 0; i < 4 && i < events.length; i++) tid |= BigInt(encodeNote(events[i])) << BigInt(16 * i);
  const fifth = events.length > 4 ? encodeNote(events[4]) : 0;
  const clock = Math.floor(((clockMs % 65536) + 65536) % 65536);
  return { targetId: tid, arg: (fifth | (clock << 16)) >>> 0 };
}

/** The inverse of packBatch (tests; the zone relays the events as Event 1120 data). */
export function unpackBatch(targetId: bigint, arg: number): { events: NoteEvent[]; clock: number } {
  const events: NoteEvent[] = [];
  for (let i = 0; i < 4; i++) {
    const n = decodeNote(Number((targetId >> BigInt(16 * i)) & 0xffffn));
    if (n) events.push(n);
  }
  const n = decodeNote(arg & 0xffff);
  if (n) events.push(n);
  return { events, clock: arg >>> 16 };
}

/** Event 1120 data: n x u16 LE. */
export function decodeNotesData(data: Uint8Array): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    const n = decodeNote(data[i] | (data[i + 1] << 8));
    if (n) out.push(n);
  }
  return out;
}

export interface Batch {
  events: NoteEvent[];
  /** The batch clock (ms) its offsets count from. */
  clock: number;
}

/**
 * The player's side: notes in, batches out. `add` when a key goes down or
 * up, `due` every few ms (or on a timer) to take what should be sent now.
 * At most one batch per `batchMs`; the first note after a quiet spell is
 * sent at once; more than 5 events in a window spill into the next batch.
 */
export class NoteBatcher {
  private pending: { note: number; vel: number; at: number }[] = [];
  private lastSent = -1e9;
  constructor(private readonly batchMs = BATCH_MS) {}

  get queued(): number {
    return this.pending.length;
  }

  add(note: number, vel: number, now: number): void {
    this.pending.push({ note, vel, at: now });
  }

  /** When the next batch may go (Infinity: nothing waiting). */
  nextDue(): number {
    if (!this.pending.length) return Infinity;
    return Math.max(this.pending[0].at, this.lastSent + this.batchMs);
  }

  /** The batch to send now, if any. */
  due(now: number): Batch | null {
    if (!this.pending.length || now < this.nextDue()) return null;
    const take = this.pending.splice(0, NOTES_PER_BATCH);
    const clock = take[0].at;
    this.lastSent = now;
    return { clock, events: take.map((p) => ({ note: p.note, vel: p.vel, offsetMs: Math.min(OFFSET_MAX, Math.max(0, p.at - clock)) })) };
  }

  clear(): void {
    this.pending = [];
  }
}

/**
 * A listener's jitter buffer for one player: when (local ms) each batch
 * should start so the player's timing survives the network. The local
 * arrival minus the player's batch clock is the latency plus a constant
 * offset between the two clocks; its minimum over the last few seconds is
 * the steady path. A batch plays at its clock + that minimum + `marginMs`
 * (never in the past). A batch more than `resetMs` after the last one
 * starts over (a new phrase is not held back by an old minimum).
 */
export class Playout {
  private base = 0; // unwrapped clock of the first batch
  private lastClock = -1;
  private unwrapped = 0;
  private samples: { at: number; d: number }[] = [];
  private lastArrival = -1e9;
  constructor(
    readonly marginMs = 45,
    readonly windowMs = 4000,
    readonly resetMs = 2500,
  ) {}

  /** Local start time (ms) for a batch with this clock arriving now. */
  schedule(clock: number, now: number): number {
    if (now - this.lastArrival > this.resetMs || this.lastClock < 0) {
      this.samples = [];
      this.lastClock = clock;
      this.unwrapped = clock;
      this.base = clock;
    } else {
      let dc = clock - this.lastClock;
      if (dc < -32768) dc += 65536;
      else if (dc > 32768) dc -= 65536;
      this.unwrapped += dc;
      this.lastClock = clock;
    }
    this.lastArrival = now;
    const d = now - this.unwrapped;
    this.samples.push({ at: now, d });
    while (this.samples.length && this.samples[0].at < now - this.windowMs) this.samples.shift();
    let min = Infinity;
    for (const s of this.samples) if (s.d < min) min = s.d;
    return Math.max(now, this.unwrapped + min + this.marginMs);
  }

  /** The player's clock this batch had (unwrapped), for tests. */
  get clock(): number {
    return this.unwrapped - this.base;
  }
}
