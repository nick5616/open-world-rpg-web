// Playtest 2 taming and pets (CR 029): the wire and the pure rules the HUD
// uses. Events 1200-1205 in, Interact 130 out (contracts/events.md); the
// zone is server/zone/internal/game/pets.go (the companion itself:
// internal/combat/pets.go). Data: contracts/content.yaml `taming`.

import { COMBAT, CONTENT, type Event as ZoneEvent, type PetAbilityDef, type PetSpeciesDef } from '@lodestone/contracts';
import { baseName, ELEMENT_NAMES } from '../inventory/items';

export const PET_INTERACT = 130;
export const PET_ACT = { feed: 1, command: 2, pet: 3, feedPet: 4, name: 5, takeOut: 6, stable: 7, release: 8, sync: 9, dev: 10 } as const;
export const PET_CMD = { follow: 1, stay: 2, attack: 3, come: 4 } as const;
export const PET_EV = { sync: 1200, calm: 1201, progress: 1202, refused: 1203, note: 1204, act: 1205 } as const;
export const TAME = { started: 1, interrupted: 2, tamed: 3, failed: 4 } as const;
export const ACT = { ability: 1, petted: 2, fed: 3, ko: 4, arrived: 5 } as const;
export const NOTE = { level: 1, ko: 2, back: 3, stabled: 4, released: 5, named: 6 } as const;
export const MODE = { follow: 0, stay: 1 } as const;
export const VARIANT_NAME = ['', 'Shiny', 'Elemental'] as const;

export const TAMING = CONTENT.taming;

export const REFUSAL: Record<number, string> = {
  1: "That didn't work.",
  2: 'It is not calm: weaken it while you carry a food it likes.',
  3: 'Get closer.',
  4: 'You carry nothing it likes to eat.',
  5: 'Someone else is taming it.',
  6: 'You have no pet out.',
  7: 'Only at a stable: near your camp or in a town.',
  8: 'Your stable is full. Release a pet first.',
  9: 'A name of 1-16 letters, digits, spaces, apostrophes or dashes.',
  10: 'It is still recovering at home; it will come to you when it has.',
  11: 'Not while you are down.',
  12: 'You are already taming something.',
};

export const INTERRUPT: Record<number, string> = {
  1: 'It was hurt and the taming broke off.',
  2: 'You were hurt: it startled and turned on you!',
  3: 'You walked away: it startled and turned on you!',
  4: 'It wandered off before you finished.',
  5: 'You went down.',
  6: '',
};

const speciesByKey = new Map(TAMING.species.map((s) => [s.key, s]));
const speciesById = new Map(TAMING.species.map((s) => [s.id, s]));
const speciesByEnemy = new Map(TAMING.species.map((s) => [s.enemy, s]));
const speciesByEnemyId = new Map(TAMING.species.map((s) => [s.enemyId, s]));
const abilityById = new Map(TAMING.abilities.map((a) => [a.id, a]));

export function species(key: string): PetSpeciesDef | undefined {
  return speciesByKey.get(key);
}
export function speciesOfId(id: number): PetSpeciesDef | undefined {
  return speciesById.get(id);
}
/** The species that tames a combat.yaml creature (undefined: not tameable). */
export function tameableEnemy(key: string): PetSpeciesDef | undefined {
  return speciesByEnemy.get(key);
}
export function tameableEnemyId(id: number): PetSpeciesDef | undefined {
  return speciesByEnemyId.get(id);
}
export function abilityOf(sp: PetSpeciesDef | undefined): PetAbilityDef | undefined {
  return sp ? abilityById.get(sp.ability) : undefined;
}
export function abilityById2(id: number): PetAbilityDef | undefined {
  return abilityById.get(id);
}
const enemyName = new Map(COMBAT.enemies.map((e) => [e.key, e.name]));
/** The creature's name for a species key ("Mossback Slime"), lower-cased for prose with lower = true. */
export function speciesName(key: string | undefined, lower = false): string {
  const sp = key ? speciesByKey.get(key) : undefined;
  const n = (sp && enemyName.get(sp.enemy)) ?? (key ?? 'creature').replace(/_/g, ' ');
  return lower ? n.toLowerCase() : n;
}

export function foodName(item: string): string {
  return baseName(item);
}
/** "Raw Meat (favourite), Grilled Meat" */
export function foodsText(sp: PetSpeciesDef): string {
  return sp.foods.map((f, i) => (i === 0 ? `${foodName(f)} (favourite)` : foodName(f))).join(', ');
}

/** The best food you carry for sp (the favourite first), or null. */
export function likedFood(sp: PetSpeciesDef, have: (item: string) => number): { item: string; fav: boolean } | null {
  for (let i = 0; i < sp.foods.length; i++) if (have(sp.foods[i]) > 0) return { item: sp.foods[i], fav: i === 0 };
  return null;
}

/** Seconds the taming meter takes (as the zone: content.TameTime). */
export function tameSeconds(sp: PetSpeciesDef, fav: boolean): number {
  return fav ? sp.tameS * TAMING.favouriteMult : sp.tameS;
}

/** XP to the next level (content.yaml xpBase x xpGrowth^(level-1); 0 at the cap). */
export function xpToNext(level: number): number {
  return level >= TAMING.levelMax ? 0 : Math.round(TAMING.xpBase * Math.pow(TAMING.xpGrowth, Math.max(0, level - 1)));
}

/** A pet's health and bite at its level and variant (as the zone: content.PetStats). */
export function petStats(sp: PetSpeciesDef, level: number, variant: number): { hp: number; damage: number } {
  const l = Math.max(0, level - 1);
  const vm = variant === 1 ? 1.1 : variant === 2 ? 1.05 : 1;
  return { hp: Math.round(sp.hp * (1 + TAMING.hpPerLevel * l) * vm), damage: sp.damage * (1 + TAMING.damagePerLevel * l) * vm };
}

export function variantLabel(variant: number, el: number): string {
  if (variant === 2 && el >= 0 && el < 8) return ELEMENT_NAMES[el];
  return VARIANT_NAME[variant] ?? '';
}

// ---- decoders ----

export interface PetInfo {
  id: number;
  sp: string;
  name: string;
  variant: number;
  el: number;
  lv: number;
  xp: number;
  next: number;
  hp: number;
  hpMax: number;
  dmg: number;
  koMs: number;
  active: boolean;
  out: number;
  kills: number;
  tamedAt: number;
}

export interface PetSync {
  pets: PetInfo[];
  active: number;
  mode: number;
  stable: boolean;
  max: number;
  /** performance.now() when it arrived (koMs counts down from it). */
  at: number;
}

const text = (e: ZoneEvent) => (e.data && e.data.length ? new TextDecoder().decode(e.data) : '');

function json<T>(e: ZoneEvent): T | null {
  try {
    return JSON.parse(text(e)) as T;
  } catch {
    return null;
  }
}

export function decodeSync(e: ZoneEvent, now: number): PetSync | null {
  const j = json<Omit<PetSync, 'at'>>(e);
  if (!j) return null;
  return { pets: j.pets ?? [], active: j.active ?? 0, mode: j.mode ?? 0, stable: !!j.stable, max: j.max ?? TAMING.maxPets, at: now };
}

export interface CalmView {
  id: number;
  species: number;
  until: number;
  x: number;
  y: number;
  z: number;
}

export function decodeCalm(e: ZoneEvent, now: number): CalmView {
  return { id: e.entityId, species: Number(e.targetId), until: now + e.value, x: e.x / 100, y: e.y / 100, z: e.z / 100 };
}

export interface TameProgress {
  sp: string;
  food?: string;
  fav?: boolean;
  reason?: number;
  variant?: number;
  el?: number;
  name?: string;
  by: number;
  ms?: number;
}

export function decodeProgress(e: ZoneEvent): TameProgress {
  return json<TameProgress>(e) ?? { sp: '', by: 0 };
}

export interface PetActView {
  pet: number;
  act: number;
  /** ability id (act 1), the player (2, 3), the pet id (4, 5). */
  target: number;
  /** act 1: the creature (or owner) the ability went to. */
  on: number;
  x: number;
  y: number;
  z: number;
  at: number;
}

export function decodeAct(e: ZoneEvent, now: number): PetActView {
  const d = e.data;
  const on = e.value === ACT.ability && d && d.length >= 4 ? (d[0] | (d[1] << 8) | (d[2] << 16)) + d[3] * 0x1000000 : 0;
  return { pet: e.entityId, act: e.value, target: Number(e.targetId), on, x: e.x / 100, y: e.y / 100, z: e.z / 100, at: now };
}

/** A pet's name as 4-byte chunks (Interact 130/5; the zone validates). */
export function nameChunks(name: string): number[] {
  const b = [...name.slice(0, 16)].map((c) => c.charCodeAt(0) & 0x7f);
  b.push(0);
  const out: number[] = [];
  for (let i = 0; i < b.length && out.length < 4; i += 4) out.push((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) * 0x1000000));
  return out;
}

/** The taming meter's fill 0..1. */
export function meterFill(m: { start: number; ms: number }, now: number): number {
  return Math.max(0, Math.min(1, (now - m.start) / Math.max(1, m.ms)));
}

/** "2:31" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- targeting (pure) ----

export interface Pickable {
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  healthPct: number;
}

/**
 * The creature under the crosshair for "attack that": the enemy (kind 2,
 * alive) closest to the look ray within `maxM` and a cone of `coneDeg`.
 * eye: camera position; dir: unit look direction. Returns its id or 0.
 */
export function pickAlong(views: readonly Pickable[], eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxM = 30, coneDeg = 9): number {
  const cos = Math.cos((coneDeg * Math.PI) / 180);
  let best = 0;
  let bestScore = Infinity;
  for (const v of views) {
    if (v.kind !== 2 || v.healthPct <= 0) continue;
    const dx = v.x - eye.x;
    const dy = v.y + 0.7 - eye.y;
    const dz = v.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > maxM || d < 0.5) continue;
    const c = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
    // a wider cone up close (a big body fills more of the view)
    if (c < Math.min(cos, Math.cos(Math.atan2(1.2, d)))) continue;
    const score = (1 - c) * 40 + d * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = v.id;
    }
  }
  return best;
}

/** The pet command wheel (hold 6): its sectors, clockwise from the top. */
export const WHEEL = [
  { key: 'attack', label: 'Attack my target', hint: 'tap 6' },
  { key: 'follow', label: 'Follow', hint: '' },
  { key: 'stay', label: 'Stay here', hint: '7 toggles' },
  { key: 'come', label: 'Come here', hint: '' },
  { key: 'pet', label: 'Pet', hint: 'E beside it' },
  { key: 'feed', label: 'Feed', hint: 'heals' },
] as const;
export type WheelKey = (typeof WHEEL)[number]['key'];
