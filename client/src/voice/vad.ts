// Playtest 2 voice settings: input levels in dBFS and the voice-activation
// gate (open mic). Pure, so the threshold / open-after / hold-open rules are
// unit-tested without a microphone.
//
//   level >= threshold for `attackMs`  -> gate opens
//   level <  threshold for `releaseMs` -> gate closes (the hold keeps word gaps open)

/** Below this a buffer counts as silence. */
export const DB_FLOOR = -100;
/** A sample this close to full scale counts as clipping. */
export const CLIP_LEVEL = 0.99;

export interface Levels {
  rmsDb: number;
  peakDb: number;
  clipped: boolean;
}

const toDb = (v: number) => (v > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(v)) : DB_FLOOR);

/** RMS and peak of one analyser buffer, in dBFS. */
export function measure(buf: ArrayLike<number>): Levels {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    sum += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const rms = buf.length ? Math.sqrt(sum / buf.length) : 0;
  return { rmsDb: toDb(rms), peakDb: toDb(peak), clipped: peak >= CLIP_LEVEL };
}

/** Meter position 0-1 for a dBFS value on a lo..hi scale. */
export function dbToMeter(db: number, lo = -60, hi = 0): number {
  return Math.max(0, Math.min(1, (db - lo) / (hi - lo)));
}

/** Linear gain for a boost in dB. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export interface VadConfig {
  /** Open when the RMS level reaches this (dBFS). */
  thresholdDb: number;
  /** ...and stays there this long (ms): a click or a bump doesn't open it. */
  attackMs: number;
  /** Close after this long below the threshold (ms). */
  releaseMs: number;
}

export const DEFAULT_VAD: VadConfig = { thresholdDb: -50, attackMs: 20, releaseMs: 450 };

export const VAD_LIMITS = {
  thresholdDb: [-80, -10],
  attackMs: [0, 300],
  releaseMs: [50, 3000],
} as const;

export class VadGate {
  private cfg: VadConfig;
  private aboveSince: number | null = null;
  private lastAbove = -Infinity;
  private isOpen = false;

  constructor(cfg: VadConfig = DEFAULT_VAD) {
    this.cfg = { ...cfg };
  }

  configure(cfg: VadConfig): void {
    this.cfg = { ...cfg };
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Feed one level reading (dBFS) taken at `now` (ms); returns whether the gate is open. */
  update(db: number, now: number): boolean {
    if (db >= this.cfg.thresholdDb) {
      if (this.aboveSince === null) this.aboveSince = now;
      if (this.isOpen || now - this.aboveSince >= this.cfg.attackMs) {
        this.isOpen = true;
        this.lastAbove = now;
      }
    } else {
      this.aboveSince = null;
      if (this.isOpen && now - this.lastAbove >= this.cfg.releaseMs) this.isOpen = false;
    }
    return this.isOpen;
  }

  reset(): void {
    this.aboveSince = null;
    this.lastAbove = -Infinity;
    this.isOpen = false;
  }
}
