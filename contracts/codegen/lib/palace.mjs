// palace.yaml -> the sky palace's collision layout and gameplay table
// (playtest 3, CR 044). The layout is authored here in the palace's local
// frame (x right, z toward the gate, y up from the floor, metres) and
// expanded into one explicit box list, so the zone (server/pkg/palace) and
// the client (client/src/world/palace) read identical numbers.
//
// Box record: [kind, flags, cx, cz, hx, hz, y0, y1, y2] (towns box kinds:
// 0 floor, 1 wall, 2 upper, 3 roof; flags 1 walk, 2 solid, 4 ceiling).
import { HEADER_NOTE } from './util.mjs';

function fail(msg) {
  throw new Error(`palace.yaml: ${msg}`);
}

const K = { floor: 0, wall: 1, upper: 2, roof: 3 };
const F = { walk: 1, solid: 2, ceil: 4 };

// ---- the plan (local metres) ----
const HX = 28; // outer wall centre lines
const HZ = 40;
const T = 1; // half wall thickness
const H = 10; // ground rooms' wall height (ceiling underside)
const DOOR_H = 6.5;
const RING_Y = 14; // the atrium's upper gallery and the throne hall floor
const ATRIUM_TOP = 30;
const THRONE_TOP = 28;
const SHAFT = { x: 0, z: -5, r: 5.5, top: RING_Y + 3.5, lift: 15 };

/** Build the boxes. */
function layout() {
  const boxes = [];
  const box = (kind, flags, x0, x1, z0, z1, y0, y1, y2 = y1) => {
    boxes.push([kind, flags, (x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, y0, y1, y2]);
  };
  // A wall along x (z fixed) or z (x fixed), with gaps [a, b] along its length: pieces between the gaps, lintels over them.
  const wallX = (z, x0, x1, gaps, yTop = H, yBase = -1) => {
    let a = x0;
    for (const [g0, g1] of [...gaps].sort((p, q) => p[0] - q[0])) {
      if (g0 > a) box(K.wall, F.solid, a, g0, z - T, z + T, yBase, yTop);
      if (yTop > DOOR_H) box(K.upper, F.solid, g0, g1, z - T, z + T, DOOR_H, yTop);
      a = g1;
    }
    if (x1 > a) box(K.wall, F.solid, a, x1, z - T, z + T, yBase, yTop);
  };
  const wallZ = (x, z0, z1, gaps, yTop = H, yBase = -1) => {
    let a = z0;
    for (const [g0, g1] of [...gaps].sort((p, q) => p[0] - q[0])) {
      if (g0 > a) box(K.wall, F.solid, x - T, x + T, a, g0, yBase, yTop);
      if (yTop > DOOR_H) box(K.upper, F.solid, x - T, x + T, g0, g1, DOOR_H, yTop);
      a = g1;
    }
    if (z1 > a) box(K.wall, F.solid, x - T, x + T, a, z1, yBase, yTop);
  };
  const column = (x, z, y0, y1) => box(K.wall, F.solid, x - 1, x + 1, z - 1, z + 1, y0, y1);
  const ceiling = (x0, x1, z0, z1, y) => box(K.roof, F.ceil, x0, x1, z0, z1, y, y + 1);

  // The plinth the palace stands on (walkable top = the floor) and its front steps (0.4 m rises, then the island).
  box(K.floor, F.walk | F.solid, -34, 34, -46, 46, -8, 0);
  for (let i = 0; i < 5; i++) box(K.floor, F.walk | F.solid, -8, 8, 46 + i * 1.5, 47.5 + i * 1.5, -8, -0.4 * (i + 1));
  // Outer walls (12 m, a parapet over the 10 m ceilings), the gate in the front.
  wallZ(-HX, -HZ - T, HZ + T, [], 12);
  wallZ(HX, -HZ - T, HZ + T, [], 12);
  wallX(-HZ, -HX + T, HX - T, [], ATRIUM_TOP); // the throne hall's back wall
  wallX(HZ, -HX + T, HX - T, [[-4, 4]], 12);
  // Inner wall lines (x = +-14), doorways to the annexes, the galleries and the wings.
  for (const sx of [-1, 1]) {
    const x = sx * 14;
    wallZ(x, -HZ + T, -14 - T, [], ATRIUM_TOP); // throne block side
    wallZ(x, -14 + T, 4 - T, [[-8, -2]], ATRIUM_TOP); // atrium <-> wing
    wallZ(x, 4 + T, 26 - T, [[13, 19]], H); // colonnade <-> gallery
    wallZ(x, 26 + T, HZ - T, [[31, 35]], H); // vestibule <-> annex
  }
  // Cross walls: vestibule | colonnade, colonnade | atrium (central doorways), the throne block's front.
  wallX(26, -HX + T, HX - T, [[-3, 3]], H);
  wallX(4, -HX + T, HX - T, [[-3, 3]], H);
  wallX(-14, -HX + T, -4, [], ATRIUM_TOP);
  wallX(-14, 4, HX - T, [], ATRIUM_TOP);
  // The throne hall's doorway above the ring: a solid base to the floor, a lintel over it.
  box(K.wall, F.solid, -4, 4, -14 - T, -14 + T, -1, RING_Y);
  box(K.upper, F.solid, -4, 4, -14 - T, -14 + T, RING_Y + 7, ATRIUM_TOP);
  // The throne block (floor at the ring's height) and the towers' solid cores either side of it.
  box(K.floor, F.walk | F.solid, -14, 14, -HZ + T, -14 - T, -1, RING_Y);
  box(K.wall, F.solid, -HX + T, -14 - T, -HZ + T, -14 - T, -1, ATRIUM_TOP);
  box(K.wall, F.solid, 14 + T, HX - T, -HZ + T, -14 - T, -1, ATRIUM_TOP);
  // The atrium's upper gallery (0 m wide at the shaft): four slabs round a 20 x 10 hole.
  box(K.floor, F.walk | F.solid, -14 + T, 14 - T, -14 + T, -10, RING_Y - 2, RING_Y);
  box(K.floor, F.walk | F.solid, -14 + T, 14 - T, 0, 4 - T, RING_Y - 2, RING_Y);
  box(K.floor, F.walk | F.solid, -14 + T, -10, -10, 0, RING_Y - 2, RING_Y);
  box(K.floor, F.walk | F.solid, 10, 14 - T, -10, 0, RING_Y - 2, RING_Y);
  // Columns: vestibule, colonnade, throne hall, the front portico.
  for (const sx of [-1, 1]) {
    for (const z of [29, 37]) column(sx * 8, z, 0, H);
    for (const z of [8, 12, 20, 24]) column(sx * 8, z, 0, H);
    for (const z of [-20, -26, -32]) column(sx * 9, z, RING_Y, THRONE_TOP);
  }
  for (const x of [-20, -14, -8, 8, 14, 20]) column(x, 44, 0, 9);
  // Ceilings (and the portico roof): shelter and a head height.
  ceiling(-HX + T, -14 - T, 26 + T, HZ - T, H);
  ceiling(14 + T, HX - T, 26 + T, HZ - T, H);
  ceiling(-14 + T, 14 - T, 26 + T, HZ - T, H);
  ceiling(-HX + T, -14 - T, 4 + T, 26 - T, H);
  ceiling(14 + T, HX - T, 4 + T, 26 - T, H);
  ceiling(-14 + T, 14 - T, 4 + T, 26 - T, H);
  ceiling(-HX + T, -14 - T, -14 + T, 4 - T, H);
  ceiling(14 + T, HX - T, -14 + T, 4 - T, H);
  ceiling(-14 + T, 14 - T, -14 + T, 4 - T, ATRIUM_TOP);
  ceiling(-14 + T, 14 - T, -HZ + T, -14 - T, THRONE_TOP);
  ceiling(-24, 24, HZ + T, 46, 9);
  return boxes;
}

const round = (v) => Math.round(v * 1000) / 1000;

/** Parse and validate; `items` is the normalized item table, `combat` the normalized combat table. */
export function parsePalace(doc, items, combat) {
  if (doc.version !== 1) fail('version must be 1');
  const num = (v, what, min = 0) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail(`${what}: a number >= ${min}`);
    return v;
  };
  const rar = items.rarities.findIndex((r) => r.key === doc.chest.minRarity);
  if (rar < 0) fail(`chest.minRarity: unknown rarity ${doc.chest.minRarity}`);
  if (!combat.bosses.some((b) => b.key === doc.boss)) fail(`boss: unknown boss ${doc.boss}`);
  if (doc.wards.length !== 3) fail('wards: exactly three');
  const wardPos = [
    [-21, 15, 0],
    [21, 15, 0],
    [-12, -4.5, RING_Y],
  ];
  const wards = doc.wards.map((w, i) => ({ key: w.key, name: w.name, hint: w.hint, x: wardPos[i][0], z: wardPos[i][1], y: wardPos[i][2] }));
  const packs = [
    { room: 'colonnade', x: 0, z: 16, y: 0, comp: ['sentinel', 'sentinel', 'wisp'], elite: 'shielded' },
    { room: 'sun gallery', x: -21, z: 10, y: 0, comp: ['gale_harpy', 'gale_harpy', 'lumen_moth'], elite: '' },
    { room: 'moon gallery', x: 21, z: 10, y: 0, comp: ['wisp', 'spark_wisp', 'wisp'], elite: '' },
    { room: 'west annex', x: -21, z: 33, y: 0, comp: ['gale_harpy', 'gale_harpy'], elite: 'fast' },
    { room: 'east annex', x: 21, z: 33, y: 0, comp: ['lumen_moth', 'lumen_moth'], elite: '' },
    { room: 'west wing', x: -21, z: -5, y: 0, comp: ['sentinel', 'sentinel'], elite: '' },
    { room: 'east wing', x: 21, z: -5, y: 0, comp: ['sentinel', 'spark_wisp'], elite: 'splitting' },
    { room: 'atrium', x: 0, z: -5, y: 0, comp: ['wisp', 'wisp', 'lumen_moth'], elite: '' },
    { room: 'upper gallery', x: 0, z: -12, y: RING_Y, comp: ['gale_harpy', 'lumen_moth', 'spark_wisp'], elite: 'fast' },
  ];
  for (const p of packs) for (const k of p.comp) if (!combat.enemies.some((e) => e.key === k)) fail(`pack ${p.room}: unknown enemy ${k}`);
  const boxes = layout().map((b) => b.map(round));
  return {
    version: 1,
    floorAboveTopM: num(doc.floorAboveTopM, 'floorAboveTopM'),
    activeM: num(doc.activeM, 'activeM', 1),
    resetS: num(doc.resetS, 'resetS', 1),
    reachM: num(doc.reachM, 'reachM', 1),
    boss: doc.boss,
    chest: { gold: doc.chest.gold, minRarity: rar, items: doc.chest.items, luck: doc.chest.luck, cooldownH: doc.chest.cooldownH, x: 0, z: -37, y: RING_Y },
    wards,
    packs,
    door: { x: 0, z: HZ + 1.5, y: 0, w: 8, h: DOOR_H },
    shaft: SHAFT,
    arena: { x: 0, z: -27, y: RING_Y, r: 12 },
    half: { x: 34, z: 46 },
    ringY: RING_Y,
    atriumTop: ATRIUM_TOP,
    throneTop: THRONE_TOP,
    wallH: H,
    boxes,
  };
}

const TS_TYPES = `
export interface PalaceWard { key: string; name: string; hint: string; x: number; z: number; y: number }
export interface PalacePack { room: string; x: number; z: number; y: number; comp: string[]; elite: string }
export interface PalaceDefs {
  version: number; floorAboveTopM: number; activeM: number; resetS: number; reachM: number; boss: string;
  chest: { gold: [number, number]; minRarity: number; items: number; luck: number; cooldownH: number; x: number; z: number; y: number };
  wards: PalaceWard[]; packs: PalacePack[];
  door: { x: number; z: number; y: number; w: number; h: number };
  shaft: { x: number; z: number; r: number; top: number; lift: number };
  arena: { x: number; z: number; y: number; r: number };
  half: { x: number; z: number }; ringY: number; atriumTop: number; throneTop: number; wallH: number;
  /** [kind, flags, cx, cz, hx, hz, y0, y1, y2] in the palace's local frame. */
  boxes: number[][];
}
`;

export function genPalaceTs(d) {
  return `// ${HEADER_NOTE}\n// Source: contracts/palace.yaml (layout: contracts/codegen/lib/palace.mjs)\n/* eslint-disable */\n${TS_TYPES}\nexport const PALACE: PalaceDefs = ${JSON.stringify(d)};\n`;
}

export function genPalaceJson(d) {
  return JSON.stringify(d) + '\n';
}
