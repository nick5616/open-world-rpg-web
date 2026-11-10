// Playtest 2 instruments (CR 028): voices as Web Audio graphs. Works on any
// BaseAudioContext: the game's (audio.ts, live and positional) and an
// OfflineAudioContext (render.ts: the WAV phrases of the evidence run and
// the debug handle). Struck and plucked notes are rendered once into
// buffers (voices.ts) and cached, two variants per note so a repeated note
// isn't a copy; the flute is built live per note and held.

import { fluteParams, renderNote, type VoiceKind } from './voices';

export interface VoiceHandle {
  /** Release a held note (the flute) at `when`; struck voices ring on. */
  release(when: number): void;
  /** Cut it (voice stealing): a 30 ms fade. */
  stop(when: number): void;
  /** Context time it has ended by (Infinity while held). */
  ends: number;
}

const VARIANTS = 2;
const CACHE_MAX = 220;

/** Rendered notes per context: (voice, note, velocity, variant) -> buffer, least recently used dropped. */
export class NoteCache {
  private map = new Map<string, AudioBuffer>();
  private turn = new Map<string, number>();
  constructor(private readonly ctx: BaseAudioContext) {}

  get(kind: Exclude<VoiceKind, 'flute'>, midi: number, vel: number): AudioBuffer {
    const base = `${kind}:${midi}:${vel}`;
    const v = ((this.turn.get(base) ?? -1) + 1) % VARIANTS;
    this.turn.set(base, v);
    const key = `${base}:${v}`;
    let b = this.map.get(key);
    if (b) {
      this.map.delete(key);
      this.map.set(key, b);
      return b;
    }
    const sr = this.ctx.sampleRate;
    const data = renderNote(kind, midi, vel, sr);
    b = this.ctx.createBuffer(1, data.length, sr);
    b.getChannelData(0).set(data);
    this.map.set(key, b);
    if (this.map.size > CACHE_MAX) this.map.delete(this.map.keys().next().value as string);
    return b;
  }

  /** Render both variants of these notes ahead of time (entering play mode). */
  warm(kind: VoiceKind, notes: number[], vel: number): void {
    if (kind === 'flute') return;
    for (const m of notes) for (let i = 0; i < VARIANTS; i++) this.get(kind, m, vel);
  }

  get size(): number {
    return this.map.size;
  }
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseBuffers.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, b);
  }
  return b;
}

const waves = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
function harmonicWave(ctx: BaseAudioContext, h: number[]): PeriodicWave {
  let m = waves.get(ctx);
  if (!m) waves.set(ctx, (m = new Map()));
  const key = h.map((x) => x.toFixed(2)).join(',');
  let w = m.get(key);
  if (!w) {
    const real = new Float32Array(h.length + 1);
    const imag = new Float32Array(h.length + 1);
    h.forEach((a, i) => (imag[i + 1] = a));
    w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    m.set(key, w);
  }
  return w;
}

/** The lute's wooden body: two resonances, the top end softened. */
function lutebody(ctx: BaseAudioContext, input: AudioNode): AudioNode {
  const a = ctx.createBiquadFilter();
  a.type = 'peaking';
  a.frequency.value = 115;
  a.Q.value = 1.4;
  a.gain.value = 5;
  const b = ctx.createBiquadFilter();
  b.type = 'peaking';
  b.frequency.value = 260;
  b.Q.value = 1.1;
  b.gain.value = 3;
  const c = ctx.createBiquadFilter();
  c.type = 'highshelf';
  c.frequency.value = 3800;
  c.gain.value = -4;
  input.connect(a).connect(b).connect(c);
  return c;
}

function struck(ctx: BaseAudioContext, dest: AudioNode, kind: Exclude<VoiceKind, 'flute'>, midi: number, vel: number, when: number, cache: NoteCache): VoiceHandle {
  const src = ctx.createBufferSource();
  src.buffer = cache.get(kind, midi, vel);
  const g = ctx.createGain();
  src.connect(g);
  const out = kind === 'pluck' ? lutebody(ctx, g) : g;
  out.connect(dest);
  src.start(when);
  const h: VoiceHandle = {
    ends: when + src.buffer.duration,
    release: () => {},
    stop: (t) => {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.03);
      try {
        src.stop(t + 0.04);
      } catch {
        /* already stopped */
      }
      h.ends = Math.min(h.ends, t + 0.04);
    },
  };
  src.onended = () => {
    try {
      out.disconnect();
    } catch {
      /* gone */
    }
  };
  return h;
}

function flute(ctx: BaseAudioContext, dest: AudioNode, midi: number, vel: number, when: number, holdMaxS: number): VoiceHandle {
  const p = fluteParams(midi, vel);
  const out = ctx.createGain();
  out.gain.value = p.gain;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = p.toneHz;
  tone.Q.value = 0.4;
  tone.connect(out).connect(dest);
  // The tone: a near-sine with weak harmonics, scooping up to pitch, delayed vibrato.
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(harmonicWave(ctx, p.harmonics));
  osc.frequency.value = p.hz;
  osc.detune.setValueAtTime(-p.scoopCents, when);
  osc.detune.linearRampToValueAtTime(0, when + p.attackS * 1.2);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = p.vibratoHz;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, when);
  depth.gain.setValueAtTime(0, when + p.vibratoDelayS);
  depth.gain.linearRampToValueAtTime(p.vibratoCents, when + p.vibratoDelayS + 0.45);
  lfo.connect(depth).connect(osc.detune);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(1, when + p.attackS);
  osc.connect(env).connect(tone);
  // Breath: noise band-passed around the pitch, under the tone the whole time.
  const nz = ctx.createBufferSource();
  nz.buffer = noiseBuffer(ctx);
  nz.loop = true;
  nz.loopStart = 0;
  nz.loopEnd = nz.buffer.duration;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = p.hz * 1.02;
  band.Q.value = 2.2;
  const breath = ctx.createGain();
  breath.gain.setValueAtTime(0, when);
  breath.gain.linearRampToValueAtTime(p.breath * 3, when + p.attackS * 0.6);
  breath.gain.linearRampToValueAtTime(p.breath, when + p.attackS * 2);
  nz.connect(band).connect(breath).connect(tone);
  // The chiff: a puff of bright noise at the onset.
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = Math.min(9000, p.hz * 3);
  const chiff = ctx.createGain();
  chiff.gain.setValueAtTime(0, when);
  chiff.gain.linearRampToValueAtTime(p.chiff, when + 0.006);
  chiff.gain.exponentialRampToValueAtTime(0.0005, when + 0.07);
  nz.connect(hp).connect(chiff).connect(out);
  osc.start(when);
  lfo.start(when);
  nz.start(when, Math.random() * 0.5);
  let released = false;
  const autoAt = when + holdMaxS;
  const rel = (t: number) => {
    const at = Math.max(t, when + p.attackS * 0.5);
    for (const g of [env.gain, breath.gain]) {
      g.cancelScheduledValues(at);
      g.setTargetAtTime(0, at, p.releaseS / 3);
    }
    const end = at + p.releaseS * 2.2;
    for (const n of [osc, lfo, nz]) {
      try {
        n.stop(end);
      } catch {
        /* already stopped */
      }
    }
    h.ends = end;
  };
  const h: VoiceHandle = {
    ends: Infinity,
    release: (t) => {
      if (released || t >= autoAt) return;
      released = true;
      rel(t);
    },
    stop: (t) => {
      released = true;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(0, t + 0.03);
      const end = Math.min(h.ends, t + 0.04);
      for (const n of [osc, lfo, nz]) {
        try {
          n.stop(end);
        } catch {
          /* already stopped */
        }
      }
      h.ends = end;
    },
  };
  // A held note whose note-off never comes (a lost message, a tab gone) ends by itself.
  rel(autoAt);
  osc.onended = () => {
    try {
      out.disconnect();
    } catch {
      /* gone */
    }
  };
  return h;
}

/** Start one note of `kind` at context time `when` into `dest`. */
export function startVoice(ctx: BaseAudioContext, dest: AudioNode, kind: VoiceKind, midi: number, vel: number, when: number, cache: NoteCache, holdMaxS = 8): VoiceHandle {
  if (kind === 'flute') return flute(ctx, dest, midi, vel, when, holdMaxS);
  return struck(ctx, dest, kind, midi, vel, when, cache);
}
