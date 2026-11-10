// Playtest 2 fishing: the reel fight (pure, fixed 60 Hz steps; tested in
// fishing.test.ts). The zone sends the fight's seed and the species'
// numbers when you hook a fish (Event 1081); the fish's pull is a seeded
// sequence of calm spells and surges (longer and more often for an erratic
// fish, harder for a strong one).
//
//   reeling    tension eases toward 0.25 + 1.1 x pull (a strong fish's
//              surge drives it past the top), progress climbs at
//              0.6 / stamina per second against a calm fish, barely
//              against a surging one
//   letting go tension falls toward 0.12 x pull, the fish takes a little
//              line back (progress falls, faster while it pulls)
//   in the red tension at the top for 0.4 s snaps the line
//   landed     progress reaches 1 (it starts at 0.25); escaped at 0 or
//              after maxFightS
//
// So: reel while it rests, ease off while it surges. The fastest possible
// fight (reeling the whole time against a calm fish) is 1.25 x stamina
// seconds: the zone refuses a landing sooner than that
// (content.FightMinMs).

import { CONTENT } from '@lodestone/contracts';

export interface FightParams {
  seed: number;
  strength: number; // 0..1
  erratic: number; // 0..1
  stamina: number; // s
}

export type FightEnd = 'landed' | 'snapped' | 'escaped';

export const FIGHT = {
  stepS: 1 / 60,
  start: 0.25,
  ease: 3, // 1/s toward the tension target
  redS: 0.4,
  red: 0.97,
  /** contracts/content.yaml fishing.maxFightS */
  maxS: CONTENT.fishing.maxFightS,
} as const;

/** Mulberry32: the same stream on every client for a seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Fight {
  tension = 0.2;
  progress: number = FIGHT.start;
  /** The fish's pull now (0..1). */
  pull = 0;
  /** Seconds fought. */
  t = 0;
  /** Seconds at the top of the bar (the line snaps at FIGHT.redS). */
  red = 0;
  done: FightEnd | null = null;
  /** Is the fish surging now (for the HUD's "It's pulling!"). */
  surging = false;
  private next: () => number;
  private segEnd = 0;
  private target = 0;
  private acc = 0;

  constructor(readonly p: FightParams) {
    this.next = rng(p.seed);
    this.segEnd = 0.6 + this.next() * 0.6; // a calm first moment to get a grip
    this.target = 0.08 * p.strength;
  }

  private segment(): void {
    const e = this.p.erratic;
    const surge = this.next() < 0.35 + 0.4 * e;
    const len = (0.35 + this.next() * 1.3) * (1 - 0.45 * e) + (surge ? 0.25 : 0.4);
    this.segEnd = this.t + len;
    this.surging = surge;
    this.target = surge ? this.p.strength * (0.85 + 0.15 * this.next()) : this.p.strength * (0.05 + 0.2 * this.next());
  }

  /** One fixed step with the reel held or not. */
  step(reeling: boolean): FightEnd | null {
    if (this.done) return this.done;
    const dt = FIGHT.stepS;
    this.t += dt;
    if (this.t >= this.segEnd) this.segment();
    // the pull follows its target quickly (a surge kicks in within ~0.15 s)
    this.pull += (this.target - this.pull) * (1 - Math.exp(-dt / 0.12));
    const pull = this.pull;
    const tgt = reeling ? 0.25 + 1.1 * pull : 0.12 * pull;
    this.tension += (tgt - this.tension) * (1 - Math.exp(-dt * FIGHT.ease));
    this.tension = Math.max(0, Math.min(1, this.tension));
    if (reeling) this.progress += dt * (0.6 / this.p.stamina) * (1 - 0.85 * pull);
    else this.progress -= dt * (0.02 + 0.06 * pull);
    this.red = this.tension >= FIGHT.red ? this.red + dt : Math.max(0, this.red - dt * 2);
    if (this.red >= FIGHT.redS) this.done = 'snapped';
    else if (this.t >= FIGHT.maxS) this.done = 'escaped'; // it tired you out (the zone gives up then too)
    else if (this.progress >= 1) {
      this.progress = 1;
      this.done = 'landed';
    } else if (this.progress <= 0) {
      this.progress = 0;
      this.done = 'escaped';
    }
    return this.done;
  }

  /** Advance real time (ms) with the reel held or not; whole steps only. */
  advance(ms: number, reeling: boolean): FightEnd | null {
    this.acc += Math.min(ms, 250) / 1000;
    while (this.acc >= FIGHT.stepS && !this.done) {
      this.acc -= FIGHT.stepS;
      this.step(reeling);
    }
    return this.done;
  }

  /** Milliseconds fought (the land Interact carries it). */
  get ms(): number {
    return Math.round(this.t * 1000);
  }
}

/** The fastest win against a fish (ms): the zone's content.FightMinMs. */
export function fightMinMs(stamina: number): number {
  return Math.trunc(1250 * stamina);
}
