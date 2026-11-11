import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { CUES, type CueId } from './cues';
import { CUE_FILES } from './cueFiles.gen';
import { assetNames } from './assets';
import { ELEMENTS, TRIGGERS, ZONE_EVENTS, achievementCue, castCue, impactCue, levelUpCue, lootCue, runTrigger, runZoneEvent, stepCue, swingCue, type TriggerApi, type TriggerName } from './triggers';
import { loadAudioPrefs, DEFAULT_AUDIO_PREFS } from './settings';
import { sliderToGain } from './context';
import { BELLS, BELL_PARTIALS, partialDecay, partialLevel, synthName } from './bells';
import { COMBAT } from '@lodestone/contracts';

function api(selfId = 7) {
  const played: { cue: CueId; at?: unknown; volume?: number; delay?: number }[] = [];
  let combat = 0;
  const a: TriggerApi = {
    play: (cue, o) => played.push({ cue, at: o?.at, volume: o?.volume, delay: o?.delay }),
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
      // synth:<bell> files are rendered at run time (bells.ts), not built
      for (const f of def.files) expect(names.has(f) || !!BELLS[synthName(f) ?? ''], `${id}: ${f} missing`).toBe(true);
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

  it('footsteps by surface', () => {
    expect(['soft', 'hard', 'wood', 'snow', 'water', undefined].map(stepCue)).toEqual(['step_soft', 'step_hard', 'step_wood', 'step_snow', 'step_water', 'step_soft']);
    const { a, played } = api();
    runTrigger('step', { surface: 'wood' }, a);
    expect(played[0].cue).toBe('step_wood');
    // wooden steps reuse the stone knocks, lower
    expect(CUES.step_wood.files).toEqual(CUES.step_hard.files);
    expect(CUES.step_wood.rate).toBeLessThan(1);
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

  it('achievement unlocks (CR 031) use the level-up stings by tier, and gold+ unlocks of others a soft notify', () => {
    expect([0, 1, 2, 3].map((t) => achievementCue(t))).toEqual(['level_up_small', 'level_up', 'level_up_big', 'level_up_big']);
    const { a, played } = api();
    runTrigger('achievement', { tier: 2 }, a);
    runZoneEvent({ type: 'Event', kind: 1240, entityId: 9, targetId: 1, value: 2, x: 0, y: 0, z: 0, data: new Uint8Array() }, a);
    expect(played.map((p) => p.cue)).toEqual(['level_up_big', 'notify']);
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
    const n = played.length;
    runZoneEvent(ev(401, { targetId: 4, data: json([{ b: 'sword', q: 1, r: 1 }]) }), a); // common craft: forge sound only
    expect(played).toHaveLength(n);
    runZoneEvent(ev(401, { targetId: 4, data: json([{ b: 'sword', q: 1, r: 4 }]) }), a);
    expect(played.at(-1)?.cue).toBe('loot_epic');
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
    for (const hook of ['achievement', 'level_up', 'tower_attuned', 'tower_attuning', 'quest_accept', 'quest_complete', 'door_open', 'door_close', 'discovery_intro']) expect(TRIGGERS).toHaveProperty(hook);
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
    for (const k of Object.keys(ZONE_EVENTS).map(Number)) expect((k >= 100 && k < 1300) || (k >= 1600 && k < 1630), String(k)).toBe(true); // 100-899 WP ranges, 900-999 playtest 1, 1000-1299 playtest 2, 1600-1629 the main story (events.md)
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

describe('the main story and the Heartfall (playtest 2 immersion pass)', () => {
  const attack = (key: string) => COMBAT.enemyAttacks.find((x) => x.key === key)!;

  it('a Hollow Bell and the Hush toll a bell on the strike, other wind-ups keep the sting', () => {
    const { a, played } = api();
    runZoneEvent(ev(204, { targetId: attack('bell_toll').id, value: 600, x: 300, z: 400 }), a);
    expect(played[0]).toMatchObject({ cue: 'bell_toll', at: { x: 3, z: 4 }, delay: 0.6 });
    runZoneEvent(ev(204, { targetId: attack('hush_toll').id, value: 600 }), a);
    expect(played[1].cue).toBe('hush_toll');
    runZoneEvent(ev(204, { targetId: attack('hush_rend').id, value: 550 }), a);
    expect(played[2].cue).toBe('telegraph');
  });

  it('acts, the entrance, the choir, the endless night, the dawn and the ending are heard', () => {
    const { a, played } = api();
    runZoneEvent(ev(1602, { value: 3 }), a);
    runZoneEvent(ev(1604, { value: 7000 }), a);
    runZoneEvent(ev(1603, { value: 2 }), a);
    runZoneEvent(ev(1603, { value: 2 }), a); // a repeat (countdown refresh) is silent
    runZoneEvent(ev(1603, { value: 4 }), a);
    runZoneEvent(ev(1603, { value: 5 }), a);
    runZoneEvent(ev(1603, { value: 3 }), a);
    runZoneEvent(ev(1605, { value: 2 }), a);
    const cues = played.map((p) => p.cue);
    expect(cues).toEqual(['discovery', 'hush_toll', 'lord_risen', 'bell_toll', 'bell_toll', 'bell_toll', 'ward_falter', 'dawn', 'defense_held']);
  });

  it('revives: a friend down, raised, the hold', () => {
    const { a, played } = api(7);
    runZoneEvent(ev(1610, { entityId: 7 }), a); // you are the one down: no ping
    runZoneEvent(ev(1610, { entityId: 9 }), a);
    runZoneEvent(ev(1612, { value: 3000 }), a);
    runZoneEvent(ev(1612, { value: 0 }), a);
    runZoneEvent(ev(1611, { entityId: 9, x: 100, z: 100 }), a);
    expect(played.map((p) => p.cue)).toEqual(['notify', 'heal', 'respawn']);
  });

  it('a bell: the hum rings longest, high partials die first, the tierce is a minor third', () => {
    expect(BELL_PARTIALS.find((p) => p[0] === 1.19)).toBeDefined();
    const s = BELLS.hollow_bell;
    expect(partialDecay(s, 0.5, 7.5)).toBeGreaterThan(partialDecay(s, 2, 2.6));
    expect(partialDecay(BELLS.hush_toll, 1, 5)).toBeGreaterThan(partialDecay(s, 1, 5)); // the Hush's bell is bigger
    expect(partialLevel(1, 2, 0)).toBe(0);
    expect(partialLevel(1, 2, 0.004)).toBeCloseTo(Math.exp(-0.002), 5);
    expect(partialLevel(1, 2, 4)).toBeLessThan(0.2);
    expect(synthName('synth:hollow_bell')).toBe('hollow_bell');
    expect(synthName('hit_1')).toBeNull();
  });
});
