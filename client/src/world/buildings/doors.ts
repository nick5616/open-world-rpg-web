// Building doors on the client (playtest follow-up to WP20): the wire side.
// Events 970 door_state / 971 door_baseline / 972 door_refused
// (contracts/events.md) become DoorStates changes stamped with the input
// seq the zone applies them from; the movement ground (doorGround.ts) reads
// those per step, so prediction agrees with the zone through every open and
// close. When a change arrives after the client already predicted past its
// step (a long round trip), the pending steps are re-predicted from that
// step (ClientPrediction.replayFrom): what the zone computes, no correction.
// E on a door sends Interact 34 (open 1 / close 2); offline (solo) the door
// toggles locally from the next step.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import type { DoorStates, TownDoors } from '@lodestone/worldgen';

export const DOOR_EV = { state: 970, baseline: 971, refused: 972 } as const;
export const INTERACT_DOOR = 34;
export const DOOR_ACT = { open: 1, close: 2 } as const;
/** Reasons of 972 door_refused. */
export const DOOR_REFUSAL: Record<number, string> = {
  1: 'Too far from the door',
  2: 'That is not a door',
  3: 'Someone is standing in the doorway',
  4: 'The door is still swinging',
  5: 'The door is already like that',
};

export interface DoorStateEvent {
  /** PROPS index of the door prop. */
  prop: number;
  id: bigint;
  open: boolean;
  /** Your input seq from which the new state applies (0: already applies). */
  step: number;
  by: number;
}

export function decodeDoorState(e: ZoneEvent): DoorStateEvent {
  const dv = new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength);
  if (e.data.byteLength < 12) throw new Error('door_state: short payload');
  return { prop: e.targetId, id: dv.getBigUint64(0, true), open: e.value === 1, step: dv.getUint32(8, true), by: e.entityId };
}

export interface DoorBaseline {
  settlement: number;
  entries: { prop: number; was: boolean; to: boolean; step: number }[];
}

export function decodeDoorBaseline(e: ZoneEvent): DoorBaseline {
  const b = e.data;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.byteLength < 3 || dv.getUint8(0) !== 1) throw new Error('door_baseline: bad version');
  const n = dv.getUint16(1, true);
  if (b.byteLength < 3 + n * 10) throw new Error('door_baseline: truncated');
  const entries: DoorBaseline['entries'] = [];
  for (let i = 0, o = 3; i < n; i++, o += 10) entries.push({ prop: dv.getUint32(o, true), was: dv.getUint8(o + 4) === 1, to: dv.getUint8(o + 5) === 1, step: dv.getUint32(o + 6, true) });
  return { settlement: e.targetId, entries };
}

/** What DoorSync needs of a zone session (ZoneSession fits). */
export interface DoorSession {
  eventListeners: Set<(e: ZoneEvent) => void>;
  prediction: { replayFrom(seq: number): unknown };
  sendInteract(targetKind: number, targetId: bigint, action: number, arg?: number): void;
}

export class DoorSync {
  private session: DoorSession | null = null;
  private readonly listener = (e: ZoneEvent) => this.onEvent(e);
  /** Refusal toasts (the town HUD). */
  onRefused: ((text: string) => void) | null = null;
  /** Counters (acceptance, HUD). */
  readonly stats = { states: 0, baselines: 0, refused: 0, late: 0 };
  /** The local player's newest predicted seq (offline toggles; settling). */
  localSeq: () => number = () => 0;

  constructor(
    readonly doors: TownDoors,
    readonly states: DoorStates,
  ) {}

  /** Follow a session (or none): a new session starts with every door open until the zone says otherwise. */
  follow(s: DoorSession | null): void {
    if (s === this.session) return;
    this.session?.eventListeners.delete(this.listener);
    this.session = s;
    this.states.reset();
    s?.eventListeners.add(this.listener);
  }

  get online(): boolean {
    return this.session !== null;
  }

  /** Is door d open at the local player's current step (prompt, visuals)? */
  isOpen(d: number): boolean {
    return this.states.openAt(d, this.localSeq());
  }

  /** E on a door: Interact 34 online; offline the door changes from the next step. */
  toggle(d: number): void {
    const open = this.isOpen(d);
    const door = this.doors.doors[d];
    if (this.session) {
      this.session.sendInteract(INTERACT_DOOR, door.id, open ? DOOR_ACT.close : DOOR_ACT.open, 0);
      return;
    }
    const now = this.localSeq();
    this.states.set(d, !open, now + 1, now);
  }

  onEvent(e: ZoneEvent): void {
    if (e.kind < 970 || e.kind > 979) return;
    try {
      const now = this.localSeq();
      switch (e.kind) {
        case DOOR_EV.state: {
          const m = decodeDoorState(e);
          const d = this.doors.byPropIndex.get(m.prop);
          if (d === undefined) return;
          this.states.set(d, m.open, m.step, now);
          this.stats.states++;
          if (m.step !== 0) this.late(m.step);
          break;
        }
        case DOOR_EV.baseline: {
          const b = decodeDoorBaseline(e);
          const listed = new Set<number>();
          let earliest = 0;
          for (const en of b.entries) {
            const d = this.doors.byPropIndex.get(en.prop);
            if (d === undefined) continue;
            listed.add(d);
            this.states.put(d, en.was, en.to, en.step);
            if (en.step !== 0 && (earliest === 0 || en.step < earliest)) earliest = en.step;
          }
          // Doors of the settlement not listed are open.
          for (const door of this.doors.doors) if (door.settlement === b.settlement && !listed.has(door.index)) this.states.put(door.index, true, true, 0);
          this.stats.baselines++;
          if (earliest) this.late(earliest);
          break;
        }
        case DOOR_EV.refused:
          this.stats.refused++;
          this.onRefused?.(DOOR_REFUSAL[e.value] ?? `Refused (${e.value})`);
          break;
      }
    } catch (err) {
      console.warn('[doors] bad event payload', e.kind, err);
    }
  }

  /** A change from `step` on: re-predict if we already simulated that step (no-op otherwise). */
  private late(step: number): void {
    if (this.session?.prediction.replayFrom(step)) this.stats.late++;
  }
}
