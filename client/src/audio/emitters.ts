// Where the world's sound sources are (pure over the towns buffer;
// emitters.test.ts). Every fire prop (hearths, forges, campfires, braziers,
// wall torches) and every campfire piece of a structure or camp is a
// positional loop emitter; every forge is also where a smith hammers by day.
// They are static, so they are gathered once into a coarse grid and the
// engine asks for the ones near the listener (10 Hz).

import { PIECE_KINDS, PROP_KINDS, type TownPiece, type TownProp } from '@lodestone/worldgen';
import type { LoopEmitter } from './loopPool';
import type { LoopKind } from './spatial';

const PK = Object.fromEntries(PROP_KINDS.map((k, i) => [k, i])) as Record<(typeof PROP_KINDS)[number], number>;
const PIECE_CAMPFIRE = PIECE_KINDS.indexOf('campfire');

/** Fire prop kind -> loop category, and the flame height above the prop's y. */
const FIRE_PROPS = new Map<number, { kind: LoopKind; dy: number }>([
  [PK.hearth, { kind: 'hearth', dy: 0.5 }],
  [PK.forge, { kind: 'forge', dy: 1 }],
  [PK.campfire, { kind: 'campfire', dy: 0.3 }],
  [PK.brazier, { kind: 'brazier', dy: 1 }],
  [PK.torch, { kind: 'torch', dy: 0 }],
]);

export interface Hammer {
  id: string;
  x: number;
  y: number;
  z: number;
  space: number;
}

/** A coarse grid of points for "what is near the listener". */
export class PointGrid<T extends { x: number; z: number }> {
  private readonly cells = new Map<number, T[]>();
  readonly size: number;

  constructor(
    items: Iterable<T>,
    readonly cell = 64,
  ) {
    let n = 0;
    for (const it of items) {
      const k = this.key(Math.floor(it.x / cell), Math.floor(it.z / cell));
      const l = this.cells.get(k);
      if (l) l.push(it);
      else this.cells.set(k, [it]);
      n++;
    }
    this.size = n;
  }

  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  /** Items in the cells overlapping the square of half-size r around (x, z) (callers measure exact distance). */
  *near(x: number, z: number, r: number): Generator<T> {
    const c = this.cell;
    for (let cz = Math.floor((z - r) / c); cz <= Math.floor((z + r) / c); cz++)
      for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++) {
        const l = this.cells.get(this.key(cx, cz));
        if (l) yield* l;
      }
  }
}

/**
 * Fire loop emitters and forge hammer spots from the towns buffer. `space`
 * says which closed building a point is in (occlusion). Fires closer than
 * 1.5 m to one already taken are the same fire (a camp's campfire piece and
 * its prop).
 */
export function townEmitters(towns: { props: readonly TownProp[]; pieces: readonly TownPiece[] }, space: (x: number, y: number, z: number) => number): { fires: LoopEmitter[]; hammers: Hammer[] } {
  const fires: LoopEmitter[] = [];
  const hammers: Hammer[] = [];
  const taken = new Map<string, { x: number; z: number }[]>();
  const add = (id: string, kind: LoopKind, x: number, y: number, z: number) => {
    const k = `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const p of taken.get(`${Math.floor(x / 4) + dx},${Math.floor(z / 4) + dz}`) ?? []) if (Math.hypot(p.x - x, p.z - z) < 1.5) return;
    const l = taken.get(k);
    if (l) l.push({ x, z });
    else taken.set(k, [{ x, z }]);
    fires.push({ id, kind, x, y, z, space: space(x, y, z) });
  };
  for (const p of towns.props) {
    const f = FIRE_PROPS.get(p.kind);
    if (!f) continue;
    const id = `prop:${p.id}`;
    add(id, f.kind, p.x, p.y + f.dy, p.z);
    if (p.kind === PK.forge) hammers.push({ id, x: p.x, y: p.y + 1, z: p.z, space: space(p.x, p.y + 1, p.z) });
  }
  for (const p of towns.pieces) if (p.kind === PIECE_CAMPFIRE) add(`piece:${p.id}`, 'campfire', p.x, p.y + 0.3, p.z);
  return { fires, hammers };
}

/**
 * A smith's rhythm at a forge: bursts of 2-4 strikes ~0.45 s apart, then a
 * pause of 2.5-6 s (pure; `rnd` injectable). Returns the delay (s) to the
 * next strike and the strikes left in this burst.
 */
export function nextStrike(left: number, rnd: () => number = Math.random): { delayS: number; left: number } {
  if (left > 0) return { delayS: 0.38 + rnd() * 0.14, left: left - 1 };
  return { delayS: 2.5 + rnd() * 3.5, left: 1 + Math.floor(rnd() * 3) };
}
