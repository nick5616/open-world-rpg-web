// One-shot sound effects: buffer cache, voice pool, 3D placement, cave reverb.
//
// Every play is a fresh AudioBufferSourceNode (they are cheap and one-use by
// design); what is pooled and capped is how many can sound at once, so a
// crowd of 300 players swinging swords cannot explode CPU:
//   - per cue `maxVoices` (oldest of that cue is stolen),
//   - a global cap (lowest priority, then oldest, is stolen),
//   - per cue `cooldownMs` (rapid repeats collapse into one), duplicates
//     (same cue, same place, same moment) and stacks of one cue in one
//     frame dropped (voiceLimit.ts),
//   - 3D sounds beyond their max distance are never started.
// Panning is equal-power (cheap); HRTF stays reserved for voices (WP11).
// Distance is ours, not the PannerNode's (spatial.ts: inverse distance that
// eases to silence at the cue's range, air absorption, walls and rock
// between you and the source); sounds long enough to outlive a step are
// re-evaluated as you move (updateSpatial, 10 Hz). Repeats vary: never the
// same file twice running, a little pitch and gain each time.

import type { Vec3 } from './bridge';
import { assetUrl } from './assets';
import { SYNTH_SLICE, yieldToLoop } from './synth';
import { CUES, type CueDef, type CueId } from './cues';
import { airLowpassHz, distanceGain, LOWPASS_BYPASS_HZ, occlusion, SPACE_OUTDOORS, type Occlusion } from './spatial';
import { pickVariant, variation, VoiceLimiter } from './voiceLimit';

export interface PlayOpts {
  at?: Vec3 | null;
  volume?: number;
  /** Playback rate multiplier (on top of the cue's random pitch). */
  rate?: number;
  /** Start offset into the buffer (s). */
  offset?: number;
  /** Start this many seconds from now (sample-exact rhythms between 10 Hz passes). */
  delay?: number;
}

interface Voice {
  cue: CueId;
  def: CueDef;
  src: AudioBufferSourceNode;
  gain: GainNode;
  started: number;
  priority: number;
  ends: number;
  /** Spatial voices: where, and the distance gain / low-pass stages updateSpatial steers. */
  at: Vec3 | null;
  dist: GainNode | null;
  lp: BiquadFilterNode | null;
}

export const GLOBAL_VOICES = 40;

export interface Listener {
  x: number;
  y: number;
  z: number;
}

export class SfxEngine {
  private buffers = new Map<string, AudioBuffer | null>();
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  /** Fetched, not yet decoded (prefetch). */
  private raw = new Map<string, ArrayBuffer>();
  private voices: Voice[] = [];
  private limiter = new VoiceLimiter();
  private lastVariant = new Map<CueId, number>();
  /** Which acoustic space a point is in (spatial.ts SPACE_*; the engine sets it once the world is loaded). */
  spaceOf: ((x: number, y: number, z: number) => number) | null = null;
  /** The listener's space and how much of the surface leaks into a cave (engine, 10 Hz). */
  listenerSpace = SPACE_OUTDOORS;
  leak = 1;
  private reverbIn: GainNode;
  private convolver: ConvolverNode;
  private reverbOut: GainNode;
  private irRadius = 0;
  private reverbAmount = 0;
  /** Listener position (feet + eye), updated by the engine every frame. */
  readonly listener: Listener = { x: 0, y: 0, z: 0 };
  /** Plays started (debug hook / headless check), by cue. */
  readonly played = new Map<CueId, number>();
  readonly log: { cue: CueId; t: number }[] = [];
  stolen = 0;
  culled = 0;
  /** Plays dropped as cooldown repeats, duplicates or stacks. */
  suppressed = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly buses: { sfx: AudioNode; ui: AudioNode; ambience: AudioNode },
  ) {
    this.reverbIn = ctx.createGain();
    this.reverbIn.gain.value = 0;
    this.convolver = ctx.createConvolver();
    this.reverbOut = ctx.createGain();
    this.reverbOut.gain.value = 0.8;
    this.reverbIn.connect(this.convolver).connect(this.reverbOut).connect(buses.sfx);
    this.setChamberRadius(8);
  }

  /**
   * Cave reverb (spec 7: "a reverb bus sized by the current chamber's
   * radius"): synthesized IR, decaying darkened noise, longer for bigger
   * chambers. Ported from WP09's caveAudio.ts.
   */
  setChamberRadius(r: number): void {
    const rr = Math.max(2, Math.min(16, r));
    if (Math.abs(rr - this.irRadius) < 1.5) return;
    this.irRadius = rr;
    void this.buildIR(rr, ++this.irGen);
  }

  /**
   * WP19b: the IR (up to ~110 k samples per channel) is synthesized in
   * slices (synth.ts SYNTH_SLICE), so neither the engine start (first key
   * press) nor walking into a cave is a main-thread long task; a newer
   * radius supersedes one still being built.
   */
  private irGen = 0;
  private async buildIR(rr: number, gen: number): Promise<void> {
    const ctx = this.ctx;
    const seconds = 0.35 + rr * 0.12;
    const len = Math.floor(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        if (i % SYNTH_SLICE === SYNTH_SLICE - 1) {
          await yieldToLoop();
          if (gen !== this.irGen) return;
        }
        const t = i / len;
        lp += (Math.random() * 2 - 1 - lp) * (0.55 - 0.45 * t);
        d[i] = lp * Math.pow(1 - t, 2.2 + 6 / rr);
      }
    }
    if (gen === this.irGen) this.convolver.buffer = ir;
  }

  /** 0 = dry (surface) .. 1 = full cave reverb. */
  setReverb(amount: number): void {
    if (Math.abs(amount - this.reverbAmount) < 0.01) return;
    this.reverbAmount = amount;
    this.reverbIn.gain.setTargetAtTime(amount * 0.9, this.ctx.currentTime, 0.25);
  }

  /** The reverb send (ambience beds underground use it too). */
  get reverbSend(): AudioNode {
    return this.reverbIn;
  }

  load(name: string): Promise<AudioBuffer | null> {
    if (this.buffers.has(name)) return Promise.resolve(this.buffers.get(name) ?? null);
    const p = this.pending.get(name);
    if (p) return p;
    const url = assetUrl(name);
    if (!url) {
      this.buffers.set(name, null);
      return Promise.resolve(null);
    }
    const raw = this.raw.get(name);
    this.raw.delete(name);
    const q = (raw ? Promise.resolve(raw) : this.fetchBytes(url))
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((b) => {
        this.buffers.set(name, b);
        return b;
      })
      .catch(() => {
        this.buffers.set(name, null);
        return null;
      })
      .finally(() => this.pending.delete(name));
    this.pending.set(name, q);
    return q;
  }

  private fetchBytes(url: string): Promise<ArrayBuffer> {
    return fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))));
  }

  /** Decode a cue's files ahead of first use. */
  preload(cue: CueId): Promise<unknown> {
    return Promise.all(CUES[cue].files.map((f) => this.load(f)));
  }

  /**
   * Download a cue's files but keep them compressed (a few KB each instead of
   * ~200 KB of PCM per second); the first play decodes them, which takes
   * milliseconds instead of a network round trip.
   */
  prefetch(cue: CueId): Promise<unknown> {
    return Promise.all(
      CUES[cue].files.map(async (f) => {
        if (this.buffers.has(f) || this.pending.has(f) || this.raw.has(f)) return;
        const url = assetUrl(f);
        if (!url) return;
        try {
          this.raw.set(f, await this.fetchBytes(url));
        } catch {
          /* the first play fetches it again */
        }
      }),
    );
  }

  isLoaded(cue: CueId): boolean {
    return CUES[cue].files.every((f) => this.buffers.has(f));
  }

  /** Fire and forget. Returns false when the cue was skipped (cooldown, culled, not loaded yet). */
  play(cue: CueId, opts: PlayOpts = {}): boolean {
    const def = CUES[cue];
    if (!def) return false;
    const now = performance.now();
    const at = def.spatial ? opts.at ?? null : null;
    if (at) {
      const d = Math.hypot(at.x - this.listener.x, at.y - this.listener.y, at.z - this.listener.z);
      if (d > (def.maxDistance ?? 40)) {
        this.culled++;
        return false;
      }
    }
    if (this.limiter.admit(cue, now, at, { cooldownMs: def.cooldownMs }) !== 'play') {
      this.suppressed++;
      return false;
    }
    if (!def.files.length) return false;
    const vi = pickVariant(def.files.length, this.lastVariant.get(cue) ?? -1);
    this.lastVariant.set(cue, vi);
    const file = def.files[vi];
    const buf = this.buffers.get(file);
    if (buf === undefined) {
      // First use: load now, play when decoded if still timely. Impacts and
      // UI are preloaded, so this is the cold path of rarer cues; a sting
      // (level up, discovery) is still worth hearing a moment late.
      const late = (def.priority ?? 1) >= 4 ? 2500 : 400;
      void this.load(file).then((b) => {
        if (b && performance.now() - now < late) this.start(cue, def, b, opts, at);
      });
      return true;
    }
    if (!buf) return false;
    this.start(cue, def, buf, opts, at);
    return true;
  }

  private start(cue: CueId, def: CueDef, buf: AudioBuffer, opts: PlayOpts, at: Vec3 | null): void {
    const ctx = this.ctx;
    this.makeRoom(cue, def);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const pitch = def.pitch ?? 0;
    const vary = variation(pitch, def.gainVar ?? (pitch > 0 ? 0.1 : 0));
    src.playbackRate.value = (opts.rate ?? 1) * (def.rate ?? 1) * vary.rate;
    const gain = ctx.createGain();
    const level = (def.volume ?? 1) * (opts.volume ?? 1) * vary.gain;
    const offset = Math.min(opts.offset ?? 0, Math.max(0, buf.duration - 0.01));
    const when = ctx.currentTime + Math.max(0, opts.delay ?? 0);
    if (offset > 0) {
      // Starting mid-file: a 4 ms ramp instead of a click.
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(level, when + 0.004);
    } else gain.gain.value = level;
    src.connect(gain);
    let tail: AudioNode = gain;
    let dist: GainNode | null = null;
    let lp: BiquadFilterNode | null = null;
    if (at) {
      const a = this.attenuation(def, at);
      dist = ctx.createGain();
      dist.gain.value = a.gain;
      tail.connect(dist);
      tail = dist;
      if (a.lowpassHz < LOWPASS_BYPASS_HZ) {
        lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 0.5;
        lp.frequency.value = a.lowpassHz;
        tail.connect(lp);
        tail = lp;
      }
      const p = ctx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      // Direction only: the distance curve is spatial.ts's (dist above).
      p.rolloffFactor = 0;
      if (p.positionX) {
        p.positionX.value = at.x;
        p.positionY.value = at.y;
        p.positionZ.value = at.z;
      } else p.setPosition(at.x, at.y, at.z);
      tail.connect(p);
      tail = p;
    }
    const bus = def.bus === 'ui' ? this.buses.ui : def.bus === 'ambience' ? this.buses.ambience : this.buses.sfx;
    tail.connect(bus);
    const rv = def.reverb ?? (def.bus === 'ui' ? 0 : 1);
    if (rv > 0 && this.reverbAmount > 0.02) {
      const send = ctx.createGain();
      send.gain.value = rv;
      tail.connect(send).connect(this.reverbIn);
    }
    src.start(when, offset);
    const v: Voice = { cue, def, src, gain, started: when, priority: def.priority ?? 1, ends: when + (buf.duration - offset) / src.playbackRate.value, at, dist, lp };
    this.voices.push(v);
    src.onended = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
      try {
        tail.disconnect();
      } catch {
        /* gone */
      }
    };
    this.played.set(cue, (this.played.get(cue) ?? 0) + 1);
    this.log.push({ cue, t: performance.now() });
    if (this.log.length > 400) this.log.splice(0, 100);
  }

  /** Distance, air and occlusion for a cue at a point, from where the listener is now. */
  attenuation(def: CueDef, at: Vec3): Occlusion {
    const L = this.listener;
    const d = Math.hypot(at.x - L.x, at.y - L.y, at.z - L.z);
    const g = distanceGain(d, { ref: def.refDistance ?? 3, max: def.maxDistance ?? 40, rolloff: def.rolloff ?? 1 });
    const o = this.spaceOf ? occlusion(this.listenerSpace, this.spaceOf(at.x, at.y, at.z), this.leak) : null;
    return { gain: g * (o?.gain ?? 1), lowpassHz: Math.min(airLowpassHz(d), o?.lowpassHz ?? 20000) };
  }

  /**
   * Re-place the spatial voices that are still sounding (long stings, demon
   * rises, the boss phase roar) as the listener moves (engine, 10 Hz).
   */
  updateSpatial(): void {
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      if (!v.at || !v.dist || v.ends < t + 0.15) continue;
      const a = this.attenuation(v.def, v.at);
      v.dist.gain.setTargetAtTime(a.gain, t, 0.08);
      v.lp?.frequency.setTargetAtTime(Math.max(200, a.lowpassHz), t, 0.08);
    }
  }

  private steal(v: Voice): void {
    this.stolen++;
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + 0.03);
    try {
      v.src.stop(t + 0.04);
    } catch {
      /* already stopped */
    }
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  private makeRoom(cue: CueId, def: CueDef): void {
    const now = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => v.ends > now - 0.05);
    const max = def.maxVoices ?? 4;
    const same = this.voices.filter((v) => v.cue === cue);
    if (same.length >= max) this.steal(same[0]);
    if (this.voices.length >= GLOBAL_VOICES) {
      const victim = [...this.voices].sort((a, b) => a.priority - b.priority || a.started - b.started)[0];
      if (victim) this.steal(victim);
    }
  }

  /** Decoded PCM held (MB). */
  get decodedMB(): number {
    let b = 0;
    for (const buf of this.buffers.values()) if (buf) b += buf.length * buf.numberOfChannels * 4;
    return Math.round(b / 1e5) / 10;
  }

  get activeVoices(): number {
    const now = this.ctx.currentTime;
    return this.voices.filter((v) => v.ends > now).length;
  }
}
