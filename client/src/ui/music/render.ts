// Playtest 2 instruments (CR 028): a short phrase rendered offline (an
// OfflineAudioContext, the same voices as in game) and encoded as a WAV.
// The evidence run saves one per instrument (docs/evidence/pt2-instruments-
// *.wav) and one through a cave's reverb; the debug handle exposes it.

import { CONTENT, type InstrumentDef } from '@lodestone/contracts';
import { degreeToMidi, foldIntoRange, scaleByKey } from './theory';
import { NoteCache, startVoice } from './synth';
import type { VoiceKind } from './voices';

export interface PhraseNote {
  /** Seconds from the start. */
  t: number;
  midi: number;
  vel: number;
  /** Held this long (the flute); struck voices ring. */
  dur: number;
}

/** A little tune per instrument: degrees of a scale, beats at a tempo. */
export function phraseFor(inst: InstrumentDef, bpm = 100): PhraseNote[] {
  const beat = 60 / bpm;
  const out: PhraseNote[] = [];
  const at = (b: number, deg: number, len: number, vel: number, scale = 'major', root = 2, octave?: number) => {
    const oct = octave ?? Math.floor((inst.range[0] + 12) / 12) - 1;
    out.push({ t: b * beat, midi: foldIntoRange(degreeToMidi(deg, scaleByKey(scale), root, oct), inst.range), vel, dur: len * beat * 0.95 });
  };
  switch (inst.voice) {
    case 'pluck': // D dorian: a broken chord, a run, a cadence
      [0, 4, 7, 9, 7, 4].forEach((d, i) => at(i * 0.5, d, 0.5, 5, 'dorian', 2, 3));
      [8, 7, 6, 4].forEach((d, i) => at(3 + i * 0.5, d, 0.5, 4, 'dorian', 2, 3));
      at(5, 0, 2, 6, 'dorian', 2, 3);
      at(5, 4, 2, 4, 'dorian', 2, 3);
      at(5, 7, 2, 4, 'dorian', 2, 3);
      break;
    case 'flute': // G major pentatonic, legato
      [
        [0, 4, 1],
        [1, 5, 0.5],
        [1.5, 7, 0.5],
        [2, 8, 1.5],
        [3.5, 7, 0.5],
        [4, 5, 1],
        [5, 4, 2],
      ].forEach(([b, d, l]) => at(b, d, l, 5, 'pentatonic', 7, 5));
      break;
    case 'drum': // bass, tones and slaps: a dum-tek pattern
      for (let bar = 0; bar < 2; bar++) {
        const o = bar * 4;
        at(o, 0, 0.5, 6, 'minor', 2, 2); // bass (low)
        at(o + 1, 2, 0.5, 5, 'minor', 2, 4); // tone
        at(o + 1.5, 4, 0.5, 4, 'minor', 2, 4);
        at(o + 2, 0, 0.5, 6, 'minor', 2, 2);
        at(o + 2.5, 0, 0.5, 4, 'minor', 2, 2);
        at(o + 3, 0, 0.5, 6, 'minor', 2, 5); // slap (high)
        at(o + 3.5, 2, 0.25, 3, 'minor', 2, 4);
        at(o + 3.75, 4, 0.25, 4, 'minor', 2, 4);
      }
      break;
    case 'bell': // F major: a peal down the scale and a chord
      [7, 6, 5, 4, 3, 2, 1, 0].forEach((d, i) => at(i * 0.5, d, 0.5, 4 + (i % 2), 'major', 5, 5));
      at(4.5, 0, 2, 5, 'major', 5, 5);
      at(4.5, 2, 2, 4, 'major', 5, 5);
      at(4.5, 4, 2, 4, 'major', 5, 5);
      break;
  }
  return out;
}

/** A cave's reverb (the same recipe as audio/sfx.ts buildIR: darkened noise, decay by chamber size). */
export function caveIR(ctx: BaseAudioContext, radius: number): AudioBuffer {
  const rr = Math.max(2, Math.min(16, radius));
  const len = Math.floor(ctx.sampleRate * (0.35 + rr * 0.12));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (Math.random() * 2 - 1 - lp) * (0.55 - 0.45 * t);
      d[i] = lp * Math.pow(1 - t, 2.2 + 6 / rr);
    }
  }
  return ir;
}

/** Render a phrase on an instrument; reverb 0..1 sends it through a cave of `radius` m. */
export async function renderPhrase(inst: InstrumentDef, notes: PhraseNote[], opts: { sampleRate?: number; reverb?: number; radius?: number; tail?: number } = {}): Promise<AudioBuffer> {
  const sr = opts.sampleRate ?? 44100;
  const end = Math.max(...notes.map((n) => n.t + n.dur)) + (opts.tail ?? 2.2);
  const Ctor = (globalThis as unknown as { OfflineAudioContext: typeof OfflineAudioContext }).OfflineAudioContext;
  const ctx = new Ctor(2, Math.ceil(end * sr), sr);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -6;
  comp.ratio.value = 8;
  master.connect(comp).connect(ctx.destination);
  const dry = ctx.createGain();
  dry.connect(master);
  if ((opts.reverb ?? 0) > 0) {
    const conv = ctx.createConvolver();
    conv.buffer = caveIR(ctx, opts.radius ?? 8);
    const send = ctx.createGain();
    send.gain.value = (opts.reverb ?? 0) * 0.9;
    dry.connect(send).connect(conv).connect(master);
  }
  const cache = new NoteCache(ctx);
  const kind = inst.voice as VoiceKind;
  for (const n of notes) {
    const v = startVoice(ctx, dry, kind, n.midi, n.vel, n.t + 0.02, cache, CONTENT.instruments.holdMaxS);
    if (inst.sustain) v.release(n.t + 0.02 + n.dur);
  }
  return ctx.startRendering();
}

/** 16-bit PCM WAV of a buffer (all channels interleaved). */
export function encodeWav(buf: AudioBuffer): Uint8Array {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const sr = buf.sampleRate;
  const bytes = 44 + n * ch * 2;
  const out = new Uint8Array(bytes);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return out;
}

/** Peak and RMS (dBFS) of a buffer: the evidence notes them. */
export function levels(buf: AudioBuffer): { peakDb: number; rmsDb: number; seconds: number } {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sum += d[i] * d[i];
      n++;
    }
  }
  const db = (x: number) => (x > 0 ? Math.round(200 * Math.log10(x)) / 10 : -200);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, n))), seconds: Math.round((buf.length / buf.sampleRate) * 100) / 100 };
}

export function instrumentByKey(key: string): InstrumentDef | undefined {
  return CONTENT.instruments.list.find((i) => i.key === key);
}
