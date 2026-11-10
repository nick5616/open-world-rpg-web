// Shared spell visual state (playtest 2, CR 022: "make spells
// graphics/animations shared client state").
//
// One record per caster: you ('self') or another player (their entity id).
// Both paths feed the SAME record through the SAME calls:
//
//   your prediction  runtime.ts (every action you start, the stream / charge /
//                    beam / guard you hold, your held dash, your aim every
//                    frame), LocalAvatar.tsx (your pickaxe swings)
//   replication      remoteEvent() below, from the zone's Events 214 (an
//                    action started, with its exact u16/i16 aim), 223 (stream /
//                    charge start and stop), 226 (CR 022: the precise aim of
//                    what they hold, and a keepalive for late observers), 219
//                    (their shield broke), 707 (a pickaxe swing), plus the
//                    Activity casting bit of their drawn snapshot (activity():
//                    a held action runs; for a dash, its thrust)
//
// and both renderers read it: the FX engine (fx/engine.ts: the aim a beam
// or a stream follows, whether a dash is thrusting) and the avatar animator
// (net/avatarAnim.ts followCaster: the action pose, the held pose, the held
// flight pose), for your own third-person body and for everyone else's.
// So your casts and another player's look the same: same origin
// (fx/castOrigin.ts), same aim function (aim.ts), same timing, same held
// state; only the source of the numbers differs.
//
// Remote events are applied when the caster's drawn body reaches the moment
// they happened: the interpolation shows other players `delayMs` in the
// past, so an event waits that long (the drawn activity bits are already
// delayed the same way). Without it a spell left a body ~100 ms before its
// arm moved.

import { COMBAT, i16ToPitch, u16ToYaw, type Event as ZoneEvent, type SpellDef } from '@lodestone/contracts';
import { angleDelta, unpackHeldAim } from './aim';
import { streamSeed } from './spellsim';

export type CasterKey = 'self' | number;
export type HeldKind = 'stream' | 'charge' | 'beam' | 'guard';

/** Event 214 targetId flag for a dash variant (contracts/events.md). */
export const CAST_FX_DASH = 0x8000;
/** Event 214 targetId: the secondary button went down on a sword, spear or bow (CR 018). */
export const CAST_FX_GUARD = 0x4001;
/** Client-only action id: a pickaxe swing (Event 707, or your own). */
export const CAST_FX_MINE = 0x4002;

const EV_CAST = 214;
const EV_SHIELD = 219;
const EV_CHANNEL = 223;
const EV_HELD = 226;
const EV_MINE_SWING = 707;
const ACTIVITY_CASTING = 8;
/** A held state nobody ended is dropped after this (ms). */
const HELD_MAX_MS = 30000;
/** A precise aim older than this falls back to the drawn look (ms). */
const AIM_FRESH_MS = 2500;

const spellById = new Map(COMBAT.spells.map((s) => [s.id, s]));

export interface HeldState {
  kind: HeldKind;
  /** Spell id (stream, charge, beam) or CAST_FX_GUARD. */
  id: number;
  /** The cast step's seq (a stream's seed: spellsim.streamSeed). */
  startSeq: number;
  /** performance.now() it started on this client (for a late observer: back-dated by its progress). */
  at: number;
  /** Ends by itself then (a channelled beam's duration), else Infinity. */
  until: number;
  /** Replication: the casting bit was seen since it started (a drop then ends it). */
  bitSeen: boolean;
}

export interface DashState {
  variant: number;
  /** The dash's key holds it now (jet thrust, skate, blink chain...). */
  holding: boolean;
  at: number;
}

export interface CasterState {
  key: CasterKey;
  /** The best aim known (radians): yours every frame; another player's from 214/223/226 (u16/i16). */
  aimYaw: number;
  aimPitch: number;
  aimAt: number;
  aimPrecise: boolean;
  /** Replication: the drawn look when the precise aim arrived (aimOf follows the drawn look's change since). */
  lookYaw0: number;
  lookPitch0: number;
  held: HeldState | null;
  dash: DashState | null;
  /** The newest action (Event 214 semantics: attack / spell / form id, CAST_FX_DASH | variant, CAST_FX_GUARD, CAST_FX_MINE). */
  action: { id: number; at: number; charge: number } | null;
  /** Bumped on every action (the animator's edge). */
  actions: number;
  /** Replication: how far in the past this caster is drawn (ms). */
  delayMs: number;
  /** The drawn look (replication; activity()). */
  lookYaw: number;
  lookPitch: number;
}

/** What replication asks the FX engine to draw (fx/api.ts spellFx implements it). */
export interface RemoteFx {
  remoteCast(casterId: number, id: number, x: number, y: number, z: number, yaw: number, pitch: number, charge?: number): void;
  remoteStream(casterId: number, sp: SpellDef, x: number, y: number, z: number, yaw: number, pitch: number, seed: number, firstShot?: number): void;
  remoteChannelEnd(casterId: number): void;
  chargeStart(sp: SpellDef, caster: number): void;
  shieldBroken(casterId: number): void;
}

const states = new Map<CasterKey, CasterState>();
const queue: { due: number; run: () => void }[] = [];

function blank(key: CasterKey): CasterState {
  return { key, aimYaw: 0, aimPitch: 0, aimAt: -1e9, aimPrecise: false, lookYaw0: 0, lookPitch0: 0, held: null, dash: null, action: null, actions: 0, delayMs: 0, lookYaw: 0, lookPitch: 0 };
}

function heldKindOf(id: number): HeldKind | null {
  if (id === CAST_FX_GUARD) return 'guard';
  const s = spellById.get(id);
  if (!s) return null;
  if (s.auto) return 'stream';
  if (s.charge) return 'charge';
  if (s.type === 'beam') return 'beam';
  return null;
}

/** A channelled beam's held window (ms): windup + duration, as the zone holds it. */
export function beamHoldMs(s: SpellDef): number {
  return s.windupMs + s.durationMs;
}

export const castState = {
  /** The record for a caster (created on first use). */
  get(key: CasterKey): CasterState {
    let s = states.get(key);
    if (!s) {
      s = blank(key);
      states.set(key, s);
    }
    return s;
  },
  peek(key: CasterKey): CasterState | undefined {
    return states.get(key);
  },
  forget(key: CasterKey): void {
    states.delete(key);
  },
  /** Every record and pending event (leaving a zone, tests). */
  clear(): void {
    states.clear();
    queue.length = 0;
  },
  keys(): CasterKey[] {
    return [...states.keys()];
  },

  /** An action started (attack, cast, form, dash, guard press, pickaxe swing). */
  action(key: CasterKey, id: number, at: number, charge = 0): void {
    const s = castState.get(key);
    s.action = { id, at, charge };
    s.actions++;
    if (id & CAST_FX_DASH) s.dash = { variant: id & 0x7fff, holding: false, at };
    else if (id !== CAST_FX_GUARD && s.held?.kind === 'guard') s.held = null; // the release (bow shot, spear thrust) ends the guard
    if (id === CAST_FX_GUARD) castState.hold(key, 'guard', id, 0, at);
    const sp = spellById.get(id);
    if (sp?.type === 'beam' && sp.durationMs > 0) castState.hold(key, 'beam', id, 0, at, at + beamHoldMs(sp));
  },

  /** A held action began (or, for a late observer, was found running). */
  hold(key: CasterKey, kind: HeldKind, id: number, startSeq: number, at: number, until = Infinity): HeldState {
    const s = castState.get(key);
    s.held = { kind, id, startSeq, at, until, bitSeen: false };
    return s.held;
  },

  /** It ended (only if it is still that kind, when one is given). */
  release(key: CasterKey, kind?: HeldKind): void {
    const s = states.get(key);
    if (s?.held && (!kind || s.held.kind === kind)) s.held = null;
  },

  /** The aim (radians). Precise: from your own view, or an Event's u16/i16. */
  aim(key: CasterKey, yaw: number, pitch: number, precise: boolean, at: number): void {
    const s = castState.get(key);
    s.aimYaw = yaw;
    s.aimPitch = pitch;
    s.aimAt = at;
    s.aimPrecise = precise;
    s.lookYaw0 = key === 'self' ? yaw : s.lookYaw;
    s.lookPitch0 = key === 'self' ? pitch : s.lookPitch;
  },

  /** Your held dash (the timeline's dashLive): variant 0 = none. */
  dashHolding(key: CasterKey, variant: number, holding: boolean, at: number): void {
    const s = castState.get(key);
    if (!variant) {
      s.dash = null;
      return;
    }
    if (!s.dash || s.dash.variant !== variant) s.dash = { variant, holding, at };
    else s.dash.holding = holding;
  },

  /**
   * Replication, every frame for every drawn player: the drawn look and
   * Activity bits (the casting bit: a held action runs; with a dash running
   * and nothing else held, it is the dash's thrust), and how far back they
   * are drawn.
   */
  activity(id: number, activity: number, lookYaw: number, lookPitch: number, delayMs: number, now: number, fx?: RemoteFx): void {
    const s = castState.get(id);
    s.lookYaw = lookYaw;
    s.lookPitch = lookPitch;
    s.delayMs = delayMs;
    const casting = (activity & ACTIVITY_CASTING) !== 0;
    const h = s.held;
    if (h) {
      if (casting) h.bitSeen = true;
      else if (h.bitSeen || now > h.until || now - h.at > HELD_MAX_MS) {
        s.held = null;
        if (h.kind === 'stream' || h.kind === 'charge') fx?.remoteChannelEnd(id);
      }
    }
    if (s.dash) s.dash.holding = casting && !s.held && now - s.dash.at < HELD_MAX_MS;
  },

  /** Your (or anyone's) held state ending by time: beams, stale holds. */
  expire(key: CasterKey, now: number): void {
    const s = states.get(key);
    if (s?.held && (now > s.held.until || now - s.held.at > HELD_MAX_MS)) s.held = null;
  },

  /**
   * The aim to draw a caster's held spell with: yours exactly; another
   * player's precise aim moved by how their drawn look turned since it
   * arrived (between 10 Hz updates), or the drawn look when none is fresh.
   */
  aimOf(key: CasterKey, lookYaw: number, lookPitch: number, now: number): { yaw: number; pitch: number } {
    const s = states.get(key);
    if (!s || !s.aimPrecise || now - s.aimAt > AIM_FRESH_MS) return { yaw: lookYaw, pitch: lookPitch };
    if (key === 'self') return { yaw: s.aimYaw, pitch: s.aimPitch };
    return { yaw: s.aimYaw + angleDelta(lookYaw, s.lookYaw0), pitch: s.aimPitch + (lookPitch - s.lookPitch0) };
  },

  /** Runs replication events whose moment has come (every frame). */
  flush(now: number): void {
    if (!queue.length) return;
    let w = 0;
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i];
      if (q.due <= now) q.run();
      else queue[w++] = q;
    }
    queue.length = w;
  },

  /** Pending replication events (tests). */
  pending(): number {
    return queue.length;
  },
};

/** Run `fn` when the caster's drawn body reaches now (their interpolation delay). */
function atDrawnTime(id: number, now: number, fn: () => void): void {
  const d = states.get(id)?.delayMs ?? 0;
  if (d <= 1) fn();
  else queue.push({ due: now + d, run: fn });
}

const dv = (ev: ZoneEvent) => new DataView(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);

/**
 * Replication: one zone Event about another player's spell or action, into
 * their caster record and the FX engine. Returns true when it was one.
 * (Your own 223 stop and 219 points are the runtime's: prediction.)
 */
export function remoteEvent(ev: ZoneEvent, selfId: number, now: number, fx: RemoteFx): boolean {
  const id = ev.entityId;
  if (!id || id === selfId) return false;
  const x = ev.x / 100;
  const y = ev.y / 100;
  const z = ev.z / 100;
  switch (ev.kind) {
    case EV_CAST: {
      if (ev.data.length < 4) return true;
      const d = dv(ev);
      const yaw = u16ToYaw(d.getUint16(0, true));
      const pitch = i16ToPitch(d.getInt16(2, true));
      const charge = ev.data.length >= 5 ? ev.data[4] / 255 : 0;
      const what = Number(ev.targetId);
      atDrawnTime(id, now, () => {
        const t = performance.now();
        castState.aim(id, yaw, pitch, true, t);
        castState.action(id, what, t, charge);
        fx.remoteCast(id, what, x, y, z, yaw, pitch, charge);
      });
      return true;
    }
    case EV_CHANNEL: {
      const d = dv(ev);
      const sp = spellById.get(Number(ev.targetId));
      if (ev.value === 0) {
        atDrawnTime(id, now, () => {
          castState.release(id, 'stream');
          castState.release(id, 'charge');
          fx.remoteChannelEnd(id);
        });
        return true;
      }
      if (!sp || ev.data.length < 8) return true;
      const yaw = u16ToYaw(d.getUint16(0, true));
      const pitch = i16ToPitch(d.getInt16(2, true));
      const start = d.getUint32(4, true);
      atDrawnTime(id, now, () => {
        const t = performance.now();
        castState.aim(id, yaw, pitch, true, t);
        if (ev.value === 2) {
          castState.hold(id, 'charge', sp.id, start, t);
          fx.chargeStart(sp, id);
        } else {
          castState.hold(id, 'stream', sp.id, start, t);
          fx.remoteStream(id, sp, x, y, z, yaw, pitch, streamSeed(start, sp.id));
        }
      });
      return true;
    }
    case EV_HELD: {
      // CR 022: the precise aim of what they hold (10 Hz at most, on change), or a keepalive.
      const what = Number(ev.targetId);
      const { yaw16, pitch16 } = unpackHeldAim(ev.value);
      const yaw = u16ToYaw(yaw16);
      const pitch = i16ToPitch(pitch16);
      const start = ev.data.length >= 4 ? dv(ev).getUint32(0, true) : 0;
      const progress = ev.data.length >= 6 ? dv(ev).getUint16(4, true) : 0;
      atDrawnTime(id, now, () => {
        const t = performance.now();
        const s = castState.get(id);
        if (what & CAST_FX_DASH) {
          // A late observer learns which dash is thrusting (its look is its velocity).
          if (!s.dash || s.dash.variant !== (what & 0x7fff)) s.dash = { variant: what & 0x7fff, holding: true, at: t };
          return;
        }
        castState.aim(id, yaw, pitch, true, t);
        const kind = heldKindOf(what);
        if (!kind || s.held?.id === what) return;
        // Joined mid-hold: start it where it is (a stream's next shot index, a charge's gathering).
        const sp = spellById.get(what);
        if (kind === 'stream' && sp?.auto) {
          const h = castState.hold(id, kind, what, start, t - (progress * sp.auto.intervalSteps * 1000) / 60);
          h.bitSeen = true;
          fx.remoteStream(id, sp, x, y, z, yaw, pitch, streamSeed(start, sp.id), progress);
        } else if (kind === 'charge' && sp) {
          castState.hold(id, kind, what, start, t - (progress * 1000) / 60).bitSeen = true;
          fx.chargeStart(sp, id);
        } else {
          castState.hold(id, kind, what, start, t, kind === 'beam' && sp ? t + beamHoldMs(sp) : Infinity).bitSeen = true;
        }
      });
      return true;
    }
    case EV_SHIELD:
      if (ev.value === 0) atDrawnTime(id, now, () => fx.shieldBroken(id));
      return true;
    case EV_MINE_SWING:
      atDrawnTime(id, now, () => castState.action(id, CAST_FX_MINE, performance.now()));
      return true;
  }
  return false;
}
