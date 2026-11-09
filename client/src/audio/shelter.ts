// "Is the listener under a roof / inside a building?" from the towns buffer
// (the same boxes the movement collides with, worldgen TownCollision), and
// "what is under their feet?" for footsteps. Pure queries over plain data,
// unit-tested on synthetic buildings (shelter.test.ts) and on the official
// world's towns when worldgen.wasm is built. The engine calls probe() at
// 10 Hz; each call is a handful of grid lookups.

import { BOX_FLAG, BOX_KINDS, BUILDING_FLAG, BUILDING_ROLES, ROOF_KINDS, type TownBoxes } from '@lodestone/worldgen';
import { SPACE_OUTDOORS } from './spatial';

/** The parts of a towns-buffer Building this needs. */
export interface ShelterBuilding {
  x: number;
  z: number;
  c: number;
  s: number;
  hx: number;
  hz: number;
  floorY: number;
  baseY: number;
  storey: number;
  floors: number;
  roof: number;
  role: number;
  flags: number;
}

/** What TownCollision offers (candidates is its grid query). */
export interface BoxQuery {
  readonly boxes: TownBoxes;
  candidates(x: number, z: number, m: number): number[];
  topAt(i: number, x: number, z: number): number;
}

export interface ShelterProbe {
  /** 0 open sky .. 1 covered overhead (centre and four points around it). */
  roof: number;
  /** 0 outdoors .. 1 inside closed walls (open-fronted forge 0.55). */
  indoors: number;
  /** Closed building the listener is in (spaceAt), or SPACE_OUTDOORS. */
  building: number;
  /** Rough room radius (m) for the reverb. */
  roomRadius: number;
}

/** Head height above the feet (TOWN_HEAD_M). */
export const HEAD_M = 1.9;
/** A roof further above the head than this is not "over you" (a bridge 30 m up). */
export const ROOF_REACH_M = 14;
const CELL = 16;
const ROLE = Object.fromEntries(BUILDING_ROLES.map((r, i) => [r, i])) as Record<(typeof BUILDING_ROLES)[number], number>;
const ROOF_NONE = ROOF_KINDS.indexOf('none');
const KIND = Object.fromEntries(BOX_KINDS.map((k, i) => [k, i])) as Record<(typeof BOX_KINDS)[number], number>;
/** Box kinds that never count as a roof over you (you stand next to them, not under them). */
const NOT_COVER = new Set([KIND.furniture, KIND.townProp, KIND.fence, KIND.railing, KIND.ramp, KIND.bridgeRamp]);
const key = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

/** Buildings with walls and a roof you can be inside (not stalls, gardens, fields). */
export function enclosed(b: ShelterBuilding): boolean {
  return b.floors > 0 && b.roof !== ROOF_NONE && (b.flags & BUILDING_FLAG.field) === 0 && b.role !== ROLE.stall && b.role !== ROLE.garden && b.role !== ROLE.farm;
}

export class ShelterIndex {
  private readonly cells = new Map<number, number[]>();

  constructor(
    readonly buildings: readonly ShelterBuilding[],
    readonly collision: BoxQuery | null,
  ) {
    buildings.forEach((b, i) => {
      if (!enclosed(b)) return;
      const r = Math.hypot(b.hx, b.hz);
      for (let cz = Math.floor((b.z - r) / CELL); cz <= Math.floor((b.z + r) / CELL); cz++)
        for (let cx = Math.floor((b.x - r) / CELL); cx <= Math.floor((b.x + r) / CELL); cx++) {
          const k = key(cx, cz);
          const l = this.cells.get(k);
          if (l) l.push(i);
          else this.cells.set(k, [i]);
        }
    });
  }

  /** The enclosed building whose walls contain (x, y, z), or SPACE_OUTDOORS. */
  buildingAt(x: number, y: number, z: number): number {
    const l = this.cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return SPACE_OUTDOORS;
    for (const i of l) {
      const b = this.buildings[i];
      const dx = x - b.x;
      const dz = z - b.z;
      const u = dx * b.c + dz * b.s;
      const v = dz * b.c - dx * b.s;
      if (Math.abs(u) > b.hx || Math.abs(v) > b.hz) continue;
      if (y < Math.min(b.baseY, b.floorY) - 0.5 || y > b.floorY + b.floors * b.storey - 0.3) continue;
      return i;
    }
    return SPACE_OUTDOORS;
  }

  /** Is anything solid above the head at (x, z) (a roof, an upper floor, a bridge deck, a gate arch)? */
  roofOver(x: number, headY: number, z: number): boolean {
    const q = this.collision;
    if (!q) return false;
    const f = q.boxes.f;
    for (const i of q.candidates(x, z, 0)) {
      if (NOT_COVER.has(q.boxes.kind[i])) continue;
      const y0 = f[i * 9 + 6];
      if (y0 < headY - 0.1 || y0 > headY + ROOF_REACH_M) continue;
      if (!Number.isNaN(q.topAt(i, x, z))) return true;
    }
    return false;
  }

  /** Roof cover (centre weighted 0.4, four points 1.5 m around it 0.15 each) and the building around the listener. */
  probe(x: number, feetY: number, z: number): ShelterProbe {
    const head = feetY + HEAD_M;
    let roof = this.roofOver(x, head, z) ? 0.4 : 0;
    const R = 1.5;
    if (this.roofOver(x + R, head, z)) roof += 0.15;
    if (this.roofOver(x - R, head, z)) roof += 0.15;
    if (this.roofOver(x, head, z + R)) roof += 0.15;
    if (this.roofOver(x, head, z - R)) roof += 0.15;
    const bi = this.buildingAt(x, feetY + 0.5, z);
    if (bi < 0) return { roof, indoors: 0, building: SPACE_OUTDOORS, roomRadius: 4 };
    const b = this.buildings[bi];
    const open = (b.flags & BUILDING_FLAG.openFront) !== 0;
    return { roof: Math.max(roof, open ? 0.6 : 0.85), indoors: open ? 0.55 : 1, building: open ? SPACE_OUTDOORS : bi, roomRadius: Math.sqrt(b.hx * b.hz) };
  }

  /**
   * The acoustic space of a point for occlusion: a closed building's index,
   * else SPACE_OUTDOORS (an open-fronted forge is outdoors: nothing walls it
   * off from the street).
   */
  spaceAt(x: number, y: number, z: number): number {
    const bi = this.buildingAt(x, y, z);
    if (bi < 0 || (this.buildings[bi].flags & BUILDING_FLAG.openFront) !== 0) return SPACE_OUTDOORS;
    return bi;
  }

  /** The kind of walkable town box under the feet (BOX_KINDS name), or null on bare ground. */
  surfaceUnder(x: number, feetY: number, z: number): (typeof BOX_KINDS)[number] | null {
    const q = this.collision;
    if (!q) return null;
    let best = -Infinity;
    let kind = -1;
    for (const i of q.candidates(x, z, 0)) {
      if ((q.boxes.flags[i] & BOX_FLAG.walk) === 0) continue;
      const t = q.topAt(i, x, z);
      if (Number.isNaN(t) || Math.abs(t - feetY) > 0.3 || t <= best) continue;
      best = t;
      kind = q.boxes.kind[i];
    }
    return kind >= 0 ? BOX_KINDS[kind] : null;
  }
}
