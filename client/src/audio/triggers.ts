// The trigger map: every game moment that makes a sound, in one place.
//
//  - ZONE_EVENTS: zone Event kind (contracts/events.md) -> what plays.
//    The engine subscribes to session.eventListeners and runs these.
//  - TRIGGERS: named moments the client knows locally (prediction, input,
//    movement, UI) -> what plays. Game code calls emitSound(name, payload)
//    (bridge.ts). A new moment is one line here plus one emitSound call.
//
// Both are plain functions of (payload, api) so they unit-test without
// Web Audio (triggers.test.ts). README.md lists the triggers that nothing
// emits yet (doors, quests, tower attunement, discovery intros): they are
// defined and tested here so wiring them is one line at the call site.

import { COMBAT, type Event as ZoneEvent } from '@lodestone/contracts';
import type { Vec3 } from './bridge';
import type { CueId } from './cues';
import type { PlayOpts } from './sfx';

export interface TriggerPayload {
  at?: Vec3 | null;
  /** Character level (level_up). */
  level?: number;
  /** Levels gained at once (level_up). */
  gained?: number;
  /** Item rarity 0-7 (loot). */
  rarity?: number;
  /** Spell tree / element key (cast, impact). */
  element?: string;
  /** Weapon key (attack). */
  weapon?: string;
  /** Move kind (light, heavy, charged...) or spell type. */
  kind?: string;
  gem?: boolean;
  crit?: boolean;
  /** Landing speed (m/s) or similar magnitude. */
  speed?: number;
  /** Surface for steps: soft | hard | snow | water. */
  surface?: string;
}

export interface TriggerApi {
  play(cue: CueId, opts?: PlayOpts): void;
  selfId(): number;
  selfPos(): Vec3;
  /** Mark the player as fighting for this long (music director). */
  markCombat(seconds: number): void;
  /** Remember small bits between events (ward health). */
  mem: Record<string, number>;
}

/** Element index (combat.yaml elements; 8 = physical) -> key. */
export const ELEMENTS = COMBAT.elements as readonly string[];

const SPELL_TREE = new Map(COMBAT.spells.map((s) => [s.id, { tree: s.tree as string, type: s.type as string }]));

const CAST_CUE: Record<string, CueId> = {
  fire: 'cast_fire',
  ice: 'cast_ice',
  lightning: 'cast_lightning',
  earth: 'cast_earth',
  wind: 'cast_wind',
  light: 'cast_light',
  dark: 'cast_dark',
  void: 'cast_void',
};
const IMPACT_CUE: Record<string, CueId> = {
  fire: 'impact_fire',
  ice: 'impact_ice',
  lightning: 'impact_lightning',
  earth: 'impact_earth',
  wind: 'impact_wind',
  light: 'impact_light',
  dark: 'impact_dark',
  void: 'impact_void',
};

export function castCue(element: string | undefined): CueId {
  return CAST_CUE[element ?? ''] ?? 'cast_light';
}
export function impactCue(element: string | undefined): CueId {
  return IMPACT_CUE[element ?? ''] ?? 'hit';
}

/** Weapon move -> swing cue. */
export function swingCue(weapon: string | undefined, kind: string | undefined): CueId {
  switch (weapon) {
    case 'spear':
      return kind === 'heavy' ? 'swing_heavy' : 'thrust_spear';
    case 'bow':
      return 'bow_release';
    case 'staff':
      return kind === 'light' ? 'bolt' : 'swing_staff';
    case 'wand':
      return kind === 'light' ? 'bolt' : 'wand_flick';
    default:
      return kind === 'heavy' || kind === 'plunge' || kind === 'riposte' ? 'swing_heavy' : 'swing_sword';
  }
}

const WEAPON_BY_HUNDRED: Record<number, string> = { 1: 'sword', 2: 'spear', 3: 'bow', 4: 'staff', 5: 'wand' };

/** Loot rarity (items.yaml r) -> cue. 7 = Bitchin'. */
export function lootCue(r: number): CueId {
  if (r >= 7) return 'loot_bitchin';
  if (r >= 5) return 'loot_mythic';
  if (r >= 3) return 'loot_epic';
  if (r === 2) return 'loot_rare';
  if (r === 1) return 'loot_uncommon';
  return 'loot_common';
}

/** Level-up sting by size: Nicole's three level-up sounds. */
export function levelUpCue(level: number, gained = 1): CueId {
  if (gained >= 3 || level % 10 === 0) return 'level_up_big'; // "level up sound 3"
  if (gained >= 2 || level % 5 === 0) return 'level_up'; // "level up sound 2"
  return 'level_up_small'; // "level up sound 1"
}

const cm = (ev: ZoneEvent): Vec3 => ({ x: ev.x / 100, y: ev.y / 100, z: ev.z / 100 });
const td = new TextDecoder();

function lootEntries(data: Uint8Array): { b: string; q: number; r: number }[] {
  try {
    const j = JSON.parse(td.decode(data)) as { b?: string; q?: number; r?: number }[];
    return Array.isArray(j) ? j.map((e) => ({ b: String(e.b ?? ''), q: Number(e.q ?? 1), r: Number(e.r ?? 0) })) : [];
  } catch {
    return [];
  }
}

type EventHandler = (ev: ZoneEvent, api: TriggerApi) => void;

export const ZONE_EVENTS: Record<number, EventHandler> = {
  // WP10
  100: (_e, a) => a.play('splash'),
  // WP13 combat
  200: (e, a) => a.play(e.data[0] & 1 ? 'hit_crit' : 'hit', { at: cm(e) }),
  201: (e, a) => a.play('enemy_die', { at: cm(e) }),
  202: (e, a) => {
    if (e.entityId !== a.selfId()) return;
    a.play('player_hurt');
    a.markCombat(10);
  },
  203: (e, a) => {
    if (e.entityId === a.selfId()) a.play('player_downed');
  },
  204: (e, a) => {
    const at = cm(e);
    a.play('telegraph', { at });
    const p = a.selfPos();
    if (Math.hypot(at.x - p.x, at.z - p.z) < 18) a.markCombat(8);
  },
  205: (e, a) => a.play('enemy_shot', { at: cm(e) }),
  207: (e, a) => {
    if (e.entityId !== a.selfId()) return;
    a.play(e.value === 2 ? 'parry' : 'dodge');
    a.markCombat(8);
  },
  208: (e, a) => {
    a.play('boss_phase', { at: cm(e) });
    a.markCombat(15);
  },
  209: (_e, a) => {
    a.play('boss_engaged');
    a.markCombat(15);
  },
  210: (_e, a) => a.play('boss_defeated'),
  211: (_e, a) => a.play('camp_cleared'),
  214: (e, a) => {
    // Another player's attack or cast (within 64 m).
    const id = e.targetId & 0x7fff;
    const at = cm(e);
    const sp = SPELL_TREE.get(id);
    if (sp) a.play(sp.type === 'domain' ? 'domain' : castCue(sp.tree), { at });
    else if (id >= 100 && id < 600) a.play(swingCue(WEAPON_BY_HUNDRED[Math.floor(id / 100)], undefined), { at });
  },
  215: (_e, a) => a.play('spell_refused'),
  216: (_e, a) => a.play('skill_up'),
  217: (e, a) => {
    if (e.targetId === a.selfId()) a.play('heal');
  },
  218: (e, a) => {
    if (e.targetId === 1) a.play('drink');
  },
  219: (e, a) => {
    if (e.targetId !== 0) a.play('shield');
  },
  221: (_e, a) => a.play('respawn'),
  222: (e, a) => {
    if (e.x || e.z) a.play('hit', { at: cm(e) });
  },
  // WP14 loot
  401: (e, a) => {
    const entries = lootEntries(e.data);
    if (!entries.length) return;
    const gold = entries.every((x) => x.b.startsWith('currency:'));
    if (gold) return a.play('coins');
    a.play(lootCue(Math.max(...entries.map((x) => x.r))));
  },
  402: (e, a) => a.play('loot_bitchin', { volume: e.entityId === a.selfId() ? 1 : 0.55 }),
  403: (_e, a) => a.play('ui_error'),
  404: (_e, a) => a.play('station_open', { at: a.selfPos() }),
  405: (_e, a) => {
    a.play('forge_hammer', { at: a.selfPos() });
    a.play('craft_done');
  },
  407: (_e, a) => a.play('chest_open', { at: a.selfPos() }),
  408: (_e, a) => a.play('item_drop'),
  410: (_e, a) => a.play('loot_rare'),
  411: (_e, a) => a.play('loot_common'),
  // WP15 night, chemistry, defense
  501: (_e, a) => a.play('dusk'),
  502: (_e, a) => a.play('dawn'),
  503: (e, a) => a.play(e.value === 1 ? 'demon_burn' : 'demon_growl', { at: cm(e) }),
  504: (_e, a) => {
    a.play('demon_shrug');
    a.markCombat(8);
  },
  505: (e, a) => {
    const at = cm(e);
    a.play('demons_rise', { at });
    a.play('demon_growl', { at });
  },
  506: (_e, a) => a.play('lord_risen'),
  510: (_e, a) => a.play('ward_falter'),
  511: (_e, a) => a.play('wave_horn'),
  512: (e, a) => {
    const prev = a.mem.ward ?? e.value;
    a.mem.ward = e.value;
    if (e.value < prev) a.play('ward_hit', { at: { x: e.x / 100, y: a.selfPos().y, z: e.z / 100 } });
  },
  513: (e, a) => {
    delete a.mem.ward;
    if (e.value === 1) a.play('defense_held');
    else if (e.value === 2) a.play('defense_broken');
  },
  514: () => {},
  520: (e, a) => a.play('ignite', { at: { x: e.x / 100, y: a.selfPos().y, z: e.z / 100 } }),
  521: (e, a) => a.play('extinguish', { at: { x: e.x / 100, y: a.selfPos().y, z: e.z / 100 } }),
  522: (e, a) => a.play('freeze', { at: { x: e.x / 100, y: a.selfPos().y, z: e.z / 100 } }),
  523: (e, a) => a.play('pillar', { at: cm(e) }),
  // WP12 exploration
  600: (_e, a) => a.play('tower_attune'),
  601: (_e, a) => a.play('waypoint'),
  602: (_e, a) => a.play('discovery'),
  604: (e, a) => a.play(levelUpCue(e.value)),
  // WP09 mining: the local swing/break/pickup already sound through
  // CaveAudio (caves/caveAudio.ts -> emitSound), online and solo alike.
  // WP20 towns
  800: (_e, a) => a.play('npc_talk'),
  803: (_e, a) => a.play('quest_accept'),
  804: (_e, a) => a.play('rest'),
  805: (e, a) => a.play(e.targetId === 1 ? 'smelt' : 'station_open', { at: a.selfPos() }),
  807: (_e, a) => a.play('coins'),
};

type TriggerFn = (p: TriggerPayload, api: TriggerApi) => void;

const at = (p: TriggerPayload) => (p.at ? { at: p.at } : {});

export const TRIGGERS = {
  // Local combat (spec 8: feedback from the client's prediction, instantly)
  attack: (p, a) => {
    a.play(swingCue(p.weapon, p.kind), at(p));
    a.markCombat(6);
  },
  cast: (p, a) => {
    a.play(p.kind === 'domain' ? 'domain' : castCue(p.element), at(p));
    a.markCombat(6);
  },
  bow_draw: (_p, a) => a.play('bow_draw'),
  impact: (p, a) => {
    if (p.element) a.play(impactCue(p.element), at(p));
    else a.play(p.crit ? 'hit_crit' : p.weapon === 'bow' ? 'arrow_hit' : 'hit', at(p));
    a.markCombat(8);
  },
  dodge: (_p, a) => a.play('dash'),
  // Movement
  step: (p, a) => a.play(p.surface === 'hard' ? 'step_hard' : p.surface === 'snow' ? 'step_snow' : p.surface === 'water' ? 'swim_stroke' : 'step_soft'),
  jump: (_p, a) => a.play('jump'),
  land: (p, a) => a.play('land', { volume: Math.min(1, 0.4 + (p.speed ?? 6) / 20) }),
  splash: (_p, a) => a.play('splash'),
  swim: (_p, a) => a.play('swim_stroke'),
  glide_open: (_p, a) => a.play('glide_open'),
  climb: (_p, a) => a.play('climb_grab'),
  // Mining (CaveAudio shim)
  mine_hit: (p, a) => a.play(p.gem ? 'mine_gem' : 'mine_stone', at(p)),
  vein_break: (p, a) => a.play('vein_break', at(p)),
  pickup: (_p, a) => a.play('loot_common'),
  // UI
  ui_click: (_p, a) => a.play('ui_click'),
  ui_confirm: (_p, a) => a.play('ui_confirm'),
  map_open: (_p, a) => a.play('map_open'),
  map_close: (_p, a) => a.play('map_close'),
  panel_open: (_p, a) => a.play('ui_open'),
  panel_close: (_p, a) => a.play('ui_close'),
  whisper: (_p, a) => a.play('whisper'),
  loot: (p, a) => a.play(lootCue(p.rarity ?? 0)),
  // Not emitted by anything on main yet (README "not-yet-wired hooks"):
  level_up: (p, a) => a.play(levelUpCue(p.level ?? 2, p.gained ?? 1)),
  tower_attuned: (_p, a) => a.play('tower_attune'),
  /** The attunement build-up starts (a riser leading into tower_attuned). */
  tower_attuning: (_p, a) => a.play('tower_riser'),
  quest_accept: (_p, a) => a.play('quest_accept'),
  quest_complete: (_p, a) => a.play('quest_complete'),
  door_open: (p, a) => a.play('door_open', at(p)),
  door_close: (p, a) => a.play('door_close', at(p)),
  discovery_intro: (_p, a) => a.play('discovery'),
  chest_open: (p, a) => a.play('chest_open', at(p)),
} satisfies Record<string, TriggerFn>;

export type TriggerName = keyof typeof TRIGGERS;

/** Run a zone Event through the map (unknown kinds are silent). */
export function runZoneEvent(ev: ZoneEvent, api: TriggerApi): void {
  ZONE_EVENTS[ev.kind]?.(ev, api);
}

export function runTrigger(name: TriggerName, payload: TriggerPayload, api: TriggerApi): void {
  (TRIGGERS[name] as TriggerFn | undefined)?.(payload, api);
}
