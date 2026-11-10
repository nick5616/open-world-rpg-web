// What a worn outfit is made of (playtest 2 visible armor, CR 034): the
// appearance (appearance.ts) mapped to a model spec, pure data that the
// mesh builder (model.ts) draws and the tests check for every armor item:
//
//   parts  named low-poly pieces, each parented to one rig bone (the head on
//          the neck, a cuirass on the torso, a fauld or robe skirt on the
//          hips, sleeves and vambraces on the arm segments, thigh and shin
//          pieces on the legs)
//   hides  which of the bare rig's meshes the armor replaces (the navy shirt,
//          the skin head, the trousers): hidden, so the armor costs fewer
//          draw calls than it saves
//   finish the surfaces: material colours (iron, silver, sunsteel's glow,
//          starmetal, voidglass, leather, cloth), the rarity's trim colour, a
//          subtle glow from relic up, Bitchin' holographic, the gem's colour
//
// Art direction: Valheim / Breath of the Wild low poly. Faceted plate,
// banded mail, stitched leather, soft cloth; one accent colour per rarity.

import * as THREE from 'three';
import { ITEMS } from '@lodestone/contracts';
import { ELEMENT_COLORS } from '../events';
import { surf, shade, type Surface } from '../weapons/builder';
import { unpackAppearance, type ArmorSlot, type WornPiece } from './appearance';

/** The rig bones armor can hang from (net/avatar.ts makes one THREE.Bone in each joint group). */
export const ARMOR_BONES = ['body', 'torso', 'neck', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'hipR', 'kneeR'] as const;
export type ArmorBone = (typeof ARMOR_BONES)[number];
export const BONE_INDEX: Readonly<Record<ArmorBone, number>> = Object.fromEntries(ARMOR_BONES.map((b, i) => [b, i])) as Record<ArmorBone, number>;

/** A rig mesh the armor can replace. */
export type RigPart = 'head' | 'visor' | 'torso' | 'upperArms' | 'forearms' | 'thighs' | 'shins';

export interface ArmorPart {
  /** Builder id (model.ts PARTS). */
  id: string;
  bone: ArmorBone;
  /** Which worn piece it belongs to (its finish). */
  slot: ArmorSlot;
  /** -1 left, 1 right, 0 centre. */
  side: -1 | 0 | 1;
}

export interface Finish {
  /** Main surface (plate, leather, cloth). */
  base: Surface;
  /** Second surface: mail under plate, darker leather, the robe's lining. */
  under: Surface;
  /** Edges, rivets, stitching. */
  edge: Surface;
  /** The rarity's accent (trim, buckle, band). */
  trim: Surface;
  /** The socketed gem's inlay (null: none). */
  gem: Surface | null;
  /** Faceted (plate) or smooth (leather, cloth, mail). */
  faceted: boolean;
  metal: boolean;
}

export interface ArmorSpec {
  /** The appearance number this was made from. */
  ap: number;
  pieces: (WornPiece | null)[];
  parts: ArmorPart[];
  hides: Record<RigPart, boolean>;
  finish: Partial<Record<ArmorSlot, Finish>>;
  /** Far-LOD box tint (null: nothing worn). */
  tint: THREE.Color | null;
  /** Mid LOD: the helmet's silhouette. */
  midHead: 'none' | 'cap' | 'hood' | 'closed' | 'nasal' | 'circlet';
  midBody: 'none' | 'short' | 'long';
  midLegs: boolean;
}

// ---- surfaces ----

interface Mat {
  base: Surface;
  under: Surface;
  edge: Surface;
  faceted: boolean;
  metal: boolean;
}

const MATS: Record<string, Mat> = {
  leather: { base: surf('#7a4d2b', 0, 0.82), under: surf('#4d301b', 0, 0.9), edge: surf('#d8c08c', 0, 0.75), faceted: false, metal: false },
  cloth: { base: surf('#43604a', 0, 0.95), under: surf('#2c3d31', 0, 0.95), edge: surf('#d9bf7a', 0.2, 0.6), faceted: false, metal: false },
  wood: { base: surf('#8a6a44', 0, 0.8), under: surf('#5e4529', 0, 0.85), edge: surf('#b99a6a', 0, 0.75), faceted: false, metal: false },
  // Stylized metal: half metallic, so plate keeps its colour in the scene's hemisphere and sun light
  // (no environment map) instead of going black away from the highlight; the shader adds a sky reflection.
  copper: { base: surf('#c4774a', 0.55, 0.4), under: surf('#9a6040', 0.5, 0.55), edge: surf('#f0b086', 0.6, 0.3), faceted: true, metal: true },
  iron: { base: surf('#9aa0a8', 0.55, 0.45), under: surf('#80868e', 0.5, 0.6), edge: surf('#d2d6db', 0.6, 0.32), faceted: true, metal: true },
  silver: { base: surf('#dfe5ec', 0.62, 0.22), under: surf('#a9b0b9', 0.55, 0.4), edge: surf('#ffffff', 0.65, 0.15), faceted: true, metal: true },
  // sunsteel glows a little everywhere, its edges more (the demon-killing metal: spec 7)
  sunsteel: { base: surf('#e9bb5a', 0.6, 0.22, 0.12), under: surf('#c99a48', 0.55, 0.35, 0.08), edge: surf('#fff2c4', 0.65, 0.15, 0.7), faceted: true, metal: true },
  starmetal: { base: surf('#a9b8ea', 0.6, 0.25, 0.06), under: surf('#7d8cc4', 0.55, 0.35), edge: surf('#e8eeff', 0.65, 0.18, 0.35), faceted: true, metal: true },
  voidglass: { base: surf('#46307a', 0.35, 0.1, 0.12), under: surf('#2e2050', 0.3, 0.2, 0.04), edge: surf('#b48ff2', 0.4, 0.08, 0.6), faceted: true, metal: true },
};

/** A material's armor surfaces (unknown: iron). */
export function armorPalette(key: string): Mat {
  return MATS[key] ?? MATS.iron;
}

/** Relic and above glow a little; Bitchin' is holographic (a negative glow tells the shader, material.ts). */
export const GLOW_FROM_RARITY = 3;
export const HOLO_RARITY = 7;

function trimOf(rarity: number, m: Mat): Surface {
  if (rarity <= 0) return shade(m.edge, 0.92);
  if (rarity >= HOLO_RARITY) return surf('#f4f0ff', 0.6, 0.2, -1);
  const c = ITEMS.rarities[rarity]?.color ?? '#9d9d9d';
  return surf(c, m.metal ? 0.6 : 0.2, 0.4, rarity >= GLOW_FROM_RARITY ? 0.25 + 0.1 * (rarity - GLOW_FROM_RARITY) : 0);
}

const OPAL = '#e8eefc';
const MOON = '#c8d4ff';

/** The inlay of items.yaml gem index g. */
export function gemFinish(g: number): Surface | null {
  const gem = g >= 0 ? ITEMS.gems[g] : undefined;
  if (!gem) return null;
  if (gem.element >= 0 && gem.element < 8) return surf(ELEMENT_COLORS[gem.element], 0.15, 0.1, gem.element === 6 ? 1.4 : 0.9);
  return surf(gem.key === 'opal' ? OPAL : MOON, 0.2, 0.1, 0.7);
}

export function finishOf(p: WornPiece): Finish {
  const m = armorPalette(p.material);
  let base = m.base;
  let edge = m.edge;
  if (p.rarity >= HOLO_RARITY) {
    // Bitchin': the whole piece shimmers through the spectrum (faintly), the trim strongly.
    base = { ...base, glow: -0.15 };
    edge = { ...edge, glow: -0.45 };
  } else if (p.rarity >= GLOW_FROM_RARITY) {
    edge = { ...edge, glow: Math.max(edge.glow, 0.12) };
  }
  return { base, under: m.under, edge, trim: trimOf(p.rarity, m), gem: gemFinish(p.gem), faceted: m.faceted, metal: m.metal };
}

// ---- parts ----

const both = (id: string, bone: 'shoulder' | 'elbow' | 'hip' | 'knee', slot: ArmorSlot): ArmorPart[] => [
  { id, bone: `${bone}L` as ArmorBone, slot, side: -1 },
  { id, bone: `${bone}R` as ArmorBone, slot, side: 1 },
];

/** Closed helms hide the face; iron's is an open nasal helm. */
export function helmKind(material: string): 'nasal' | 'closed' {
  return material === 'iron' || material === 'copper' || material === 'leather' ? 'nasal' : 'closed';
}

function headParts(p: WornPiece): ArmorPart[] {
  const at = (id: string): ArmorPart => ({ id, bone: 'neck', slot: 'head', side: 0 });
  const out: ArmorPart[] = [];
  switch (p.style) {
    case 'cap':
      out.push(at('cap'));
      break;
    case 'hood':
      out.push(at('hood'));
      break;
    case 'circlet':
      out.push(at('circlet'));
      break;
    case 'helm':
      if (helmKind(p.material) === 'nasal') out.push(at('helm.nasal'));
      else {
        out.push(at('helm.closed'));
        if (p.material === 'starmetal') out.push(at('helm.crest'));
        else if (p.material === 'voidglass') out.push(at('helm.spikes'));
        else if (p.material === 'sunsteel') out.push(at('helm.rays'));
        else out.push(at('helm.ridge'));
      }
      break;
  }
  if (p.gem >= 0 || p.style === 'circlet') out.push(at(`gem.${p.style}`));
  return out;
}

function bodyParts(p: WornPiece): ArmorPart[] {
  const at = (id: string, bone: ArmorBone = 'torso'): ArmorPart => ({ id, bone, slot: 'body', side: 0 });
  const out: ArmorPart[] = [at(`shell.${p.style}`), at('belt')];
  switch (p.style) {
    case 'jerkin':
      out.push(at('pauldrons.leather'), ...both('sleeve.short', 'shoulder', 'body'), ...both('bracer', 'elbow', 'body'));
      break;
    case 'cuirass':
      out.push(at('fauld', 'body'), at('pauldrons.plate'), ...both('sleeve.mail', 'shoulder', 'body'), ...both('vambrace', 'elbow', 'body'));
      break;
    case 'mail':
      out.push(at('skirt.mail', 'body'), at('tabard'), at('pauldrons.round'), ...both('sleeve.mail', 'shoulder', 'body'), ...both('bracer', 'elbow', 'body'));
      break;
    case 'robe':
      out.push(at('skirt.robe', 'body'), at('mantle'), ...both('sleeve.wide', 'shoulder', 'body'), ...both('cuff.wide', 'elbow', 'body'));
      break;
  }
  if (p.material === 'starmetal' || p.material === 'sunsteel' || p.material === 'voidglass') out.push(at(`emblem.${p.material}`));
  if (p.gem >= 0) out.push(at('gem.chest'));
  return out;
}

function legParts(p: WornPiece): ArmorPart[] {
  const out: ArmorPart[] = [];
  switch (p.style) {
    case 'leggings':
      out.push(...both('thigh.soft', 'hip', 'legs'), ...both('shin.soft', 'knee', 'legs'), ...both('boot', 'knee', 'legs'));
      break;
    case 'greaves':
      out.push(...both('thigh.mail', 'hip', 'legs'), ...both('kneecop', 'knee', 'legs'), ...both('greave', 'knee', 'legs'), ...both('sabaton', 'knee', 'legs'));
      break;
    case 'boots':
      out.push(...both('boot.tall', 'knee', 'legs'));
      break;
  }
  if (p.gem >= 0) out.push(...both('gem.knee', 'knee', 'legs'));
  return out;
}

const NO_HIDES: Record<RigPart, boolean> = { head: false, visor: false, torso: false, upperArms: false, forearms: false, thighs: false, shins: false };

/** The model spec of an appearance (pure; cached by the caller). */
export function armorSpec(ap: number): ArmorSpec {
  const pieces = unpackAppearance(ap);
  const [head, body, legs] = pieces;
  const hides = { ...NO_HIDES };
  const parts: ArmorPart[] = [];
  const finish: ArmorSpec['finish'] = {};
  let midHead: ArmorSpec['midHead'] = 'none';
  if (head) {
    parts.push(...headParts(head));
    finish.head = finishOf(head);
    if (head.style === 'helm') {
      midHead = helmKind(head.material);
      if (midHead === 'closed') hides.head = hides.visor = true;
    } else midHead = head.style as ArmorSpec['midHead'];
  }
  if (body) {
    parts.push(...bodyParts(body));
    finish.body = finishOf(body);
    hides.torso = hides.upperArms = hides.forearms = true;
  }
  if (legs) {
    parts.push(...legParts(legs));
    finish.legs = finishOf(legs);
    hides.shins = true;
    hides.thighs = legs.style !== 'boots';
  }
  // The far box: the body's colour (else the legs', else the head's), half way from the navy shirt.
  const main = finish.body ?? finish.legs ?? finish.head;
  const tint = main ? new THREE.Color(0x3b4a6b).lerp(main.base.color, 0.75) : null;
  return {
    ap,
    pieces,
    parts,
    hides,
    finish,
    tint,
    midHead,
    midBody: body ? (body.style === 'robe' || body.style === 'mail' ? 'long' : 'short') : 'none',
    midLegs: !!legs,
  };
}
