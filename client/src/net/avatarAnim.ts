// Avatar animation (playtest 2: "animations in the third person of other
// people doing things in the game. it feels a little lifeless looking at
// other players"). A procedural state machine with no assets: it turns what
// the client already knows about a player into joint angles every frame.
//
// Inputs, all already on the wire or derived here:
//  - the drawn snapshot state: position (vertical speed and the movement
//    direction come from its frame-to-frame change), yaw and look pitch,
//    horizontal speed, the Activity bits (climbing, gliding, swimming,
//    airborne), health % (0 = downed);
//  - action events: Event 214 (another player's attack, cast, form or dash
//    started; CR 018 adds 0x4001 "secondary pressed": sword parry, spear
//    charge, bow draw), 222 (an enemy strike landed on them: flinch), 203
//    (downed), 707 (CR 018: a pickaxe swing at a vein);
//  - a plain dodge is not an event: a sudden jump in ground speed past
//    anything walking or sprinting reaches (DODGE_SPEED 12 m/s) is one.
//
// Output: a Pose of joint angles (radians) the avatar rig applies. Layers:
// locomotion (idle breathing, walk/run cycle phase-locked to ground speed,
// sprint lean and arm pump, jump/fall, landing dip, glide, climb, swim),
// look (head and torso follow pitch), then the current action blended over
// the upper body (weapon swings per weapon, spear thrust, bow draw/release,
// casts with an element-coloured hand glow, parry, mining swing, dodge
// roll), an additive hurt flinch, and downed on top of everything.
//
// Pure (no three.js) and allocation-free per frame: one Pose per avatar,
// action specs cached per id. Conventions: a limb hangs along -Y from its
// joint; `swing` is the joint's rotation.x (positive = forward/up, PI =
// straight up), `spread` rotates it away from the body (mirrored per side),
// `bend` is the elbow (forward) or knee (backward). Body/torso/head pitch
// are rotation.x values: positive leans back / looks up.

import { Activity, COMBAT, DODGE_SPEED, MOVE_STEP_HZ, SPRINT_MULTIPLIER } from '@lodestone/contracts';
import type { WeaponKind } from '../combat/weapons/look';
import { ELEMENT_COLORS } from '../combat/events';
import { CAST_FX_MINE, type CasterState } from '../combat/castState';

/** CR 018: Event 214 targetId for "the secondary button went down" (sword parry, spear charge, bow draw). Go: combat.CastFXGuard. */
export const CAST_FX_GUARD = 0x4001;
/** CR 018: Event 707 mine_swing (another player swung a pickaxe at a vein). Go: game.EventMineSwing. */
export const EV_MINE_SWING = 707;
/** Event 214 targetId flag for a mobility dash variant (contracts/events.md). */
export const CAST_FX_DASH = 0x8000;

// CR 022: held dashes pose the whole body while their key holds them: jet
// (Magma Dash: Iron Man flight along the velocity), skate (Glacier Step),
// soar (Updraft's glide), rush (the burst dashes: Static Step's blinks,
// Root Launch, Sunstep, Skip, Phase Slip).
export type ActionKind = 'slash' | 'thrust' | 'spin' | 'plunge' | 'bow' | 'bolt' | 'bonk' | 'cast' | 'castStaff' | 'castBig' | 'castBeam' | 'shield' | 'form' | 'dash' | 'dodge' | 'parry' | 'charge' | 'draw' | 'mine' | 'jet' | 'skate' | 'soar' | 'rush';

export interface ActionSpec {
  kind: ActionKind;
  /** Length of the motion (ms); for held poses (charge, draw) the time-out. */
  durMs: number;
  /** Hand glow colour (spells, forms, dashes), null for none. */
  color: string | null;
  /** Slash direction: 1 forehand (right to left), -1 backhand. */
  dir: number;
  /** Held until the next action replaces it (or durMs runs out). */
  hold: boolean;
}

const STEP_MS = 1000 / MOVE_STEP_HZ;
const moveById = new Map(COMBAT.moves.map((m) => [m.id, m]));
const spellById = new Map(COMBAT.spells.map((s) => [s.id, s]));
const formById = new Map(COMBAT.forms.map((f) => [f.id, f]));
const dashColor = new Map<number, string>();
for (const s of COMBAT.spells) if (s.dash) dashColor.set(s.dash, s.color ?? ELEMENT_COLORS[s.element] ?? '#9fe8d8');
for (const f of COMBAT.forms) if (f.dash && !dashColor.has(f.dash)) dashColor.set(f.dash, ELEMENT_COLORS[f.element] ?? '#9fe8d8');

const specCache = new Map<string, ActionSpec>();
const spec = (key: string, kind: ActionKind, durMs: number, color: string | null = null, dir = 1, hold = false): ActionSpec => {
  let s = specCache.get(key);
  if (!s) {
    s = { kind, durMs, color, dir, hold };
    specCache.set(key, s);
  }
  return s;
};

const dashSustain = new Map(COMBAT.dashes.map((d) => [d.id, d.sustain?.kind ?? null]));
const HELD_DASH_KIND: Record<string, ActionKind> = { jet: 'jet', skate: 'skate', glide: 'soar', blink: 'rush', dash: 'rush', phase: 'rush' };
const HELD_KINDS = new Set<ActionKind>(['jet', 'skate', 'soar', 'rush']);

/** CR 022: the held pose of a dash variant while its key holds it (null: it cannot be held). */
export function heldDashSpec(variant: number): ActionSpec | null {
  const k = dashSustain.get(variant);
  if (!k) return null;
  return spec(`held-dash:${variant}`, HELD_DASH_KIND[k] ?? 'rush', 30000, dashColor.get(variant) ?? null, 1, true);
}

/** The plain dodge (no event: derived from the speed jump). */
export const DODGE_SPEC: ActionSpec = { kind: 'dodge', durMs: 380, color: null, dir: 1, hold: false };
/** A pickaxe swing (Event 707, or the local miner). */
export const MINE_SPEC: ActionSpec = { kind: 'mine', durMs: 520, color: null, dir: 1, hold: false };

/**
 * What an Event 214 targetId (attack / spell / form id, a dash variant with
 * 0x8000, or CAST_FX_GUARD) looks like on a player holding `weapon`.
 */
export function classifyAction(id: number, weapon: WeaponKind | null): ActionSpec {
  if (id === CAST_FX_MINE) return MINE_SPEC;
  if (id === CAST_FX_GUARD) {
    if (weapon === 'spear') return spec('guard:spear', 'charge', 2500, null, 1, true);
    if (weapon === 'bow') return spec('guard:bow', 'draw', 3000, null, 1, true);
    return spec('guard', 'parry', 450);
  }
  if (id & CAST_FX_DASH) {
    const d = id & 0x7fff;
    return spec(`dash:${d}`, 'dash', 360, dashColor.get(d) ?? null);
  }
  const m = moveById.get(id);
  if (m) {
    const dur = Math.max(260, (m.startupSteps + m.activeSteps + m.recoverySteps) * STEP_MS + 60);
    const key = `move:${id}`;
    switch (m.weapon) {
      case 'sword':
        if (m.kind === 'heavy' || m.arc >= 360) return m.kind === 'plunge' ? spec(key, 'plunge', dur) : spec(key, 'spin', Math.max(dur, 520));
        if (m.kind === 'plunge') return spec(key, 'plunge', dur);
        return spec(key, 'slash', dur, null, m.combo % 2 === 1 ? -1 : 1);
      case 'spear':
        if (m.kind === 'plunge') return spec(key, 'plunge', dur);
        return m.arc >= 90 ? spec(key, 'slash', dur, null, -1) : spec(key, 'thrust', dur);
      case 'bow':
        return spec(key, 'bow', Math.max(dur, 420));
      default:
        return m.speed > 0 ? spec(key, 'bolt', Math.max(dur, 320)) : spec(key, 'bonk', dur);
    }
  }
  const f = formById.get(id);
  if (f) return spec(`form:${id}`, 'form', 560, ELEMENT_COLORS[f.element] ?? null);
  const s = spellById.get(id);
  if (s) {
    const color = s.color ?? ELEMENT_COLORS[s.element] ?? null;
    const key = `spell:${id}`;
    switch (s.type) {
      case 'mobility':
        return spec(key, 'dash', 360, color);
      case 'defensive':
        return spec(key, 'shield', 700, color);
      case 'beam':
        return spec(key, 'castBeam', Math.max(500, s.durationMs + 250), color);
      case 'aoe':
      case 'domain':
      case 'rune':
        return spec(key, 'castBig', 720 + s.windupMs, color);
      default:
        // Playtest 2: a staff or wand casts out of its tip (castOrigin.ts); other weapons from the open off hand.
        return weapon === 'staff' || weapon === 'wand' ? spec(`${key}:tip`, 'castStaff', 460 + s.windupMs, color) : spec(key, 'cast', 460 + s.windupMs, color);
    }
  }
  return spec('unknown', 'cast', 400, null);
}

/**
 * CR 020: Event 223 (a stream or charge of another player). A stream (1)
 * holds the casting arm out for as long as it runs; a charge (2) holds the
 * big gathering pose; the stop (0) plays a short release flick (a charge's
 * release also arrives as Event 214, the cast itself).
 */
export function classifyChannel(spellId: number, value: number, weapon: WeaponKind | null): ActionSpec {
  const s = spellById.get(spellId);
  const color = s ? (s.color ?? ELEMENT_COLORS[s.element] ?? null) : null;
  const staff = weapon === 'staff' || weapon === 'wand';
  if (value === 1) return spec(`stream:${spellId}:${staff ? 'tip' : 'hand'}`, staff ? 'castStaff' : 'cast', 30000, color, 1, true);
  if (value === 2) return spec(`charge:${spellId}`, 'castBig', 30000, color, 1, true);
  return spec(`release:${spellId}:${staff ? 'tip' : 'hand'}`, staff ? 'castStaff' : 'cast', 260, color);
}

export interface LimbPose {
  swing: number;
  spread: number;
  twist: number;
  bend: number;
}

export interface Pose {
  /** Hips height offset (m): bob, landing dip, roll, lying down. */
  bodyY: number;
  /** Whole body about the hips: pitch (lean), roll, yaw (spin). */
  bodyPitch: number;
  bodyRoll: number;
  bodyYaw: number;
  torsoPitch: number;
  torsoYaw: number;
  headPitch: number;
  armL: LimbPose;
  armR: LimbPose;
  legL: LimbPose;
  legR: LimbPose;
  /** Hand glow 0..1 and which hands (spells, forms, dashes). */
  glow: number;
  glowL: boolean;
  glowR: boolean;
  glowColor: string | null;
  /** Bow draw 0..1 (for a string that can show it). */
  bowDraw: number;
  glider: boolean;
}

export interface AnimInput {
  /** Drawn feet position (m). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Horizontal speed (m/s). */
  speed: number;
  activity: number;
  healthPct: number;
  /** CR 027: riding a steed (snapshot typeId bit 14): the seated pose. */
  riding?: boolean;
}

/** CR 027: how far the seated rider's hips are above a standing person's (ui/mounts/model.ts SADDLE_Y - the rig's hip height). */
export const RIDE_HIP_RAISE = 1.68 - 0.88;

const limb = (): LimbPose => ({ swing: 0, spread: 0, twist: 0, bend: 0 });
export function newPose(): Pose {
  return { bodyY: 0, bodyPitch: 0, bodyRoll: 0, bodyYaw: 0, torsoPitch: 0, torsoYaw: 0, headPitch: 0, armL: limb(), armR: limb(), legL: limb(), legR: limb(), glow: 0, glowL: false, glowR: false, glowColor: null, bowDraw: 0, glider: false };
}

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const set = (l: LimbPose, swing: number, spread: number, bend: number, twist = 0) => {
  l.swing = swing;
  l.spread = spread;
  l.bend = bend;
  l.twist = twist;
};
const mix = (l: LimbPose, t: LimbPose, w: number) => {
  l.swing += (t.swing - l.swing) * w;
  l.spread += (t.spread - l.spread) * w;
  l.bend += (t.bend - l.bend) * w;
  l.twist += (t.twist - l.twist) * w;
};

const WALK_SPEED = 4.9; // steady walking ground speed (movement.go)
const SPRINT_SPEED = 4.9 * SPRINT_MULTIPLIER; // ~7.8
/** A dodge: ground speed above this, jumping by at least DODGE_JUMP over the recent average. */
export const DODGE_MIN_SPEED = DODGE_SPEED * 0.85;
const DODGE_JUMP = 2.5;

/**
 * One avatar's animation state. `trigger` on events, `update` once per
 * frame (dt seconds) into `pose`. Time is the animator's own clock (the sum
 * of dt), so tests drive it deterministically.
 */
export class AvatarAnimator {
  readonly pose: Pose = newPose();
  /** Seconds since creation. */
  time = 0;
  private action: ActionSpec | null = null;
  private fromDraw = false;
  private actionAt = 0;
  private hurtAt = -1e9;
  private lastDodge = -1e9;
  private rollFwd = 1;
  private rollSide = 0;
  private phase = 0;
  private climbPhase = 0;
  private swimPhase = 0;
  private init = false;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private speedAvg = 0;
  private wasAir = false;
  private airVy = 0;
  private dip = 0;
  private downed = 0;
  /** Health 0 only means "downed" once seen above 0 (a zone without combat sends 0). */
  private everAlive = false;
  private readonly t: { r: LimbPose; l: LimbPose } = { r: limb(), l: limb() };

  /** The action playing now (tests, captures). */
  get current(): ActionKind | null {
    return this.action ? this.action.kind : null;
  }

  /** CR 022 (followCaster): the caster record's action counter seen, and the held pose shown. */
  seenActions = 0;
  heldSpec: ActionSpec | null = null;
  heldId = 0;

  /** Start an action now (replaces the one playing; a release ends a held draw/charge). */
  trigger(s: ActionSpec): void {
    // A shot released from a held draw looses at once instead of drawing again.
    this.fromDraw = s.kind === 'bow' && this.action?.kind === 'draw' && this.time - this.actionAt > 0.25;
    this.action = s;
    this.actionAt = this.time;
    if (s.kind === 'dodge' || s.kind === 'dash') {
      this.lastDodge = this.time;
      this.setRollAxis();
    }
  }

  /** A held draw/charge/parry ended without an attack (button released). */
  release(): void {
    if (this.action?.hold) {
      if (HELD_KINDS.has(this.action.kind)) this.heldEndedAt = this.time;
      this.action = null;
    }
  }
  /** When a held dash pose last ended (its carry is not a dodge). */
  private heldEndedAt = -1e9;

  /** An enemy hit them. */
  hurt(): void {
    this.hurtAt = this.time;
  }

  /** Event 203: they went down (health 0 now means downed even if never seen above 0). */
  downedEvent(): void {
    this.everAlive = true;
  }

  /** Forget motion history (teleports, respawns). */
  resetMotion(): void {
    this.init = false;
  }

  private setRollAxis(): void {
    // Movement direction relative to the facing, from the drawn motion.
    const h = Math.hypot(this.vx, this.vz);
    if (h < 1) {
      this.rollFwd = 1;
      this.rollSide = 0;
      return;
    }
    const y = this.lastYaw;
    const fwd = (-this.vx * Math.sin(y) - this.vz * Math.cos(y)) / h;
    const side = (this.vx * Math.cos(y) - this.vz * Math.sin(y)) / h;
    if (Math.abs(side) > Math.abs(fwd) * 1.2) {
      this.rollFwd = 0;
      this.rollSide = side > 0 ? 1 : -1;
    } else {
      this.rollFwd = fwd >= 0 ? 1 : -1;
      this.rollSide = 0;
    }
  }
  private lastYaw = 0;

  /** Advance dt seconds and write the pose. `weapon` steers nothing here (classification does). */
  update(inp: AnimInput, dt: number): Pose {
    const p = this.pose;
    dt = clamp(dt, 0, 0.1);
    this.time += dt;
    const now = this.time;
    this.lastYaw = inp.yaw;

    // Motion from the drawn position (vertical speed, direction of travel).
    if (!this.init) {
      this.init = true;
      this.lastX = inp.x;
      this.lastY = inp.y;
      this.lastZ = inp.z;
      this.vx = this.vy = this.vz = 0;
      this.speedAvg = inp.speed;
    } else if (dt > 0) {
      const k = 1 - Math.exp(-dt / 0.08);
      const jump = Math.abs(inp.x - this.lastX) + Math.abs(inp.y - this.lastY) + Math.abs(inp.z - this.lastZ) > 8; // a teleport
      if (!jump) {
        this.vx += (clamp((inp.x - this.lastX) / dt, -60, 60) - this.vx) * k;
        this.vy += (clamp((inp.y - this.lastY) / dt, -40, 40) - this.vy) * k;
        this.vz += (clamp((inp.z - this.lastZ) / dt, -60, 60) - this.vz) * k;
      }
      this.lastX = inp.x;
      this.lastY = inp.y;
      this.lastZ = inp.z;
    }

    const act = inp.activity;
    const climbing = (act & Activity.climbing) !== 0;
    const gliding = (act & Activity.gliding) !== 0;
    const swimming = (act & Activity.swimming) !== 0;
    const air = (act & Activity.airborne) !== 0 && !gliding;
    if (inp.healthPct > 0) this.everAlive = true;
    const alive = inp.healthPct > 0 || !this.everAlive;
    const sp = inp.speed;

    // A plain dodge: a sudden burst of ground speed.
    const riding = !!inp.riding; // CR 027: seated on a steed (no dodge from a spur's burst)
    if (alive && !riding && !gliding && !climbing && !swimming && sp > DODGE_MIN_SPEED && sp - this.speedAvg > DODGE_JUMP && now - this.lastDodge > 0.45 && this.action?.kind !== 'dash' && !(this.action && HELD_KINDS.has(this.action.kind)) && now - this.heldEndedAt > 0.6) this.trigger(DODGE_SPEC);
    this.speedAvg += (sp - this.speedAvg) * (1 - Math.exp(-dt / 0.15));

    // Landing dip.
    if (air) this.airVy = this.vy;
    else if (this.wasAir && !climbing && !swimming && !gliding) this.dip = Math.max(this.dip, clamp(-this.airVy * 0.018, 0.03, 0.2));
    this.wasAir = air;
    this.dip *= Math.exp(-dt / 0.14);

    // ---- locomotion
    const br = Math.sin(now * TAU * 0.28); // breathing
    p.bodyPitch = p.bodyRoll = p.bodyYaw = 0;
    p.torsoYaw = 0;
    p.torsoPitch = 0;
    p.headPitch = 0;
    p.bodyY = 0;
    p.glider = gliding;
    p.glow = 0;
    p.glowL = p.glowR = false;
    p.glowColor = null;
    p.bowDraw = 0;
    let lookable = true;
    if (riding && alive) {
      // CR 027: astride the steed: hips on the saddle, thighs forward and
      // around its barrel, shins hanging, hands forward on the reins; the
      // rider sways with the gait and leans into a gallop.
      const stride = 1.7 + 0.2 * sp;
      this.phase += (dt * sp * TAU) / stride;
      if (this.phase > TAU * 1000) this.phase -= TAU * 1000;
      const gallop = smooth(9, 13, sp);
      const move = smooth(0.3, 3, sp);
      const bounce = Math.abs(Math.sin(this.phase)) * (0.035 * move + 0.03 * gallop);
      p.bodyY = RIDE_HIP_RAISE - bounce + 0.006 * br * (1 - move);
      p.bodyPitch = -(0.04 + 0.08 * move + 0.18 * gallop) + Math.sin(this.phase) * 0.03 * move;
      set(p.legR, 1.2, 0.5, 1.45);
      set(p.legL, 1.2, 0.5, 1.45);
      set(p.armR, 0.85 + 0.06 * Math.sin(this.phase) * move, 0.12, 1.0);
      set(p.armL, 0.85 + 0.06 * Math.sin(this.phase) * move, 0.12, 1.0);
      if (air) p.bodyY += 0.06;
    } else if (gliding) {
      lookable = false;
      p.bodyPitch = -0.3;
      set(p.armR, Math.PI - 0.15, 0.28, 0.05);
      set(p.armL, Math.PI - 0.15, 0.28, 0.05);
      set(p.legR, -0.2 + 0.05 * br, 0.06, 0.25);
      set(p.legL, -0.05 - 0.05 * br, 0.06, 0.35);
    } else if (climbing) {
      lookable = false;
      const rate = Math.abs(this.vy) + sp;
      this.climbPhase += dt * rate * 2.4;
      const c = Math.sin(this.climbPhase) * clamp(rate / 1.5, 0.25, 1);
      p.bodyPitch = -0.1;
      set(p.armR, Math.PI - 0.45 + c * 0.45, 0.2, 0.55 - c * 0.35);
      set(p.armL, Math.PI - 0.45 - c * 0.45, 0.2, 0.55 + c * 0.35);
      set(p.legR, 0.65 - c * 0.45, 0.12, 1.15 + c * 0.4);
      set(p.legL, 0.65 + c * 0.45, 0.12, 1.15 - c * 0.4);
    } else if (swimming) {
      lookable = false;
      this.swimPhase += dt * (1.4 + sp * 0.5);
      const c = Math.sin(this.swimPhase);
      p.bodyPitch = -1.25;
      p.bodyY = -0.2;
      p.headPitch = 0.9; // keep the face out of the water
      set(p.armR, Math.PI * (0.5 + 0.45 * c), 0.25, 0.3);
      set(p.armL, Math.PI * (0.5 - 0.45 * c), 0.25, 0.3);
      set(p.legR, Math.sin(this.swimPhase * 2) * 0.3, 0.08, 0.25);
      set(p.legL, -Math.sin(this.swimPhase * 2) * 0.3, 0.08, 0.25);
    } else if (air) {
      // Jumping up: knees tucked, arms lifting. Falling: arms out, legs reaching.
      const up = smooth(-1.5, 2.5, this.vy);
      set(p.legR, 0.25 + 0.5 * up, 0.06, 0.35 + 0.8 * up);
      set(p.legL, -0.1 + 0.3 * up, 0.06, 0.2 + 0.35 * up);
      set(p.armR, 0.35 + 0.25 * up, 0.75 - 0.4 * up, 0.35 + 0.2 * up);
      set(p.armL, 0.35 + 0.25 * up, 0.75 - 0.4 * up, 0.35 + 0.2 * up);
      p.bodyPitch = -0.08 * up;
    } else {
      // Walk / run: the cycle is locked to distance travelled, so feet don't slide.
      const stride = 1.5 + 0.17 * sp; // m per full cycle (two steps)
      this.phase += (dt * sp * TAU) / stride;
      if (this.phase > TAU * 1000) this.phase -= TAU * 1000;
      const amp = clamp(sp / (WALK_SPEED * 0.9), 0, 1);
      const sprint = clamp((sp - (WALK_SPEED + 0.4)) / (SPRINT_SPEED - WALK_SPEED - 0.4), 0, 1);
      const s = Math.sin(this.phase);
      const c = Math.cos(this.phase);
      const legAmp = 0.5 * amp + 0.28 * sprint;
      set(p.legR, s * legAmp, 0.04, 0.08 * amp + Math.max(0, c) * (0.85 * amp + 0.55 * sprint));
      set(p.legL, -s * legAmp, 0.04, 0.08 * amp + Math.max(0, -c) * (0.85 * amp + 0.55 * sprint));
      const armAmp = 0.42 * amp + 0.38 * sprint;
      const idle = 1 - amp;
      set(p.armR, 0.12 - s * armAmp, 0.1 + idle * 0.03 * (1 + br), 0.35 + 0.25 * amp + 0.95 * sprint);
      set(p.armL, 0.05 + s * armAmp, 0.1 + idle * 0.03 * (1 + br), 0.2 + 0.3 * amp + 0.95 * sprint);
      p.bodyPitch = -(0.05 * amp + 0.2 * sprint);
      p.torsoYaw = s * (0.1 * amp + 0.06 * sprint);
      p.bodyY = -Math.abs(c) * (0.04 * amp + 0.03 * sprint) + 0.008 * br * idle;
      p.torsoPitch = 0.025 * br * idle;
    }
    p.bodyY -= this.dip;
    p.legR.bend += this.dip * 4;
    p.legL.bend += this.dip * 4;

    // ---- look: the head and some of the torso follow the pitch.
    const pitch = clamp(inp.pitch, -1.3, 1.3);
    let aim = 0; // extra arm pitch for aimed actions
    if (lookable) {
      p.headPitch = clamp(pitch * 0.55, -0.6, 0.6);
      p.torsoPitch += clamp(pitch * 0.3, -0.35, 0.35);
      aim = pitch - clamp(pitch * 0.3, -0.35, 0.35);
    }

    // ---- action over the upper body
    const a = this.action;
    if (a && alive) {
      const e = (now - this.actionAt) * 1000;
      if (e >= a.durMs) this.action = null;
      else this.applyAction(a, e, aim, p);
    } else if (!alive) this.action = null;

    // ---- hurt flinch (additive)
    const he = (now - this.hurtAt) * 1000;
    if (he < 320 && alive) {
      const h = Math.sin((Math.PI * he) / 320);
      p.torsoPitch += 0.35 * h;
      p.headPitch += 0.3 * h;
      p.armR.spread += 0.25 * h;
      p.armL.spread += 0.25 * h;
      p.bodyY -= 0.05 * h;
    }

    // ---- downed: fall onto the back and lie there until health returns.
    this.downed += ((alive ? 0 : 1) - this.downed) * (1 - Math.exp(-dt / (alive ? 0.25 : 0.18)));
    const dk = this.downed;
    if (dk > 0.001) {
      p.bodyPitch += (1.5 - p.bodyPitch) * dk;
      p.bodyRoll *= 1 - dk;
      p.bodyYaw *= 1 - dk;
      p.bodyY += (-0.72 - p.bodyY) * dk;
      p.torsoPitch *= 1 - dk;
      p.torsoYaw *= 1 - dk;
      p.headPitch *= 1 - dk;
      set(this.t.r, 0.25, 0.9, 0.3);
      mix(p.armR, this.t.r, dk);
      mix(p.armL, this.t.r, dk);
      set(this.t.r, 0.05, 0.14, 0.15);
      mix(p.legR, this.t.r, dk);
      mix(p.legL, this.t.r, dk);
      p.glow *= 1 - dk;
      p.glider = p.glider && dk < 0.5;
    }
    return p;
  }

  private applyAction(a: ActionSpec, e: number, aim: number, p: Pose): void {
    const u = e / a.durMs;
    // Envelope: in over 70 ms, out over the last quarter (held poses stay in).
    const w = Math.min(1, e / 70) * (a.hold ? 1 - smooth(a.durMs - 200, a.durMs, e) : 1 - smooth(0.75, 1, u));
    const R = this.t.r;
    const L = this.t.l;
    let glow = 0;
    let gl = false;
    let gr = false;
    switch (a.kind) {
      case 'slash':
      case 'bonk':
      case 'form': {
        const k = a.kind === 'bonk' ? 0.7 : 1;
        const d = a.dir;
        const wind = smooth(0, 0.28, u);
        const strike = smooth(0.28, 0.5, u);
        set(R, 0.3 + (2.3 * wind - 1.6 * strike) * k, d * (0.15 + 0.6 * wind - 1.1 * strike) * k, 0.15 + 0.9 * wind * (1 - strike), -0.5 * d * strike * k);
        set(L, 0.3, 0.3, 0.6);
        p.torsoYaw += d * (-0.4 * wind + 0.9 * strike) * k * w;
        p.bodyPitch -= 0.08 * strike * w;
        if (a.kind === 'form') {
          glow = smooth(0, 0.2, u) * (1 - smooth(0.6, 1, u));
          gr = true;
        }
        break;
      }
      case 'thrust': {
        const wind = smooth(0, 0.35, u);
        const strike = smooth(0.35, 0.52, u);
        set(R, 0.4 + 1.0 * wind + 0.1 * strike + aim, 0.05, 0.1 + 1.8 * wind * (1 - strike));
        set(L, 1.1 + aim, -0.35, 1.0 - 0.6 * strike);
        p.torsoYaw += (-0.3 * wind + 0.45 * strike) * w;
        p.bodyPitch -= 0.15 * strike * w;
        break;
      }
      case 'spin': {
        p.bodyYaw += TAU * smooth(0.08, 0.85, u);
        set(R, 1.45, 0.5, 0.1);
        set(L, 1.3, 0.6, 0.2);
        break;
      }
      case 'plunge': {
        const wind = smooth(0, 0.3, u);
        const strike = smooth(0.3, 0.5, u);
        set(R, 0.3 + 2.6 * wind - 2.2 * strike, 0.1, 0.3);
        set(L, 0.3 + 2.4 * wind - 2.0 * strike, 0.1, 0.4);
        p.bodyPitch -= 0.35 * strike * w;
        p.bodyY -= 0.15 * strike * w;
        p.legR.bend += 0.5 * strike * w;
        p.legL.bend += 0.5 * strike * w;
        break;
      }
      case 'bow':
      case 'draw': {
        // Left arm holds the bow out at the aim; the right draws the string to the chin.
        const draw = a.kind === 'draw' ? smooth(0, 800, e) : this.fromDraw ? 1 - smooth(0, 40, e) : smooth(0, 0.45, u) * (1 - smooth(0.5, 0.56, u));
        set(L, 1.5 + aim, -0.15, 0.05);
        set(R, 1.42 + aim, -0.38, 0.55 + 1.65 * draw);
        p.torsoYaw -= 0.45 * w;
        p.bowDraw = draw * w;
        break;
      }
      case 'charge': {
        set(R, 0.9 + aim, 0.05, 1.9);
        set(L, 1.0 + aim, -0.3, 1.1);
        p.torsoYaw -= 0.35 * w;
        break;
      }
      case 'bolt': {
        const flick = smooth(0, 0.22, u);
        set(R, 0.5 + (1.1 + aim) * flick, 0.05, 0.9 - 0.8 * smooth(0.12, 0.3, u));
        set(L, 0.2, 0.2, 0.4);
        p.torsoYaw += 0.15 * flick * w;
        break;
      }
      case 'cast': {
        // The off hand rises toward the aim, glowing, and pushes.
        const raise = smooth(0, 0.3, u);
        const push = smooth(0.25, 0.45, u);
        set(L, 0.3 + (1.25 + aim) * raise, -0.1, 0.05 + 1.2 * raise * (1 - push));
        set(R, 0.45, 0.15, 0.6);
        p.torsoYaw -= 0.2 * raise * w;
        glow = raise * (1 - smooth(0.6, 1, u));
        gl = true;
        break;
      }
      case 'castStaff': {
        // The weapon hand raises the staff/wand toward the aim and thrusts its tip forward.
        const raise = smooth(0, 0.28, u);
        const push = smooth(0.22, 0.42, u);
        set(R, 0.4 + (1.2 + aim) * raise, 0.05, 0.1 + 1.1 * raise * (1 - push));
        set(L, 0.35, 0.25, 0.55);
        p.torsoYaw += 0.15 * raise * w;
        glow = raise * (1 - smooth(0.6, 1, u));
        gr = true;
        break;
      }
      case 'castBig': {
        const up = smooth(0, 0.4, u);
        const slam = smooth(0.42, 0.58, u);
        const sw = 0.2 + 2.7 * up - 1.9 * slam;
        set(R, sw, 0.35, 0.2);
        set(L, sw, 0.35, 0.2);
        p.torsoPitch += 0.2 * up * (1 - slam) * w;
        p.bodyPitch -= 0.2 * slam * w;
        glow = up * (1 - smooth(0.7, 1, u));
        gl = gr = true;
        break;
      }
      case 'castBeam': {
        set(R, 1.45 + aim, -0.12, 0.1);
        set(L, 1.45 + aim, -0.12, 0.1);
        glow = smooth(0, 0.1, u) * (1 - smooth(0.85, 1, u));
        gl = gr = true;
        break;
      }
      case 'shield': {
        set(R, 1.3, -0.55, 1.6);
        set(L, 1.3, -0.55, 1.6);
        glow = smooth(0, 0.25, u) * (1 - smooth(0.6, 1, u));
        gl = gr = true;
        break;
      }
      case 'dash': {
        set(R, -0.55, 0.3, 0.2);
        set(L, -0.55, 0.3, 0.2);
        p.bodyPitch -= 0.45 * w;
        glow = a.color ? 1 - smooth(0.5, 1, u) : 0;
        gl = gr = true;
        break;
      }
      case 'jet': {
        // Iron Man: the body lies along the flight (upright climbing, flat in
        // level flight, head first in a dive), arms back and down thrusting,
        // legs straight together, the head kept toward the flight.
        const hs = Math.hypot(this.vx, this.vz);
        const elev = Math.atan2(this.vy, Math.max(0.5, hs));
        const lean = -(Math.PI / 2 - elev) * 0.92;
        p.bodyPitch += (lean - p.bodyPitch) * w;
        p.bodyRoll *= 1 - w;
        p.headPitch += (clamp(-lean * 0.65, 0, 1.2) - p.headPitch) * w;
        p.torsoPitch *= 1 - w;
        set(R, -0.3, 0.32, 0.05);
        set(L, -0.3, 0.32, 0.05);
        set(this.t.r, 0.04, 0.03, 0.08);
        mix(p.legR, this.t.r, w);
        set(this.t.r, -0.04, 0.03, 0.12);
        mix(p.legL, this.t.r, w);
        glow = 1;
        gl = gr = true;
        break;
      }
      case 'skate': {
        // Long skating strides on the frozen path, leaning in, arms swinging wide.
        const s = Math.sin(this.time * 7);
        p.bodyPitch += (-0.42 - p.bodyPitch) * w;
        set(R, 0.2 - 0.7 * s, 0.45, 0.4);
        set(L, 0.2 + 0.7 * s, 0.45, 0.4);
        set(this.t.r, 0.35 + 0.45 * s, 0.25 + 0.15 * Math.max(0, -s), 0.55 - 0.3 * s);
        mix(p.legR, this.t.r, w);
        set(this.t.r, 0.35 - 0.45 * s, 0.25 + 0.15 * Math.max(0, s), 0.55 + 0.3 * s);
        mix(p.legL, this.t.r, w);
        glow = 0.6;
        gl = gr = true;
        break;
      }
      case 'soar': {
        // A held glide: arms spread wide like wings, body flat, legs trailing.
        p.bodyPitch += (-1.1 - p.bodyPitch) * w;
        p.headPitch += (0.9 - p.headPitch) * w;
        set(R, Math.PI / 2, 1.25, 0.05);
        set(L, Math.PI / 2, 1.25, 0.05);
        set(this.t.r, -0.15, 0.12, 0.1);
        mix(p.legR, this.t.r, w);
        mix(p.legL, this.t.r, w);
        glow = 0.7;
        gl = gr = true;
        break;
      }
      case 'rush': {
        // A sustained burst: low forward lean, arms swept back, legs driving.
        const s = Math.sin(this.time * 14);
        p.bodyPitch += (-0.7 - p.bodyPitch) * w;
        p.headPitch += (0.5 - p.headPitch) * w;
        set(R, -0.95, 0.3, 0.15);
        set(L, -0.95, 0.3, 0.15);
        set(this.t.r, 0.6 * s + 0.3, 0.05, 0.6 + 0.6 * Math.max(0, s));
        mix(p.legR, this.t.r, w);
        set(this.t.r, -0.6 * s + 0.3, 0.05, 0.6 + 0.6 * Math.max(0, -s));
        mix(p.legL, this.t.r, w);
        glow = 0.9;
        gl = gr = true;
        break;
      }
      case 'dodge': {
        // A roll in the direction of travel; tucked in the middle.
        const k = smooth(0.04, 0.92, u);
        const tuck = Math.sin(Math.PI * clamp(u, 0, 1));
        if (this.rollSide !== 0) p.bodyRoll -= TAU * k * this.rollSide;
        else p.bodyPitch -= TAU * k * this.rollFwd;
        // curled up (torso and head forward) so the roll stays above the ground
        p.bodyY -= 0.3 * tuck;
        p.torsoPitch -= 0.85 * tuck;
        p.headPitch -= 0.5 * tuck;
        set(R, 1.0, 0.2, 1.4);
        set(L, 1.0, 0.2, 1.4);
        set(this.t.r, 1.2, 0.05, 1.8);
        mix(p.legR, this.t.r, tuck);
        mix(p.legL, this.t.r, tuck);
        break;
      }
      case 'parry': {
        // The blade across the body, edge out.
        set(R, 1.35, -0.55, 1.0, -0.6);
        set(L, 0.9, -0.2, 1.2);
        p.torsoYaw -= 0.2 * w;
        break;
      }
      case 'mine': {
        const wind = smooth(0, 0.35, u);
        const strike = smooth(0.35, 0.55, u);
        set(R, 0.3 + 2.6 * wind - 2.2 * strike, 0.05, 0.5 * wind);
        set(L, 0.3 + 2.4 * wind - 2.0 * strike, -0.2, 0.6 * wind);
        p.bodyPitch -= 0.25 * strike * w;
        p.bodyY -= 0.08 * strike * w;
        break;
      }
    }
    mix(p.armR, R, w);
    mix(p.armL, L, w);
    if (glow > 0 && a.color) {
      p.glow = glow * w;
      p.glowL = gl;
      p.glowR = gr;
      p.glowColor = a.color;
    }
  }
}

/** An action older than this (ms) is not played when an avatar first follows its record. */
const ACTION_FRESH_MS = 1500;

/** What followCaster reads of a caster record (combat/castState.ts). */
export type CasterView = Pick<CasterState, 'action' | 'actions' | 'held' | 'dash'>;

/** The held pose a caster record asks for now (null: none). */
export function heldSpecOf(st: CasterView, weapon: WeaponKind | null): ActionSpec | null {
  const h = st.held;
  if (h) {
    switch (h.kind) {
      case 'stream':
        return classifyChannel(h.id, 1, weapon);
      case 'charge':
        return classifyChannel(h.id, 2, weapon);
      case 'guard': {
        const g = classifyAction(CAST_FX_GUARD, weapon);
        return g.hold ? g : null; // a sword's parry is a short stance (its press played it)
      }
      default:
        return null; // a beam: its castBeam action lasts its duration
    }
  }
  if (st.dash?.holding) return heldDashSpec(st.dash.variant);
  return null;
}

/**
 * CR 022: drive an avatar from its caster's shared state, every frame. The
 * SAME call poses your own third-person body (scene/LocalAvatar.tsx, fed by
 * your prediction) and every other player's (RemotePlayers.tsx, fed by
 * replication): a new action plays its pose, a held stream / charge / guard
 * holds its pose until it ends (a stream's end flicks the hand), a held dash
 * flies / skates / soars / rushes while its key holds it, and an action
 * played over a hold returns to the hold when it ends.
 */
export function followCaster(anim: AvatarAnimator, st: CasterView | undefined, weapon: WeaponKind | null, now = performance.now()): void {
  if (!st) {
    anim.seenActions = 0; // a record made later counts from its first action
    if (anim.heldSpec) {
      anim.release();
      anim.heldSpec = null;
    }
    return;
  }
  if (st.actions !== anim.seenActions) {
    anim.seenActions = st.actions;
    // (an action from before this body was drawn is not replayed)
    if (st.action && now - st.action.at < ACTION_FRESH_MS) anim.trigger(classifyAction(st.action.id, weapon));
  }
  const want = heldSpecOf(st, weapon);
  const prev = anim.heldSpec;
  if (want !== prev) {
    anim.heldSpec = want;
    if (want) {
      anim.heldId = st.held?.id ?? 0;
      anim.trigger(want);
    } else if (prev) {
      anim.release();
      if (prev.kind === 'cast' || prev.kind === 'castStaff') anim.trigger(classifyChannel(anim.heldId, 0, weapon)); // the stream's release flick
    }
  } else if (want && anim.current === null) anim.trigger(want); // an action played over the hold ended
}
