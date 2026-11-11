// What a dropped item looks like lying in the world (playtest 2 ground loot,
// Nicole: "put the actual weapon model on the floor"): weapons are their
// real weapon model (combat/weapons weaponGeometry: weapon type + material
// from the item key), armor pieces their real armor model (combat/armor
// armorPieceGeometry: style, material, rarity trim), and everything else a
// small procedural model of its own built with the same mesh builder (vertex
// colour + `surf`, so it draws with the shared weapon material: no new
// program): a flask of the potion's colour, bread, a bowl of stew, fish,
// raw meat on the bone, a bundle of herbs, a pelt, an ingot, a sheaf of
// arrows, a pickaxe, a rod, a lute, a drum, a tome bound in its spell's
// colour, a rolled blueprint, a pile of coins that grows with the amount...
// Ores and gems are drawn by WP09's caveManager (its nuggets and crystals);
// this file maps them to 'cave' so the layer adds only the light and hum.
//
// Bitchin' items draw with the armor material on a copy whose `surf.z` is
// negative (its holographic sheen); everything else uses the weapon material
// (armor: the armor material). Geometry is cached per item key (and coin
// bucket / rarity) and never disposed: a few dozen small buffers at most.

import * as THREE from 'three';
import { COMBAT, ITEMS } from '@lodestone/contracts';
import { MeshBuilder, M, circle, lathe, polygon, shade, surf, sweep, type Surface, type V3 } from '../../../combat/weapons/builder';
import { metalOf, weaponGeometry } from '../../../combat/weapons/models';
import type { WeaponKind } from '../../../combat/weapons/look';
import { armorPieceGeometry } from '../../../combat/armor/model';
import { ELEMENT_COLORS } from '../../../combat/events';
import { itemDef } from '../items';

export type DropKind = 'weapon' | 'armor' | 'prop' | 'cave';
/** lie: flat on the ground at a slight angle; hover: floating in its beam, slowly turning. */
export type DropPose = 'lie' | 'hover';

export interface DropModel {
  kind: DropKind;
  /** Prop builder name (props), the weapon type (weapons), the armor slot (armor). */
  shape: string;
  pose: DropPose;
  /** Draw with the holographic armor material (Bitchin'). */
  holo: boolean;
}

export const PROP_SHAPES = [
  'flask',
  'bowl',
  'loaf',
  'apple',
  'cheese',
  'pie',
  'skewer',
  'fishDish',
  'platter',
  'meat',
  'herbs',
  'mushroom',
  'moss',
  'pelt',
  'pouch',
  'fish',
  'ingot',
  'arrows',
  'pickaxe',
  'rod',
  'torch',
  'rope',
  'whetstone',
  'whistle',
  'kit',
  'lute',
  'flute',
  'drum',
  'bells',
  'tome',
  'scroll',
  'coins',
  'parcel',
  'key',
  'logs',
  'sack',
] as const;
export type PropShape = (typeof PROP_SHAPES)[number];

/** Rare and better float in their beam; commoner things lie on the ground. */
export const HOVER_FROM_RARITY = 2;

function foodShape(name: string): PropShape {
  if (/stew|broth|chowder|curry/.test(name)) return 'bowl';
  if (/pie|tart/.test(name)) return 'pie';
  if (/skewer/.test(name)) return 'skewer';
  if (/feast|banquet/.test(name)) return 'platter';
  if (/perch|trout|pike|fillet|eel/.test(name)) return 'fishDish';
  if (name === 'apple') return 'apple';
  if (name === 'cheese') return 'cheese';
  if (name === 'grilled_meat') return 'meat';
  return 'loaf';
}

function propShape(key: string, kind: string | undefined): PropShape {
  const [cat, name = ''] = key.split(':');
  switch (cat) {
    case 'potion':
      return 'flask';
    case 'food':
      return foodShape(name);
    case 'meat':
      return 'meat';
    case 'herb':
      return name === 'frostcap' ? 'mushroom' : name === 'glowmoss' ? 'moss' : 'herbs';
    case 'hide':
      return 'pelt';
    case 'seed':
      return 'pouch';
    case 'fish':
      return 'fish';
    case 'ingot':
      return 'ingot';
    case 'ammo':
      return 'arrows';
    case 'tool':
      return name === 'pickaxe' ? 'pickaxe' : name === 'fishing_rod' ? 'rod' : name === 'torch' ? 'torch' : name === 'rope' ? 'rope' : name === 'whetstone' ? 'whetstone' : name === 'spirit_whistle' ? 'whistle' : 'kit';
    case 'camp':
      return 'kit';
    case 'instrument':
      return name === 'lute' ? 'lute' : name === 'wooden_flute' ? 'flute' : name === 'hand_drum' ? 'drum' : 'bells';
    case 'tome':
      return 'tome';
    case 'blueprint':
      return 'scroll';
    case 'currency':
      return 'coins';
    case 'quest':
      return 'parcel';
    case 'wood':
      return 'logs';
  }
  if (kind === 'key') return 'key';
  if (kind === 'consumable') return 'flask';
  return 'sack';
}

/** How a dropped item of this key and rarity is drawn. Pure. */
export function dropModelOf(key: string, rarity: number): DropModel {
  const d = itemDef(key);
  const holo = rarity >= 7;
  const pose: DropPose = rarity >= HOVER_FROM_RARITY ? 'hover' : 'lie';
  if (key.startsWith('ore:') || key.startsWith('gem:')) return { kind: 'cave', shape: key.split(':')[0], pose, holo: false };
  if (d?.kind === 'weapon' && d.weapon) return { kind: 'weapon', shape: d.weapon, pose, holo };
  if (d?.kind === 'armor' && d.armor) return { kind: 'armor', shape: d.armor, pose: d.armor === 'head' ? (rarity >= HOVER_FROM_RARITY ? 'hover' : 'lie') : pose, holo };
  return { kind: 'prop', shape: propShape(key, d?.kind), pose, holo };
}

/** Coins in the pile for a gold amount (3 .. 14, more for more). */
export function coinCount(qty: number): number {
  return Math.max(3, Math.min(14, Math.round(3 + Math.log2(Math.max(1, qty)) * 1.4)));
}

// ---- geometry ----

const cache = new Map<string, THREE.BufferGeometry>();

function cached(k: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = cache.get(k);
  if (!g) {
    g = build();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    g.name = `drop:${k}`;
    cache.set(k, g);
  }
  return g;
}

/** A copy whose `surf.z` (glow) is negative: the armor material's holographic sheen (Bitchin'). */
function holoCopy(g: THREE.BufferGeometry, k: string): THREE.BufferGeometry {
  return cached(`holo:${k}`, () => {
    const c = g.clone();
    const s = c.getAttribute('surf') as THREE.BufferAttribute;
    for (let i = 0; i < s.count; i++) s.setZ(i, -0.7);
    s.needsUpdate = true;
    return c;
  });
}

/**
 * The geometry for a drop (null: drawn elsewhere, ores and gems). Props sit
 * with their base at y = 0; weapons and armor in their own frames (the
 * layer centres them).
 */
export function dropGeometry(key: string, rarity: number, qty = 1): THREE.BufferGeometry | null {
  const m = dropModelOf(key, rarity);
  let g: THREE.BufferGeometry | null = null;
  let k = key;
  switch (m.kind) {
    case 'cave':
      return null;
    case 'weapon': {
      const d = itemDef(key);
      g = weaponGeometry({ weapon: m.shape as WeaponKind, material: d?.material ?? '', gem: -1 }, 1);
      break;
    }
    case 'armor':
      // Bitchin' armor is already holographic in its own finish (combat/armor/spec.ts).
      return armorPieceGeometry(key, rarity);
    case 'prop': {
      const n = m.shape === 'coins' ? coinCount(qty) : 0;
      k = n ? `${key}#${n}` : key;
      g = cached(k, () => buildProp(m.shape as PropShape, key, n));
      break;
    }
  }
  if (!g) return null;
  return m.holo ? holoCopy(g, k) : g;
}

// ---- props ----

const WOOD = surf('#8a6236', 0, 0.8);
const DARK_WOOD = surf('#5a3c22', 0, 0.8);
const CLOTH = surf('#b9a27a', 0, 0.95);
const TWINE = surf('#c8b07a', 0, 0.9);
const IRON = surf('#8c9198', 0.85, 0.45);
const GOLD = surf('#f2c64a', 0.92, 0.28, 0.05);
const PAPER = surf('#efe4c8', 0, 0.85);

const LIQUID: Record<string, string> = {
  health: '#d8263a',
  greater_health: '#a0102c',
  antidote: '#4fc35a',
  glowmoss_tonic: '#3fe0c0',
  duskpetal_draught: '#9a5cf0',
  dawnroot_elixir: '#ffcf4a',
  moonlit_tonic: '#bcd8ff',
};

const HERB: Record<string, string> = { heartleaf: '#3f9e3a', emberroot: '#d2582a', duskpetal: '#8a4ad8' };

function hashKey(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** A small capped ellipsoid centred at c (radii rx, ry, rz). */
function blob(b: MeshBuilder, c: V3, rx: number, ry: number, rz: number, s: Surface, segs = 8): void {
  const prof: [number, number][] = [];
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    prof.push([Math.sin(a) * ry, Math.max(1e-4, Math.cos(a))]);
  }
  b.with(M.t(c[0], c[1], c[2]), () => lathe(b, prof, segs, s, { rx, rz }));
}

/** A rod from a to b (radius r, n sides). */
function rod(b: MeshBuilder, a: V3, e: V3, r: number, s: Surface, n = 6): void {
  sweep(b, [a, e], polygon(n, r), s, { side: Math.abs(e[1] - a[1]) > 0.9 * Math.hypot(e[0] - a[0], e[1] - a[1], e[2] - a[2]) ? [1, 0, 0] : [0, 1, 0], capStart: true, capEnd: true });
}

/** A box of half sizes at c, optionally rotated about Y. */
function box(b: MeshBuilder, c: V3, hx: number, hy: number, hz: number, s: Surface, ry = 0): void {
  b.with(M.of(M.t(c[0], c[1], c[2]), M.ry(ry)), () => {
    const sq = polygon(4, Math.SQRT2 * hx, Math.SQRT2 * hz, Math.PI / 4);
    b.loft([sq.map(([u, v]) => [u, -hy, -v] as V3), sq.map(([u, v]) => [u, hy, -v] as V3)], s, { smooth: false, capStart: true, capEnd: true });
  });
}

/** A fish along X (head at +X), lying on its side, base at y = 0. */
function fishBody(b: MeshBuilder, len: number, body: Surface, belly: Surface): void {
  const n = 9;
  const path: V3[] = [];
  for (let i = 0; i < n; i++) path.push([(i / (n - 1) - 0.5) * len, len * 0.11, 0]);
  const prof = (i: number): [number, number] => {
    const t = i / (n - 1);
    const w = Math.sin(Math.PI * Math.pow(t, 0.8)) * (t < 0.15 ? t / 0.15 : 1);
    return [Math.max(0.06, w) * 0.22, Math.max(0.06, w) * 0.5];
  };
  // section: u along Y (the fish's height, it lies on its side: width up), v along Z
  sweep(b, path, polygon(8, len * 0.5, len * 0.12), (r, k) => (k >= 3 && k <= 5 ? belly : body), { side: [0, 0, 1], scale: prof, capStart: true, capEnd: true });
  // tail fin
  const x0 = -len * 0.5;
  b.loft(
    [
      [
        [x0 + 0.01, len * 0.11, -0.004],
        [x0 - len * 0.18, len * 0.11, -len * 0.16],
        [x0 - len * 0.18, len * 0.11, len * 0.16],
      ],
      [
        [x0 + 0.01, len * 0.11 + 0.006, -0.004],
        [x0 - len * 0.18, len * 0.11 + 0.006, -len * 0.16],
        [x0 - len * 0.18, len * 0.11 + 0.006, len * 0.16],
      ],
    ],
    shade(body, 0.8),
    { smooth: false, capStart: true, capEnd: true },
  );
  blob(b, [len * 0.36, len * 0.11 + len * 0.05, len * 0.04], 0.012, 0.012, 0.012, surf('#111111', 0.3, 0.2), 6);
}

function spellColor(key: string): string {
  const sp = COMBAT.spells.find((s) => s.key === key.slice(5));
  const el = sp?.element ?? -1;
  return el >= 0 && el < 8 ? ELEMENT_COLORS[el] : ['#7a2d2d', '#2d4a7a', '#2d6a3a', '#5a2d7a'][Math.floor(hashKey(key) * 4)];
}

function buildProp(shape: PropShape, key: string, coins: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const name = key.split(':')[1] ?? '';
  const h = hashKey(key);
  switch (shape) {
    case 'flask': {
      const liq = surf(LIQUID[name] ?? '#d8263a', 0.1, 0.12, 0.35);
      lathe(b, [[0, 1e-4], [0.002, 0.05], [0.03, 0.07], [0.09, 0.07], [0.13, 0.045], [0.155, 0.02], [0.2, 0.02]], 12, (r) => (r >= 5 ? surf('#cfe6ec', 0.2, 0.1, 0.05) : liq), { capEnd: false });
      lathe(b, [[0.19, 0.022], [0.235, 0.024], [0.24, 1e-4]], 8, surf('#9c7a4c', 0, 0.9));
      break;
    }
    case 'bowl': {
      lathe(b, [[0, 1e-4], [0.002, 0.05], [0.02, 0.085], [0.06, 0.11], [0.066, 0.104]], 14, WOOD);
      lathe(b, [[0.05, 0.1], [0.058, 1e-4]], 14, surf(name.includes('curry') ? '#c8742a' : name.includes('broth') ? '#c9d8c0' : '#8a4a2a', 0, 0.6, 0.04));
      break;
    }
    case 'loaf':
      lathe(b, [[0, 0.06], [0.03, 0.068], [0.06, 0.052], [0.08, 0.025], [0.085, 1e-4]], 10, (r) => (r >= 2 ? surf('#b8742f', 0, 0.85) : surf('#d9a560', 0, 0.85)), { rx: 1.7, capStart: true });
      break;
    case 'apple':
      lathe(b, [[0, 1e-4], [0.008, 0.032], [0.035, 0.05], [0.07, 0.042], [0.082, 0.012], [0.078, 1e-4]], 10, surf('#c8322a', 0.05, 0.45));
      rod(b, [0, 0.075, 0], [0.006, 0.105, 0], 0.004, DARK_WOOD, 4);
      break;
    case 'cheese':
      sweep(
        b,
        [
          [0, 0.035, -0.055],
          [0, 0.035, 0.055],
        ],
        [
          [0.0, -0.035],
          [0.11, -0.035],
          [0.0, 0.035],
        ],
        surf('#f0c84a', 0, 0.6),
        { side: [1, 0, 0], capStart: true, capEnd: true, smooth: false },
      );
      break;
    case 'pie':
      lathe(b, [[0, 1e-4], [0.003, 0.1], [0.025, 0.115], [0.04, 0.1], [0.045, 1e-4]], 14, (r) => (r >= 3 ? surf(name.includes('tart') ? '#7a1f4a' : '#c08040', 0, 0.7) : surf('#d4a058', 0, 0.85)));
      break;
    case 'skewer':
      rod(b, [-0.16, 0.03, 0], [0.16, 0.03, 0], 0.004, DARK_WOOD, 4);
      for (let i = 0; i < 3; i++) blob(b, [-0.07 + i * 0.07, 0.03, 0], 0.03, 0.026, 0.03, surf(i === 1 ? '#c8742a' : '#8a4428', 0, 0.75), 7);
      break;
    case 'fishDish':
      lathe(b, [[0, 1e-4], [0.004, 0.15], [0.012, 0.16]], 16, surf('#d8d4c8', 0.05, 0.4));
      b.with(M.t(0, 0.012, 0), () => fishBody(b, 0.22, surf('#a8663a', 0, 0.7), surf('#c8925a', 0, 0.7)));
      break;
    case 'platter':
      lathe(b, [[0, 1e-4], [0.006, 0.22], [0.016, 0.23]], 18, surf('#c9a24a', 0.7, 0.35));
      blob(b, [0, 0.05, 0], 0.13, 0.05, 0.1, surf('#a0522d', 0, 0.7), 10);
      for (let i = 0; i < 4; i++) blob(b, [Math.cos(i * 1.6) * 0.15, 0.03, Math.sin(i * 1.6) * 0.15], 0.025, 0.025, 0.025, surf(['#c8322a', '#5a9e3a', '#e8c84a', '#8a4ad8'][i], 0.05, 0.5), 6);
      break;
    case 'meat': {
      const cooked = name === 'grilled_meat';
      blob(b, [0, 0.045, 0], 0.09, 0.045, 0.065, surf(cooked ? '#8a4428' : '#b03a3a', 0, 0.6), 10);
      blob(b, [-0.02, 0.07, 0.01], 0.05, 0.02, 0.04, surf(cooked ? '#b0683a' : '#e8c8b8', 0, 0.7), 8);
      rod(b, [0.07, 0.045, 0], [0.16, 0.05, 0], 0.012, surf('#efe6d2', 0, 0.6), 6);
      blob(b, [0.165, 0.05, 0], 0.02, 0.02, 0.025, surf('#efe6d2', 0, 0.6), 6);
      break;
    }
    case 'herbs': {
      const leaf = surf(HERB[name] ?? '#4a9e3a', 0, 0.7);
      for (let i = 0; i < 6; i++) {
        const a = -0.6 + i * 0.24;
        const tip: V3 = [Math.cos(a) * 0.2, 0.012, Math.sin(a) * 0.2];
        sweep(b, [[0, 0.012, 0], [tip[0] * 0.5, 0.025, tip[2] * 0.5], tip], [[-0.02, 0], [0.02, 0], [0, 0.006]], (r) => shade(leaf, r === 1 ? 1 : 0.85), { side: [0, 1, 0], capStart: true, capEnd: true, smooth: false, scale: (k) => (k === 1 ? [1, 1] : [0.35, 1]) });
      }
      rod(b, [-0.02, 0.012, 0], [0.03, 0.012, 0], 0.014, TWINE, 6);
      break;
    }
    case 'mushroom':
      for (let i = 0; i < 3; i++) {
        const x = (i - 1) * 0.06;
        rod(b, [x, 0, 0], [x, 0.05 + i * 0.01, 0], 0.01, surf('#e8e8f0', 0, 0.7), 6);
        b.with(M.t(x, 0.05 + i * 0.01, 0), () => lathe(b, [[-0.005, 0.035], [0.012, 0.03], [0.022, 1e-4]], 10, surf('#bfe6ff', 0.05, 0.4, 0.12), { capStart: true }));
      }
      break;
    case 'moss':
      for (let i = 0; i < 5; i++) blob(b, [Math.cos(i * 1.3) * 0.05, 0.02, Math.sin(i * 1.3) * 0.05], 0.045, 0.025, 0.045, surf('#7dff9a', 0, 0.8, 0.55), 7);
      break;
    case 'pelt': {
      const rings: V3[][] = [0, 0.018].map((y) => circle(y, 0.2, 14, { rx: 1.3, rAt: (a) => 0.2 * (0.8 + 0.25 * Math.sin(a * 3 + h * 6) + 0.12 * Math.sin(a * 7)) }));
      b.loft(rings, surf(name === 'wolf' ? '#7b7468' : '#7b5a3e', 0, 0.95), { capStart: true, capEnd: true });
      break;
    }
    case 'pouch':
      lathe(b, [[0, 1e-4], [0.005, 0.045], [0.04, 0.055], [0.07, 0.03], [0.08, 0.02], [0.1, 0.03]], 10, surf('#8a6a44', 0, 0.9));
      rod(b, [-0.025, 0.08, 0], [0.025, 0.08, 0], 0.008, TWINE, 5);
      break;
    case 'fish': {
      const tint = ['#c8d0d8', '#a8b878', '#d8a868', '#8898a8', '#b8c0c8'][Math.floor(h * 5)];
      const big = ['humming_sturgeon', 'deepmaw', 'stormray', 'moonlit_koi'].includes(name);
      fishBody(b, big ? 0.42 : 0.26, surf(tint, 0.35, 0.3, big ? 0.15 : 0), surf('#ece8dc', 0.3, 0.3));
      break;
    }
    case 'ingot': {
      const mt = metalOf(name).base;
      const lo = polygon(4, Math.SQRT2 * 0.07, Math.SQRT2 * 0.035, Math.PI / 4).map(([u, v]) => [u, 0, -v] as V3);
      const hi = polygon(4, Math.SQRT2 * 0.055, Math.SQRT2 * 0.024, Math.PI / 4).map(([u, v]) => [u, 0.035, -v] as V3);
      b.loft([lo, hi], mt, { smooth: false, capStart: true, capEnd: true });
      break;
    }
    case 'arrows': {
      const head = metalOf(name.replace('_arrow', '')).base;
      for (let i = 0; i < 3; i++) {
        const z = (i - 1) * 0.022;
        rod(b, [-0.3, 0.012, z], [0.3, 0.012, z], 0.004, surf('#b88d58', 0, 0.75), 4);
        sweep(b, [[0.3, 0.012, z], [0.345, 0.012, z]], polygon(4, 0.012), head, { side: [0, 1, 0], scale: (k) => (k === 0 ? [1, 1] : [0.05, 0.05]), capStart: true, smooth: false });
        box(b, [-0.27, 0.012, z], 0.03, 0.002, 0.009, surf('#c23b2b', 0, 0.8));
      }
      break;
    }
    case 'pickaxe':
      rod(b, [-0.3, 0.02, 0], [0.22, 0.02, 0], 0.014, WOOD, 6);
      sweep(b, [[0.2, 0.02, -0.17], [0.24, 0.02, 0], [0.2, 0.02, 0.17]], polygon(4, 0.018), IRON, { side: [0, 1, 0], scale: (k) => (k === 1 ? [1, 1] : [0.4, 0.4]), capStart: true, capEnd: true, smooth: false });
      break;
    case 'rod':
      rod(b, [-0.6, 0.012, 0], [0.6, 0.012, 0], 0.008, WOOD, 5);
      b.with(M.of(M.t(-0.42, 0.03, 0), M.rx(Math.PI / 2)), () => lathe(b, [[-0.015, 0.03], [0.015, 0.03]], 10, IRON, { capStart: true, capEnd: true }));
      break;
    case 'torch':
      rod(b, [-0.2, 0.018, 0], [0.12, 0.018, 0], 0.014, WOOD, 6);
      blob(b, [0.15, 0.026, 0], 0.045, 0.026, 0.026, surf('#3a2a1a', 0, 0.95, 0.1), 8);
      break;
    case 'rope': {
      const path: V3[] = [];
      for (let i = 0; i <= 28; i++) {
        const a = (i / 28) * Math.PI * 4.3;
        const r = 0.07 + (i / 28) * 0.05;
        path.push([Math.cos(a) * r, 0.014 + (i % 14 === 0 ? 0 : 0.002), Math.sin(a) * r]);
      }
      sweep(b, path, polygon(5, 0.013), surf('#c8a870', 0, 0.95), { side: [0, 1, 0] });
      break;
    }
    case 'whetstone':
      box(b, [0, 0.018, 0], 0.08, 0.018, 0.025, surf('#7a7f86', 0.1, 0.8));
      break;
    case 'whistle':
      rod(b, [-0.05, 0.012, 0], [0.05, 0.012, 0], 0.012, surf('#c8d8f0', 0.4, 0.3, 0.25), 8);
      break;
    case 'kit': {
      const tint = surf(['#7a5230', '#6a6a4a', '#5a4a3a', '#7a6a50'][Math.floor(h * 4)], 0, 0.85);
      box(b, [0, 0.07, 0], 0.13, 0.07, 0.09, tint);
      for (const x of [-0.07, 0.07]) box(b, [x, 0.07, 0], 0.012, 0.073, 0.093, surf('#3a2a1a', 0, 0.8));
      break;
    }
    case 'lute':
      b.with(M.t(-0.08, 0, 0), () => lathe(b, [[0, 1e-4], [0.01, 0.12], [0.05, 0.13], [0.06, 1e-4]], 12, (r) => (r === 2 ? surf('#d8b07a', 0, 0.6) : WOOD), { rx: 1.25 }));
      box(b, [0.17, 0.055, 0], 0.15, 0.012, 0.022, DARK_WOOD);
      box(b, [0.34, 0.055, 0], 0.035, 0.012, 0.028, DARK_WOOD, 0.3);
      break;
    case 'flute':
      rod(b, [-0.18, 0.014, 0], [0.18, 0.014, 0], 0.014, surf('#c8a06a', 0, 0.6), 8);
      for (let i = 0; i < 5; i++) blob(b, [-0.04 + i * 0.035, 0.027, 0], 0.005, 0.002, 0.005, surf('#2a1a10', 0, 0.9), 5);
      break;
    case 'drum':
      lathe(b, [[0, 0.11], [0.09, 0.115], [0.1, 0.1]], 14, (r) => (r >= 1 ? surf('#e8d8b8', 0, 0.8) : WOOD), { capStart: true, capEnd: true });
      break;
    case 'bells':
      for (const x of [-0.06, 0.06]) {
        b.with(M.t(x, 0, 0), () => lathe(b, [[0.005, 0.05], [0.02, 0.045], [0.06, 0.025], [0.075, 1e-4]], 10, GOLD, { capStart: true }));
        rod(b, [x, 0.075, 0], [x, 0.14, 0], 0.008, DARK_WOOD, 5);
      }
      break;
    case 'tome': {
      const cover = surf(spellColor(key), 0.1, 0.6, 0.12);
      box(b, [0, 0.03, 0], 0.11, 0.03, 0.08, cover);
      box(b, [0.006, 0.03, 0], 0.104, 0.024, 0.075, PAPER);
      box(b, [-0.108, 0.03, 0], 0.008, 0.031, 0.08, shade(cover, 0.7));
      for (const z of [-0.07, 0.07]) box(b, [0.095, 0.061, z], 0.012, 0.002, 0.01, GOLD);
      break;
    }
    case 'scroll':
      rod(b, [-0.15, 0.03, 0], [0.15, 0.03, 0], 0.03, surf('#3a6ea8', 0, 0.8), 10);
      for (const x of [-0.153, 0.153]) rod(b, [x - 0.004, 0.03, 0], [x + 0.004, 0.03, 0], 0.032, PAPER, 10);
      rod(b, [-0.006, 0.03, 0], [0.006, 0.03, 0], 0.033, surf('#c23b2b', 0, 0.8), 10);
      break;
    case 'coins': {
      for (let i = 0; i < coins; i++) {
        const a = i * 2.4 + h * 6;
        const r = i < 3 ? 0 : 0.03 + (i % 5) * 0.012;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const y = i < 3 ? i * 0.007 : 0;
        b.with(M.of(M.t(x, y, z), M.rx((i % 3) * 0.12)), () => lathe(b, [[0, 0.022], [0.006, 0.022]], 10, (r) => shade(GOLD, r ? 1 : 0.85), { capStart: true, capEnd: true }));
      }
      break;
    }
    case 'parcel':
      box(b, [0, 0.05, 0], 0.09, 0.05, 0.07, surf('#c8a870', 0, 0.85, 0.08));
      box(b, [0, 0.05, 0], 0.092, 0.052, 0.008, TWINE);
      box(b, [0, 0.05, 0], 0.008, 0.052, 0.072, TWINE);
      break;
    case 'key':
      b.with(M.t(-0.05, 0.008, 0), () => lathe(b, [[-0.006, 0.025], [0.006, 0.025]], 10, GOLD, { capStart: true, capEnd: true }));
      rod(b, [-0.025, 0.008, 0], [0.08, 0.008, 0], 0.006, GOLD, 5);
      box(b, [0.07, 0.008, 0.012], 0.006, 0.006, 0.012, GOLD);
      break;
    case 'logs':
      for (const [x, z, y] of [
        [0, -0.045, 0.04],
        [0.01, 0.045, 0.04],
        [-0.01, 0, 0.11],
      ] as const) {
        rod(b, [-0.18 + x, y, z], [0.18 + x, y, z], 0.04, surf('#6a4a2c', 0, 0.9), 7);
        for (const e of [-0.181 + x, 0.181 + x]) rod(b, [e - 0.002, y, z], [e + 0.002, y, z], 0.036, surf('#c8a070', 0, 0.85), 7);
      }
      break;
    case 'sack':
      lathe(b, [[0, 1e-4], [0.005, 0.07], [0.06, 0.085], [0.11, 0.05], [0.13, 0.03], [0.15, 0.045]], 10, CLOTH);
      rod(b, [-0.035, 0.13, 0], [0.035, 0.13, 0], 0.008, TWINE, 5);
      break;
  }
  return b.build();
}

/** Every item key the table knows plus one tome: the model mapping is total (tests). */
export function allDropKeys(): string[] {
  return [...ITEMS.items.map((i) => i.key), `tome:${COMBAT.spells[0]?.key ?? 'x'}`];
}
