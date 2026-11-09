// Positional loops: fires (torches, braziers, hearths, campfires, forges,
// burning grass) and water (rivers, lake shores). loopPool.ts decides which
// emitters get a voice and how loud/bright each is; this class owns the
// voices: a looping rendered texture (synth.ts) per family, each voice a
// buffer source at a random offset and slightly detuned (two torches never
// phase), through a low-pass (air + walls), a gain (distance) and an
// equal-power panner (direction only: rolloffFactor 0, the distance curve is
// ours). Voices fade in when picked and fade out and stop when dropped, so
// a fire 40 m behind you costs nothing and nothing ever clicks.

import type { LoopTarget } from './loopPool';
import { LOOP_PROFILES } from './spatial';
import { renderLoop, type LoopFamily } from './synth';

interface LoopVoice {
  id: string;
  src: AudioBufferSourceNode;
  lp: BiquadFilterNode;
  gain: GainNode;
  pan: PannerNode;
  /** ctx time it was told to fade out (stopping), or 0. */
  dying: number;
}

const FADE_IN_TAU = 0.3;
const FADE_OUT_TAU = 0.25;
const MOVE_TAU = 0.12;

export class LoopVoices {
  private buffers = new Map<LoopFamily, AudioBuffer | null>();
  private voices = new Map<string, LoopVoice>();
  /** Voices started / stopped (debug, headless check). */
  started = 0;
  stopped = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
    /** The reverb send (fires in a cave or a hall ring a little). */
    private readonly wet: AudioNode | null,
  ) {
    for (const f of ['fire', 'flow', 'lap'] as const) {
      this.buffers.set(f, null);
      void renderLoop(ctx, f).then((b) => this.buffers.set(f, b));
    }
  }

  /** Ids with a live (not fading-out) voice. */
  get playing(): ReadonlySet<string> {
    const s = new Set<string>();
    for (const v of this.voices.values()) if (!v.dying) s.add(v.id);
    return s;
  }

  get count(): number {
    return this.playing.size;
  }

  /** Apply a selection (loopPool.selectLoops): new ones fade in, missing ones fade out. */
  update(targets: readonly LoopTarget[]): void {
    const t = this.ctx.currentTime;
    const keep = new Set<string>();
    for (const tg of targets) {
      const e = tg.emitter;
      keep.add(e.id);
      let v = this.voices.get(e.id);
      if (v?.dying) {
        // Picked again while fading out: let that one finish, start afresh.
        this.voices.delete(e.id);
        this.voices.set(`${e.id}#${this.started}`, v);
        v = undefined;
      }
      if (!v) {
        const nv = this.start(e.id, e.kind, tg.gain, e.x, e.y, e.z);
        if (!nv) continue;
        v = nv;
        v.lp.frequency.value = Math.max(200, tg.lowpassHz);
      }
      v.gain.gain.setTargetAtTime(tg.gain, t, FADE_IN_TAU);
      v.lp.frequency.setTargetAtTime(Math.max(200, tg.lowpassHz), t, 0.15);
      setPos(v.pan, e.x, e.y, e.z, t);
    }
    for (const v of this.voices.values()) {
      if (keep.has(v.id) || v.dying) continue;
      this.fadeOut(v, t);
    }
    // Reap voices that have finished fading.
    for (const [id, v] of this.voices) if (v.dying && t > v.dying + FADE_OUT_TAU * 6) this.reap(id, v);
  }

  private start(id: string, kind: keyof typeof LOOP_PROFILES, gain: number, x: number, y: number, z: number): LoopVoice | null {
    const p = LOOP_PROFILES[kind];
    const buf = this.buffers.get(p.family);
    if (!buf || gain <= 0) return null;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = p.rate * (0.96 + Math.random() * 0.08);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.5;
    lp.frequency.value = 20000;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.rolloffFactor = 0;
    if (pan.positionX) {
      pan.positionX.value = x;
      pan.positionY.value = y;
      pan.positionZ.value = z;
    } else pan.setPosition(x, y, z);
    src.connect(lp).connect(g).connect(pan).connect(this.out);
    if (this.wet) {
      const send = ctx.createGain();
      send.gain.value = 0.35;
      pan.connect(send).connect(this.wet);
    }
    src.start(t, Math.random() * buf.duration);
    const v: LoopVoice = { id, src, lp, gain: g, pan, dying: 0 };
    this.voices.set(id, v);
    this.started++;
    return v;
  }

  private fadeOut(v: LoopVoice, t: number): void {
    v.dying = t;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, FADE_OUT_TAU);
    try {
      v.src.stop(t + FADE_OUT_TAU * 6);
    } catch {
      /* already stopped */
    }
  }

  private reap(id: string, v: LoopVoice): void {
    this.voices.delete(id);
    this.stopped++;
    try {
      v.pan.disconnect();
    } catch {
      /* gone */
    }
  }

  /** Fade everything out (engine dispose, a teleport). */
  clear(): void {
    const t = this.ctx.currentTime;
    for (const v of this.voices.values()) if (!v.dying) this.fadeOut(v, t);
  }

  debug(): { id: string; gain: number; dying: boolean }[] {
    return [...this.voices.values()].map((v) => ({ id: v.id, gain: Math.round(v.gain.gain.value * 1000) / 1000, dying: !!v.dying }));
  }
}

function setPos(p: PannerNode, x: number, y: number, z: number, t: number): void {
  if (p.positionX) {
    p.positionX.setTargetAtTime(x, t, MOVE_TAU);
    p.positionY.setTargetAtTime(y, t, MOVE_TAU);
    p.positionZ.setTargetAtTime(z, t, MOVE_TAU);
  } else p.setPosition(x, y, z);
}
