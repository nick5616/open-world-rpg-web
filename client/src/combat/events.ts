// WP13 Event kinds (contracts/events.md 200-399), the Interact verbs and
// payload decoders. Mirrors server/zone/internal/combat/events.go.

import { COMBAT, type Event as ZoneEvent } from '@lodestone/contracts';

export const EV = {
  damage: 200,
  enemyDied: 201,
  playerHurt: 202,
  playerDowned: 203,
  telegraph: 204,
  projectile: 205,
  status: 206,
  evaded: 207,
  bossPhase: 208,
  bossEngaged: 209,
  bossDefeated: 210,
  campCleared: 211,
  combatSync: 212,
  mana: 213,
  cast: 214,
  refused: 215,
  skillUp: 216,
  heal: 217,
  consumable: 218,
  shield: 219,
  bossReset: 220,
  respawned: 221,
  strikeHit: 222,
  // CR 020 spell mechanics
  channel: 223,
  detonate: 224,
  summonAttack: 225,
} as const;

export const INTERACT_COMBAT = 50;
export const ACT = { swapLoadout: 1, equipWeapon: 2, equipSpell: 3, learn: 4, setGem: 5, devGrant: 7 } as const;

const weaponById = new Map(COMBAT.weapons.map((w) => [w.id, w.key]));
const spellById = new Map(COMBAT.spells.map((s) => [s.id, s.key]));
const skillById = new Map(COMBAT.skills.list.map((s) => [s.id, s.key]));
const enemyById = new Map(COMBAT.enemies.map((e) => [e.id, e]));

export interface SyncState {
  active: number;
  /** material: the weapon's look material code (weapons/look.ts), from combat_sync. */
  loadouts: { weapon: string; spells: (string | null)[]; gem: number; material?: number }[];
  known: string[];
  skillXp: Record<string, number>;
  manaMax: number;
  charges: number;
  skillPoints: number;
  level: number;
}

/** combat_sync payload (server EncodeSync). */
export function decodeSync(d: Uint8Array): SyncState | null {
  if (d.length < 2 || d[0] !== 1) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 1;
  const active = d[o++];
  const loadouts: SyncState['loadouts'] = [];
  for (let l = 0; l < 2; l++) {
    const weapon = weaponById.get(d[o++]) ?? 'sword';
    const spells: (string | null)[] = [];
    for (let k = 0; k < 4; k++) {
      const id = v.getUint16(o, true);
      o += 2;
      spells.push(id ? spellById.get(id) ?? null : null);
    }
    const gem = v.getInt8(o++);
    loadouts.push({ weapon, spells, gem });
  }
  const nk = v.getUint16(o, true);
  o += 2;
  const known: string[] = [];
  for (let i = 0; i < nk; i++) {
    const k = spellById.get(v.getUint16(o, true));
    o += 2;
    if (k) known.push(k);
  }
  const ns = d[o++];
  const skillXp: Record<string, number> = {};
  for (let i = 0; i < ns; i++) {
    const id = d[o++];
    skillXp[skillById.get(id) ?? String(id)] = v.getUint32(o, true);
    o += 4;
  }
  const manaMax = v.getUint16(o, true) / 10;
  o += 2;
  const charges = d[o++];
  const skillPoints = v.getUint16(o, true);
  o += 2;
  const level = d[o++] ?? 1;
  // pt/ux: 2 x u8 weapon look material code (weapons/look.ts), absent from older zones.
  for (let l = 0; l < 2 && o < d.length; l++) loadouts[l].material = d[o++];
  return { active, loadouts, known, skillXp, manaMax, charges, skillPoints, level };
}

export interface TelegraphView {
  enemy: number;
  shape: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  radius: number;
  reach: number;
  arc: number;
  width: number;
  windupMs: number;
}

/** telegraph Event (204) payload. */
export function decodeTelegraph(ev: ZoneEvent): TelegraphView | null {
  const d = ev.data;
  if (d.length < 12) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    enemy: ev.entityId,
    shape: d[0],
    x: ev.x / 100,
    y: ev.y / 100,
    z: ev.z / 100,
    yaw: (v.getUint16(1, true) / 65536) * 2 * Math.PI,
    radius: v.getUint16(3, true) / 100,
    reach: v.getUint16(5, true) / 100,
    arc: d[7] * 2,
    width: v.getUint16(8, true) / 100,
    windupMs: ev.value,
  };
}

export interface EnemyInfo {
  key: string;
  name: string;
  family: string;
  element: number; // 8 = physical
  affix: number; // 0 none, 1..3 elite, 7 boss
  size: number;
  color: string;
  radius: number;
  height: number;
  behavior: string;
}

const cache = new Map<number, EnemyInfo>();

/** A player as a hit target (playtest 2 PvP: the zone's player radius 0.4 m, centre 0.9 m). */
const PLAYER_TARGET: EnemyInfo = { key: 'player', name: 'Player', family: 'player', element: 8, affix: 0, size: 1, color: '#e9ecef', radius: 0.4, height: 0.9, behavior: 'player' };

/** Unpack an enemy's typeId (combatdefs.TypeID): bits 0-7 id, 8-11 element+1, 12-14 affix. Players (kind 1) are PvP targets. */
export function enemyInfo(e: { typeId?: number; kind?: number }): EnemyInfo {
  if (e.kind === 1) return PLAYER_TARGET;
  const t = e.typeId ?? 0;
  let info = cache.get(t);
  if (info) return info;
  const def = enemyById.get(t & 0xff);
  const el = ((t >> 8) & 0xf) - 1;
  const size = def?.size ?? 1;
  info = { key: def?.key ?? '?', name: def?.name ?? 'Enemy', family: def?.family ?? 'beast', element: el < 0 ? 8 : el, affix: (t >> 12) & 7, size, color: def?.color ?? '#888888', radius: 0.5 * size, height: 0.9 * size, behavior: def?.behavior ?? 'melee' };
  cache.set(t, info);
  return info;
}

export const ELEMENT_COLORS = ['#ff6b2b', '#a0d8ff', '#ffe066', '#7cb342', '#9fe8d8', '#ffd76a', '#6600cc', '#b98cff', '#c8c8c8'];
