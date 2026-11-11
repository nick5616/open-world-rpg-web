// Synthesized one-shots (playtest 2 immersion pass): the bells of the
// Heartfall. A Hollow Bell's toll and the Hush's own deeper toll played the
// generic telegraph sting; a struck bell is a handful of inharmonic partials
// (hum, prime, tierce, quint, nominal ... the classic church-bell series),
// each a pair of slightly detuned sines that beat against each other, the
// high ones dying first, plus a short metallic strike. Rendered once per
// sound through an OfflineAudioContext (on the audio thread, no asset, no
// main-thread long task) and then played like any file cue (sfx.ts treats
// `synth:<name>` files as these).

/** Partials of a bell as multiples of its prime: ratio, level, decay (s at a 200 Hz prime). */
export const BELL_PARTIALS: [ratio: number, level: number, decay: number][] = [
  [0.5, 0.55, 7.5], // hum
  [1.0, 0.8, 5.0], // prime
  [1.19, 0.55, 3.8], // tierce (the minor third: the bell's sorrow)
  [1.5, 0.22, 3.0], // quint
  [2.0, 0.6, 2.6], // nominal
  [2.52, 0.28, 1.8],
  [2.66, 0.14, 1.5],
  [3.01, 0.16, 1.2],
  [4.17, 0.09, 0.8],
  [5.43, 0.05, 0.5],
];

export interface BellSpec {
  /** The prime's frequency (Hz). */
  prime: number;
  seconds: number;
  /** Decay times scale (longer for a big bell). */
  sustain: number;
  /** Detune between each partial's pair (Hz): the warble. */
  beat: number;
  /** Strike noise level 0..1. */
  strike: number;
  /** A dark low-pass on the whole thing (Hz). */
  lowpass: number;
}

export const BELLS: Record<string, BellSpec> = {
  // a cracked bronze bell somewhere about G3, flat; eerie, not churchly
  hollow_bell: { prime: 188, seconds: 7, sustain: 0.9, beat: 1.3, strike: 0.5, lowpass: 5200 },
  // the Hush's toll: an octave and a fourth lower, slower, bigger
  hush_toll: { prime: 70, seconds: 10, sustain: 1.6, beat: 0.6, strike: 0.35, lowpass: 2600 },
};

/** Envelope level of one partial `t` seconds after the strike (pure, tested). */
export function partialLevel(level: number, decayS: number, t: number): number {
  if (t < 0) return 0;
  const attack = Math.min(1, t / 0.004);
  return level * attack * Math.exp(-t / Math.max(0.05, decayS));
}

/** Decay of a partial for a bell (higher partials ring shorter; a lower bell rings longer). */
export function partialDecay(spec: BellSpec, ratio: number, decay: number): number {
  return decay * spec.sustain * Math.pow(200 / Math.max(40, spec.prime * ratio), 0.35);
}

type OfflineCtor = new (channels: number, length: number, rate: number) => OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

const RATE = 32000;

/** Render one bell (null: no OfflineAudioContext, e.g. in tests). */
export async function renderBell(name: string): Promise<AudioBuffer | null> {
  const spec = BELLS[name];
  const Ctor = offlineCtor();
  if (!spec || !Ctor) return null;
  const len = Math.floor(RATE * spec.seconds);
  const ctx = new Ctor(2, len, RATE);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = spec.lowpass;
  lp.Q.value = 0.5;
  const master = ctx.createGain();
  // a long fade over the last 1.8 s: the buffer never ends on a ringing partial (no click)
  master.gain.setValueAtTime(0.32, 0);
  master.gain.setValueAtTime(0.32, spec.seconds - 1.8);
  master.gain.linearRampToValueAtTime(0, spec.seconds - 0.02);
  lp.connect(master).connect(ctx.destination);
  for (const [ratio, level, decay] of BELL_PARTIALS) {
    const f = spec.prime * ratio;
    if (f > RATE / 2.2) continue;
    const d = partialDecay(spec, ratio, decay);
    for (const [side, det] of [
      [-0.35, -spec.beat / 2],
      [0.35, spec.beat / 2],
    ] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f + det;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(level * 0.5, 0.004);
      g.gain.setTargetAtTime(0, 0.004, d);
      const p = ctx.createStereoPanner();
      p.pan.value = side * Math.min(1, ratio / 3);
      o.connect(g).connect(p).connect(lp);
      o.start(0);
      o.stop(spec.seconds);
    }
  }
  // the strike: a short burst of metallic noise around the nominal
  if (spec.strike > 0) {
    const n = Math.floor(RATE * 0.08);
    const nb = ctx.createBuffer(1, n, RATE);
    const ch = nb.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (RATE * 0.012));
    const s = ctx.createBufferSource();
    s.buffer = nb;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(RATE / 2.5, spec.prime * 2.5);
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.value = spec.strike;
    s.connect(bp).connect(g).connect(lp);
    s.start(0);
  }
  return ctx.startRendering();
}

/** `synth:<name>` file names that sfx.ts renders instead of fetching. */
export function synthName(file: string): string | null {
  return file.startsWith('synth:') ? file.slice(6) : null;
}
