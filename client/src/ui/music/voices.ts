// Playtest 2 instruments (CR 028): the four voices, synthesized. No sample
// files: Nicole's libraries are genre loop packs (Novation) and a Kontakt
// piano whose samples are encrypted and licensed for her own productions,
// none of them single plucked, blown or struck notes, so every note here is
// computed (zero download bytes, every pitch exact).
//
//   pluck (the lute)   Karplus-Strong with the Jaffe-Smith extensions: a
//                      noise burst shaped by the pick (velocity darkens or
//                      brightens it, a comb for the pick position) runs
//                      round a delay line one period long, an averaging
//                      low-pass and a per-pitch loss; an all-pass tunes the
//                      fractional delay. Two strings a few cents apart (a
//                      lute's double courses); a body resonance after it
//                      (synth.ts).
//   flute              live oscillators (synth.ts): a near-sine with weak
//                      harmonics, breath noise band-passed at the pitch, a
//                      chiff at the onset, a scoop up to pitch, delayed
//                      vibrato; held while the key is down.
//   drum (hand drum)   a circular membrane's modes (Bessel ratios) with a
//                      pitch drop at the strike; the register picks the
//                      stroke: bass (low notes, the drum's centre), open
//                      tone, slap (high notes, a bright crack); the note
//                      tunes the drum like a tabla, so it follows the scale.
//   bell (handbells)   additive partials of a tuned handbell (fundamental,
//                      the twelfth, upper inharmonic partials), each a
//                      slightly beating pair with its own decay, and a
//                      short metallic strike.
//
// The parameter functions and the renderers are pure (music.test.ts checks
// the pitch of a rendered pluck, the strokes, the partials, the envelopes).

import { midiToHz } from './theory';

export type VoiceKind = 'pluck' | 'flute' | 'drum' | 'bell';

/** A small deterministic PRNG (renders are reproducible in tests; play passes Math.random). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Velocity 1-7 -> linear gain (a gentle curve: 1 is about -21 dB under 7). */
export function velGain(vel: number): number {
  const v = Math.max(1, Math.min(7, vel)) / 7;
  return Math.pow(v, 1.6);
}

// ---------------------------------------------------------------- pluck

export interface PluckParams {
  hz: number;
  /** Seconds for the string to fall 60 dB. */
  t60: number;
  /** Rendered length (s). */
  seconds: number;
  /** Excitation low-pass coefficient (0 dark .. 1 bright). */
  bright: number;
  /** Pick position as a fraction of the string (comb notch). */
  pick: number;
  /** Detune of the second string of the course (cents). */
  detuneCents: number;
  gain: number;
}

export function pluckParams(midi: number, vel: number): PluckParams {
  const hz = midiToHz(midi);
  // Low strings ring long, high ones short (about 3.6 s at 82 Hz, 1 s at 1 kHz).
  const t60 = Math.max(0.8, Math.min(4, 3.6 * Math.pow(82 / hz, 0.5)));
  return { hz, t60, seconds: Math.min(4, t60 * 1.05 + 0.1), bright: 0.35 + 0.55 * (Math.max(1, Math.min(7, vel)) / 7), pick: 0.14, detuneCents: 3, gain: velGain(vel) };
}

/** One Karplus-Strong string into `out` (added). */
function ksString(out: Float32Array, sr: number, hz: number, t60: number, bright: number, pick: number, amp: number, rnd: () => number): void {
  const period = sr / hz;
  // The averaging filter delays half a sample; the all-pass takes the fraction.
  const total = period - 0.5;
  let L = Math.floor(total);
  let frac = total - L;
  if (frac < 0.1) {
    L -= 1;
    frac += 1;
  }
  const C = (1 - frac) / (1 + frac);
  const g = Math.pow(10, -3 / (hz * t60)); // per period
  const buf = new Float32Array(L + 2);
  // Excitation: one period of noise, low-passed by the pick's brightness, minus a delayed copy (the pick position).
  const exc = new Float32Array(L + 2);
  let lp = 0;
  for (let i = 0; i < exc.length; i++) {
    lp += ((rnd() * 2 - 1) - lp) * bright;
    exc[i] = lp;
  }
  const d = Math.max(1, Math.round(pick * L));
  for (let i = exc.length - 1; i >= d; i--) exc[i] -= exc[i - d];
  let mean = 0;
  for (let i = 0; i < exc.length; i++) mean += exc[i];
  mean /= exc.length;
  for (let i = 0; i < exc.length; i++) buf[i] = exc[i] - mean;
  // The loop: y = all-pass(average(two taps)) * g.
  let idx = 0;
  let prev = 0;
  let apX = 0;
  let apY = 0;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const cur = buf[idx];
    const avg = 0.5 * (cur + prev);
    prev = cur;
    const y = C * avg + apX - C * apY; // first-order all-pass
    apX = avg;
    apY = y;
    buf[idx] = y * g;
    idx = idx + 1 >= L ? 0 : idx + 1;
    out[i] += cur * amp;
  }
}

/** The lute note: two strings of a course, DC removed, a fade at the end. */
export function renderPluck(sr: number, p: PluckParams, rnd: () => number = Math.random): Float32Array {
  const out = new Float32Array(Math.ceil(p.seconds * sr));
  const c = Math.pow(2, p.detuneCents / 1200);
  ksString(out, sr, p.hz * c, p.t60, p.bright, p.pick, 0.55, rnd);
  ksString(out, sr, p.hz / c, p.t60 * 0.92, p.bright * 0.9, p.pick * 1.1, 0.45, rnd);
  finish(out, sr, p.gain * 0.6);
  return out;
}

// ---------------------------------------------------------------- drum

export type Stroke = 'bass' | 'tone' | 'slap';

export interface DrumParams {
  stroke: Stroke;
  hz: number;
  /** Strike pitch drop: starts this much higher, falls over `dropS`. */
  drop: number;
  dropS: number;
  decayS: number;
  /** Membrane modes: frequency ratios, amplitudes, decay multipliers. */
  modes: { ratio: number; amp: number; decay: number }[];
  /** Noise (the hand on the skin) level and band. */
  noise: number;
  noiseHz: number;
  noiseDecayS: number;
  seconds: number;
  gain: number;
}

/** A circular membrane's first modes (Bessel zeros over the first). */
export const MEMBRANE = [1, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501];

/** Fold a frequency by octaves into [lo, hi). */
export function foldHz(hz: number, lo: number, hi: number): number {
  let f = hz;
  while (f < lo) f *= 2;
  while (f >= hi) f /= 2;
  return f;
}

export function strokeOf(midi: number): Stroke {
  return midi < 48 ? 'bass' : midi < 72 ? 'tone' : 'slap';
}

export function drumParams(midi: number, vel: number): DrumParams {
  const stroke = strokeOf(midi);
  const v = Math.max(1, Math.min(7, vel)) / 7;
  const note = midiToHz(midi);
  if (stroke === 'bass') {
    return { stroke, hz: foldHz(note, 62, 124), drop: 0.35, dropS: 0.05, decayS: 0.55, modes: [{ ratio: 1, amp: 1, decay: 1 }, { ratio: MEMBRANE[1], amp: 0.25, decay: 0.5 }, { ratio: MEMBRANE[2], amp: 0.1, decay: 0.35 }], noise: 0.08 + 0.05 * v, noiseHz: 900, noiseDecayS: 0.03, seconds: 0.9, gain: velGain(vel) * 1.1 };
  }
  if (stroke === 'tone') {
    return { stroke, hz: foldHz(note, 150, 300), drop: 0.12, dropS: 0.03, decayS: 0.32, modes: MEMBRANE.slice(0, 6).map((r, i) => ({ ratio: r, amp: [1, 0.55, 0.4, 0.25, 0.18, 0.12][i] * (i ? 0.6 + 0.4 * v : 1), decay: [1, 0.7, 0.55, 0.45, 0.4, 0.35][i] })), noise: 0.12 + 0.12 * v, noiseHz: 2400, noiseDecayS: 0.025, seconds: 0.6, gain: velGain(vel) * 0.9 };
  }
  return { stroke, hz: foldHz(note, 300, 600), drop: 0.06, dropS: 0.015, decayS: 0.14, modes: MEMBRANE.map((r, i) => ({ ratio: r, amp: [0.6, 0.7, 0.65, 0.5, 0.45, 0.4, 0.3, 0.25][i], decay: [1, 0.8, 0.7, 0.6, 0.55, 0.5, 0.45, 0.4][i] })), noise: 0.45 + 0.3 * v, noiseHz: 4200, noiseDecayS: 0.035, seconds: 0.35, gain: velGain(vel) * 0.8 };
}

export function renderDrum(sr: number, p: DrumParams, rnd: () => number = Math.random): Float32Array {
  const n = Math.ceil(p.seconds * sr);
  const out = new Float32Array(n);
  const nyq = sr * 0.45;
  for (const m of p.modes) {
    let ph = rnd() * 0.2;
    const tau = (p.decayS * m.decay) / 6.9; // e-fold time for a 60 dB fall over decayS
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = p.hz * m.ratio * (1 + p.drop * Math.exp(-t / p.dropS));
      if (f >= nyq) break;
      ph += (2 * Math.PI * f) / sr;
      out[i] += m.amp * Math.sin(ph) * Math.exp(-t / tau);
    }
  }
  // The hand on the skin: band-passed noise (a two-pole resonator), quick decay.
  const w = (2 * Math.PI * Math.min(p.noiseHz, nyq)) / sr;
  const r = 0.92;
  const a1 = 2 * r * Math.cos(w);
  const a2 = -r * r;
  let y1 = 0;
  let y2 = 0;
  const nt = p.noiseDecayS / 6.9;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const x = (rnd() * 2 - 1) * Math.exp(-t / nt);
    const y = x + a1 * y1 + a2 * y2;
    y2 = y1;
    y1 = y;
    out[i] += y * p.noise * 0.25;
  }
  // A 1 ms attack ramp (no click from the phase start).
  const ramp = Math.floor(sr * 0.001);
  for (let i = 0; i < ramp && i < n; i++) out[i] *= i / ramp;
  finish(out, sr, p.gain * 0.5);
  return out;
}

// ---------------------------------------------------------------- bell

export interface BellPartial {
  ratio: number;
  amp: number;
  /** 60 dB decay (s). */
  t60: number;
  /** The pair's beating (Hz). */
  beat: number;
}

export interface BellParams {
  hz: number;
  partials: BellPartial[];
  strike: number;
  seconds: number;
  gain: number;
}

/** A tuned handbell: the fundamental and its twelfth lead; inharmonic upper partials fade first. */
export const HANDBELL: BellPartial[] = [
  { ratio: 1, amp: 1, t60: 4.2, beat: 0.35 },
  { ratio: 2.01, amp: 0.12, t60: 2.6, beat: 0.6 },
  { ratio: 3.0, amp: 0.55, t60: 2.4, beat: 0.8 },
  { ratio: 4.16, amp: 0.22, t60: 1.3, beat: 1.1 },
  { ratio: 5.43, amp: 0.18, t60: 0.95, beat: 1.4 },
  { ratio: 6.79, amp: 0.1, t60: 0.6, beat: 1.9 },
  { ratio: 8.21, amp: 0.07, t60: 0.42, beat: 2.3 },
  { ratio: 9.68, amp: 0.05, t60: 0.3, beat: 2.8 },
];

export function bellParams(midi: number, vel: number, sr = 48000): BellParams {
  const hz = midiToHz(midi);
  const v = Math.max(1, Math.min(7, vel)) / 7;
  // Higher bells ring shorter; a hard strike brings the upper partials up.
  const shorten = Math.pow(523 / hz, 0.35);
  const partials = HANDBELL.filter((p) => hz * p.ratio < sr * 0.45).map((p, i) => ({ ...p, amp: p.amp * (i > 2 ? 0.5 + 0.7 * v : 1), t60: p.t60 * Math.min(1.4, shorten) }));
  const longest = Math.max(...partials.map((p) => p.t60));
  return { hz, partials, strike: 0.15 + 0.25 * v, seconds: Math.min(4.5, longest + 0.1), gain: velGain(vel) };
}

export function renderBell(sr: number, p: BellParams, rnd: () => number = Math.random): Float32Array {
  const n = Math.ceil(p.seconds * sr);
  const out = new Float32Array(n);
  for (const pt of p.partials) {
    const f = p.hz * pt.ratio;
    const tau = pt.t60 / 6.9;
    const w1 = (2 * Math.PI * (f - pt.beat / 2)) / sr;
    const w2 = (2 * Math.PI * (f + pt.beat / 2)) / sr;
    const p0 = rnd() * Math.PI * 2;
    const k = Math.exp(-1 / (tau * sr));
    let env = pt.amp * 0.5;
    for (let i = 0; i < n; i++) {
      out[i] += env * (Math.sin(p0 + w1 * i) + Math.sin(p0 * 1.3 + w2 * i));
      env *= k;
      if (env < 1e-5) break;
    }
  }
  // The clapper: a few ms of bright noise.
  const sn = Math.floor(sr * 0.012);
  let hp = 0;
  let last = 0;
  for (let i = 0; i < sn && i < n; i++) {
    const x = rnd() * 2 - 1;
    hp = 0.7 * (hp + x - last);
    last = x;
    out[i] += hp * p.strike * (1 - i / sn);
  }
  const ramp = Math.floor(sr * 0.0008);
  for (let i = 0; i < ramp && i < n; i++) out[i] *= i / ramp;
  finish(out, sr, p.gain * 0.32);
  return out;
}

// ---------------------------------------------------------------- flute

export interface FluteParams {
  hz: number;
  attackS: number;
  releaseS: number;
  /** Start this many cents flat, rising to pitch over attackS (the player's lip). */
  scoopCents: number;
  vibratoHz: number;
  vibratoCents: number;
  vibratoDelayS: number;
  /** Harmonic amplitudes (1 = fundamental). */
  harmonics: number[];
  breath: number;
  chiff: number;
  gain: number;
  /** Low-pass over the tone (Hz). */
  toneHz: number;
}

export function fluteParams(midi: number, vel: number): FluteParams {
  const hz = midiToHz(midi);
  const v = Math.max(1, Math.min(7, vel)) / 7;
  // Overblown high notes are purer; a forceful breath is brighter and breathier.
  const high = Math.max(0, Math.min(1, (midi - 72) / 24));
  return {
    hz,
    attackS: 0.09 - 0.04 * v,
    releaseS: 0.14,
    scoopCents: 25 + 15 * (1 - v),
    vibratoHz: 5.2,
    vibratoCents: 11,
    vibratoDelayS: 0.28,
    harmonics: [1, 0.28 + 0.18 * v - 0.12 * high, 0.1 + 0.1 * v - 0.05 * high, 0.04 + 0.04 * v, 0.015 + 0.02 * v],
    breath: 0.05 + 0.06 * v,
    chiff: 0.25 + 0.3 * v,
    gain: velGain(vel) * 0.42,
    toneHz: Math.min(16000, hz * (5 + 4 * v)),
  };
}

/** The flute's amplitude envelope at t s (held until `heldS`, then released): pure, for tests and the offline renderer. */
export function fluteEnvelope(p: FluteParams, t: number, heldS: number): number {
  if (t < 0) return 0;
  const a = Math.min(1, t / p.attackS);
  const atk = a * a * (3 - 2 * a);
  if (t <= heldS) return atk;
  return atk * Math.exp(-(t - heldS) / (p.releaseS / 3));
}

// ---------------------------------------------------------------- shared

/** DC blocker, scale, and a 30 ms fade at the end. */
function finish(out: Float32Array, sr: number, gain: number): void {
  let x1 = 0;
  let y1 = 0;
  const R = 0.995;
  for (let i = 0; i < out.length; i++) {
    const x = out[i];
    const y = x - x1 + R * y1;
    x1 = x;
    y1 = y;
    out[i] = y * gain;
  }
  const f = Math.min(out.length, Math.floor(sr * 0.03));
  for (let i = 0; i < f; i++) out[out.length - 1 - i] *= i / f;
}

/** Render a struck/plucked voice's note (the flute is live: synth.ts). */
export function renderNote(kind: Exclude<VoiceKind, 'flute'>, midi: number, vel: number, sr: number, rnd: () => number = Math.random): Float32Array {
  if (kind === 'pluck') return renderPluck(sr, pluckParams(midi, vel), rnd);
  if (kind === 'drum') return renderDrum(sr, drumParams(midi, vel), rnd);
  return renderBell(sr, bellParams(midi, vel, sr), rnd);
}

/** Fundamental of a signal by autocorrelation (tests): Hz, searching [lo, hi]. */
export function estimatePitch(x: Float32Array, sr: number, lo = 50, hi = 2000, from = 0.05, len = 0.25): number {
  const a = Math.floor(from * sr);
  const n = Math.min(x.length - a, Math.floor(len * sr));
  const minLag = Math.floor(sr / hi);
  const maxLag = Math.ceil(sr / lo);
  let best = 0;
  let bestLag = minLag;
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[a + i] * x[a + i + lag];
    r[lag] = s;
  }
  // The first strong peak (an octave error is the classic failure of a plain maximum).
  let max = 0;
  for (let lag = minLag; lag <= maxLag; lag++) max = Math.max(max, r[lag]);
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (r[lag] > 0.85 * max && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      best = r[lag];
      bestLag = lag;
      break;
    }
  }
  if (!best) return 0;
  // Parabolic interpolation around the peak.
  const y0 = r[bestLag - 1];
  const y1 = r[bestLag];
  const y2 = r[bestLag + 1];
  const den = y0 - 2 * y1 + y2;
  const shift = den !== 0 ? (0.5 * (y0 - y2)) / den : 0;
  return sr / (bestLag + shift);
}
