// Playtest 2 fishing, the client's side of a cast: a small state machine
// driven by your keys and the zone's Events (1080 the line landed, 1081
// hooked, 1082 caught, 1083 lost, 1084 refused). The zone decides what
// bites, when, and whether a fight could have been won that fast; this
// shows it and runs the reel fight (minigame.ts). Phases:
//
//   idle -> casting (sent) -> waiting (the float bobs; false nibbles; the
//   bite: strike now) -> hooking (sent) -> fight -> landing (sent) ->
//   result (the catch card or why it got away) -> idle
//
// `fishingTick` runs every frame (FishingLayer); the HUD re-renders on
// phase changes and polls `fishLive` for the bars.

import { create } from 'zustand';
import { CONTENT, type Event as ZoneEvent } from '@lodestone/contracts';
import { Fight, type FightEnd } from './minigame';
import { FEV, FISH_ACT, FISH_INTERACT, FISH_LOST_TEXT, FISH_REFUSAL_TEXT, LOST, packCast } from './fish';

export type FishPhase = 'idle' | 'casting' | 'waiting' | 'hooking' | 'fight' | 'landing' | 'result';

export interface Caught {
  key: string;
  name: string;
  item: string;
  weightG: number;
  rarity: number;
  water: string;
  first: boolean;
  record: boolean;
  count: number;
  best: number;
  id: number;
}

export interface FishingState {
  phase: FishPhase;
  seq: number;
  bobber: { x: number; y: number; z: number };
  water: string;
  /** performance.now() when the line landed (1080), the bite and its window (ms after that). */
  castAt: number;
  biteMs: number;
  windowMs: number;
  nibbles: number[];
  /** Where you stood when you cast (walking away reels in). */
  from: { x: number; z: number };
  rarity: number;
  caught: Caught | null;
  lostText: string;
  resultAt: number;
  notice: string;
  noticeAt: number;
}

export interface FishSend {
  interact(action: number, target: bigint, arg?: number): void;
}

const initial = (): FishingState => ({ phase: 'idle', seq: 0, bobber: { x: 0, y: 0, z: 0 }, water: '', castAt: 0, biteMs: 0, windowMs: 0, nibbles: [], from: { x: 0, z: 0 }, rarity: 0, caught: null, lostText: '', resultAt: 0, notice: '', noticeAt: 0 });

export const useFishing = create<FishingState>(() => initial());

/** Per-frame values (no React): the fight, the reel, the cast target. */
export const fishLive = {
  fight: null as Fight | null,
  reel: false,
  /** Where a cast would land now (FishingLayer computes it), and whether E would cast. */
  target: null as { x: number; y: number; z: number } | null,
  canCast: false,
  sentAt: 0,
  send: null as FishSend | null,
  /** Hooks: the local fishing pose (ui/emotes), set by link.ts. */
  onPose: null as null | ((id: number, value: number, at?: { x: number; y: number; z: number }) => void),
};

const now = () => performance.now();

function notice(text: string) {
  useFishing.setState({ notice: text, noticeAt: now() });
}

function toResult(p: Partial<FishingState>) {
  fishLive.fight = null;
  fishLive.reel = false;
  useFishing.setState({ ...p, phase: 'result', resultAt: now() });
}

/** E (or a click) with nothing on the line: cast at the current target. */
export function cast(): boolean {
  const s = useFishing.getState();
  const t = fishLive.target;
  if (s.phase !== 'idle' || !t || !fishLive.send) return false;
  fishLive.send.interact(FISH_ACT.cast, packCast(t.x, t.z));
  fishLive.sentAt = now();
  useFishing.setState({ phase: 'casting', bobber: { ...t }, caught: null });
  return true;
}

/** Strike (a bite, or too early) or reel in, by phase. Returns true when it used the press. */
export function press(): boolean {
  const s = useFishing.getState();
  switch (s.phase) {
    case 'waiting':
      fishLive.send?.interact(FISH_ACT.hook, BigInt(s.seq));
      fishLive.sentAt = now();
      useFishing.setState({ phase: 'hooking' });
      return true;
    case 'fight':
      fishLive.reel = true;
      return true;
    case 'casting':
    case 'hooking':
    case 'landing':
      return true;
  }
  return false;
}

export function release(): void {
  fishLive.reel = false;
}

/** Reel the line in (walked off, an emote, the Esc of the HUD). */
export function reelIn(reason: number = LOST.cancelled): void {
  const s = useFishing.getState();
  if (s.phase === 'idle' || s.phase === 'result') return;
  if (s.seq && s.phase !== 'casting') fishLive.send?.interact(FISH_ACT.lose, BigInt(s.seq), reason);
  fishLive.onPose?.(0, 0);
  toResult({ lostText: FISH_LOST_TEXT[reason] ?? 'You reeled in', caught: null });
}

/** Every frame: the fight, a missed bite, walking away, time-outs. */
export function fishingTick(dtMs: number, pos: { x: number; z: number }, t = now()): void {
  const s = useFishing.getState();
  switch (s.phase) {
    case 'casting':
    case 'hooking':
    case 'landing':
      if (t - fishLive.sentAt > 4000) toResult({ lostText: 'No answer from the water', caught: null });
      return;
    case 'waiting': {
      if (t > s.castAt + s.biteMs + s.windowMs) {
        fishLive.send?.interact(FISH_ACT.lose, BigInt(s.seq), LOST.missed);
        fishLive.onPose?.(0, 0);
        toResult({ lostText: FISH_LOST_TEXT[LOST.missed], caught: null });
      } else if (Math.hypot(pos.x - s.from.x, pos.z - s.from.z) > CONTENT.fishing.walkAwayM - 0.6) reelIn(LOST.walked);
      return;
    }
    case 'fight': {
      const f = fishLive.fight;
      if (!f) return;
      const end: FightEnd | null = f.advance(dtMs, fishLive.reel);
      if (end === 'landed') {
        fishLive.send?.interact(FISH_ACT.land, BigInt(s.seq), f.ms);
        fishLive.sentAt = t;
        useFishing.setState({ phase: 'landing' });
      } else if (end) {
        const reason = end === 'snapped' ? LOST.snapped : LOST.escaped;
        fishLive.send?.interact(FISH_ACT.lose, BigInt(s.seq), reason);
        fishLive.onPose?.(0, 0);
        toResult({ lostText: FISH_LOST_TEXT[reason], caught: null });
      } else if (Math.hypot(pos.x - s.from.x, pos.z - s.from.z) > CONTENT.fishing.walkAwayM - 0.6) reelIn(LOST.walked);
      return;
    }
    case 'result':
      if (t - s.resultAt > (s.caught ? 4200 : 2400)) useFishing.setState({ phase: 'idle', caught: null, lostText: '' });
      return;
  }
}

/** The bite phase of a waiting line at time t: 'calm' | 'nibble' | 'bite'. */
export function floatState(s: Pick<FishingState, 'castAt' | 'biteMs' | 'windowMs' | 'nibbles'>, t: number): 'calm' | 'nibble' | 'bite' {
  const el = t - s.castAt;
  if (el >= s.biteMs && el <= s.biteMs + s.windowMs) return 'bite';
  for (const n of s.nibbles) if (el >= n && el < n + 260) return 'nibble';
  return 'calm';
}

/** Apply one zone Event 1080-1084 (pure but for the store; the link calls it). */
export function applyFishEvent(e: ZoneEvent, pos: { x: number; z: number }, t = now()): boolean {
  if (e.kind < FEV.cast || e.kind > FEV.refused) return false;
  const s = useFishing.getState();
  const json = <T,>(): T | null => {
    try {
      return JSON.parse(new TextDecoder().decode(e.data)) as T;
    } catch {
      return null;
    }
  };
  switch (e.kind) {
    case FEV.cast: {
      const d = json<{ seq: number; water: string; biteMs: number; windowMs: number; nibbles: number[] | null }>();
      if (!d) return true;
      const bobber = { x: e.x / 100, y: e.y / 100, z: e.z / 100 };
      useFishing.setState({ phase: 'waiting', seq: d.seq, water: d.water, castAt: t, biteMs: d.biteMs, windowMs: d.windowMs, nibbles: d.nibbles ?? [], bobber, from: { x: pos.x, z: pos.z }, caught: null, lostText: '' });
      fishLive.onPose?.(20, 0, bobber);
      return true;
    }
    case FEV.hooked: {
      if (e.targetId !== s.seq || (s.phase !== 'hooking' && s.phase !== 'waiting')) return true;
      const d = json<{ seed: number; strength: number; erratic: number; stamina: number; rarity: number }>();
      if (!d) return true;
      fishLive.fight = new Fight({ seed: d.seed, strength: d.strength, erratic: d.erratic, stamina: d.stamina });
      fishLive.reel = false;
      useFishing.setState({ phase: 'fight', rarity: d.rarity });
      return true;
    }
    case FEV.caught: {
      const d = json<Omit<Caught, 'id'>>();
      if (!d) return true;
      fishLive.onPose?.(21, e.targetId);
      toResult({ caught: { ...d, id: e.targetId }, lostText: '' });
      return true;
    }
    case FEV.lost: {
      if (e.targetId !== s.seq) return true;
      if (s.phase !== 'result') {
        fishLive.onPose?.(0, 0);
        toResult({ lostText: FISH_LOST_TEXT[e.value] ?? 'It got away', caught: null });
      }
      return true;
    }
    case FEV.refused: {
      if (s.phase === 'casting' || s.phase === 'hooking' || s.phase === 'landing') useFishing.setState({ phase: 'idle' });
      notice(FISH_REFUSAL_TEXT[e.value] ?? 'Not now');
      return true;
    }
  }
  return true;
}

export function resetFishing(): void {
  fishLive.fight = null;
  fishLive.reel = false;
  useFishing.setState(initial());
}

export { FISH_INTERACT };
