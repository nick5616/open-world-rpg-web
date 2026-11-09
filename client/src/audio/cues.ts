// Every sound effect cue: which processed files it picks from (variants are
// chosen at random), which bus it plays on and how. The files come from
// tools/audio/build-audio.mjs (cueFiles.gen.ts lists what was built); the
// cue sheet with sources and where each cue plays is ../audio/README.md.

import { CUE_FILES } from './cueFiles.gen';

export type Bus = 'sfx' | 'ui' | 'ambience';

export interface CueDef {
  files: string[];
  bus: Bus;
  /** Linear gain (files are normalized; this is the mix). */
  volume?: number;
  /** +/- random playback-rate fraction per play. */
  pitch?: number;
  /** Placed in the world when the caller gives a position. */
  spatial?: boolean;
  refDistance?: number;
  maxDistance?: number;
  rolloff?: number;
  /** Simultaneous voices of this cue (oldest stolen). */
  maxVoices?: number;
  /** Repeats closer than this collapse into one. */
  cooldownMs?: number;
  /** Cave reverb send (default 1 for world sounds, 0 for UI). */
  reverb?: number;
  /** Higher survives voice stealing. */
  priority?: number;
  /** Duck the music under this one (big stings). */
  duckMusic?: boolean;
}

type Opts = Omit<CueDef, 'files' | 'bus'>;

function files(id: string): string[] {
  return CUE_FILES[id] ?? [];
}

const ui = (id: string, o: Opts = {}): CueDef => ({ files: files(id), bus: 'ui', volume: 0.7, maxVoices: 3, cooldownMs: 40, reverb: 0, priority: 3, ...o });
const sfx = (id: string, o: Opts = {}): CueDef => ({ files: files(id), bus: 'sfx', maxVoices: 4, priority: 2, ...o });
const world = (id: string, o: Opts = {}): CueDef => sfx(id, { spatial: true, refDistance: 3, maxDistance: 45, ...o });
const sting = (id: string, o: Opts = {}): CueDef => ({ files: files(id), bus: 'sfx', maxVoices: 1, priority: 5, reverb: 0.3, duckMusic: true, ...o });

export const CUES = {
  // UI
  ui_click: ui('ui_click', { volume: 0.5, pitch: 0.04 }),
  ui_confirm: ui('ui_confirm'),
  ui_open: ui('ui_open', { volume: 0.55 }),
  ui_close: ui('ui_close', { volume: 0.5 }),
  ui_error: ui('ui_error', { volume: 0.55, cooldownMs: 250 }),
  map_open: ui('map_open', { volume: 0.6 }),
  map_close: ui('map_close', { volume: 0.55 }),
  notify: ui('notify', { volume: 0.5, cooldownMs: 150 }),
  whisper: ui('whisper', { volume: 0.45, cooldownMs: 400 }),
  quest_accept: ui('quest_accept', { volume: 0.75 }),
  quest_complete: sting('quest_complete', { volume: 0.8 }),

  // Movement (local player; remote players' steps are not voiced, by design: crowds)
  step_soft: sfx('step_soft', { volume: 0.32, pitch: 0.08, maxVoices: 2, priority: 1 }),
  step_hard: sfx('step_hard', { volume: 0.32, pitch: 0.08, maxVoices: 2, priority: 1 }),
  step_snow: sfx('step_snow', { volume: 0.3, pitch: 0.08, maxVoices: 2, priority: 1 }),
  jump: sfx('jump', { volume: 0.35, pitch: 0.06, maxVoices: 1 }),
  land: sfx('land', { volume: 0.5, pitch: 0.06, maxVoices: 1, cooldownMs: 150 }),
  dash: sfx('dash', { volume: 0.55, pitch: 0.05, maxVoices: 2 }),
  splash: sfx('splash', { volume: 0.6, pitch: 0.06, maxVoices: 2, cooldownMs: 300 }),
  swim_stroke: sfx('swim_stroke', { volume: 0.35, pitch: 0.1, maxVoices: 2, cooldownMs: 300 }),
  glide_open: sfx('glide_open', { volume: 0.5, maxVoices: 1, cooldownMs: 500 }),
  climb_grab: sfx('climb_grab', { volume: 0.35, pitch: 0.1, maxVoices: 2, cooldownMs: 180 }),

  // Weapons (local: instant from prediction, spec 8; remote: Event 214, spatial)
  swing_sword: world('swing_sword', { volume: 0.6, pitch: 0.07, maxVoices: 4, maxDistance: 30 }),
  swing_heavy: world('swing_heavy', { volume: 0.7, pitch: 0.05, maxVoices: 3, maxDistance: 30 }),
  thrust_spear: world('thrust_spear', { volume: 0.6, pitch: 0.07, maxVoices: 4, maxDistance: 30 }),
  swing_staff: world('swing_staff', { volume: 0.5, pitch: 0.07, maxVoices: 3, maxDistance: 30 }),
  wand_flick: world('wand_flick', { volume: 0.5, pitch: 0.08, maxVoices: 3, maxDistance: 30 }),
  bow_draw: sfx('bow_draw', { volume: 0.5, maxVoices: 1 }),
  bow_release: world('bow_release', { volume: 0.65, pitch: 0.05, maxVoices: 3, maxDistance: 35 }),
  bolt: world('bolt', { volume: 0.45, pitch: 0.08, maxVoices: 3, maxDistance: 35 }),
  hit: world('hit', { volume: 0.75, pitch: 0.08, maxVoices: 5, cooldownMs: 25, priority: 3 }),
  hit_crit: world('hit_crit', { volume: 0.85, pitch: 0.05, maxVoices: 2, priority: 3 }),
  hit_resist: world('hit_resist', { volume: 0.6, pitch: 0.06, maxVoices: 2 }),
  arrow_hit: world('arrow_hit', { volume: 0.6, pitch: 0.08, maxVoices: 4 }),
  parry: sfx('parry', { volume: 0.8, pitch: 0.04, maxVoices: 1, priority: 4 }),
  dodge: sfx('dodge', { volume: 0.5, pitch: 0.05, maxVoices: 1 }),

  // Spells per element: cast and impact
  cast_fire: world('cast_fire', { volume: 0.65, pitch: 0.05, maxVoices: 3 }),
  cast_ice: world('cast_ice', { volume: 0.6, pitch: 0.05, maxVoices: 3 }),
  cast_lightning: world('cast_lightning', { volume: 0.6, pitch: 0.05, maxVoices: 3 }),
  cast_earth: world('cast_earth', { volume: 0.7, pitch: 0.05, maxVoices: 3 }),
  cast_wind: world('cast_wind', { volume: 0.6, pitch: 0.05, maxVoices: 3 }),
  cast_light: world('cast_light', { volume: 0.6, pitch: 0.04, maxVoices: 3 }),
  cast_dark: world('cast_dark', { volume: 0.65, pitch: 0.05, maxVoices: 3 }),
  cast_void: world('cast_void', { volume: 0.65, pitch: 0.04, maxVoices: 3 }),
  impact_fire: world('impact_fire', { volume: 0.7, pitch: 0.06, maxVoices: 3 }),
  impact_ice: world('impact_ice', { volume: 0.65, pitch: 0.06, maxVoices: 3 }),
  impact_lightning: world('impact_lightning', { volume: 0.6, pitch: 0.06, maxVoices: 3 }),
  impact_earth: world('impact_earth', { volume: 0.75, pitch: 0.06, maxVoices: 3 }),
  impact_wind: world('impact_wind', { volume: 0.55, pitch: 0.06, maxVoices: 3 }),
  impact_light: world('impact_light', { volume: 0.6, pitch: 0.05, maxVoices: 3 }),
  impact_dark: world('impact_dark', { volume: 0.65, pitch: 0.06, maxVoices: 3 }),
  impact_void: world('impact_void', { volume: 0.7, pitch: 0.05, maxVoices: 3 }),
  domain: world('domain', { volume: 0.8, maxVoices: 1, maxDistance: 80, priority: 4, duckMusic: true }),
  spell_refused: ui('spell_refused', { volume: 0.4, cooldownMs: 300 }),

  // Hurt, death, healing
  player_hurt: sfx('player_hurt', { volume: 0.7, pitch: 0.06, maxVoices: 2, cooldownMs: 120, priority: 4 }),
  player_downed: sting('player_downed', { volume: 0.85 }),
  respawn: sting('respawn', { volume: 0.6, duckMusic: false }),
  enemy_die: world('enemy_die', { volume: 0.6, pitch: 0.08, maxVoices: 3 }),
  heal: sfx('heal', { volume: 0.5, maxVoices: 1, cooldownMs: 300 }),
  shield: sfx('shield', { volume: 0.55, maxVoices: 1, cooldownMs: 200 }),
  drink: sfx('drink', { volume: 0.55, maxVoices: 1 }),

  // Enemies and demons (vocal-ish stingers)
  telegraph: world('telegraph', { volume: 0.45, pitch: 0.05, maxVoices: 3, cooldownMs: 120, priority: 3 }),
  enemy_shot: world('enemy_shot', { volume: 0.5, pitch: 0.07, maxVoices: 3 }),
  beast_growl: world('beast_growl', { volume: 0.55, pitch: 0.1, maxVoices: 2, cooldownMs: 1500 }),
  demon_growl: world('demon_growl', { volume: 0.6, pitch: 0.1, maxVoices: 2, cooldownMs: 1200, maxDistance: 60 }),
  demons_rise: world('demons_rise', { volume: 0.8, maxVoices: 2, maxDistance: 120, refDistance: 10, priority: 4 }),
  demon_shrug: world('demon_shrug', { volume: 0.55, pitch: 0.05, maxVoices: 2, cooldownMs: 200 }),
  demon_burn: world('demon_burn', { volume: 0.6, pitch: 0.1, maxVoices: 4, maxDistance: 90, refDistance: 6 }),
  lord_risen: sting('lord_risen', { volume: 0.9 }),
  boss_engaged: sting('boss_engaged', { volume: 0.85 }),
  boss_phase: world('boss_phase', { volume: 0.9, maxVoices: 1, maxDistance: 120, refDistance: 10, priority: 5, duckMusic: true }),
  boss_defeated: sting('boss_defeated', { volume: 0.9 }),

  // Mining
  mine_stone: world('mine_stone', { volume: 0.6, pitch: 0.07, maxVoices: 3, maxDistance: 30 }),
  mine_gem: world('mine_gem', { volume: 0.55, pitch: 0.05, maxVoices: 3, maxDistance: 30 }),
  vein_break: world('vein_break', { volume: 0.8, pitch: 0.05, maxVoices: 2, maxDistance: 40 }),

  // Loot by rarity (items.yaml r 0..7)
  loot_common: ui('loot_common', { volume: 0.5, cooldownMs: 80 }),
  loot_uncommon: ui('loot_uncommon', { volume: 0.55, cooldownMs: 80 }),
  loot_rare: ui('loot_rare', { volume: 0.6, cooldownMs: 80 }),
  loot_epic: sting('loot_epic', { volume: 0.7, duckMusic: false }),
  loot_mythic: sting('loot_mythic', { volume: 0.8 }),
  loot_bitchin: sting('loot_bitchin', { volume: 1 }),
  coins: ui('coins', { volume: 0.5, cooldownMs: 120 }),
  chest_open: world('chest_open', { volume: 0.7, maxVoices: 2 }),
  item_drop: ui('item_drop', { volume: 0.45 }),

  // Crafting and towns
  forge_hammer: world('forge_hammer', { volume: 0.7, pitch: 0.04, maxVoices: 2 }),
  smelt: world('smelt', { volume: 0.6, maxVoices: 1 }),
  craft_done: ui('craft_done', { volume: 0.6 }),
  station_open: world('station_open', { volume: 0.55, maxVoices: 1 }),
  npc_talk: ui('npc_talk', { volume: 0.4, pitch: 0.1, cooldownMs: 200 }),
  door_open: world('door_open', { volume: 0.6, pitch: 0.05, maxVoices: 2, maxDistance: 25 }),
  door_close: world('door_close', { volume: 0.6, pitch: 0.05, maxVoices: 2, maxDistance: 25 }),
  rest: sting('rest', { volume: 0.6, duckMusic: false }),

  // Night, fire, chemistry, wards
  dusk: sting('dusk', { volume: 0.6 }),
  dawn: sting('dawn', { volume: 0.7 }),
  ignite: world('ignite', { volume: 0.7, pitch: 0.06, maxVoices: 3, maxDistance: 60 }),
  extinguish: world('extinguish', { volume: 0.55, pitch: 0.06, maxVoices: 2, maxDistance: 50 }),
  freeze: world('freeze', { volume: 0.6, pitch: 0.06, maxVoices: 2, maxDistance: 50 }),
  pillar: world('pillar', { volume: 0.8, pitch: 0.05, maxVoices: 2, maxDistance: 60 }),
  ward_falter: sting('ward_falter', { volume: 0.85 }),
  ward_hit: world('ward_hit', { volume: 0.5, pitch: 0.08, maxVoices: 2, cooldownMs: 500, maxDistance: 120, refDistance: 15 }),
  wave_horn: sting('wave_horn', { volume: 0.85, duckMusic: false }),
  defense_held: sting('defense_held', { volume: 0.9 }),
  defense_broken: sting('defense_broken', { volume: 0.85 }),

  // Exploration and progression
  discovery: sting('discovery', { volume: 0.75 }),
  tower_riser: sting('tower_riser', { volume: 0.8 }),
  tower_attune: sting('tower_attune', { volume: 0.9 }),
  waypoint: sting('waypoint', { volume: 0.7, duckMusic: false }),
  level_up_small: sting('level_up_small', { volume: 0.8 }),
  level_up: sting('level_up', { volume: 0.85 }),
  level_up_big: sting('level_up_big', { volume: 0.9 }),
  skill_up: ui('skill_up', { volume: 0.55 }),
  camp_cleared: sting('camp_cleared', { volume: 0.7 }),
} satisfies Record<string, CueDef>;

export type CueId = keyof typeof CUES;
