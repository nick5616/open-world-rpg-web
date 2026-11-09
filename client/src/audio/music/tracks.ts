// Which of Nicole's tracks play in which musical state (the cue sheet in
// ../README.md lists the same). Asset names are files under ../assets/.

import type { MusicState } from './director';

export interface StateMusic {
  /** Tracks of the state; several rotate (each comes back as the next). */
  tracks: string[];
  /** Linear gain trim for the state (tracks are mastered to -16 LUFS). */
  gain: number;
  /** Low-pass on the music for the state (Hz); 20000 = open. */
  lowpassHz: number;
  /** Crossfade into this state (s). */
  fadeIn: number;
  /** Short rhythmic loop: decode and loop it sample-exact instead of streaming. */
  seamless?: boolean;
}

export const STATE_MUSIC: Record<Exclude<MusicState, 'silence' | 'timed'>, StateMusic> = {
  // "future land 1" and "future land 2": the overworld by day, alternating.
  day: { tracks: ['music/future_land_1', 'music/future_land_2'], gain: 0.8, lowpassHz: 20000, fadeIn: 4 },
  // "night overworld theme" (see README: the export is silent, so night
  // plays the nocturne cut of future land 2 until Nicole re-exports it).
  night: { tracks: ['music/night'], gain: 0.85, lowpassHz: 20000, fadeIn: 5 },
  // Towns: future land, warmer and softer (rolled-off highs), so a town
  // feels like a roof over your head without leaving the theme.
  town: { tracks: ['music/future_land_2', 'music/future_land_1'], gain: 0.6, lowpassHz: 3200, fadeIn: 3 },
  // "void realm": caves and underground, a little filtered...
  cave: { tracks: ['music/void_realm'], gain: 0.75, lowpassHz: 6000, fadeIn: 3 },
  // ...and wide open for Void magic moments (domains, the void lord).
  void: { tracks: ['music/void_realm'], gain: 1, lowpassHz: 20000, fadeIn: 1.5 },
  // Fights: a synthwave combat loop cut from the Novation Analog Synthwave
  // pack (134 bpm, Bb minor), same tempo family as "time crunch".
  combat: { tracks: ['music/combat'], gain: 0.75, lowpassHz: 20000, fadeIn: 1, seamless: true },
};

/** "time crunch": intro -> loop -> "5 sec left" for timed events. */
export const TIMED_MUSIC = {
  intro: 'music/time_crunch_intro',
  loop: 'music/time_crunch_loop',
  final: 'music/time_crunch_final',
  gain: 0.9,
};

/** Crossfade before a track's end into the next one (s). */
export const END_CROSSFADE_S = 6;
