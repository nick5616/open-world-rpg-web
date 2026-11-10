// The listener's surroundings -> the mix (pure; acoustics.test.ts). The
// engine samples where the listener stands ten times a second (shelter.ts:
// roof overhead, inside a building; caves: depth and the distance to the
// mouth) and turns it into targets here; the Web Audio side only glides
// gains and filter cutoffs to them (setTargetAtTime), so walking through a
// doorway or into a cave mouth is a smooth crossfade, never a switch.
//
//   weather (wind, open-air rain, thunder, insects): one submix, faded and
//     low-passed by shelter: under a porch it is a little duller, behind
//     walls quiet and muffled, in a cave it fades with the distance from the
//     opening;
//   rain on the roof: a separate drumming layer that rises as the open-air
//     rain falls away (the "inside while it pours" sound);
//   interior: a small-room reverb send indoors, the chamber reverb
//     underground, and a gentle low-pass on the sfx and ambience buses.

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Exponential (perceptual) interpolation between two frequencies. */
const lerpHz = (a: number, b: number, t: number) => a * Math.pow(b / a, clamp01(t));

/**
 * How much of the surface (weather, open-air sounds) reaches a listener in a
 * cave: 1 outside and at the mouth, falling with the distance to the nearest
 * opening and the depth (`underground`, CaveManager's eased 0.25..1 inside).
 */
export function caveLeak(underground: number, mouthM: number): number {
  const u = clamp01(underground);
  if (u < 0.01) return 1;
  const m = Number.isFinite(mouthM) ? Math.max(0, mouthM) : 200;
  const inside = Math.exp(-(m + u * 18) / 11);
  // Blend in over the first quarter of `underground` (it eases in from 0).
  return lerp(1, inside, clamp01(u / 0.25));
}

export interface ShelterState {
  /** 0 open sky .. 1 roof overhead (a porch, a bridge, inside). */
  roof: number;
  /** 0 outdoors .. 1 inside closed walls (an open-fronted forge is ~0.55). */
  indoors: number;
}

export interface WeatherMix {
  /** Gain of the weather submix (wind, open-air rain, thunder, insects). */
  gain: number;
  /** Its low-pass cutoff. */
  lowpassHz: number;
  /** Open-air rain level (before the submix gain). */
  rain: number;
  /** Rain drumming on the roof above you. */
  roofRain: number;
}

/**
 * Weather through walls and rock. `rain` is the rain intensity 0..1
 * (RainIntensity), `leak` = caveLeak(...).
 */
export function weatherMix(rain: number, s: ShelterState, leak: number): WeatherMix {
  const roof = clamp01(s.roof);
  const indoors = clamp01(s.indoors);
  // Muffling: a roof alone (porch) takes a third, walls the rest.
  const m = clamp01(0.35 * roof + 0.65 * indoors);
  let gain = 1 - 0.78 * m;
  let lowpassHz = lerpHz(16000, 650, m);
  const l = clamp01(leak);
  if (l < 1) {
    gain *= l;
    lowpassHz = Math.min(lowpassHz, 300 + 9000 * Math.pow(l, 1.5));
  }
  const r = clamp01(rain);
  return { gain, lowpassHz, rain: r, roofRain: r * roof * (0.4 + 0.45 * indoors) * l };
}

export interface InteriorMix {
  /** Reverb amount 0..1 (SfxEngine.setReverb). */
  reverb: number;
  /** Room/chamber radius for the reverb tail (m). */
  radius: number;
  /** Low-pass on the sfx and ambience buses (20 kHz = none). */
  busLowpassHz: number;
}

/**
 * Indoors: a short, small-room reverb and a touch of damping; underground:
 * the chamber reverb (sized by CaveManager) and darker. Whichever dominates.
 */
export function interiorMix(s: ShelterState, roomRadius: number, underground: number, chamberRadius: number): InteriorMix {
  const u = clamp01(underground);
  const i = clamp01(s.indoors);
  if (u > 0.01 && u >= i * 0.4) return { reverb: u, radius: chamberRadius, busLowpassHz: lerpHz(20000, 7500, u) };
  return { reverb: i * 0.32, radius: Math.max(2, Math.min(6, roomRadius)), busLowpassHz: lerpHz(20000, 11000, i) };
}

/**
 * Rain intensity: the weather is on/off (a seeded window), but rain should
 * build from a drizzle and taper off, and breathe a little while it falls.
 */
export class RainIntensity {
  value = 0;
  /** Seconds to build to full rain / to die away. */
  constructor(
    readonly riseS = 14,
    readonly fallS = 9,
  ) {}

  update(raining: boolean, dt: number, tS: number): number {
    const target = raining ? 0.8 + 0.12 * Math.sin(tS * 0.11) + 0.08 * Math.sin(tS * 0.037 + 1.3) : 0;
    const tau = raining ? this.riseS / 3 : this.fallS / 3;
    this.value += (target - this.value) * (1 - Math.exp(-Math.max(0, dt) / tau));
    if (!raining && this.value < 0.002) this.value = 0;
    return this.value;
  }
}

export interface Thunder {
  /** Sound travels ~343 m/s: the rumble arrives this long after the strike. */
  delayS: number;
  gain: number;
  /** Distance eats the crack: far thunder is a low roll. */
  lowpassHz: number;
  attackS: number;
  decayS: number;
}

/** A thunder rumble from a strike `distanceM` away. */
export function thunderFor(distanceM: number): Thunder {
  const d = Math.max(100, distanceM);
  return {
    delayS: d / 343,
    gain: Math.min(0.9, 0.9 / (1 + d / 900)),
    lowpassHz: Math.max(90, Math.min(900, 900 * Math.exp(-d / 1800))),
    attackS: Math.min(1.2, 0.08 + d / 4000),
    decayS: 3 + Math.min(4, d / 1200),
  };
}

/** First-order smoothing toward a target (time constant `tau` seconds). */
export class Smooth {
  constructor(
    public value = 0,
    readonly tau = 0.35,
  ) {}

  update(target: number, dt: number): number {
    this.value += (target - this.value) * (1 - Math.exp(-Math.max(0, dt) / this.tau));
    return this.value;
  }
}

/**
 * Bus ducking: the factor for each bus from what is going on. Voice chat
 * keeps priority (spec 10), then big stings; a hidden tab fades music,
 * ambience and effects out (voice stays).
 */
export interface DuckState {
  speaking: boolean;
  sting: boolean;
  hidden: boolean;
  /** CR 028: an instrument is playing near you (yours or another player's): the score steps back. */
  instrument?: boolean;
}

export function duckLevels(d: DuckState): { music: number; ambience: number; sfx: number } {
  if (d.hidden) return { music: 0, ambience: 0, sfx: 0 };
  return {
    music: d.speaking ? 0.35 : d.sting ? 0.5 : d.instrument ? 0.3 : 1,
    ambience: d.speaking ? 0.6 : d.sting ? 0.72 : 1,
    sfx: d.speaking ? 0.8 : 1,
  };
}
