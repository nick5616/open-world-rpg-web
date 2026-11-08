// Rolling frame-time statistics, separated from the DOM so it is testable.
// adapted from wizard-wars client/src/components/ui/FrameStats.tsx: fps over
// a one-second window, worst frame, and "dropped" frames (longer than the
// 30 fps budget, i.e. something stalled the main thread for 33 ms+).

export const DROPPED_FRAME_MS = 1000 / 30;
export const WINDOW_MS = 1000;

export interface FrameWindow {
  fps: number;
  avgMs: number;
  maxMs: number;
  dropped: number;
}

export class FrameStatsWindow {
  private start = -1;
  private last = -1;
  private frames = 0;
  private sumMs = 0;
  private maxMs = 0;
  private dropped = 0;

  /** Feed a frame timestamp (ms). Returns a completed window once per WINDOW_MS, else null. */
  tick(now: number): FrameWindow | null {
    if (this.last < 0) {
      this.last = now;
      this.start = now;
      return null;
    }
    const dt = now - this.last;
    this.last = now;
    this.frames++;
    this.sumMs += dt;
    if (dt > this.maxMs) this.maxMs = dt;
    if (dt > DROPPED_FRAME_MS) this.dropped++;
    const elapsed = now - this.start;
    if (elapsed < WINDOW_MS) return null;
    const w: FrameWindow = {
      fps: Math.round((this.frames * 1000) / elapsed),
      avgMs: this.sumMs / this.frames,
      maxMs: this.maxMs,
      dropped: this.dropped,
    };
    this.start = now;
    this.frames = 0;
    this.sumMs = 0;
    this.maxMs = 0;
    this.dropped = 0;
    return w;
  }
}

export const fpsColor = (fps: number) => (fps < 45 ? '#ff6b6b' : fps < 55 ? '#ffd43b' : '#8ce99a');
