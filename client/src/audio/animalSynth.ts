// Synthesized animal sounds for petting (playtest 5, CR 054), rendered once
// through an OfflineAudioContext like the bells (bells.ts) and played as
// `synth:<name>` cues:
//
//   pet_dog   a soft panting bark: three low "huff"s (band-passed noise with
//             a faint voiced hum under it), the last one a little happy yip
//   pet_cat   a purr: a low voiced buzz (about 26 Hz amplitude pulses on a
//             sawtooth near 70 Hz, filtered dark), swelling and fading
//
// The envelopes are pure (tested); only the rendering needs an audio context.

export interface AnimalSpec {
  seconds: number;
}

export const ANIMAL_SYNTH: Record<string, AnimalSpec> = {
  pet_dog: { seconds: 1.6 },
  pet_cat: { seconds: 2.6 },
};

export function isAnimalSynth(name: string): boolean {
  return name in ANIMAL_SYNTH;
}

/** The three huffs of a panting bark: start time, length and level (s, s, 0..1). */
export const HUFFS: [at: number, len: number, level: number][] = [
  [0.0, 0.22, 0.8],
  [0.34, 0.2, 0.7],
  [0.7, 0.3, 0.9],
];

/** Envelope of a huff `t` seconds after its start: a quick rise and a breathy fall. */
export function huffEnv(t: number, len: number): number {
  if (t < 0 || t > len) return 0;
  const a = Math.min(1, t / 0.03);
  return a * Math.pow(1 - t / len, 1.6);
}

/** Purr loudness `t` seconds in over `seconds`: swells in over 0.5 s, fades over the last 0.9 s, pulsing about 26 times a second. */
export function purrEnv(t: number, seconds: number): number {
  if (t < 0 || t > seconds) return 0;
  const swell = Math.min(1, t / 0.5);
  const fade = Math.min(1, (seconds - t) / 0.9);
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 26);
  return swell * fade * (0.35 + 0.65 * pulse);
}

type OfflineCtor = new (channels: number, length: number, rate: number) => OfflineAudioContext;
const RATE = 32000;

function offlineCtor(): OfflineCtor | null {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

/** Render one animal sound (null: unknown name or no OfflineAudioContext, e.g. in tests). */
export async function renderAnimal(name: string): Promise<AudioBuffer | null> {
  const spec = ANIMAL_SYNTH[name];
  const Ctor = offlineCtor();
  if (!spec || !Ctor) return null;
  const len = Math.floor(RATE * spec.seconds);
  const ctx = new Ctor(1, len, RATE);
  const buf = ctx.createBuffer(1, len, RATE);
  const d = buf.getChannelData(0);
  let seed = name === 'pet_dog' ? 17 : 91;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  if (name === 'pet_dog') {
    let lp = 0;
    for (const [at, hl, level] of HUFFS) {
      const i0 = Math.floor(at * RATE);
      const n = Math.floor(hl * RATE);
      const pitch = at > 0.6 ? 340 : 230; // the last one is the yip
      for (let i = 0; i < n && i0 + i < len; i++) {
        const t = i / RATE;
        const e = huffEnv(t, hl) * level;
        lp += (rnd() * 2 - lp) * 0.18; // breath: noise through a one-pole low-pass
        const voice = Math.sin(2 * Math.PI * pitch * (1 + 0.25 * (1 - t / hl)) * t) * 0.35 + Math.sin(2 * Math.PI * pitch * 2.1 * t) * 0.12;
        d[i0 + i] += (lp * 0.9 + voice) * e * 0.5;
      }
    }
  } else {
    let f = 0;
    for (let i = 0; i < len; i++) {
      const t = i / RATE;
      f += (70 + 6 * Math.sin(t * 3)) / RATE;
      const saw = (f % 1) * 2 - 1;
      d[i] = saw * purrEnv(t, spec.seconds) * 0.5 + rnd() * 0.05 * purrEnv(t, spec.seconds);
    }
  }
  // A gentle low-pass over the whole thing (soft, never harsh); the tail goes to zero by construction.
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = name === 'pet_dog' ? 1900 : 520;
  lpf.Q.value = 0.6;
  src.connect(lpf).connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}
