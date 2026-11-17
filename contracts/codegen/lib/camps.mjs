// camps.yaml -> normalized camp tables (playtest 2, CR 025).
//
// Like content.mjs: the pieces map becomes an array with stable 1-based ids,
// every kit and the fire's wood are checked against items.yaml, and the
// same object is emitted as a TS module (client: the build menu, the ghost,
// the collision twin) and as JSON embedded by server/pkg/campdefs (zone).
import { HEADER_NOTE } from './util.mjs';
import { parseBuild } from './build.mjs'; // CR 041: base building appends its pieces

function fail(msg) {
  throw new Error(`camps.yaml: ${msg}`);
}

const num = (v, what, min = 0) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail(`${what}: a number >= ${min}`);
  return v;
};

/** Parse and validate; `items` is the normalized item table. */
export function parseCamps(doc, items, buildDoc) {
  if (doc.version !== 1) fail('version must be 1');
  const itemKeys = new Set(items.items.map((i) => i.key));
  const item = (k, what) => {
    if (!itemKeys.has(k)) fail(`${what}: unknown item ${k}`);
    return k;
  };
  const l = doc.limits;
  const limits = { maxPieces: num(l.maxPieces, 'limits.maxPieces', 1), campRadiusM: num(l.campRadiusM, 'limits.campRadiusM', 1), reachM: num(l.reachM, 'limits.reachM', 1) };
  const p = doc.placement;
  if (p.rotSteps !== 8) fail('placement.rotSteps must be 8 (45 degree steps: exact cos/sin on both sides)');
  const placement = {
    rotSteps: 8,
    maxSlopeDeg: num(p.maxSlopeDeg, 'placement.maxSlopeDeg'),
    maxSpreadM: num(p.maxSpreadM, 'placement.maxSpreadM'),
    townMarginM: num(p.townMarginM, 'placement.townMarginM'),
    otherCampM: num(p.otherCampM, 'placement.otherCampM'),
    gapM: num(p.gapM, 'placement.gapM'),
    bodyClearM: num(p.bodyClearM, 'placement.bodyClearM'),
    maxDepthM: num(p.maxDepthM, 'placement.maxDepthM'),
  };
  const d = doc.decay;
  const decay = { days: num(d.days, 'decay.days', 1), visitM: num(d.visitM, 'decay.visitM', 1), checkEveryS: num(d.checkEveryS, 'decay.checkEveryS', 1) };
  const f = doc.fire;
  const fire = {
    wood: item(f.wood, 'fire.wood'),
    kitHours: num(f.kitHours, 'fire.kitHours'),
    hoursPerWood: num(f.hoursPerWood, 'fire.hoursPerWood', 0.1),
    maxHours: num(f.maxHours, 'fire.maxHours', 1),
    safeRadiusM: num(f.safeRadiusM, 'fire.safeRadiusM', 1),
    warmthM: num(f.warmthM, 'fire.warmthM', 1),
  };
  if (fire.kitHours > fire.maxHours) fail('fire.kitHours > fire.maxHours');
  const r = doc.rested;
  const rested = {
    durationS: num(r.durationS, 'rested.durationS', 1),
    fireBonusS: num(r.fireBonusS, 'rested.fireBonusS'),
    staminaBonus: num(r.staminaBonus, 'rested.staminaBonus'),
    regenMult: num(r.regenMult, 'rested.regenMult', 1),
    manaRegenMult: num(r.manaRegenMult, 'rested.manaRegenMult', 1),
    combatLockS: num(r.combatLockS, 'rested.combatLockS'),
  };
  const chest = { slots: num(doc.chest.slots, 'chest.slots', 1) };
  if (chest.slots > 32) fail('chest.slots: at most 32');
  const keys = Object.keys(doc.pieces);
  for (const k of ['campfire', 'bedroll', 'chest', 'workbench', 'signpost']) if (!keys.includes(k)) fail(`pieces: ${k} is required (the zone's rules name it)`);
  const pieces = keys.map((key, i) => {
    const pc = doc.pieces[key];
    if (!Array.isArray(pc.footprint) || pc.footprint.length !== 2) fail(`pieces.${key}.footprint: [width, depth]`);
    const kit = item(pc.kit, `pieces.${key}.kit`);
    if (!kit.startsWith('camp:')) fail(`pieces.${key}.kit: a camp: item`);
    return {
      key,
      id: i + 1,
      name: pc.name,
      kit,
      w: num(pc.footprint[0], `pieces.${key}.footprint`, 0.1),
      d: num(pc.footprint[1], `pieces.${key}.footprint`, 0.1),
      height: num(pc.height, `pieces.${key}.height`, 0.05),
      solid: !!pc.solid,
      max: num(pc.max ?? limits.maxPieces, `pieces.${key}.max`, 1),
      desc: pc.desc ?? '',
    };
  });
  if (pieces.length > 15) fail('pieces: at most 15');
  // CR 041: the building pieces follow (ids 100+ and 200+; camps keep 1-5).
  const built = parseBuild(buildDoc, itemKeys);
  for (const b of built.pieces) if (pieces.some((q) => q.id === b.id)) fail(`build piece ${b.key}: id ${b.id} taken`);
  return { version: doc.version, limits, placement, decay, fire, rested, chest, build: built.config, pieces: [...pieces, ...built.pieces] };
}

export function genCampsJson(d) {
  return JSON.stringify(d, null, 1) + '\n';
}

const TS_TYPES = `
export type Pt3 = [number, number, number]; // x, z, y in cm (local frame)
export type Box6 = [number, number, number, number, number, number]; // x0, x1, z0, z1, y0, y1 in cm (local frame)
export interface BuildShape {
  cat: 'structure' | 'furnish'; base: string; mat: number; // mat: index into build.materials, -1 none
  par: [number, number] | null; // cm parity (0 even, 100 odd) of the position at rot 0; null: every 0.5 m
  anchor: ('foundation' | 'ground' | 'sockets' | 'surface' | 'wall')[]; gpt: [number, number];
  boxes: Box6[]; openBoxes: Box6[] | null; door: boolean; surface: Box6 | null; occ: Box6;
  up: Pt3[]; down: Pt3[]; side: Pt3[]; face: Pt3[]; reach: number; coexist: string[];
  cost: { item: string; qty: number }[]; comfort: number; use: '' | 'bed' | 'chest' | 'forge' | 'cook' | 'workbench' | 'hearth'; slots: number; light: number;
}
export interface CampPieceDef { key: string; id: number; name: string; kit: string; w: number; d: number; height: number; solid: boolean; max: number; desc: string; build?: BuildShape }
export interface BuildConfig {
  grid: { cellM: number; levelM: number; maxLevels: number };
  budget: number; areaBudget: number; reachM: number; townMarginM: number; siteMarginM: number; roadMarginM: number; otherBuildM: number;
  refundPct: number; repairPct: number; weatherFloor: number; mendPerDay: number; decayDays: number;
  foundation: { maxSpreadM: number; maxBuriedM: number; skirtM: number; snapM: number }; maxHeightM: number;
  hearth: { wardRadiusM: number; warmthM: number };
  comfort: { radiusM: number; perKindCap: number; maxScore: number; tiers: { score: number; name: string }[]; durationPct: number; regenPct: number };
  home: { cooldownS: number };
  materials: { key: string; index: number; name: string; perUnit: { item: string; qty: number }[]; weather: number }[];
}
export interface CampDefs {
  version: number;
  limits: { maxPieces: number; campRadiusM: number; reachM: number };
  placement: { rotSteps: number; maxSlopeDeg: number; maxSpreadM: number; townMarginM: number; otherCampM: number; gapM: number; bodyClearM: number; maxDepthM: number };
  decay: { days: number; visitM: number; checkEveryS: number };
  fire: { wood: string; kitHours: number; hoursPerWood: number; maxHours: number; safeRadiusM: number; warmthM: number };
  rested: { durationS: number; fireBonusS: number; staminaBonus: number; regenMult: number; manaRegenMult: number; combatLockS: number };
  chest: { slots: number };
  build: BuildConfig;
  pieces: CampPieceDef[];
}
`;

export function genCampsTs(d) {
  return `// ${HEADER_NOTE}\n// Source: contracts/camps.yaml (normalized by contracts/codegen/lib/camps.mjs)\n/* eslint-disable */\n${TS_TYPES}\nexport const CAMPS: CampDefs = ${JSON.stringify(d)};\n`;
}
