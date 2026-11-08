// NTP-style clock sync against the zone's ClockPing/ClockPong (server time is
// Unix ms with sub-ms precision, contracts/protocol.yaml).
//
// adapted from wizard-wars client/src/networking/ClockSync.ts. Same rules:
// under jitter the symmetric-path assumption breaks per sample (a ping that
// queued on the way out reads as a large bogus offset), so trust the sample
// with the lowest RTT in the recent window (the least-queued one) instead of a
// median, and slew the published offset toward it so serverNow() never jumps
// by tens of ms between two calls. Only first sync and real clock steps
// (> SLEW_LIMIT_MS) apply at once.
//
// Remote-entity interpolation does NOT use this clock (see interpolation.ts,
// which derives its render clock from snapshot arrival times); this one feeds
// the HUD's RTT and anything that needs "server now" (combat claims, world
// time).

/** Offsets differing by less than this are slewed in, MAX_SLEW_MS per sample. */
const SLEW_LIMIT_MS = 50;
const MAX_SLEW_MS = 3;
/** wizard-wars MAX_CLOCK_SAMPLES: ~10 s of history at the steady 1 Hz ping rate. */
export const MAX_CLOCK_SAMPLES = 10;

interface Sample {
  offset: number;
  rtt: number;
}

export class ClockSync {
  private samples: Sample[] = [];
  private _offset = 0;
  private _rtt = 0;
  private _minRtt = Infinity;
  private synced = false;

  /** now: injectable for tests; defaults to Date.now (the server clock is Unix ms too). */
  constructor(private readonly now: () => number = Date.now) {}

  get offset(): number {
    return this._offset;
  }
  /** Latest sample's round trip (ms). */
  get rtt(): number {
    return this._rtt;
  }
  /** Lowest RTT in the window: the path's floor, what the HUD's "rtt" should show under jitter. */
  get minRtt(): number {
    return this._minRtt === Infinity ? 0 : this._minRtt;
  }
  get isSynced(): boolean {
    return this.synced;
  }

  serverNow(): number {
    return this.now() + this._offset;
  }

  /** Forget all samples (reconnect: new path, maybe a different process). */
  reset(): void {
    this.samples = [];
    this.synced = false;
    this._minRtt = Infinity;
  }

  /** t1 = our send time, t2 = server receive, t3 = server send (ClockPong). */
  onPong(t1: number, t2: number, t3: number): void {
    const t4 = this.now();
    const rtt = Math.max(0, t4 - t1 - (t3 - t2));
    const offset = (t2 - t1 + (t3 - t4)) / 2;
    this._rtt = rtt;
    this.samples.push({ offset, rtt });
    if (this.samples.length > MAX_CLOCK_SAMPLES) this.samples.shift();

    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this._minRtt = best.rtt;

    const diff = best.offset - this._offset;
    if (!this.synced || Math.abs(diff) > SLEW_LIMIT_MS) {
      this._offset = best.offset;
      this.synced = true;
    } else {
      this._offset += Math.max(-MAX_SLEW_MS, Math.min(MAX_SLEW_MS, diff));
    }
  }
}
