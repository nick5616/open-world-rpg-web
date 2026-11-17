// A soft synthesized murmur for each person (CR 049): one short, quiet
// syllable blip per few letters as a line types out, pitched from the
// person's id so everyone has their own voice. Original and tiny: two
// oscillators through a low-pass with a soft attack, on the UI bus (so the
// volume sliders and mute apply); silent before the first gesture or with
// sound off.

import { busInput, getAudioContext } from '../../audio/context';
import { useAudioSettings } from '../../audio/settings';

function hash(n: number): number {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** A person's base pitch, Hz (110-250), from their id. */
export function basePitch(id: number): number {
  return 110 + (hash(id) % 1400) / 10;
}

const VOWEL: Record<string, number> = { a: 1.0, e: 1.18, i: 1.4, o: 0.9, u: 0.8, y: 1.3 };

/** The blip's pitch for the letter at hand: the person's base, bent by the vowel and nudged by position (never the same twice in a row). */
export function blipHz(id: number, ch: string, index: number): number {
  const c = ch.toLowerCase();
  const v = VOWEL[c] ?? 0.95 + ((c.charCodeAt(0) || 0) % 7) * 0.025;
  const wob = 1 + (((hash(id + index * 31) % 100) - 50) / 50) * 0.06;
  return basePitch(id) * v * wob;
}

/** Whether a letter makes a blip: every third letter, letters only (punctuation and spaces are the pauses). */
export function blipsAt(ch: string, index: number): boolean {
  return /[a-z]/i.test(ch) && index % 3 === 0;
}

let lastAt = 0;

/** One blip (quiet; nothing when sound is off or the context isn't up). */
export function speakBlip(id: number, ch: string, index: number): void {
  const ctx = getAudioContext();
  const bus = busInput('ui');
  if (!ctx || !bus || ctx.state !== 'running') return;
  const st = useAudioSettings.getState();
  if (st.muted || st.volumes.ui <= 0 || st.volumes.master <= 0) return;
  const now = ctx.currentTime;
  if (now - lastAt < 0.05) return;
  lastAt = now;
  const f = blipHz(id, ch, index);
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1100 + (hash(id) % 600);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.045, now + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);
  const a = ctx.createOscillator();
  a.type = 'triangle';
  a.frequency.setValueAtTime(f, now);
  a.frequency.exponentialRampToValueAtTime(f * 0.93, now + 0.08);
  const b = ctx.createOscillator();
  b.type = 'sine';
  b.frequency.setValueAtTime(f * 2.01, now);
  const bg = ctx.createGain();
  bg.gain.value = 0.3;
  a.connect(lp);
  b.connect(bg).connect(lp);
  lp.connect(g).connect(bus);
  a.start(now);
  b.start(now);
  a.stop(now + 0.1);
  b.stop(now + 0.1);
  a.onended = () => {
    a.disconnect();
    b.disconnect();
    bg.disconnect();
    lp.disconnect();
    g.disconnect();
  };
}
