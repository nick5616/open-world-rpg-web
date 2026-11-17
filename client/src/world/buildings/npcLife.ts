// The pure half of lively townsfolk (playtest 4, CR 050): where an NPC looks,
// when it greets, who chats with whom and what they say, which speech
// bubbles are drawn, and the procedural work poses. No three.js, no DOM, no
// clocks of its own (callers pass time), so vitest can drive every piece.
//
// Pose conventions (npcs.ts applies them to the instanced parts; the model
// faces +x, so):
//   arm `fwd`  rotation about the shoulder's z axis: 0 hangs, +1.57 points
//              straight ahead, +3.1 overhead.
//   arm `in`   swing toward the body's centre line (>0 inward, <0 outward).
//   `bend`     torso lean about the hips (>0 forward).
//   `twist`    torso turn about the spine.
//   head       yaw (about up), pitch (>0 looks up), roll (tilt).
//   `sit`      0..1 (hips down, legs forward), `crouch` 0..1 (cower).

import { CONVOS, h32 } from './npcLines';

export const TAU = Math.PI * 2;
/** npc/life.go StepOutM: the doorstep (2 m outside a building's door) villagers rest on and cats sit by. */
export const STEP_OUT_M = 2;
export const wrapPi = (a: number): number => {
  const x = (a + Math.PI) % TAU;
  return (x < 0 ? x + TAU : x) - Math.PI;
};
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);

// ---- Looking -----------------------------------------------------------------

export interface LookResult {
  /** Head yaw relative to the body (worldgen convention: >0 toward +z from +x). */
  head: number;
  /** Torso twist relative to the body, a fraction of the head's. */
  torso: number;
  /** False when the target is too far behind to track (the head eases back). */
  reach: boolean;
}

export const HEAD_MAX = 1.05;
export const TORSO_MAX = 0.4;
/** Beyond this relative angle (about 125 degrees) the NPC stops tracking. */
export const REACH_ANGLE = 2.2;

/** Head and torso angles for an NPC at (nx, nz) facing `yaw` (worldgen convention) looking at (tx, tz). */
export function lookAt(yaw: number, nx: number, nz: number, tx: number, tz: number, out: LookResult = { head: 0, torso: 0, reach: false }): LookResult {
  const rel = wrapPi(Math.atan2(tz - nz, tx - nx) - yaw);
  out.reach = Math.abs(rel) <= REACH_ANGLE;
  if (!out.reach) {
    out.head = 0;
    out.torso = 0;
    return out;
  }
  out.head = clamp(rel, -HEAD_MAX, HEAD_MAX);
  out.torso = clamp(rel * 0.3, -TORSO_MAX, TORSO_MAX);
  return out;
}

/** Exponential ease of an angle toward a target (frame-rate independent). */
export function easeTo(cur: number, target: number, dt: number, rate: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** Smooth wander of the head when nothing is watched: two slow sines per NPC, in [-0.6, 0.6] rad. */
export function lookAround(t: number, seed: number): number {
  const s = (seed % 97) * 0.37;
  return 0.42 * Math.sin(t * 0.37 + s) + 0.2 * Math.sin(t * 0.93 + s * 2.1);
}

/** Blink: the eyes are closed for 0.14 s every 2.6-6 s. Pure of time and seed. */
export function blinking(t: number, seed: number): boolean {
  const period = 2.6 + (h32(seed, 11) % 34) / 10;
  const off = (h32(seed, 12) % 100) / 100 * period;
  return (t + off) % period < 0.14;
}

// ---- Greeting ----------------------------------------------------------------

export const GREET_M = 5;
export const LOOK_M = 6;

/**
 * Greetings are rare: an NPC that greeted you is quiet toward you for
 * `perNpcMs`, and the whole town allows at most `maxInWindow` in `windowMs`
 * with at least `gapMs` between two, so a walk down the street is a few
 * friendly words, not a chorus.
 */
export class GreetLimiter {
  private readonly last = new Map<number, number>();
  private lastAny = -1e12;
  private recent: number[] = [];
  constructor(
    readonly perNpcMs = 150_000,
    readonly gapMs = 8_000,
    readonly windowMs = 60_000,
    readonly maxInWindow = 4,
  ) {}

  /** True (and recorded) when NPC `key` may greet now. */
  tryGreet(key: number, nowMs: number): boolean {
    if (nowMs - this.lastAny < this.gapMs) return false;
    const l = this.last.get(key);
    if (l !== undefined && nowMs - l < this.perNpcMs) return false;
    this.recent = this.recent.filter((t) => nowMs - t < this.windowMs);
    if (this.recent.length >= this.maxInWindow) return false;
    this.last.set(key, nowMs);
    this.lastAny = nowMs;
    this.recent.push(nowMs);
    if (this.last.size > 400) for (const [k, t] of this.last) if (nowMs - t > this.perNpcMs) this.last.delete(k);
    return true;
  }

  reset(): void {
    this.last.clear();
    this.recent = [];
    this.lastAny = -1e12;
  }
}

// ---- Chatting ----------------------------------------------------------------

export const CHAT_M = 3.4;
const CHAT_SLOT_S = 60;
const LINE_S = 4.6;
/** A chat is held by this share of the minute slots in which two neighbours are idle together. */
const CHAT_SHARE = 55;

export interface ChatLine {
  /** True when A speaks (A is the NPC with the smaller key). */
  speakerIsA: boolean;
  text: string;
  /** Index of the line in its conversation (the renderer says it when this changes). */
  index: number;
  convo: number;
  /** Seconds the line has been up. */
  age: number;
}

/**
 * The line that two idle neighbours `a` < `b` (stable keys) are saying at
 * unix time `nowS`, or null when they are quiet. Deterministic from the ids
 * and the clock: every client sees the same chat, no server needed.
 */
export function chatLine(a: number, b: number, nowS: number): ChatLine | null {
  const slot = Math.floor(nowS / CHAT_SLOT_S);
  const h = h32(a, b, slot);
  if (h % 100 >= CHAT_SHARE) return null;
  const convo = (h >>> 8) % CONVOS.length;
  const lines = CONVOS[convo];
  const start = slot * CHAT_SLOT_S + ((h >>> 16) % 8);
  const el = nowS - start;
  if (el < 0) return null;
  const index = Math.floor(el / LINE_S);
  if (index >= lines.length) return null;
  return { speakerIsA: index % 2 === 0, text: lines[index], index, convo, age: el - index * LINE_S };
}

export interface ChatCandidate {
  key: number;
  /** Stable id for the pairing hash (towns-buffer index when known). */
  stable: number;
  x: number;
  z: number;
  speed: number;
}

/**
 * Pair idle neighbours: each candidate takes its nearest idle neighbour
 * within CHAT_M when that neighbour's nearest is also it. Returns pairs of
 * indexes into `c` (a before b), each NPC in at most one pair.
 */
export function chatPairs(c: readonly ChatCandidate[], maxSpeed = 0.25): [number, number][] {
  const nearest = new Array<number>(c.length).fill(-1);
  for (let i = 0; i < c.length; i++) {
    if (c[i].speed > maxSpeed) continue;
    let bd = CHAT_M * CHAT_M;
    for (let j = 0; j < c.length; j++) {
      if (i === j || c[j].speed > maxSpeed) continue;
      const d = (c[i].x - c[j].x) ** 2 + (c[i].z - c[j].z) ** 2;
      if (d < bd || (d === bd && nearest[i] >= 0 && c[j].stable < c[nearest[i]].stable)) {
        bd = d;
        nearest[i] = j;
      }
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < c.length; i++) {
    const j = nearest[i];
    if (j > i && nearest[j] === i) out.push(c[i].stable <= c[j].stable ? [i, j] : [j, i]);
  }
  return out;
}

// ---- Speech bubbles ----------------------------------------------------------

export const BUBBLE_M = 25;
export const BUBBLE_MAX = 4;
/** Distance a line addressed to you gets knocked off when ranking (it wins ties against near chatter). */
const TO_YOU_BONUS_M = 8;

export interface BubbleCandidate {
  key: number;
  /** Metres from the camera. */
  d: number;
  toYou: boolean;
  /** False when the NPC's head is off screen. */
  onScreen: boolean;
}

/** Which live lines get a bubble: in range, on screen, nearest first (yours slightly preferred), a few at once. */
export function selectBubbles<T extends BubbleCandidate>(c: readonly T[], max = BUBBLE_MAX, range = BUBBLE_M): T[] {
  return c
    .filter((x) => x.onScreen && x.d <= range)
    .sort((a, b) => a.d - (a.toYou ? TO_YOU_BONUS_M : 0) - (b.d - (b.toYou ? TO_YOU_BONUS_M : 0)))
    .slice(0, max);
}

/** Bubble opacity: eases in over 0.2 s, out over the last 0.5 s, and fades toward the range edge. */
export function bubbleAlpha(nowMs: number, from: number, until: number, d: number, range = BUBBLE_M): number {
  const a = Math.min(1, (nowMs - from) / 200, (until - nowMs) / 500);
  const edge = clamp((range - d) / 4, 0, 1);
  return clamp(a, 0, 1) * edge;
}

// ---- Poses -------------------------------------------------------------------

export interface Pose {
  rFwd: number;
  rIn: number;
  lFwd: number;
  lIn: number;
  bend: number;
  twist: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
  sit: number;
  crouch: number;
  /** Extra leg swing multiplier (0 plants the feet). */
  legs: number;
  /** Held prop (PROP.*), -1 none. */
  prop: number;
}

export function newPose(): Pose {
  return { rFwd: 0, rIn: 0, lFwd: 0, lIn: 0, bend: 0, twist: 0, headYaw: 0, headPitch: 0, headRoll: 0, sit: 0, crouch: 0, legs: 1, prop: -1 };
}

export function resetPose(p: Pose): Pose {
  p.rFwd = p.rIn = p.lFwd = p.lIn = p.bend = p.twist = p.headYaw = p.headPitch = p.headRoll = p.sit = p.crouch = 0;
  p.legs = 1;
  p.prop = -1;
  return p;
}

export const NPC_ROLE = { villager: 0, merchant: 1, blacksmith: 2, innkeeper: 3, bounty: 4, farmer: 5, guard: 6 } as const;
/** Held props (one instanced "props" part draws them all). */
export const PROP = { hammer: 0, hoe: 1, scythe: 2, broom: 3, basket: 4, bucket: 5, mug: 6, spear: 7, crate: 8 } as const;

// Blacksmith: bursts of five hammer blows, then a breath.
export const SMITH_BURST = 5;
const SMITH_GAP = 0.85;
const SMITH_REST = 3.2;
const SMITH_CYCLE = SMITH_BURST * SMITH_GAP + SMITH_REST;

export interface SmithState {
  /** Blows struck so far (monotonic: the renderer fires a clang when it grows). */
  strikes: number;
  /** 0..1 within a blow (the blow lands at 0.5); -1 while resting. */
  ph: number;
  /** 0..1 through the rest. */
  rest: number;
}

export function smithState(t: number, out: SmithState = { strikes: 0, ph: 0, rest: 0 }): SmithState {
  const cyc = Math.floor(t / SMITH_CYCLE);
  const tc = t - cyc * SMITH_CYCLE;
  if (tc < SMITH_BURST * SMITH_GAP) {
    const k = Math.floor(tc / SMITH_GAP);
    out.ph = (tc - k * SMITH_GAP) / SMITH_GAP;
    out.strikes = cyc * SMITH_BURST + k + (out.ph >= 0.5 ? 1 : 0);
    out.rest = 0;
  } else {
    out.ph = -1;
    out.strikes = cyc * SMITH_BURST + SMITH_BURST;
    out.rest = (tc - SMITH_BURST * SMITH_GAP) / SMITH_REST;
  }
  return out;
}

/** Hammer arm angle through a blow (down at ph 0.5: the strike, then a swing back up). */
export function hammerArm(ph: number): number {
  if (ph < 0.5) {
    const u = ph / 0.5;
    return lerp(2.35, 0.8, u * u); // gathers speed into the blow
  }
  const u = (ph - 0.5) / 0.5;
  return lerp(0.8, 2.35, 1 - (1 - u) * (1 - u));
}

const sm: SmithState = { strikes: 0, ph: 0, rest: 0 };

/**
 * Work pose of `role` at its work spot, t seconds on the shared clock, `seed`
 * the NPC's own number (variant/phase). Writes into `p`; returns it.
 */
export function workPose(p: Pose, role: number, t: number, seed: number, variant: number): Pose {
  const s = (seed % 61) * 0.7;
  switch (role) {
    case NPC_ROLE.blacksmith: {
      smithState(t + s, sm);
      p.prop = PROP.hammer;
      if (sm.ph >= 0) {
        const a = hammerArm(sm.ph);
        const down = 1 - (a - 0.8) / 1.55;
        p.rFwd = a;
        p.rIn = 0.18;
        p.lFwd = 0.95;
        p.lIn = 0.3;
        p.bend = 0.12 + 0.3 * down;
        p.headPitch = -0.3 * down;
      } else {
        // Wipe the brow, breathe.
        const e = Math.sin(clamp(sm.rest * 1.3, 0, 1) * Math.PI);
        p.rFwd = lerp(0.9, 2.75, e);
        p.rIn = 0.5 * e;
        p.lFwd = 0.5;
        p.headPitch = 0.2 * e;
        p.bend = 0.05;
      }
      return p;
    }
    case NPC_ROLE.farmer: {
      if (variant & 1) {
        // Scythe: a long, slow sweep.
        const w = Math.sin((t + s) * 1.9);
        p.prop = PROP.scythe;
        p.twist = 0.7 * w;
        p.bend = 0.34;
        p.rFwd = 1.0;
        p.rIn = 0.25;
        p.lFwd = 1.0;
        p.lIn = 0.35;
        p.headPitch = -0.25;
      } else {
        // Hoe: lift, chop, rest on the handle.
        const ph = ((t + s) % 2.6) / 2.6;
        let a: number;
        if (ph < 0.4) a = lerp(0.7, 2.3, smooth(ph / 0.4));
        else if (ph < 0.52) a = lerp(2.3, 0.45, (ph - 0.4) / 0.12);
        else a = lerp(0.45, 0.7, smooth((ph - 0.52) / 0.48));
        const chop = 1 - (a - 0.45) / 1.85;
        p.prop = PROP.hoe;
        p.rFwd = a;
        p.rIn = 0.2;
        p.lFwd = a * 0.9;
        p.lIn = 0.3;
        p.bend = 0.12 + 0.38 * chop;
        p.headPitch = -0.3 * chop;
      }
      return p;
    }
    case NPC_ROLE.merchant: {
      const w = Math.sin((t + s) * 1.7);
      p.prop = (variant & 3) === 0 ? PROP.crate : -1;
      p.rFwd = 0.95 + 0.3 * w;
      p.lFwd = 0.95 - 0.3 * w;
      p.rIn = 0.35;
      p.lIn = 0.35;
      p.bend = 0.14 + 0.08 * Math.sin((t + s) * 0.6);
      p.headPitch = -0.28 + 0.1 * w;
      if (p.prop === PROP.crate) {
        p.rFwd = 1.15;
        p.lFwd = 1.15;
        p.rIn = 0.55;
        p.lIn = 0.55;
        p.headPitch = -0.1;
      }
      return p;
    }
    case NPC_ROLE.guard: {
      // Weight on one leg, a slow scan, spear grounded.
      p.prop = PROP.spear;
      p.rFwd = 0.12;
      p.rIn = 0.0;
      p.lFwd = -0.05;
      p.lIn = -0.05;
      p.headYaw = 0.85 * Math.sin((t + s) * 0.33) * Math.cos((t + s) * 0.11);
      p.bend = -0.03;
      return p;
    }
    case NPC_ROLE.innkeeper: {
      const cyc = ((t + s) % 24) / 24;
      if (cyc < 0.62) {
        // Wipe the counter.
        const w = Math.sin((t + s) * 4.2);
        p.rFwd = 1.05;
        p.rIn = 0.3 + 0.28 * w;
        p.lFwd = 0.4;
        p.bend = 0.14;
        p.headPitch = -0.22;
      } else {
        // Carry a mug over to someone.
        p.prop = PROP.mug;
        p.rFwd = 1.25;
        p.rIn = 0.3;
        p.lFwd = 0.2;
        p.headPitch = 0.05;
      }
      return p;
    }
    case NPC_ROLE.bounty: {
      // Arms folded, studying the board.
      p.rFwd = 0.95;
      p.lFwd = 0.95;
      p.rIn = 0.85;
      p.lIn = 0.85;
      p.headYaw = 0.5 * Math.sin((t + s) * 0.21);
      p.headPitch = 0.05;
      return p;
    }
    default: {
      // Villagers do their own small chores.
      switch (variant & 3) {
        case 0: {
          // Sweep.
          const w = Math.sin((t + s) * 2.3);
          p.prop = PROP.broom;
          p.twist = 0.5 * w;
          p.bend = 0.25;
          p.rFwd = 0.95;
          p.rIn = 0.2;
          p.lFwd = 1.0;
          p.lIn = 0.3;
          p.headPitch = -0.25;
          break;
        }
        case 1:
          p.prop = PROP.basket;
          p.rFwd = 0.4;
          break;
        case 2:
          p.prop = PROP.bucket;
          p.rFwd = 0.1;
          p.bend = 0.04;
          break;
        default:
          break;
      }
      return p;
    }
  }
}

/** What a villager carries while walking (the same chore props; others carry nothing). */
export function carryProp(role: number, variant: number): number {
  if (role !== NPC_ROLE.villager) return role === NPC_ROLE.guard ? PROP.spear : -1;
  const v = variant & 3;
  return v === 1 ? PROP.basket : v === 2 ? PROP.bucket : -1;
}

/** Rain pose: a hand (or the basket) over the head, shoulders hunched. */
export function rainPose(p: Pose, t: number, seed: number): Pose {
  p.rFwd = 2.7 + 0.05 * Math.sin(t * 3 + seed);
  p.rIn = 0.45;
  p.bend = 0.18;
  p.headPitch = -0.15;
  return p;
}

/** Cower: crouched, both arms over the head. */
export function cowerPose(p: Pose, t: number, seed: number): Pose {
  p.crouch = 1;
  p.rFwd = 2.5;
  p.lFwd = 2.5;
  p.rIn = 0.7;
  p.lIn = 0.7;
  p.bend = 0.5;
  p.headPitch = -0.3;
  p.headRoll = 0.05 * Math.sin(t * 17 + seed);
  p.legs = 0;
  return p;
}

/** A waved greeting t seconds in (right hand up, swinging; a head dip). Returns false after 1.6 s. */
export function wavePose(p: Pose, t: number): boolean {
  if (t < 0 || t > 1.6) return false;
  const env = Math.min(1, t / 0.2) * Math.min(1, (1.6 - t) / 0.25);
  p.rFwd = lerp(p.rFwd, 2.7, env);
  p.rIn = lerp(p.rIn, -0.1 + 0.45 * Math.sin(t * 11), env);
  p.headPitch += 0.12 * env;
  p.headRoll += 0.1 * Math.sin(t * 3) * env;
  return true;
}

/** Talking hands: small expressive swings of both arms while `speaking`, a thoughtful hold otherwise. */
export function talkPose(p: Pose, t: number, seed: number, speaking: boolean): Pose {
  const s = (seed % 23) * 0.9;
  if (speaking) {
    const a = Math.sin(t * 3.1 + s);
    const b = Math.sin(t * 2.3 + s * 1.7);
    p.rFwd = 0.9 + 0.55 * a;
    p.lFwd = 0.7 + 0.45 * b;
    p.rIn = 0.3 + 0.2 * b;
    p.lIn = 0.3 - 0.2 * a;
    p.headPitch = 0.08 * Math.sin(t * 4.1 + s);
    p.headRoll = 0.1 * Math.sin(t * 1.7 + s);
    p.bend = 0.04;
  } else {
    p.rFwd = 0.25;
    p.lFwd = 0.2;
    p.headRoll = 0.05 * Math.sin(t * 0.8 + s);
  }
  p.prop = -1;
  return p;
}

/** Mouth open while speaking/barking: a flap that varies (never a metronome). */
export function mouthOpen(t: number, seed: number): boolean {
  return Math.sin(t * 13.5 + seed) + Math.sin(t * 7.1) > 0.35;
}

// ---- Variety -----------------------------------------------------------------

export interface Build {
  /** Height scale (about 0.92..1.08). */
  h: number;
  /** Thickness/width scale (about 0.9..1.12). */
  w: number;
  /** Walk speed scale of the leg swing (a gait). */
  gait: number;
  /** 0 or 1: elders stoop and shuffle. */
  elder: number;
}

/** Per-NPC body: height, build, gait; elders (about one in six villagers) stoop and walk slower. */
export function buildOf(role: number, variant: number, stable: number): Build {
  const h = h32(stable, variant, 5);
  const elder = role === NPC_ROLE.villager && h % 6 === 0 ? 1 : role === NPC_ROLE.innkeeper && h % 5 === 0 ? 1 : 0;
  return {
    h: 0.92 + ((h >>> 3) % 17) / 100 - (elder ? 0.03 : 0),
    w: 0.9 + ((h >>> 9) % 23) / 100,
    gait: (elder ? 0.7 : 0.9) + ((h >>> 15) % 21) / 100,
    elder,
  };
}

// ---- Dress -------------------------------------------------------------------

/** Pieces on the head transform (one bit each; npcGear.ts builds the geometry per bit). */
export const H = { short: 0, long: 1, bun: 2, curls: 3, pony: 4, hat: 5, cap: 6, helm: 7, hood: 8, scarf: 9, beardShort: 10, beardFull: 11, beardDwarf: 12, moustache: 13, flatCap: 14, bald: 15 } as const;
/** Pieces on the torso. */
export const T = { apron: 0, vest: 1, skirt: 2, collar: 3, tabard: 4, belt: 5, shawl: 6 } as const;
/** Pieces on the arms. */
export const A = { long: 0, rolled: 1, bracer: 2 } as const;

export interface Dress {
  /** Bitmasks (1 << H.x ...). */
  head: number;
  torso: number;
  arm: number;
  /** Indexes into the renderer's colour tables. */
  hairCol: number;
  cloth: number;
  accent: number;
  skin: number;
  fem: boolean;
}

const bit = (n: number) => 1 << n;
const HAIR_BITS = bit(H.short) | bit(H.long) | bit(H.bun) | bit(H.curls) | bit(H.pony);

/**
 * What an NPC wears, from its variant and stable id: hair style, beard, hat
 * or hood or headscarf, vest, apron, skirt or dress, sleeves long or rolled.
 * Roles keep their look (guards helmeted and in tabards, smiths in leather
 * aprons with bare forearms) and vary within it; villagers vary the most.
 */
export function dressFor(role: number, variant: number, stable: number, dwarf: boolean, elder: boolean): Dress {
  const h = h32(stable, variant, role + 31);
  const r = (n: number, shift: number) => (h >>> shift) % n;
  const fem = !dwarf && role !== NPC_ROLE.guard && role !== NPC_ROLE.blacksmith && r(100, 12) < 46;
  let head = 0;
  let torso = 0;
  let arm = bit(A.long);
  const hairCol = elder ? 6 : ((variant >> 3) ^ variant) & 7;
  if (r(14, 4) === 0 && !fem) head |= bit(H.bald);
  else head |= bit((fem ? [H.long, H.bun, H.pony, H.long, H.curls] : [H.short, H.short, H.curls, H.pony, H.long])[r(5, 8)]);
  switch (role) {
    case NPC_ROLE.guard:
      head = (head & ~(HAIR_BITS | bit(H.bald))) | bit(H.helm) | bit(H.short);
      break;
    case NPC_ROLE.farmer:
      if (r(10, 16) < 7) head |= bit(H.hat);
      else if (fem) head |= bit(H.scarf);
      break;
    case NPC_ROLE.merchant:
      head |= bit(r(2, 16) === 0 ? H.flatCap : H.cap);
      break;
    case NPC_ROLE.bounty:
      head |= bit(H.hat);
      break;
    case NPC_ROLE.blacksmith:
      if (r(3, 16) === 0) head |= bit(H.scarf);
      break;
    case NPC_ROLE.innkeeper:
      if (r(5, 16) < 2) head |= bit(H.scarf);
      break;
    default: {
      const k = r(20, 16);
      if (k < 3) head |= bit(H.cap);
      else if (k < 6) head = (head & ~(HAIR_BITS | bit(H.bald))) | bit(H.hood);
      else if (k < 9) head |= bit(H.scarf);
      else if (k < 10) head |= bit(H.flatCap);
    }
  }
  // Curls and ponytails under a cap or hat would poke through: keep them short.
  if (head & (bit(H.cap) | bit(H.flatCap) | bit(H.hat) | bit(H.helm))) head = (head & ~(bit(H.curls) | bit(H.pony) | bit(H.long) | bit(H.bun))) | (head & bit(H.bald) ? 0 : bit(H.short));
  if (dwarf) head |= bit(H.beardDwarf);
  else if (!fem && role !== NPC_ROLE.guard) {
    const b = r(10, 20);
    if (b < 2) head |= bit(H.beardFull);
    else if (b < 4) head |= bit(H.beardShort);
    else if (b < 5) head |= bit(H.moustache);
  } else if (role === NPC_ROLE.guard && r(4, 20) === 0) head |= bit(H.moustache);
  if (role === NPC_ROLE.blacksmith || role === NPC_ROLE.innkeeper) torso |= bit(T.apron);
  if (role === NPC_ROLE.farmer && r(3, 24) === 0) torso |= bit(T.apron);
  if (role === NPC_ROLE.merchant && r(4, 24) === 0) torso |= bit(T.apron);
  if (role === NPC_ROLE.guard) torso |= bit(T.tabard) | bit(T.belt);
  if (fem && role !== NPC_ROLE.guard && r(100, 2) < 70) torso |= bit(T.skirt);
  if (role === NPC_ROLE.villager || role === NPC_ROLE.farmer || role === NPC_ROLE.merchant) {
    if (r(10, 26) < 3) torso |= bit(T.vest);
    if (r(10, 28) < 3) torso |= bit(T.collar);
    if (r(10, 30) < 3) torso |= bit(T.shawl);
    if (!(torso & bit(T.apron)) && r(10, 6) < 4) torso |= bit(T.belt);
  }
  if (role === NPC_ROLE.blacksmith) arm = 0;
  else if (role === NPC_ROLE.guard) arm = bit(A.long) | bit(A.bracer);
  else if (role === NPC_ROLE.farmer || role === NPC_ROLE.innkeeper || r(10, 14) < 3) arm = bit(A.rolled);
  return { head, torso, arm, hairCol, cloth: ((variant >> 2) ^ r(8, 22)) & 7, accent: r(8, 18), skin: variant & 3, fem };
}
