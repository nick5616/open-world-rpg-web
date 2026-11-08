// Remote entity interpolation: every other entity is drawn a little in the
// past, between the two server samples that straddle that moment.
//
// adapted from wizard-wars client/src/networking/EntityInterpolation.ts,
// keeping its three ideas:
//  - The render clock comes from the snapshots themselves: the fastest recent
//    (arrival - serverTime) is the baseline one-way lag, so it does not wobble
//    with ClockSync's jittery ping samples and heals after a path change.
//  - The delay adapts to measured arrival jitter (p95 lateness vs that
//    baseline), so a bad link grows the buffer instead of starving it.
//  - When a buffer runs dry it dead-reckons, and the jump when real data
//    lands is eased out instead of snapped; real teleports are cut.
//
// What changes for Lodestone (spec 9):
//  - Per-ring delay: INTERP_DELAY_NEAR/MID/FAR_MS are the floors for an
//    entity 0-64 / 64-200 / 200+ m away (mid updates at 10 Hz and far at
//    2 Hz, so they need about two sample intervals of buffer).
//  - Per-entity sample spacing also sets a floor (1.5 x its recent update
//    interval): under the zone's byte budget (decision 0005) a crowd member
//    may update every few ticks instead of every tick.
//  - Each entity's delay is slewed toward its target (playback at 0.7-1.3x
//    real time while it changes) so crossing a ring boundary never makes it
//    jump.
//  - Dead reckoning uses the velocity on the wire (cm/s) instead of the
//    difference of recent samples. A delta snapshot sends nothing for an
//    unchanged entity, so a player standing still has an old newest sample;
//    with its velocity of 0 that "extrapolation" is exact and is not counted.
//  - No arena: the extrapolated position is floored at the ground.

import { INTERP_DELAY_FAR_MS, INTERP_DELAY_MID_MS, INTERP_DELAY_NEAR_MS, RING_MID_M, RING_NEAR_M, TICK_RATE_HZ, u8ToPitch, u8ToYaw } from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';
import type { EntState } from './snapshotDecoder';

const TICK_MS = 1000 / TICK_RATE_HZ;
/** Lowest global jitter delay (two near-ring samples). */
const MIN_DELAY_MS = 2 * TICK_MS;
/** Per-ring ceilings: past these the view is too stale, extrapolation covers the rest. */
const MAX_DELAY_MS = { near: 400, mid: 600, far: 1600 } as const;
/** Dead-reckon at most this far past the newest sample, then freeze. */
const MAX_EXTRAPOLATION_MS = 300;
/** A sample this far from the previous one (or implying > 40 m/s) is a teleport: cut, never lerp. */
const TELEPORT_DIST_M = 4;
const TELEPORT_SPEED = 40;
/** Time constant for easing out discontinuities in the drawn position. */
const SMOOTH_TAU_MS = 70;
/** A per-frame jump this far beyond plausible motion counts as a visible correction ("rubber band"). */
const VISIBLE_JUMP_M = 0.05;
const DEV_WINDOW = 256;
const LAG_BUCKET_MS = 1000;
const LAG_BUCKETS = 8;
const MAX_SAMPLES = 96;
/** Entities absent from a full snapshot linger this long (in render time) before removal. */
const ABSENT_GRACE_MS = 1000;

export type Ring = 'near' | 'mid' | 'far';

export function ringFor(distM: number): Ring {
  return distM < RING_NEAR_M ? 'near' : distM < RING_MID_M ? 'mid' : 'far';
}

const RING_FLOOR: Record<Ring, number> = { near: INTERP_DELAY_NEAR_MS, mid: INTERP_DELAY_MID_MS, far: INTERP_DELAY_FAR_MS };

interface Sample {
  t: number; // server time (ms)
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  teleport: boolean;
}

/** What the renderer draws for one remote entity. */
export interface RemoteView {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Horizontal speed (m/s) at the drawn moment, for walk animation. */
  speed: number;
  kind: number;
  name: string;
  level: number;
  healthPct: number;
  activity: number;
  partyId: number;
  /** EntityRecord.typeId (enemy type, element, affix: WP13). */
  typeId?: number;
  ring: Ring;
  delayMs: number;
  mode: 'interp' | 'extrap' | 'frozen' | 'waiting';
}

interface Track {
  id: number;
  samples: Sample[];
  state: EntState;
  delay: number;
  interval: number; // EMA of server-time spacing between samples (ms)
  ring: Ring;
  removeAt: number | null; // server time after which the entity is gone
  lastMode: RemoteView['mode'];
  smooth: { lastX: number; lastY: number; lastZ: number; ox: number; oy: number; oz: number; at: number; init: boolean };
}

/** Counters for the HUD and the acceptance log. */
export interface InterpMetrics {
  frames: number;
  interpFrames: number;
  extrapFrames: number;
  /** Times an entity started dead-reckoning while moving (its buffer ran dry). */
  extrapEvents: number;
  frozenFrames: number;
  teleports: number;
  /** Per-frame position jumps beyond plausible motion (eased, but counted). */
  visibleJumps: number;
  maxJumpM: number;
  /** Discontinuity when real data replaced a dead-reckoned position (m). */
  maxHandbackM: number;
  /** The last visible jumps with context (diagnostics for the acceptance log). */
  jumps: { atMs: number; cm: number; dtMs: number; mode: string; handback: boolean; id: number }[];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class EntityInterpolation {
  private tracks = new Map<number, Track>();
  private lagBuckets: number[] = [];
  private bucketStart = 0;
  private baseLag: number | null = null;
  private devs: number[] = [];
  private ticksSinceDelay = 0;
  private jitterDelay = INTERP_DELAY_NEAR_MS;
  private nowMs = 0;
  readonly metrics: InterpMetrics = { frames: 0, interpFrames: 0, extrapFrames: 0, extrapEvents: 0, frozenFrames: 0, teleports: 0, visibleJumps: 0, maxJumpM: 0, maxHandbackM: 0, jumps: [] };

  constructor(private ground: GroundQuery | null = null) {}

  setGround(g: GroundQuery | null): void {
    this.ground = g;
  }

  get size(): number {
    return this.tracks.size;
  }

  ids(): number[] {
    return [...this.tracks.keys()];
  }

  /** Global (link) part of the delay, ms. */
  get linkDelay(): number {
    return this.jitterDelay;
  }

  debugArrival() {
    const sorted = [...this.devs].sort((a, b) => a - b);
    const pick = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);
    return { baseLag: this.baseLag, p50: pick(0.5), p95: pick(0.95), max: pick(1), delay: this.jitterDelay, n: sorted.length };
  }

  /** Once per applied snapshot: feeds the render clock and the jitter delay. */
  onSnapshot(serverTime: number, arrivalMs: number): void {
    const lag = arrivalMs - serverTime;
    if (this.lagBuckets.length === 0 || arrivalMs - this.bucketStart >= LAG_BUCKET_MS) {
      this.lagBuckets.push(lag);
      if (this.lagBuckets.length > LAG_BUCKETS) this.lagBuckets.shift();
      this.bucketStart = arrivalMs;
    } else if (lag < this.lagBuckets[this.lagBuckets.length - 1]) {
      this.lagBuckets[this.lagBuckets.length - 1] = lag;
    }
    this.baseLag = Math.min(...this.lagBuckets);
    this.devs.push(Math.max(0, lag - this.baseLag));
    if (this.devs.length > DEV_WINDOW) this.devs.shift();
    if (++this.ticksSinceDelay >= 8 && this.devs.length >= 16) {
      this.ticksSinceDelay = 0;
      const sorted = [...this.devs].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const target = Math.max(MIN_DELAY_MS, p95 + TICK_MS * 1.5);
      // Grow fast (starving hurts more), shrink slowly.
      this.jitterDelay += (target - this.jitterDelay) * (target > this.jitterDelay ? 0.25 : 0.04);
    }
  }

  /** Server-clock time drawn for an entity with the given delay. */
  renderTime(nowMs: number, delay: number): number {
    return nowMs - (this.baseLag ?? 0) - delay;
  }

  /** A new authoritative state for an entity (it carried a record in this snapshot). */
  record(e: EntState, serverTime: number, local: { x: number; z: number }): void {
    let tr = this.tracks.get(e.id);
    const x = e.x / 100;
    const y = e.y / 100;
    const z = e.z / 100;
    const ring = ringFor(Math.hypot(x - local.x, z - local.z));
    if (!tr) {
      tr = {
        id: e.id,
        samples: [],
        state: e,
        delay: Math.max(RING_FLOOR[ring], this.jitterDelay),
        interval: TICK_MS,
        ring,
        removeAt: null,
        lastMode: 'waiting',
        smooth: { lastX: 0, lastY: 0, lastZ: 0, ox: 0, oy: 0, oz: 0, at: 0, init: false },
      };
      this.tracks.set(e.id, tr);
    }
    tr.state = e;
    tr.ring = ring;
    tr.removeAt = null;
    const prev = tr.samples[tr.samples.length - 1];
    if (prev && serverTime <= prev.t) return;
    let teleport = false;
    if (prev) {
      const d = Math.hypot(x - prev.x, y - prev.y, z - prev.z);
      const dt = (serverTime - prev.t) / 1000;
      tr.interval += (serverTime - prev.t - tr.interval) * 0.2;
      teleport = d > TELEPORT_DIST_M && d / Math.max(dt, 1e-3) > TELEPORT_SPEED;
      if (teleport) this.metrics.teleports++;
    }
    tr.samples.push({ t: serverTime, x, y, z, vx: e.vx / 100, vy: e.vy / 100, vz: e.vz / 100, yaw: u8ToYaw(e.yaw), pitch: u8ToPitch(e.pitch), teleport });
    if (tr.samples.length > MAX_SAMPLES) tr.samples.shift();
  }

  /** The entity still exists but carried no record (unchanged / not due); refresh its non-positional state. */
  touch(e: EntState): void {
    const tr = this.tracks.get(e.id);
    if (tr) tr.state = e;
  }

  /**
   * The entity left this client's interest at serverTime. It is drawn until
   * the render clock reaches that moment (so it doesn't vanish 100+ ms
   * before its last steps play out), plus graceMs for implicit removals (a
   * full snapshot that happens to lack it).
   */
  remove(id: number, serverTime: number, graceMs = 0): void {
    const tr = this.tracks.get(id);
    if (tr && tr.removeAt === null) tr.removeAt = serverTime + graceMs;
  }

  /** Entities missing from a full snapshot: linger, then go. */
  removeAbsent(present: Set<number>, serverTime: number): void {
    for (const id of this.tracks.keys()) if (!present.has(id)) this.remove(id, serverTime, ABSENT_GRACE_MS);
  }

  clear(): void {
    this.tracks.clear();
    this.lagBuckets = [];
    this.baseLag = null;
    this.devs = [];
    this.ticksSinceDelay = 0;
    this.jitterDelay = INTERP_DELAY_NEAR_MS;
  }

  /**
   * Advance every entity to the current frame and return what to draw.
   * frameDtMs paces the delay slew and the smoothing decay.
   */
  update(nowMs: number, frameDtMs: number, out: RemoteView[] = []): RemoteView[] {
    out.length = 0;
    this.nowMs = nowMs;
    const dt = Math.min(250, Math.max(0, frameDtMs));
    for (const tr of this.tracks.values()) {
      const target = Math.min(MAX_DELAY_MS[tr.ring], Math.max(RING_FLOOR[tr.ring], this.jitterDelay, tr.interval * 1.5 + TICK_MS * 0.5));
      const diff = target - tr.delay;
      tr.delay += Math.max(-0.3 * dt, Math.min(0.3 * dt, diff));
      const rt = this.renderTime(nowMs, tr.delay);
      if (tr.removeAt !== null && rt >= tr.removeAt) {
        this.tracks.delete(tr.id);
        continue;
      }
      const v = this.sampleTrack(tr, rt);
      if (!v) continue;
      this.smoothTrack(tr, v, dt);
      out.push(v);
    }
    return out;
  }

  private sampleTrack(tr: Track, rt: number): RemoteView | null {
    const buf = tr.samples;
    if (buf.length === 0) return null;
    const st = tr.state;
    const base = { id: tr.id, kind: st.kind, name: st.name, level: st.level, healthPct: st.healthPct, activity: st.activity, partyId: st.partyId, typeId: st.typeId, ring: tr.ring, delayMs: tr.delay };
    this.metrics.frames++;

    let i = buf.length - 1;
    while (i >= 0 && buf[i].t > rt) i--;
    if (i < 0) {
      // Render clock before our first sample (just appeared): show it there.
      const s = buf[0];
      tr.lastMode = 'waiting';
      return { ...base, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, speed: Math.hypot(s.vx, s.vz), mode: 'waiting' };
    }
    const a = buf[i];
    const b = buf[i + 1];
    if (b) {
      // Drop samples we'll never need again (keep one before the render time).
      if (i > 1) buf.splice(0, i - 1);
      const t = Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t)));
      this.metrics.interpFrames++;
      if (tr.lastMode === 'extrap') this.noteHandback(tr);
      tr.lastMode = 'interp';
      if (b.teleport) {
        const s = t >= 1 ? b : a;
        return { ...base, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, speed: 0, mode: 'interp' };
      }
      return {
        ...base,
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t),
        yaw: lerpAngle(a.yaw, b.yaw, t),
        pitch: lerp(a.pitch, b.pitch, t),
        speed: Math.hypot(lerp(a.vx, b.vx, t), lerp(a.vz, b.vz, t)),
        mode: 'interp',
      };
    }
    // Past the newest sample.
    const overdue = rt - a.t;
    const speed = Math.hypot(a.vx, a.vz, a.vy);
    if (speed < 0.05) {
      // Standing still: the delta stream sends nothing new, and that is exact.
      this.metrics.interpFrames++;
      tr.lastMode = 'interp';
      return { ...base, x: a.x, y: a.y, z: a.z, yaw: a.yaw, pitch: a.pitch, speed: 0, mode: 'interp' };
    }
    if (overdue <= MAX_EXTRAPOLATION_MS) {
      // Ease the speed to zero at the limit so it never overshoots abruptly
      // (wizard-wars' travel curve), using the wire velocity.
      const s = overdue / 1000;
      const travel = s - (s * s) / (2 * (MAX_EXTRAPOLATION_MS / 1000));
      const x = a.x + a.vx * travel;
      const z = a.z + a.vz * travel;
      const floor = this.ground ? this.ground.heightAt(x, z) : -Infinity;
      const y = Math.max(floor, a.y + a.vy * travel);
      this.metrics.extrapFrames++;
      if (tr.lastMode !== 'extrap') this.metrics.extrapEvents++;
      tr.lastMode = 'extrap';
      return { ...base, x, y, z, yaw: a.yaw, pitch: a.pitch, speed: Math.hypot(a.vx, a.vz), mode: 'extrap' };
    }
    this.metrics.frozenFrames++;
    tr.lastMode = 'frozen';
    const s = MAX_EXTRAPOLATION_MS / 2000;
    return { ...base, x: a.x + a.vx * s, y: a.y, z: a.z + a.vz * s, yaw: a.yaw, pitch: a.pitch, speed: 0, mode: 'frozen' };
  }

  private noteHandback(tr: Track): void {
    // The smoothing offset right after the switch is what the eye would have
    // seen as a snap; smoothTrack measures it on this frame.
    tr.smooth.at = -1;
  }

  /**
   * Ease out discontinuities without adding steady-state lag: the offset is
   * measured against the target's previous position, so smooth motion leaves
   * it at zero and only jumps decay (wizard-wars smooth()).
   */
  private smoothTrack(tr: Track, v: RemoteView, dt: number): void {
    const sm = tr.smooth;
    const handback = sm.at === -1;
    sm.at = 0;
    if (sm.init) {
      const jx = v.x - sm.lastX;
      const jy = v.y - sm.lastY;
      const jz = v.z - sm.lastZ;
      const jump = Math.hypot(jx, jy, jz);
      // 12 m/s covers sprinting and falling between frames, plus slack.
      const plausible = (dt / 1000) * 12 + 0.02;
      if (jump > TELEPORT_DIST_M) {
        sm.ox = sm.oy = sm.oz = 0;
      } else if (jump > plausible) {
        const excess = (jump - plausible) / jump;
        sm.ox -= jx * excess;
        sm.oy -= jy * excess;
        sm.oz -= jz * excess;
        const visible = jump - plausible;
        if (visible > VISIBLE_JUMP_M) this.metrics.visibleJumps++;
        if (visible > this.metrics.maxJumpM) this.metrics.maxJumpM = visible;
        if (handback && visible > this.metrics.maxHandbackM) this.metrics.maxHandbackM = visible;
        if (visible > VISIBLE_JUMP_M) {
          this.metrics.jumps.push({ atMs: Math.round(this.nowMs), cm: Math.round(visible * 1000) / 10, dtMs: Math.round(dt), mode: v.mode, handback, id: v.id });
          if (this.metrics.jumps.length > 50) this.metrics.jumps.shift();
        }
      }
    }
    sm.lastX = v.x;
    sm.lastY = v.y;
    sm.lastZ = v.z;
    sm.init = true;
    const decay = Math.exp(-dt / SMOOTH_TAU_MS);
    sm.ox *= decay;
    sm.oy *= decay;
    sm.oz *= decay;
    v.x += sm.ox;
    v.y += sm.oy;
    v.z += sm.oz;
  }
}
