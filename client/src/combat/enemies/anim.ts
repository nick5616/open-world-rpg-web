// Enemy animation state machine (playtest 2 enemy models). Pure (no
// three.js), allocation-free per frame, driven only by what the client
// already has (no contract change):
//
//   movement   the interpolated snapshot: horizontal speed (walk/run/hop
//              cycles locked to distance travelled, so feet don't slide),
//              yaw (turn rate -> lean), height (vertical motion);
//   wind-up    telegraph Event 204 (attack id -> what the attack looks
//              like, wind-up ms, active ms); the Activity.casting bit the
//              zone sets while an enemy winds up is the fallback when the
//              event was missed (out of its 70 m range, joined mid-swing);
//   strike     the active frames follow the wind-up (activeMs from the
//              event), then recovery (combat.yaml recoveryMs);
//   hit        HitResult (yours) / Event 200 (anyone's): flash + flinch;
//   stagger    a wind-up the zone interrupted (the casting bit dropped
//              well before the wind-up could finish: demons' stagger,
//              parries), knockback / stun statuses (206), parries (207);
//   hold       freeze / petrify (206): the pose stops where it is;
//   death      Event 201 or health 0 in the snapshot (the corpse lasts
//              1.5 s on the zone): fall / splat / dissolve.
//
// States: idle, move, windup, strike, recover, stagger, dying. The pose
// builders (pose.ts) read the public fields.

import { COMBAT, type EnemyAttackDef } from '@lodestone/contracts';

export type AttackKind = 'bite' | 'swipe' | 'slam' | 'punch' | 'stomp' | 'charge' | 'leap' | 'shoot' | 'spit' | 'sting' | 'cast' | 'nova' | 'bump';

export interface AttackAnim {
  key: string;
  kind: AttackKind;
  windupMs: number;
  activeMs: number;
  recoveryMs: number;
}

const BY_KEY: Record<string, AttackKind> = {
  slime_bump: 'bump',
  slime_hop: 'leap',
  pounce: 'leap',
  harpy_dive: 'leap',
  umbral_leap: 'leap',
  arrow_shot: 'shoot',
  frost_spit: 'spit',
  mud_spray: 'spit',
  stomp: 'stomp',
  smash: 'slam',
  sentinel_slam: 'slam',
  boss_slam: 'slam',
  grave_slam: 'slam',
  golem_punch: 'punch',
  stinger: 'sting',
  headbutt: 'bite',
  gore: 'bite',
  lord_meteor: 'cast',
  boss_meteor: 'cast',
  boss_beam: 'cast',
};

/** What an enemy attack looks like (by key, then by shape). */
export function attackKindFor(a: Pick<EnemyAttackDef, 'key' | 'shape' | 'arc' | 'charge'>): AttackKind {
  const k = BY_KEY[a.key];
  if (k) return k;
  switch (a.shape) {
    case 'cone':
      return a.arc < 90 ? 'bite' : 'swipe';
    case 'circle':
      return 'nova';
    case 'ground':
      return 'slam';
    case 'line':
      return a.charge ? 'charge' : 'cast';
    case 'projectile':
      return 'cast';
  }
  return 'bite';
}

const animById = new Map<number, AttackAnim>();
const animByKey = new Map<string, AttackAnim>();
for (const a of COMBAT.enemyAttacks) {
  const x: AttackAnim = { key: a.key, kind: attackKindFor(a), windupMs: a.windupMs, activeMs: a.activeMs, recoveryMs: a.recoveryMs };
  animById.set(a.id, x);
  animByKey.set(a.key, x);
}
const FALLBACK: AttackAnim = { key: '?', kind: 'bite', windupMs: 450, activeMs: 100, recoveryMs: 500 };

export function attackAnim(id: number): AttackAnim {
  return animById.get(id) ?? FALLBACK;
}

export function attackAnimByKey(key: string): AttackAnim {
  return animByKey.get(key) ?? FALLBACK;
}

/** The first attack of an enemy key (the casting-bit fallback). */
export function defaultAttack(enemyKey: string): AttackAnim {
  const e = COMBAT.enemies.find((x) => x.key === enemyKey);
  return e?.attacks.length ? attackAnimByKey(e.attacks[0]) : FALLBACK;
}

export type AnimState = 'idle' | 'move' | 'windup' | 'strike' | 'recover' | 'stagger' | 'dying';

export interface AnimOptions {
  /** Ground speed (m/s) that counts as a full walk/run cycle amplitude. */
  refSpeed: number;
  /** Metres per locomotion cycle (one full stride / hop). */
  stride: number;
  /** Death animation length (ms). */
  deathMs: number;
  /** The attack shown when only the casting bit says "winding up". */
  fallback: AttackAnim;
}

export interface AnimInput {
  speed: number;
  yaw: number;
  y: number;
  healthPct: number;
  /** Activity.casting: the zone says this enemy is winding up. */
  winding: boolean;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Shortest signed angle a - b. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const HURT_MS = 320;
export const FLASH_MS = 130;
export const STAGGER_MS = 520;
const STRIKE_MIN_MS = 140;
const RECOVER_MAX_MS = 700;

export class EnemyAnimator {
  state: AnimState = 'idle';
  /** Animation clock (s): stops while held (freeze / petrify). */
  time = 0;
  /** ms in the current state. */
  stateMs = 0;
  /** Smoothed horizontal speed (m/s) and its 0..1.5 share of refSpeed. */
  speed = 0;
  move = 0;
  /** Locomotion cycles travelled (distance / stride). */
  gait = 0;
  /** Smoothed yaw rate (rad/s), + = turning left. */
  turn = 0;
  /** Smoothed vertical speed (m/s). */
  vy = 0;
  attack: AttackAnim;
  /** 0..1 through the wind-up (holds 1 through strike and recovery). */
  windup = 0;
  /** 0..1 through the active frames (holds 1 through recovery). */
  strike = 0;
  /** 0..1 through the recovery. */
  recover = 0;
  /** 0..1: how hard the wind-up pose shakes (the last half of the wind-up). */
  tremble = 0;
  /** 0..1 hit flash (real time: it runs through hitstop). */
  flash = 0;
  /** 0..1..0 hurt flinch envelope. */
  flinch = 0;
  /** 0..1..0 stagger envelope. */
  stagger = 0;
  /** 0..1 through the death animation. */
  death = 0;
  /** 0..1 dissolve (last part of the death). */
  dissolve = 0;
  /** Seconds of hold (freeze / petrify) left. */
  held = 0;
  /** Which way the last hit came from does not matter for the pose; a heavy one flinches harder. */
  heavy = false;
  /** A free-running phase (rad) that speeds up through wind-ups (rings, halos, orbiting motes). */
  spin = 0;

  private everAlive = false;
  private diedByEvent = false;
  private hurtAt = -1e9;
  private flashLeft = 0;
  private bitSeen = false;
  private fromBit = false;
  private lastYaw = 0;
  private lastY = 0;
  private init = false;
  private staggerMs = STAGGER_MS;

  constructor(readonly opts: AnimOptions) {
    this.attack = opts.fallback;
  }

  get alive(): boolean {
    return this.state !== 'dying';
  }

  /** Telegraph Event 204: a wind-up starts now. */
  telegraph(a: AttackAnim, windupMs = a.windupMs, activeMs = a.activeMs): void {
    if (this.state === 'dying') return;
    // the casting bit got here first: keep its clock, take the real attack
    const keep = this.state === 'windup' && this.fromBit && this.stateMs < 250;
    this.attack = windupMs === a.windupMs && activeMs === a.activeMs ? a : { ...a, windupMs, activeMs };
    this.enter('windup', keep ? this.stateMs : 0);
    this.fromBit = false;
    this.bitSeen = false;
  }

  /** A confirmed hit on this enemy. */
  hit(heavy = false): void {
    if (this.state === 'dying') return;
    this.flashLeft = FLASH_MS;
    this.hurtAt = this.time;
    this.heavy = heavy;
  }

  /** Knocked off balance (stagger, parry, knockback, stun). */
  staggerNow(ms = STAGGER_MS): void {
    if (this.state === 'dying') return;
    this.staggerMs = ms;
    this.enter('stagger');
  }

  /** Freeze / petrify: the pose holds for `s` seconds. */
  hold(s: number): void {
    this.held = Math.max(this.held, s);
  }

  /** Event 201 (or health 0). */
  die(): void {
    this.diedByEvent = true;
    if (this.state !== 'dying') this.enter('dying');
  }

  private enter(s: AnimState, ms = 0): void {
    this.state = s;
    this.stateMs = ms;
  }

  /**
   * Advance by dt seconds. `frozen` (hitstop) stops the animation but not
   * the flash.
   */
  update(inp: AnimInput, dt: number, frozen = false): this {
    dt = clamp(dt, 0, 0.1);
    this.flashLeft = Math.max(0, this.flashLeft - dt * 1000);
    this.flash = this.flashLeft / FLASH_MS;
    if (inp.healthPct > 0) this.everAlive = true;

    if (!this.init) {
      this.init = true;
      this.lastYaw = inp.yaw;
      this.lastY = inp.y;
      this.speed = inp.speed;
    }
    // Health 0 means dying once it was seen alive (or the death event came).
    if (inp.healthPct <= 0 && this.everAlive && this.state !== 'dying') this.enter('dying');
    else if (this.state === 'dying' && inp.healthPct > 0 && !this.diedByEvent && this.death < 0.3) this.enter('idle');

    if (frozen && this.state !== 'dying') return this;
    if (this.held > 0 && this.state !== 'dying') {
      this.held = Math.max(0, this.held - dt);
      this.lastYaw = inp.yaw;
      this.lastY = inp.y;
      return this;
    }

    this.time += dt;
    this.stateMs += dt * 1000;
    this.spin = (this.spin + dt * (1.4 + 7 * this.attackWeight)) % (Math.PI * 200);
    const k = 1 - Math.exp(-dt / 0.12);
    this.speed += (inp.speed - this.speed) * k;
    this.move = clamp(this.speed / this.opts.refSpeed, 0, 1.5);
    this.gait += (dt * this.speed) / this.opts.stride;
    if (this.gait > 1e6) this.gait -= 1e6;
    if (dt > 0) {
      const yr = clamp(angleDiff(inp.yaw, this.lastYaw) / dt, -8, 8);
      this.turn += (yr - this.turn) * (1 - Math.exp(-dt / 0.15));
      const vy = clamp((inp.y - this.lastY) / dt, -20, 20);
      this.vy += (vy - this.vy) * (1 - Math.exp(-dt / 0.1));
    }
    this.lastYaw = inp.yaw;
    this.lastY = inp.y;

    // hurt flinch: a quick in-and-out over HURT_MS
    const he = (this.time - this.hurtAt) * 1000;
    this.flinch = he >= 0 && he < HURT_MS ? Math.sin((Math.PI * he) / HURT_MS) : 0;

    const a = this.attack;
    switch (this.state) {
      case 'dying': {
        this.death = clamp(this.stateMs / this.opts.deathMs, 0, 1);
        this.dissolve = smooth(0.5, 1, this.death);
        this.windup = this.strike = this.recover = this.tremble = 0;
        this.stagger = 0;
        return this;
      }
      case 'idle':
      case 'move':
        if (inp.winding) {
          // casting bit without a telegraph: a wind-up of the default attack
          this.attack = this.opts.fallback;
          this.enter('windup');
          this.fromBit = true;
          this.bitSeen = true;
        } else this.state = this.speed > 0.35 ? 'move' : 'idle';
        break;
      case 'windup':
        if (inp.winding) this.bitSeen = true;
        else if (this.bitSeen && this.stateMs < a.windupMs * 0.6) {
          // the zone dropped the wind-up early: interrupted (stagger)
          this.enter('stagger');
          this.staggerMs = STAGGER_MS;
          break;
        }
        if (this.stateMs >= a.windupMs) this.enter('strike', this.stateMs - a.windupMs);
        break;
      case 'strike':
        if (this.stateMs >= Math.max(STRIKE_MIN_MS, a.activeMs)) this.enter('recover');
        break;
      case 'recover':
        if (this.stateMs >= Math.min(RECOVER_MAX_MS, a.recoveryMs)) this.enter(this.speed > 0.35 ? 'move' : 'idle');
        break;
      case 'stagger':
        if (this.stateMs >= this.staggerMs) this.enter('idle');
        break;
    }

    // phase outputs
    const st = this.state;
    this.windup = st === 'windup' ? clamp(this.stateMs / a.windupMs, 0, 1) : st === 'strike' || st === 'recover' ? 1 : 0;
    this.strike = st === 'strike' ? clamp(this.stateMs / Math.max(STRIKE_MIN_MS, a.activeMs), 0, 1) : st === 'recover' ? 1 : 0;
    this.recover = st === 'recover' ? clamp(this.stateMs / Math.min(RECOVER_MAX_MS, a.recoveryMs), 0, 1) : 0;
    this.tremble = st === 'windup' ? smooth(0.45, 1, this.windup) : 0;
    this.stagger = st === 'stagger' ? Math.sin(Math.PI * clamp(this.stateMs / this.staggerMs, 0, 1)) : 0;
    return this;
  }

  /**
   * How much of the attack pose is in (0..1): eases in during the wind-up,
   * full through the strike, eases out over the recovery.
   */
  get attackWeight(): number {
    switch (this.state) {
      case 'windup':
        return smooth(0, 0.35, this.windup);
      case 'strike':
        return 1;
      case 'recover':
        return 1 - smooth(0.2, 1, this.recover);
      default:
        return 0;
    }
  }
}
