import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { CUES, type CueId } from './cues';
import { CUE_FILES } from './cueFiles.gen';
import { assetNames } from './assets';
import { ELEMENTS, TRIGGERS, ZONE_EVENTS, castCue, impactCue, levelUpCue, lootCue, runTrigger, runZoneEvent, swingCue, type TriggerApi, type TriggerName } from './triggers';
import { loadAudioPrefs, DEFAULT_AUDIO_PREFS } from './settings';
import { sliderToGain } from './context';

function api(selfId = 7) {
  const played: { cue: CueId; at?: unknown; volume?: number }[] = [];
  let combat = 0;
  const a: TriggerApi = {
    play: (cue, o) => played.push({ cue, at: o?.at, volume: o?.volume }),
    selfId: () => selfId,
    selfPos: () => ({ x: 0, y: 10, z: 0 }),
    markCombat: (s) => {
      combat = Math.max(combat, s);
    },
    mem: {},
  };
  return { a, played, combat: () => combat };
}

const ev = (kind: number, p: Partial<ZoneEvent> = {}): ZoneEvent => ({ type: 'Event', kind, entityId: 0, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: new Uint8Array(0), ...p });
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

describe('trigger map', () => {
  it('every cue a trigger can play exists and has built files', () => {
    const names = new Set(assetNames());
    for (const [id, def] of Object.entries(CUES)) {
      expect(def.files.length, `${id} has no files (run tools/audio/build-audio.mjs)`).toBeGreaterThan(0);
      for (const f of def.files) expect(names.has(f), `${id}: ${f} missing`).toBe(true);
    }
    // and nothing built is orphaned
    for (const id of Object.keys(CUE_FILES)) expect(CUES[id as CueId], `cueFiles.gen has unknown cue ${id}`).toBeDefined();
  });

  it('music assets are all present', () => {
    const names = new Set(assetNames());
    for (const m of ['future_land_1', 'future_land_2', 'night', 'void_realm', 'time_crunch_intro', 'time_crunch_loop', 'time_crunch_final', 'combat']) expect(names.has(`music/${m}`), m).toBe(true);
  });

  it('every element has its own cast and impact', () => {
    expect(ELEMENTS).toEqual(['fire', 'ice', 'lightning', 'earth', 'wind', 'light', 'dark', 'void']);
    const casts = new Set(ELEMENTS.map(castCue));
    const impacts = new Set(ELEMENTS.map(impactCue));
    expect(casts.size).toBe(8);
    expect(impacts.size).toBe(8);
  });

  it('weapons swing differently', () => {
    expect(swingCue('sword', 'light')).toBe('swing_sword');
    expect(swingCue('sword', 'heavy')).toBe('swing_heavy');
    expect(swingCue('spear', 'light')).toBe('thrust_spear');
    expect(swingCue('bow', 'charged')).toBe('bow_release');
    expect(swingCue('staff', 'light')).toBe('bolt');
    expect(swingCue('staff', 'heavy')).toBe('swing_staff');
    expect(swingCue('wand', 'heavy')).toBe('wand_flick');
  });

  it('loot sounds by rarity, Bitchin\' has its own', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(lootCue)).toEqual(['loot_common', 'loot_uncommon', 'loot_rare', 'loot_epic', 'loot_epic', 'loot_mythic', 'loot_mythic', 'loot_bitchin']);
  });

  it("level-ups use Nicole's three stings by size", () => {
    expect(levelUpCue(2)).toBe('level_up_small');
    expect(levelUpCue(5)).toBe('level_up');
    expect(levelUpCue(3, 2)).toBe('level_up');
    expect(levelUpCue(10)).toBe('level_up_big');
    expect(levelUpCue(4, 3)).toBe('level_up_big');
  });

  it('zone events: combat', () => {
    const { a, played, combat } = api(7);
    runZoneEvent(ev(200, { x: 100, y: 200, z: 300, data: new Uint8Array([1, 50]) }), a);
    expect(played.at(-1)).toEqual({ cue: 'hit_crit', at: { x: 1, y: 2, z: 3 }, volume: undefined });
    runZoneEvent(ev(202, { entityId: 8 }), a); // someone else hurt: silent
    expect(played).toHaveLength(1);
    runZoneEvent(ev(202, { entityId: 7, value: 12 }), a);
    expect(played.at(-1)?.cue).toBe('player_hurt');
    expect(combat()).toBeGreaterThan(0);
    runZoneEvent(ev(207, { entityId: 7, value: 2 }), a);
    expect(played.at(-1)?.cue).toBe('parry');
    // remote cast: spell id 1001 (ember_flick, fire), move id 201 (spear)
    runZoneEvent(ev(214, { targetId: 1001, x: 500 }), a);
    expect(played.at(-1)).toMatchObject({ cue: 'cast_fire', at: { x: 5, y: 0, z: 0 } });
    runZoneEvent(ev(214, { targetId: 201 }), a);
    expect(played.at(-1)?.cue).toBe('thrust_spear');
  });

  it('zone events: loot, night, exploration', () => {
    const { a, played } = api(7);
    runZoneEvent(ev(401, { data: json([{ b: 'ore:iron', q: 1, r: 0 }, { b: 'sword', q: 1, r: 4 }]) }), a);
    expect(played.at(-1)?.cue).toBe('loot_epic');
    runZoneEvent(ev(401, { data: json([{ b: 'currency:gold', q: 30, r: 0 }]) }), a);
    expect(played.at(-1)?.cue).toBe('coins');
    runZoneEvent(ev(402, { entityId: 9 }), a);
    expect(played.at(-1)).toMatchObject({ cue: 'loot_bitchin', volume: 0.55 });
    runZoneEvent(ev(402, { entityId: 7 }), a);
    expect(played.at(-1)).toMatchObject({ cue: 'loot_bitchin', volume: 1 });
    for (const [k, cue] of [
      [501, 'dusk'],
      [502, 'dawn'],
      [506, 'lord_risen'],
      [510, 'ward_falter'],
      [511, 'wave_horn'],
      [600, 'tower_attune'],
      [601, 'waypoint'],
      [803, 'quest_accept'],
      [902, 'tower_attune'],
      [953, 'quest_complete'],
      [955, 'quest_accept'],
    ] as const) {
      runZoneEvent(ev(k), a);
      expect(played.at(-1)?.cue, String(k)).toBe(cue);
    }
    runZoneEvent(ev(970, { value: 1 }), a);
    expect(played.at(-1)?.cue).toBe('door_open');
    runZoneEvent(ev(970, { value: 0 }), a);
    expect(played.at(-1)?.cue).toBe('door_close');
    runZoneEvent(ev(503, { value: 1, x: 100 }), a);
    expect(played.at(-1)?.cue).toBe('demon_burn');
    runZoneEvent(ev(604, { value: 10 }), a);
    expect(played.at(-1)?.cue).toBe('level_up_big');
  });

  it('ward hits sound only when the ward loses health; the end says held or broken', () => {
    const { a, played } = api();
    runZoneEvent(ev(512, { value: 1000 }), a);
    runZoneEvent(ev(512, { value: 1000 }), a);
    expect(played).toHaveLength(0);
    runZoneEvent(ev(512, { value: 900 }), a);
    expect(played.at(-1)?.cue).toBe('ward_hit');
    runZoneEvent(ev(513, { value: 1 }), a);
    expect(played.at(-1)?.cue).toBe('defense_held');
    runZoneEvent(ev(513, { value: 2 }), a);
    expect(played.at(-1)?.cue).toBe('defense_broken');
  });

  it('unknown events are silent', () => {
    const { a, played } = api();
    runZoneEvent(ev(9999), a);
    runZoneEvent(ev(212), a); // combat_sync
    expect(played).toHaveLength(0);
  });

  it('every named trigger plays something; the not-yet-wired hooks are defined', () => {
    for (const name of Object.keys(TRIGGERS) as TriggerName[]) {
      const { a, played } = api();
      runTrigger(name, { level: 3, rarity: 2, element: 'ice', weapon: 'sword', kind: 'light', at: { x: 1, y: 2, z: 3 } }, a);
      expect(played.length, name).toBeGreaterThan(0);
      for (const p of played) expect(CUES[p.cue], `${name} -> ${p.cue}`).toBeDefined();
    }
    for (const hook of ['level_up', 'tower_attuned', 'tower_attuning', 'quest_accept', 'quest_complete', 'door_open', 'door_close', 'discovery_intro']) expect(TRIGGERS).toHaveProperty(hook);
  });

  it('local prediction triggers: attack, cast, impact', () => {
    const { a, played, combat } = api();
    runTrigger('attack', { weapon: 'spear', kind: 'light' }, a);
    runTrigger('cast', { element: 'void', kind: 'projectile' }, a);
    runTrigger('cast', { element: 'void', kind: 'domain' }, a);
    runTrigger('impact', { element: 'lightning', at: { x: 0, y: 0, z: 0 } }, a);
    runTrigger('impact', { weapon: 'bow' }, a);
    expect(played.map((p) => p.cue)).toEqual(['thrust_spear', 'cast_void', 'domain', 'impact_lightning', 'arrow_hit']);
    expect(combat()).toBeGreaterThan(0);
  });

  it('every zone event handler is keyed by a registered kind', () => {
    for (const k of Object.keys(ZONE_EVENTS).map(Number)) expect(k >= 100 && k < 1000, String(k)).toBe(true); // 100-899 WP ranges, 900-999 playtest 1 (events.md)
  });
});

describe('sound settings', () => {
  it('validates stored prefs and clamps volumes', () => {
    expect(loadAudioPrefs(null)).toEqual(DEFAULT_AUDIO_PREFS);
    expect(loadAudioPrefs('nonsense{')).toEqual(DEFAULT_AUDIO_PREFS);
    const p = loadAudioPrefs(JSON.stringify({ muted: true, volumes: { music: 2, sfx: -1, ui: 'x', voice: 0.25 } }));
    expect(p.muted).toBe(true);
    expect(p.volumes).toMatchObject({ music: 1, sfx: 0, ui: DEFAULT_AUDIO_PREFS.volumes.ui, voice: 0.25, master: DEFAULT_AUDIO_PREFS.volumes.master });
  });

  it('sliders map to a perceptual gain curve', () => {
    expect(sliderToGain(0)).toBe(0);
    expect(sliderToGain(1)).toBe(1);
    expect(sliderToGain(0.5)).toBeCloseTo(0.25);
    expect(sliderToGain(3)).toBe(1);
  });
});
