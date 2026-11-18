import { describe, expect, it } from 'vitest';
import { assetNames } from '../assets';
import { pickTrack, STATE_MUSIC, TIMED_MUSIC, TITLE_MUSIC } from './tracks';

describe('which track plays', () => {
  it('every track of every state exists as an asset', () => {
    const names = new Set(assetNames());
    for (const [state, sm] of Object.entries(STATE_MUSIC)) for (const t of sm.tracks) expect(names.has(t), `${state}: ${t}`).toBe(true);
    for (const t of [TITLE_MUSIC.track, TIMED_MUSIC.intro, TIMED_MUSIC.loop, TIMED_MUSIC.final]) expect(names.has(t), t).toBe(true);
  });

  it('caves play the crystal caves 1, 3, 2, 3; the Depths and the void keep the void realm', () => {
    expect(STATE_MUSIC.cave.tracks).toEqual(['music/crystal_cave_1', 'music/crystal_cave_3', 'music/crystal_cave_2', 'music/crystal_cave_3']);
    expect(STATE_MUSIC.void.tracks).toEqual(['music/void_realm']);
  });

  it('night rotates the new theme with the nocturne cut; day gains the main theme; the anthem is the main theme', () => {
    expect(STATE_MUSIC.night.tracks).toEqual(['music/night_2', 'music/night']);
    expect(STATE_MUSIC.day.tracks).toEqual(['music/future_land_1', 'music/future_land_2', 'music/main_theme']);
    expect(STATE_MUSIC.anthem.tracks).toEqual(['music/main_theme']);
  });

  it("a state's consecutive tracks always differ, from any rotation and any last track", () => {
    for (const [state, sm] of Object.entries(STATE_MUSIC)) {
      if (sm.tracks.length < 2) continue;
      for (let r = 0; r < 12; r++) for (const last of sm.tracks) expect(pickTrack(sm.tracks, r, last), `${state} r=${r}`).not.toBe(last);
    }
    // walking a cave visit track by track (each end bumps the rotation)
    let last: string | null = null;
    const seen: string[] = [];
    for (let r = 0; r < 8; r++) {
      last = pickTrack(STATE_MUSIC.cave.tracks, r, last);
      seen.push(last);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    expect(new Set(seen).size).toBe(3);
  });

  it('a single-track state repeats itself', () => {
    expect(pickTrack(['music/main_theme'], 3, 'music/main_theme')).toBe('music/main_theme');
  });
});
