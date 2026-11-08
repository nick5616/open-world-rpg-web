// Speaking indicators, outside React (spec 10 "Proximity voice" 4).
// adapted from the-circle frontend/src/audio.ts: one AnalyserNode per audio
// track (they all live in the mixer's single AudioContext), a rAF loop turns
// each into a perceptual 0-1 level, and the loop writes it straight onto
// bound DOM nodes as the CSS variable --lvl and data-speaking, so a voice
// starting or stopping never re-renders React. Nameplates (canvas sprites)
// read `isSpeaking(name)` from their own render loop instead.
//
// Keys are character names (the same key nameplates and the party frame
// have), or SELF for the local microphone.

export const SELF = '\u0000self';

interface Entry {
  analyser: AnalyserNode;
  data: Float32Array;
  level: number;
  speaking: boolean;
  lastLoud: number;
}

// Same calibration as the-circle: conversational speech after AGC sits
// around -30..-20 dB, so -58..-18 dB spans silence to loud talk.
const FLOOR_DB = -58;
const CEIL_DB = -18;
const SPEAKING_LEVEL = 0.22;
const HANGOVER_MS = 450;

const entries = new Map<string, Entry>();
const bound = new Map<string, Set<HTMLElement>>();
const written = new Map<HTMLElement, string>();
let raf = 0;

function frame() {
  raf = 0;
  const now = performance.now();
  for (const e of entries.values()) {
    e.analyser.getFloatTimeDomainData(e.data);
    let sum = 0;
    for (let i = 0; i < e.data.length; i++) sum += e.data[i] * e.data[i];
    const rms = Math.sqrt(sum / e.data.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    const raw = Math.max(0, Math.min(1, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)));
    // Fast attack, slow release: the glow jumps with a syllable, then settles.
    e.level += (raw - e.level) * (raw > e.level ? 0.45 : 0.08);
    if (e.level > SPEAKING_LEVEL) e.lastLoud = now;
    e.speaking = e.level > SPEAKING_LEVEL || now - e.lastLoud < HANGOVER_MS;
  }
  for (const [key, els] of bound) {
    const e = entries.get(key);
    const lvl = e ? e.level.toFixed(2) : '0.00';
    const speaking = e?.speaking ? '1' : '0';
    for (const el of els) {
      const k = lvl + speaking;
      if (written.get(el) === k) continue;
      written.set(el, k);
      el.style.setProperty('--lvl', lvl);
      el.dataset.speaking = speaking;
    }
  }
  if (entries.size > 0 || bound.size > 0) raf = requestAnimationFrame(frame);
}

function ensureLoop() {
  if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);
}

export const voiceLevels = {
  /** Meter this analyser under key (replaces an earlier one). */
  attach(key: string, analyser: AnalyserNode) {
    entries.set(key, { analyser, data: new Float32Array(analyser.fftSize), level: 0, speaking: false, lastLoud: 0 });
    ensureLoop();
  },
  detach(key: string) {
    entries.delete(key);
  },
  /** Write --lvl / data-speaking for key onto el every frame. Returns an unbind function. */
  bind(key: string, el: HTMLElement): () => void {
    let set = bound.get(key);
    if (!set) bound.set(key, (set = new Set()));
    set.add(el);
    ensureLoop();
    return () => {
      set!.delete(el);
      written.delete(el);
      if (!set!.size) bound.delete(key);
    };
  },
  level(key: string): number {
    return entries.get(key)?.level ?? 0;
  },
  isSpeaking(key: string): boolean {
    return entries.get(key)?.speaking ?? false;
  },
};

/** For nameplates: is this player audibly talking right now (local analyser)? */
export function isSpeaking(name: string): boolean {
  return voiceLevels.isSpeaking(name);
}
