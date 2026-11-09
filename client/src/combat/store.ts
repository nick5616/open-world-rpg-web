// Combat HUD state (zustand, updated at event rate, never per frame) plus a
// non-reactive FX queue the 3D layer drains every frame.

import { create } from 'zustand';
import { COMBAT } from '@lodestone/contracts';

export interface DamageNumber {
  id: number;
  x: number;
  y: number;
  z: number;
  value: number;
  kind: 'dealt' | 'taken' | 'heal' | 'crit' | 'weak' | 'resist' | 'miss';
  at: number;
}

export interface BossBar {
  id: number;
  name: string;
  phase: number;
  phases: number;
  pct: number;
}

export interface CombatHudState {
  active: boolean;
  health: number;
  healthMax: number;
  mana: number;
  manaMax: number;
  charges: number;
  activeLoadout: number;
  loadouts: { weapon: string; spells: (string | null)[]; gem: number }[];
  known: string[];
  skillXp: Record<string, number>;
  level: number;
  skillPoints: number;
  boss: BossBar | null;
  downedUntil: number;
  toast: { text: string; at: number } | null;
  refused: { id: number; at: number } | null;
  /** Playtest 1: what the right mouse button uses: -1 the weapon secondary, 0-3 a spell slot (wheel cycles; spellSelect.ts). */
  selected: number;
  selectedAt: number;
  set: (p: Partial<CombatHudState>) => void;
}

const start = COMBAT.start.loadouts.map((l) => ({ weapon: l.weapon, spells: [...l.spells], gem: -1 }));

export const useCombatHud = create<CombatHudState>()((set) => ({
  active: false,
  health: 100,
  healthMax: 100,
  mana: 100,
  manaMax: 100,
  charges: COMBAT.start.consumable.charges,
  activeLoadout: 0,
  loadouts: start,
  known: [...COMBAT.start.spells],
  skillXp: {},
  level: 1,
  skillPoints: 0,
  boss: null,
  downedUntil: 0,
  toast: null,
  refused: null,
  selected: -1,
  selectedAt: 0,
  set: (p) => set(p),
}));

export function toast(text: string): void {
  useCombatHud.getState().set({ toast: { text, at: performance.now() } });
}

/** FX the 3D layer consumes (sparks, projectiles, telegraphs, numbers). */
export type Fx =
  | { t: 'spark'; x: number; y: number; z: number; color: string; at: number }
  | { t: 'number'; n: DamageNumber }
  | { t: 'telegraph'; enemy: number; shape: number; x: number; y: number; z: number; yaw: number; radius: number; reach: number; arc: number; width: number; windupMs: number; at: number }
  | { t: 'projectile'; id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; gravity: number; radius: number; color: string; life: number; at: number; enemy: boolean }
  | { t: 'area'; x: number; y: number; z: number; radius: number; color: string; durationMs: number; at: number }
  | { t: 'swing'; arc: number; reach: number; color: string; durationMs: number; at: number }
  | { t: 'beam'; x: number; y: number; z: number; x2: number; y2: number; z2: number; color: string; durationMs: number; at: number };

export const fxQueue: Fx[] = [];

let numId = 1;
export function pushNumber(x: number, y: number, z: number, value: number, kind: DamageNumber['kind']): void {
  fxQueue.push({ t: 'number', n: { id: numId++, x, y, z, value, kind, at: performance.now() } });
}
