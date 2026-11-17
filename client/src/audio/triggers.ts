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
  /** Surface for steps and landings: soft | hard | wood | snow | water (surface.ts). */
  surface?: string;
  /** CR 031: achievement tier index (0 bronze .. 3 platinum). */
  tier?: number;
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

/** Footstep surface (surface.ts StepSurface) -> cue. */
export function stepCue(surface: string | undefined): CueId {
  switch (surface) {
    case 'hard':
      return 'step_hard';
    case 'wood':
      return 'step_wood';
    case 'snow':
      return 'step_snow';
    case 'water':
      return 'step_water';
    default:
      return 'step_soft';
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

/**
 * CR 031: the achievement unlock fanfare, played when its toast shows (ui/achievements;
 * a queued card waits for the level-up and discovery cards, so its sound waits too):
 * the level-up stings by tier, the big one for gold and platinum.
 */
export function achievementCue(tier = 0): CueId {
  if (tier >= 2) return 'level_up_big';
  if (tier === 1) return 'level_up';
  return 'level_up_small';
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

/** Enemy attacks (combat.yaml ids) that toll a bell instead of the telegraph sting (playtest 2 immersion pass). */
const BELL_ATTACKS: Record<number, CueId> = Object.fromEntries(
  COMBAT.enemyAttacks.filter((x) => x.key === 'bell_toll' || x.key === 'hush_toll').map((x) => [x.id, x.key === 'hush_toll' ? 'hush_toll' : 'bell_toll']),
);

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
  // CR 038: a hard landing, catching fire in the Depths' lava.
  1700: (e, a) => {
    if (e.entityId === a.selfId()) a.play('player_hurt');
  },
  1701: (e, a) => {
    if (e.entityId === a.selfId() && e.value === 1) a.play('player_hurt');
  },
  // CR 043: a hall found, a chest opened, a tablet read, the lower halls' warden.
  1860: (e, a) => {
    if (e.entityId === a.selfId()) a.play('loot_rare');
  },
  1861: (e, a) => {
    if (e.entityId === a.selfId() && e.value > 0) a.play('chest_open', { at: a.selfPos() });
  },
  1863: (e, a) => a.play(e.value === 1 ? 'loot_epic' : 'domain', { volume: 0.7 }),
  204: (e, a) => {
    const at = cm(e);
    // Playtest 2 immersion pass: the Heartfall's bells toll on the strike (the wind-up's end), not a generic sting
    const bell = BELL_ATTACKS[e.targetId];
    if (bell) {
      a.play(bell, { at, delay: Math.max(0, e.value) / 1000 });
      a.markCombat(8);
      return;
    }
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
  // CR 020: another player's stream / charge started (the shots themselves stay silent: one cue, no per-bullet sound), a burst, an ally's attack.
  223: (e, a) => {
    const sp = SPELL_TREE.get(e.targetId);
    if (sp && e.value > 0) a.play(castCue(sp.tree), { at: cm(e), rate: e.value === 2 ? 0.7 : 1.2 });
  },
  224: (e, a) => {
    const sp = SPELL_TREE.get(e.value);
    a.play(impactCue(sp?.tree), { at: cm(e) });
  },
  225: (e, a) => {
    const sp = SPELL_TREE.get(e.value);
    a.play(castCue(sp?.tree), { at: cm(e), volume: 0.5, rate: 1.2 });
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
    const r = Math.max(...entries.map((x) => x.r));
    // A craft (source 4 in targetId) already rang the forge on 405; only an epic+ result adds its sting.
    if (e.targetId === 4 && r < 3) return;
    a.play(lootCue(r));
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
  // 602 discovery: the discovery intro (ui/intro) emits discovery_intro for
  // every intro it shows, so the event itself stays silent (no double sting).
  604: (e, a) => a.play(levelUpCue(e.value)),
  // WP09 mining: the local swing/break/pickup already sound through
  // CaveAudio (caves/caveAudio.ts -> emitSound), online and solo alike.
  // Playtest 1: tower attunement, quests, doors
  902: (_e, a) => a.play('tower_attune'),
  953: (_e, a) => a.play('quest_complete'),
  955: (_e, a) => a.play('quest_accept'),
  970: (e, a) => a.play(e.value === 1 ? 'door_open' : 'door_close', { at: cm(e) }),
  // WP20 towns
  800: (_e, a) => a.play('npc_talk'),
  803: (_e, a) => a.play('quest_accept'),
  804: (_e, a) => a.play('rest'),
  805: (e, a) => a.play(e.targetId === 1 ? 'smelt' : 'station_open', { at: a.selfPos() }),
  807: (_e, a) => a.play('coins'),
  // Playtest 2 PvP and duels (CR 019)
  990: (e, a) => a.play(e.value & 1 ? 'ui_confirm' : 'ui_close'),
  991: (_e, a) => a.play('ui_error'),
  992: (_e, a) => {
    a.play('player_hurt');
    a.markCombat(8);
  },
  993: (e, a) => {
    if (e.entityId === a.selfId()) a.play('enemy_die');
  },
  994: (_e, a) => a.play('notify'),
  995: (e, a) => {
    if (e.value === 3) {
      a.play('wave_horn');
      a.markCombat(10);
    } else if (e.value === 2) a.play('ui_confirm');
  },
  996: (e, a) => a.play(e.entityId !== 0 && e.entityId === a.selfId() ? 'quest_complete' : e.targetId !== 0 && e.targetId === a.selfId() ? 'player_downed' : 'notify'),
  // CR 021: a flight dived into the ground (dash_slam)
  230: (e, a) => {
    a.play('land', { volume: 1 });
    a.play(e.entityId === a.selfId() ? 'hit_crit' : 'hit');
    a.markCombat(6);
  },
  997: (e, a) => {
    if (e.value > 0) a.play('ui_error');
  },
  // CR 031: someone near you or in your party earned a gold / platinum achievement (your own
  // unlocks sound with their toast: TRIGGERS.achievement, emitted by ui/achievements).
  1240: (_e, a) => a.play('notify'),
  // Playtest 2 immersion pass: the main story (CR 035) had no sound at all
  1602: (_e, a) => a.play('discovery'), // an act's title card
  1603: (e, a) => {
    // the finale's phase changes: the choir tolls, the endless night falters in, the dawn
    const prev = a.mem.finalePhase ?? 0;
    a.mem.finalePhase = e.value;
    if (e.value === prev) return;
    if (e.value === 4) {
      a.play('bell_toll', { volume: 1 });
      a.play('bell_toll', { volume: 0.8, delay: 0.7, rate: 0.94 });
      a.play('bell_toll', { volume: 0.7, delay: 1.5, rate: 1.06 });
    } else if (e.value === 5) a.play('ward_falter');
    else if (e.value === 3) a.play('dawn');
  },
  1604: (e, a) => {
    // the Hush rises: its toll, then its lord's sting (the music falls silent for the entrance: director)
    a.play('hush_toll', { at: { x: e.x / 100, y: a.selfPos().y + 4, z: e.z / 100 } });
    a.play('lord_risen', { delay: 0.6 });
  },
  1605: (_e, a) => a.play('defense_held'), // the ending: the song comes back
  1610: (e, a) => {
    if (e.entityId !== a.selfId()) a.play('notify'); // a friend is down near you
  },
  1611: (e, a) => a.play('respawn', { at: cm(e) }),
  1612: (e, a) => {
    if (e.value > 0) a.play('heal', { volume: 0.6 });
  },
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
    // CR 020: a stream's shots are quieter, quicker repeats of the element's cast; a charge starts low and slow.
    if (p.kind === 'stream') a.play(castCue(p.element), { ...at(p), volume: 0.45, rate: 1.35 });
    else if (p.kind === 'charge') a.play(castCue(p.element), { ...at(p), volume: 0.7, rate: 0.7 });
    else a.play(p.kind === 'domain' ? 'domain' : castCue(p.element), at(p));
    a.markCombat(6);
  },
  bow_draw: (_p, a) => a.play('bow_draw'),
  impact: (p, a) => {
    if (p.element) a.play(impactCue(p.element), at(p));
    else a.play(p.crit ? 'hit_crit' : p.weapon === 'bow' ? 'arrow_hit' : 'hit', at(p));
    a.markCombat(8);
  },
  dodge: (_p, a) => a.play('dash'),
  // CR 021: a held dash's whoosh every few hundred ms (the element's cast under the dash cue)
  dash_sustain: (p, a) => {
    a.play('dash', { volume: 0.55 });
    a.play(castCue(p.element), { volume: 0.35 });
  },
  // Movement
  step: (p, a) => a.play(stepCue(p.surface)),
  // playtest 2 immersion pass: a trot is two beats, a gallop three, a walk one
  hoof: (p, a) => {
    const cue: CueId = p.surface === 'hard' || p.surface === 'wood' ? 'hoof_hard' : 'hoof_soft';
    const beats = p.kind === 'gallop' ? [0, 0.075, 0.16] : p.kind === 'trot' ? [0, 0.12] : [0];
    beats.forEach((d, i) => a.play(cue, { delay: d, volume: 1 - i * 0.18 }));
  },
  fish_cast: (_p, a) => a.play('fish_cast'),
  fish_plop: (p, a) => a.play('fish_plop', at(p)),
  fish_nibble: (p, a) => a.play('fish_plop', { ...at(p), volume: 0.45 }),
  fish_bite: (p, a) => a.play('fish_bite', at(p)),
  fish_hooked: (p, a) => a.play('splash', { ...at(p), volume: 0.7 }),
  fish_caught: (p, a) => {
    a.play('splash', { volume: 0.8 });
    a.play(lootCue(p.rarity ?? 0), { delay: 0.25 });
  },
  fish_lost: (p, a) => a.play('fish_plop', { ...at(p), volume: 0.7 }),
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
  // Playtest 2: the duel's 3-2-1 (client/src/ui/pvp)
  duel_count: (_p, a) => a.play('telegraph'),
  // CR 031: an achievement toast appears (ui/achievements/AchievementsHud.tsx)
  achievement: (p, a) => a.play(achievementCue(p.tier ?? 0)),
} satisfies Record<string, TriggerFn>;

export type TriggerName = keyof typeof TRIGGERS;

/** Run a zone Event through the map (unknown kinds are silent). */
export function runZoneEvent(ev: ZoneEvent, api: TriggerApi): void {
  ZONE_EVENTS[ev.kind]?.(ev, api);
}

export function runTrigger(name: TriggerName, payload: TriggerPayload, api: TriggerApi): void {
  (TRIGGERS[name] as TriggerFn | undefined)?.(payload, api);
}
