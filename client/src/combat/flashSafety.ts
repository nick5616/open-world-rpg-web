// Photosensitivity rules for combat feedback (playtest 2 "calm kills").
//
// Nicole: "when the enemies die, it causes a horrible flashing that is
// overstimulating for my friend. whenever i kill an enemy". The audit
// (tools/playtest/flash-audit.mjs, docs/STATUS.md "Playtest 2: calm kills")
// found the strobe in the hit feedback, not in one place: every hit turned the
// whole enemy body white for 130 ms (re-triggered by every hit, so a wand,
// a stream or a pack strobed at 4-15 Hz), each hit ALSO popped one to three
// HDR flash sprites (the projectile's impact, the weapon / spell hit burst and,
// for a second player, the Event 200 burst: the same spot, the same frame)
// and a point light that came on at full strength in one frame; the death
// break-up drew a 2.5x HDR edge through the bloom, death motes glowed at 2.2x,
// a brand burst (CR 020) chained explosions through a pack, and the enemy
// wind-up tell flickered at 3.2 Hz.
//
// The rules (WCAG 2.3.1: no more than three flashes in any one second; a
// flash is a pair of opposing changes of >= 10 % relative luminance):
//
//   - an enemy hit is a soft tint of the body's own colour (plus a little
//     warm rim), capped, eased in and out; a new pulse at most every
//     `hitMinIntervalMs` per enemy, and hits in between HOLD the tint
//     instead of re-flashing it (a stream reads as a steady glow, not a strobe)
//   - FX flash sprites and light pulses go through one spatial gate: at most
//     one per ~2.5 m cell per `fxMinIntervalMs` (the duplicates of one hit
//     merge), they ease in over part of their life (no one-frame pop), they
//     are dimmer and, calm, stay under the bloom threshold
//   - deaths fade: no hot edge on the break-up, dim motes
//   - nothing pulses faster than ~2 Hz (the wind-up tell, a summon running out)
//
// `reduceFlashing` (stores/accessibility.ts, ON by default) picks CALM; OFF
// picks PUNCHY, which is still inside the WCAG limit. `prefers-reduced-motion`
// always picks CALM (and turns shake off: fx/screen.ts).

import { useAccessibility } from '../stores/accessibility';

export interface FlashProfile {
  name: 'calm' | 'punchy';
  /** Enemy hit tint: peak strength (emissive = body colour x peak + a little warm rim). */
  hitPeak: number;
  hitRiseMs: number;
  /** Held at the current level this long after the latest hit, then it fades over hitDecayMs. */
  hitHoldMs: number;
  hitDecayMs: number;
  /** A new pulse (a rise) at most this often per enemy; hits in between only hold the tint. */
  hitMinIntervalMs: number;
  /** FX flash sprites: opacity multiplier, the share of their life spent easing in, a floor on their life. */
  fxFlashOpacity: number;
  fxFlashRise: number;
  fxFlashMinS: number;
  /** Flash colours are clamped to this per channel (bloom threshold 1.25: < 1 never blooms). */
  fxFlashMaxChannel: number;
  /** At most one flash sprite / light pulse per FLASH_CELL_M cell per this many ms. */
  fxMinIntervalMs: number;
  /** Light pulses: intensity multiplier and the share of their life spent ramping up. */
  lightGain: number;
  lightRise: number;
  /** Spell HDR (bright cores) is capped at this (FX tier ultra = 2.2). */
  hdrMax: number;
  /** Death break-up edge (emissive x the tell colour; 0 = none) and death mote glow (0..1 of the body glow). */
  deathEdge: number;
  debrisGlow: number;
  /** Death debris count multiplier. */
  debrisCount: number;
  /** Camera shake multiplier. */
  shake: number;
  /** How white-hot a fresh additive particle starts (1 = the FX engine's original). */
  particleHot: number;
  /** A weapon swing's arc in the world: particle density and glow (1 = original). */
  swingTrail: number;
  /** Lightning crackles a second on a shocked body (it was 16). */
  shockRate: number;
  /** The enemy wind-up tell's pulse (Hz) and its depth (0..1). */
  tellHz: number;
  tellDepth: number;
  /** A summoned ally running out: its fade pulse (Hz). */
  allyFadeHz: number;
}

export const CALM: FlashProfile = {
  name: 'calm',
  hitPeak: 0.28,
  hitRiseMs: 70,
  hitHoldMs: 90,
  hitDecayMs: 320,
  hitMinIntervalMs: 480,
  fxFlashOpacity: 0.32,
  fxFlashRise: 0.4,
  fxFlashMinS: 0.24,
  fxFlashMaxChannel: 0.9,
  fxMinIntervalMs: 480,
  lightGain: 0.4,
  lightRise: 0.35,
  hdrMax: 1.35,
  deathEdge: 0,
  debrisGlow: 0.2,
  debrisCount: 0.6,
  shake: 0.5,
  particleHot: 0.3,
  swingTrail: 0.35,
  shockRate: 2,
  tellHz: 1.2,
  tellDepth: 0.25,
  allyFadeHz: 0.8,
};

export const PUNCHY: FlashProfile = {
  name: 'punchy',
  hitPeak: 0.5,
  hitRiseMs: 40,
  hitHoldMs: 70,
  hitDecayMs: 220,
  hitMinIntervalMs: 340,
  fxFlashOpacity: 0.6,
  fxFlashRise: 0.2,
  fxFlashMinS: 0.16,
  fxFlashMaxChannel: 1.6,
  fxMinIntervalMs: 340,
  lightGain: 0.75,
  lightRise: 0.2,
  hdrMax: 2.2,
  deathEdge: 0.6,
  debrisGlow: 0.45,
  debrisCount: 1,
  shake: 1,
  particleHot: 0.8,
  swingTrail: 0.8,
  shockRate: 3,
  tellHz: 2,
  tellDepth: 0.4,
  allyFadeHz: 1.3,
};

/** Size of the spatial gate's cells (m). */
export const FLASH_CELL_M = 2.5;

let reducedMotionQuery: MediaQueryList | null | undefined;
/** prefers-reduced-motion: reduce (cached; the media query object tracks changes). */
export function prefersReducedMotion(): boolean {
  if (reducedMotionQuery === undefined) {
    try {
      reducedMotionQuery = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch {
      reducedMotionQuery = null;
    }
  }
  return !!reducedMotionQuery?.matches;
}

/** Which rules run (pure). */
export function pickProfile(reduceFlashing: boolean, reducedMotion: boolean): FlashProfile {
  return reduceFlashing || reducedMotion ? CALM : PUNCHY;
}

/** The rules right now (cheap: read per hit and per frame). */
export function flashProfile(): FlashProfile {
  return pickProfile(useAccessibility.getState().reduceFlashing, prefersReducedMotion());
}

/**
 * One enemy's hit tint: rises to the peak on a pulse, holds while hits keep
 * coming, fades after. A pulse at most every hitMinIntervalMs; a hit inside
 * that interval holds the level where it is (no dip-and-rise = no flash).
 */
export class HitTint {
  level = 0;
  private pulseAt = -1e12;
  private riseUntil = -1e12;
  private holdUntil = -1e12;
  /** Pulses started (tests, the probe). */
  pulses = 0;

  hit(nowMs: number, p: FlashProfile): void {
    if (nowMs - this.pulseAt >= p.hitMinIntervalMs) {
      this.pulseAt = nowMs;
      this.riseUntil = nowMs + p.hitRiseMs;
      this.pulses++;
    }
    this.holdUntil = Math.max(this.holdUntil, Math.max(this.riseUntil, nowMs) + p.hitHoldMs);
  }

  /** Advance to nowMs (dt in ms); returns the tint strength 0..peak. */
  update(nowMs: number, dtMs: number, p: FlashProfile): number {
    const peak = p.hitPeak;
    if (nowMs < this.riseUntil) {
      const left = Math.max(1, this.riseUntil - nowMs);
      this.level += (peak - this.level) * Math.min(1, dtMs / left);
    } else if (nowMs < this.holdUntil) {
      // hold (a hit inside the interval: no rise)
      if (this.level > peak) this.level = peak;
    } else this.level = Math.max(0, this.level - (peak * dtMs) / Math.max(1, p.hitDecayMs));
    return this.level;
  }

  reset(): void {
    this.level = 0;
    this.pulseAt = this.riseUntil = this.holdUntil = -1e12;
  }
}

/**
 * The spatial gate for flash sprites and light pulses: at most one per
 * FLASH_CELL_M cell per fxMinIntervalMs. Duplicates of one hit (the shot's
 * impact, the hit burst, an observer's Event 200 burst) land in the same cell
 * within milliseconds and merge. Small fixed table (no allocation per call).
 */
export class FlashGate {
  private keys = new Float64Array(64);
  private times = new Float64Array(64).fill(-1e12);
  private next = 0;

  allow(x: number, z: number, nowMs: number, p: FlashProfile): boolean {
    const cx = Math.floor(x / FLASH_CELL_M);
    const cz = Math.floor(z / FLASH_CELL_M);
    let hit = -1;
    // the cell and its 8 neighbours (a flash on a cell border still merges)
    for (let i = 0; i < this.keys.length; i++) {
      if (nowMs - this.times[i] >= p.fxMinIntervalMs) continue;
      const k = this.keys[i];
      const kx = Math.floor(k / 1e6) - 500000;
      const kz = (k % 1e6) - 500000;
      if (Math.abs(kx - cx) <= 1 && Math.abs(kz - cz) <= 1) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) return false;
    const i = this.next;
    this.next = (this.next + 1) % this.keys.length;
    this.keys[i] = (cx + 500000) * 1e6 + (cz + 500000);
    this.times[i] = nowMs;
    return true;
  }

  reset(): void {
    this.times.fill(-1e12);
  }
}

/** A flash sprite's opacity over its life k in 0..1: eases in over `rise`, then fades (never a one-frame pop). */
export function flashEnvelope(k: number, rise: number): number {
  if (k <= 0 || k >= 1) return 0;
  if (rise > 0 && k < rise) {
    const u = k / rise;
    return u * u * (3 - 2 * u);
  }
  const u = rise > 0 ? (k - rise) / (1 - rise) : k;
  return (1 - u) * (1 - u);
}

/** A light pulse's intensity share over its life: ramps up over `rise`, then falls off. */
export function lightEnvelope(k: number, rise: number): number {
  return flashEnvelope(k, rise);
}

// Headless audits (tools/playtest/flash-audit.mjs): the live profile and the toggle. On window
// because a bare import('/src/...') after a hot update can load a second, idle copy of a module.
if (typeof window !== 'undefined') {
  (window as unknown as { __lodestoneFlash?: unknown }).__lodestoneFlash = {
    profile: flashProfile,
    setReduceFlashing: (v: boolean) => useAccessibility.getState().setReduceFlashing(v),
  };
}
