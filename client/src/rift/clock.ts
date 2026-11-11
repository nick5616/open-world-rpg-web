// CR 040: when to draw the rift's shots. The zone checks a shot against
// you when it applies your input frame, so you must see each shot where it
// will be when the frame you are looking at reaches the zone: the newest
// snapshot says "at tick T I had applied your frames up to seq A", your
// newest frame is S, two frames per tick, so the frame on screen lands at
// about T + (S - A) / 2. A smooth clock follows that estimate (never
// jumping by less than a few ticks), so bullets glide.

export const TICKS_PER_S = 30;

export interface ClockInput {
  tick: number;
  ackSeq: number;
  lastSeq: number;
}

export class BulletClock {
  private est = 0;
  private last = 0;

  /** The tick to draw shots at (fractional), given the newest snapshot and frame. */
  now(inp: ClockInput | null, perfMs: number): number {
    if (!inp || inp.tick === 0) return this.est;
    const target = inp.tick + Math.max(0, inp.lastSeq - inp.ackSeq) / 2;
    const dt = this.last ? Math.min(0.25, (perfMs - this.last) / 1000) : 0;
    this.last = perfMs;
    if (this.est === 0 || Math.abs(target - this.est) > 6) {
      this.est = target;
      return this.est;
    }
    this.est += dt * TICKS_PER_S;
    this.est += (target - this.est) * Math.min(1, dt * 4); // slew a quarter second toward the estimate
    return this.est;
  }

  reset(): void {
    this.est = 0;
    this.last = 0;
  }
}

export const bulletClock = new BulletClock();
