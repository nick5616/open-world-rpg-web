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
  // "future land 1", "future land 2" and (playtest 4) the "main theme": the overworld by day, rotating.
  day: { tracks: ['music/future_land_1', 'music/future_land_2', 'music/main_theme'], gain: 0.8, lowpassHz: 20000, fadeIn: 4 },
  // Playtest 4: "night theme 2 (more lively)" and the nocturne cut of future
  // land 2 (the old "night overworld theme" export was silent), alternating.
  night: { tracks: ['music/night_2', 'music/night'], gain: 0.85, lowpassHz: 20000, fadeIn: 5 },
  // The anthem ("main theme", 196 s, ends on its own fade-out): a new
  // character's arrival and the ending's credits. It is also a day track, so
  // when the arrival window closes it simply carries on as day music.
  anthem: { tracks: ['music/main_theme'], gain: 0.85, lowpassHz: 20000, fadeIn: 5 },
  // Towns: future land, warmer and softer (rolled-off highs), so a town
  // feels like a roof over your head without leaving the theme.
  town: { tracks: ['music/future_land_2', 'music/future_land_1'], gain: 0.6, lowpassHz: 3200, fadeIn: 3 },
  // Playtest 4: "crystal cave 1, 2, 3" for caves, the Underground and the
  // dwarven halls. 1 and 2 are takes of one arrangement and 3 is a sparser
  // piece, so the order is 1, 3, 2, 3 (consecutive tracks always differ).
  // These are warm and already dark: no low-pass needed, only a touch off
  // the top (the old 6 kHz roll-off was for the void realm's bright synths).
  cave: { tracks: ['music/crystal_cave_1', 'music/crystal_cave_3', 'music/crystal_cave_2', 'music/crystal_cave_3'], gain: 0.8, lowpassHz: 14000, fadeIn: 3 },
  // "void realm" stays wide open for Void magic moments (a Void domain, 6 s), the Depths and the Heartfall.
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

/** The title screen and character creation (titleMusic.ts, outside the director: the engine is not loaded yet). */
export const TITLE_MUSIC = { track: 'music/menu_theme', gain: 0.85, fadeIn: 2.5 };

/**
 * The track of a state for a rotation count, never the one that last played
 * in that state when there is another (so 1, 3, 2, 3 never repeats, and a
 * cave entered again after a fight is a different piece).
 */
export function pickTrack(tracks: readonly string[], rotation: number, last: string | null | undefined): string {
  const n = tracks.length;
  for (let k = 0; k < n; k++) {
    const t = tracks[(rotation + k) % n];
    if (n === 1 || t !== last) return t;
  }
  return tracks[rotation % n];
}

/** Crossfade before a track's end into the next one (s). */
export const END_CROSSFADE_S = 6;
