// The input-to-hit timing probe (WP13, spec 8: "the combat feel targets,
// measured with an input-to-hit timing probe in the client"). It timestamps
// every step of an attack's life in REAL time (performance.now), from the
// key/button event to the first hit frame, the local hit feedback, the
// hitstop and the zone's verdict, plus dodge i-frames, buffered inputs,
// consumable use and enemy telegraphs. `summary()` is what the headless
// feel run (client/src/combat/dev/feel.mjs) records as evidence.

import { MOVE_STEP_HZ } from '@lodestone/contracts';
import type { MoveState } from '../sim/movement';
import type { Started } from './timeline';

const STEP_MS = 1000 / MOVE_STEP_HZ;

export interface Stat {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
}

function stat(xs: number[]): Stat {
  if (xs.length === 0) return { n: 0, min: 0, p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  const r = (v: number) => Math.round(v * 10) / 10;
  return { n: s.length, min: r(s[0]), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]) };
}

interface Live {
  s: Started;
  startAt: number;
  activeAt: number;
  activeEndAt: number;
  hitAt: number;
}

export class CombatProbe {
  private presses: Record<string, number[]> = { attack: [], dodge: [], drink: [] };
  private live: Live[] = [];
  readonly samples = {
    /** press -> first hit frame (spec: light startup <= 100 ms). */
    startup: [] as number[],
    /** move table startup in ms (light moves). */
    startupTable: [] as number[],
    /** press -> local hit feedback (spark/hitstop). */
    pressToFeedback: [] as number[],
    /** hit frames end -> next attack start, when the next press was buffered (recovery <= 250 ms). */
    recovery: [] as number[],
    /** hit frames end -> next attack start through a dodge cancel. */
    cancelGap: [] as number[],
    /** dodge i-frame window, ms (spec: 150 ms). */
    iframes: [] as number[],
    /** press -> start for presses buffered during an animation (<= 150 ms buffer). */
    buffered: [] as number[],
    /** requested and measured hitstop (spec: 40-80 ms, local only). */
    hitstop: [] as number[],
    hitstopMeasured: [] as number[],
    /** consumable press -> effect (spec <= 400 ms); speed kept while drinking. */
    drink: [] as number[],
    drinkSpeedRatio: [] as number[],
    /** enemy wind-ups as telegraphed (ms) and telegraph -> resolution. */
    windup: [] as number[],
    telegraphToStrike: [] as number[],
    /** local hit -> HitResult (network confirmation, not a feel target). */
    confirm: [] as number[],
  };
  counts = { presses: 0, started: 0, lostPresses: 0, accepted: 0, refused: 0, dodges: 0, evaded: 0, hurt: 0 };
  private lastActiveEnd = 0;
  private lastActiveEndSeq = 0;
  private dodgeSinceEnd = false;
  private dodgeSeq = -1;
  private iframeSteps = 0;
  private iframeStart = 0;
  private drinkAt = 0;
  private speedBefore = 0;
  private speedDuring: number[] = [];
  private telegraphs: number[] = [];

  press(kind: 'attack' | 'dodge' | 'drink', t: number): void {
    this.presses[kind].push(t);
    if (kind === 'attack') this.counts.presses++;
  }

  started(s: Started, t: number): void {
    this.counts.started++;
    this.live.push({ s, startAt: t, activeAt: 0, activeEndAt: 0, hitAt: 0 });
    if (s.kind === 'move' && s.move?.kind === 'light') this.startupTable.push((s.startup * 1000) / MOVE_STEP_HZ);
    // A press that waited for the previous move: buffered.
    const waited = t - s.pressedAt;
    if (s.kind === 'move' && waited > STEP_MS * 1.5) this.samples.buffered.push(waited);
    if (s.kind === 'move' && this.lastActiveEnd > 0 && s.seq >= this.lastActiveEndSeq) {
      const gap = (s.seq - this.lastActiveEndSeq) * STEP_MS;
      if (this.dodgeSinceEnd) this.samples.cancelGap.push(gap);
      else if (waited > STEP_MS * 1.5) this.samples.recovery.push(gap);
    }
    this.dodgeSinceEnd = false;
  }

  private get startupTable(): number[] {
    return this.samples.startupTable;
  }

  dodgeStart(seq: number, t: number): void {
    this.counts.dodges++;
    this.dodgeSeq = seq;
    this.iframeSteps = 0;
    this.iframeStart = t;
    this.dodgeSinceEnd = true;
  }

  afterStep(seq: number, state: MoveState, t: number): void {
    for (const l of this.live) {
      if (!l.activeAt && seq >= l.s.seq + l.s.startup) {
        l.activeAt = t;
        if (l.s.kind === 'move' && l.s.move?.kind === 'light') this.samples.startup.push(t - l.s.pressedAt);
      }
      if (!l.activeEndAt && seq >= l.s.seq + l.s.startup + l.s.active) {
        l.activeEndAt = t;
        if (l.s.kind === 'move') {
          this.lastActiveEnd = t;
          this.lastActiveEndSeq = seq;
          this.dodgeSinceEnd = false;
        }
      }
    }
    this.live = this.live.filter((l) => t - l.startAt < 3000);
    if (this.dodgeSeq >= 0) {
      if ((state.iframes ?? 0) > 0) this.iframeSteps++;
      else if (seq > this.dodgeSeq) {
        this.samples.iframes.push(this.iframeSteps * STEP_MS);
        this.dodgeSeq = -1;
      }
    }
    const sp = Math.hypot(state.vel.x, state.vel.z);
    if (this.drinkAt > 0) this.speedDuring.push(sp);
    else this.speedBefore = sp;
    void this.iframeStart;
  }

  localHit(s: Started, t: number, hitstopMs: number): void {
    const l = this.live.find((x) => x.s === s);
    if (l && !l.hitAt) {
      l.hitAt = t;
      this.samples.pressToFeedback.push(t - s.pressedAt);
    }
    if (hitstopMs > 0) this.samples.hitstop.push(hitstopMs);
  }

  hitstopMeasured(ms: number): void {
    this.samples.hitstopMeasured.push(ms);
  }

  confirmed(accepted: boolean, hitAt: number, t: number): void {
    if (accepted) this.counts.accepted++;
    else this.counts.refused++;
    if (hitAt > 0) this.samples.confirm.push(t - hitAt);
  }

  drinkStart(t: number): void {
    this.drinkAt = t;
    this.speedDuring = [];
  }

  drinkDone(t: number): void {
    if (this.drinkAt > 0) {
      const press = this.presses.drink.length ? this.presses.drink[this.presses.drink.length - 1] : this.drinkAt;
      this.samples.drink.push(t - press);
      if (this.speedBefore > 0.5 && this.speedDuring.length) this.samples.drinkSpeedRatio.push(this.speedDuring.reduce((a, b) => a + b, 0) / this.speedDuring.length / this.speedBefore);
    }
    this.drinkAt = 0;
  }

  telegraph(windupMs: number, t: number): void {
    this.samples.windup.push(windupMs);
    this.telegraphs.push(t);
    if (this.telegraphs.length > 32) this.telegraphs.shift();
  }

  strike(t: number, evaded: boolean): void {
    if (evaded) this.counts.evaded++;
    else this.counts.hurt++;
    const tg = this.telegraphs.shift();
    if (tg !== undefined && t - tg < 3000) this.samples.telegraphToStrike.push(t - tg);
  }

  summary(): Record<string, unknown> {
    const out: Record<string, unknown> = { counts: { ...this.counts } };
    for (const [k, v] of Object.entries(this.samples)) out[k] = stat(v);
    return out;
  }
}
