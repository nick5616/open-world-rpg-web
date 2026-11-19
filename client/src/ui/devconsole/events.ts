// Playtest 2 dev console (CR 032): the wire. Interact 250 out, Events
// 1400-1402 in (contracts/events.md); the zone side is
// server/zone/internal/game/devconsole.go and only answers when it was
// started with LODESTONE_ZONE_DEV=1 (scripts/dev.mjs, `npm run dev`).

export const DEV_INTERACT = 250;

export const DEV_ACT = {
  status: 1,
  give: 2,
  learn: 3,
  unlearn: 4,
  level: 5,
  xp: 6,
  gold: 7,
  skillPoints: 8,
  weaponSkill: 9,
  refill: 10,
  flags: 11,
  speed: 12,
  reset: 13,
  teleport: 14,
  time: 15,
  weather: 16,
  spawn: 17,
  despawn: 18,
  event: 19,
  tameable: 20,
  pet: 21,
  steed: 22,
  quest: 23,
  reveal: 24,
  attune: 25,
  places: 26,
  achieve: 27,
  story: 28, // CR 035 main story: arg = DEV_STORY, target = act | step << 8 (jump) or percent (hush)
  rift: 36, // CR 040 rift runs: arg = DEV_RIFT | chapter << 4 | stage << 8
} as const;

/** /rift sub-commands (Interact 250/36 arg low nibble; game/rift_dev.go). */
export const DEV_RIFT = { spawn: 1, go: 2, win: 3, leave: 4, list: 5 } as const;

export const DEV_EV = { status: 1400, result: 1401, places: 1402 } as const;

/** Event 1400 value / Interact 250/11 arg bits. */
export const DEV_FLAG = { god: 1, mana: 2, stamina: 4, cooldowns: 8, fly: 16, freeLearn: 32, freezeTime: 64 } as const;
export type DevFlagName = keyof typeof DEV_FLAG;

export const DEV_FLAG_LABEL: Record<DevFlagName, string> = {
  god: 'God mode (no damage)',
  mana: 'Infinite mana',
  stamina: 'Infinite stamina',
  cooldowns: 'No cooldowns',
  fly: 'Fly (Space up, Ctrl down, Shift fast)',
  freeLearn: 'Free skill tree (every tier, no points)',
  freezeTime: 'Freeze time (zone-wide)',
};

/** Event 1401 value. */
export const DEV_RESULT = { ok: 0, off: 1, badArg: 2, failed: 3, unknown: 4 } as const;

/** One Interact 250 to send. */
export interface DevSend {
  action: number;
  target: bigint;
  arg: number;
}

export const send = (action: number, target: bigint | number = 0n, arg = 0): DevSend => ({ action, target: BigInt(target), arg: arg >>> 0 });

/** FNV-1a 32 of a UTF-8 string (the zone's game.DevHash). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface GiveOpts {
  qty?: number;
  /** Item level (0 = the base's). */
  level?: number;
  /** Rarity tier 0-7 (-1 / undefined: common). */
  rarity?: number;
  /** Index into ITEMS.gems (-1 none) and the cut 0-2. */
  gem?: number;
  cut?: number;
  /** Index into ITEMS.affixes (-1 none). */
  affix?: number;
  /** Weapons into this loadout's main hand, armor into its slot, anything else is used. */
  equip?: boolean;
  loadout?: number;
}

export function giveSend(key: string, o: GiveOpts = {}): DevSend {
  const t =
    BigInt(fnv1a32(key)) |
    (BigInt(Math.max(0, Math.min(255, o.level ?? 0))) << 32n) |
    (BigInt(Math.max(0, Math.min(15, (o.rarity ?? -1) + 1))) << 40n) |
    (BigInt(Math.max(0, Math.min(15, (o.gem ?? -1) + 1))) << 44n) |
    (BigInt(Math.max(0, Math.min(3, o.cut ?? 0))) << 48n) |
    (BigInt(Math.max(0, Math.min(255, (o.affix ?? -1) + 1))) << 50n);
  const arg = Math.max(1, Math.min(0xffff, o.qty ?? 1)) | (o.equip ? 1 << 16 : 0) | (((o.loadout ?? 0) & 3) << 17); // CR 039: loadout 3 too
  return send(DEV_ACT.give, t, arg);
}
/** Interact 250/14: x, z in metres (cm, u32 each); y 0 = the ground. */
/** y: undefined = the ground; a number = exactly that height, below the terrain too (the Underground; playtest 3): offset binary in the low 31 bits, bit 31 set (server devExactY). */
export function teleportSend(x: number, z: number, y?: number): DevSend {
  const cm = (v: number) => BigInt(Math.max(0, Math.round(v * 100)) >>> 0);
  const arg = y === undefined ? 0 : (0x80000000 | (Math.round(y * 100) + 0x40000000)) >>> 0;
  return send(DEV_ACT.teleport, cm(x) | (cm(z) << 32n), arg);
}

/** Interact 250/17: count, level (0 = yours), a boss index or an enemy id, an elite affix id. */
export function spawnSend(id: number, count = 1, level = 0, boss = false, elite = 0): DevSend {
  return send(DEV_ACT.spawn, id, (Math.max(1, Math.min(20, count)) & 0xff) | ((Math.max(0, Math.min(255, level)) & 0xff) << 8) | (boss ? 1 << 16 : 0) | ((elite & 0xf) << 17));
}

/** Interact 250/21: variant 0 plain, 1 shiny, 2 elemental (element 0-7). */
export function petSend(species: number, variant = 0, level = 1, element = -1): DevSend {
  return send(DEV_ACT.pet, species, (variant & 0xf) | (((element + 1) & 0xf) << 4) | ((Math.max(1, Math.min(255, level)) & 0xff) << 8));
}

/** Event 1400 data. */
export interface DevStatus {
  flags: number;
  speed: number;
  skillBonus: number;
  frozen: boolean;
  hour: number;
  weather: number;
  spawned: number;
}

export interface DevPlace {
  n: string;
  x: number;
  z: number;
}

/** Event 1402 data. */
export interface DevPlaces {
  towers: DevPlace[];
  towns: DevPlace[];
  vaults: DevPlace[];
}

/** CR 035: /story sub-commands (Interact 250/28 arg; server/zone/internal/game/story_dev.go). */
export const DEV_STORY = { jump: 1, heartfall: 2, win: 3, reset: 4, hush: 5, vigil: 6, places: 7, bells: 8, down: 9 } as const;
