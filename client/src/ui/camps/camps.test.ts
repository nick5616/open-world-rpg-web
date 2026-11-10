// Camps (playtest 2, CR 025): the collision twin replays
// server/pkg/camps/testdata/camps.json (written by the Go port) bit for
// bit; the camp ground passes through without pieces; the placement
// preview's rules (the zone's, mirrored); the ghost's spot and facing; the
// wire decoders and the store reducer.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAMPS, type Event as ZoneEvent } from '@lodestone/contracts';
import { repoRoot } from '../../sim/dev/traversalRun';
import type { CollideResult, GroundQuery } from '../../sim/ground';
import { CampGround, CampSet, campBox, campRuntime } from './collide';
import { CAMP_EV, PIECE, decodeArea, decodePiece, decodeRemoved, labelChunks, placeTarget } from './events';
import { checkPlacement, corners, facingRot, footprint, ghostSpot, overlaps, type PlaceEnv, type Placed, type Want } from './placement';
import { emptyMine, reduceCampEvent, safeByFire, type CampState } from './store';

interface VecFile {
  pieces: { id: number; kind: number; rot: number; x: number; y: number; z: number }[];
  boxes: number[][];
  ids: number[];
  collide: { in: number[]; out: number[] }[];
}

describe('camp collision vs the Go port (testdata/camps.json)', () => {
  const file = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'pkg', 'camps', 'testdata', 'camps.json'), 'utf8')) as VecFile;
  const set = new CampSet(file.pieces.map((p) => ({ id: p.id, kind: p.kind, rot: p.rot, x: p.x / 100, y: p.y / 100, z: p.z / 100 })));

  it('builds the same boxes in the same order', () => {
    expect(set.ids).toEqual(file.ids);
    expect(set.size).toBe(file.boxes.length);
    for (let i = 0; i < set.size; i++) expect(set.f.slice(i * 9, i * 9 + 9)).toEqual(file.boxes[i]);
  });

  it('pushes bit for bit', () => {
    const out: CollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };
    let pushed = 0;
    for (const c of file.collide) {
      const [x, y, z, px, pz] = c.in;
      set.after({ x, y, z, pushX: px, pushZ: pz, ceiling: false }, out);
      expect([out.x, out.z, out.pushX, out.pushZ]).toEqual(c.out);
      if (out.x !== x) pushed++;
    }
    expect(pushed).toBeGreaterThan(50);
  });
});

describe('camp ground', () => {
  class Walls implements GroundQuery {
    heightAt() {
      return 10;
    }
    atLevel() {
      return this;
    }
    collide(x: number, y: number, z: number, out: CollideResult) {
      out.x = x;
      out.y = y;
      out.z = z;
      out.pushX = 0;
      out.pushZ = 0;
      out.ceiling = false;
      return out;
    }
  }
  it('is the inner ground without pieces, and pushes out of a chest with one', () => {
    const inner = new Walls();
    const g = new CampGround(inner);
    campRuntime.set = new CampSet([]);
    expect(g.atLevel(10)).toBe(inner);
    campRuntime.set = new CampSet([{ id: 5, kind: PIECE.chest, rot: 0, x: 100, y: 10, z: 100 }]);
    const out: CollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };
    g.atLevel(10).collide!(100.3, 10, 100, out);
    expect(out.x).toBeCloseTo(100 + 0.6 + 0.4, 9);
    // A campfire is not solid: no set entry at all.
    campRuntime.set = new CampSet([{ id: 6, kind: PIECE.campfire, rot: 0, x: 100, y: 10, z: 100 }]);
    expect(campRuntime.set.size).toBe(0);
    campRuntime.set = new CampSet([]);
  });
  it('a box spans the footprint from under the base to the top', () => {
    const b = campBox(PIECE.workbench, 2, 1, 2, 3);
    const def = CAMPS.pieces[PIECE.workbench - 1];
    expect(b).toEqual([1, 3, 0, 1, def.w / 2, def.d / 2, 2 - 0.5, 2 + def.height, 2 + def.height]);
  });
});

// Open dry ground (height 50 + slope x), a town at (500, 500) r 60, a structure 6 x 6 at (1200, 1200).
function env(slope = 0, water = -100): PlaceEnv {
  return {
    heightAt: (x) => 50 + slope * x,
    waterAt: () => water,
    inTown: (x, z, m) => Math.hypot(x - 500, z - 500) < 60 + m,
    structure: (f) => overlaps(f, { x: 1200, z: 1200, c: 1, s: 0, hx: 3, hz: 3 }),
  };
}
const want = (kind: number, x: number, z: number, extra: Partial<Want> = {}): Want => ({ kind, rot: 0, x, z, feetX: x - 2, feetY: 1e4, feetZ: z, kits: 1, ...extra });

describe('placement preview (the zone rules, mirrored)', () => {
  it('green on open ground; red for each rule', () => {
    expect(checkPlacement(want(PIECE.campfire, 1000, 1000), [], env())).toEqual({ y: 50, reason: 0 });
    const mineFire: Placed = { id: 1, kind: PIECE.campfire, rot: 0, x: 1000, z: 1000, mine: true };
    const theirFire: Placed = { ...mineFire, mine: false };
    const cases: [string, Want, Placed[], PlaceEnv, number][] = [
      ['no kit', want(PIECE.chest, 1000, 1000, { kits: 0 }), [], env(), 11],
      ['too far', want(PIECE.chest, 1000, 1000, { feetX: 990 }), [], env(), 2],
      ['in town', want(PIECE.chest, 560, 500), [], env(), 3],
      ['steep', want(PIECE.workbench, 1000, 1000), [], env(0.9), 4],
      ['water', want(PIECE.chest, 1000, 1000), [], env(0, 60), 5],
      ['structure', want(PIECE.chest, 1203, 1200), [], env(), 6],
      ['underground', want(PIECE.chest, 1000, 1000, { feetY: 40 }), [], env(), 13],
      ['overlap', want(PIECE.chest, 1000.5, 1000), [mineFire], env(), 6],
      ["someone else's camp", want(PIECE.chest, 1005, 1000), [theirFire], env(), 7],
      ['outside your camp', want(PIECE.chest, 1000 + CAMPS.limits.campRadiusM + 1, 1000), [mineFire], env(), 10],
      ['one bedroll', want(PIECE.bedroll, 1004, 1000), [{ ...mineFire, kind: PIECE.bedroll }], env(), 9],
    ];
    for (const [name, w, near, e, reason] of cases) expect(checkPlacement(w, near, e).reason, name).toBe(reason);
    const full: Placed[] = [PIECE.campfire, PIECE.campfire, PIECE.chest, PIECE.chest, PIECE.workbench, PIECE.signpost].map((kind, i) => ({ id: i + 1, kind, rot: 0, x: 990 + i * 2, z: 990, mine: true }));
    expect(checkPlacement(want(PIECE.bedroll, 1000, 1004), full, env()).reason).toBe(8);
    expect(checkPlacement(want(PIECE.chest, 1002.5, 1000), [mineFire], env()).reason).toBe(0);
    const sloped = checkPlacement(want(PIECE.campfire, 1000, 1000), [], env(0.1));
    expect(sloped.reason).toBe(0);
    expect(sloped.y).toBeCloseTo(150, 2);
  });

  it('footprints turn in 45 degree steps', () => {
    const f = footprint(PIECE.workbench, 2, 0, 0);
    const xs = corners(f).map((c) => Math.abs(c[0]));
    expect(Math.max(...xs)).toBeCloseTo(CAMPS.pieces[PIECE.workbench - 1].d / 2, 9); // rotated 90: depth along x
    expect(overlaps(footprint(PIECE.workbench, 0, 0, 0), footprint(PIECE.workbench, 0, 2.0, 0))).toBe(false);
    expect(overlaps(footprint(PIECE.workbench, 0, 0, 0), footprint(PIECE.workbench, 0, 1.8, 0))).toBe(true);
  });

  it('the ghost goes ahead of you and faces you', () => {
    // yaw 0 looks toward -z.
    expect(ghostSpot(100, 100, 0, 3)).toEqual({ x: 100, z: 97 });
    const g = ghostSpot(100, 100, Math.PI / 2, 3); // looking toward -x
    expect(g.x).toBeCloseTo(97, 6);
    // The piece's front (local +z: (-sin a, cos a)) points back at the player.
    for (const yaw of [0, Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const r = facingRot(yaw);
      const a = (r * Math.PI) / 4;
      const front = [-Math.sin(a), Math.cos(a)];
      const back = [Math.sin(yaw), Math.cos(yaw)];
      expect(front[0]).toBeCloseTo(back[0], 6);
      expect(front[1]).toBeCloseTo(back[1], 6);
    }
  });
});

function record(id: number, kind: number, rot: number, x: number, y: number, z: number, flags: number, leftMs: number, used: number, owner: string, label: string): number[] {
  const b: number[] = [];
  const u32 = (v: number) => b.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  u32(id % 4294967296);
  u32(Math.floor(id / 4294967296));
  b.push(kind, rot);
  u32(x);
  u32(y);
  u32(z);
  b.push(flags);
  u32(leftMs);
  b.push(used, owner.length, ...[...owner].map((c) => c.charCodeAt(0)), label.length, ...[...label].map((c) => c.charCodeAt(0)));
  return b;
}

const ev = (kind: number, data: number[] | Uint8Array, extra: Partial<ZoneEvent> = {}): ZoneEvent => ({ kind, entityId: 0, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: data instanceof Uint8Array ? data : new Uint8Array(data), ...extra }) as ZoneEvent;

describe('camp wire', () => {
  const big = 2 ** 40 - 3;
  it('decodes piece records and areas (40-bit ids, negative heights)', () => {
    const r = record(big, PIECE.campfire, 3, 123456, -250, 234567, 1 | 8, 90000, 0, 'Ash', 'Home');
    const [p, next] = decodePiece(new Uint8Array(r), 0, 1000);
    expect(next).toBe(r.length);
    expect(p).toMatchObject({ id: big, kind: PIECE.campfire, rot: 3, x: 1234.56, y: -2.5, z: 2345.67, mine: true, burning: true, burnEnd: 91000, owner: 'Ash', label: 'Home' });
    const area = [1, 3, 0, 4, 0, 2, 0, ...r, ...record(7, PIECE.chest, 0, 1, 2, 3, 2 | 4, 0, 5, 'Bo', '')];
    const a = decodeArea(ev(CAMP_EV.area, area, { targetId: 4 * 64 + 3 }), 0);
    expect(a.pieces.map((q) => q.id)).toEqual([big, 7]);
    expect(a.pieces[1]).toMatchObject({ shared: true, party: true, used: 5, burning: false });
    const rm = new Uint8Array(8);
    new DataView(rm.buffer).setUint32(0, big % 4294967296, true);
    new DataView(rm.buffer).setUint32(4, Math.floor(big / 4294967296), true);
    expect(decodeRemoved(ev(CAMP_EV.removed, rm))).toBe(big);
  });

  it('packs placements and labels like the zone unpacks them', () => {
    const t = placeTarget(PIECE.signpost, 5, 409599, 12345);
    expect(Number(t & 0xffn)).toBe(PIECE.signpost);
    expect(Number((t >> 8n) & 0xffn)).toBe(5);
    expect(Number((t >> 16n) & 0xffffffn)).toBe(409599);
    expect(Number((t >> 40n) & 0xffffffn)).toBe(12345);
    const chunks = labelChunks('Camp Ash!');
    const bytes = chunks.flatMap((c) => [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff]);
    expect(String.fromCharCode(...bytes.slice(0, 9))).toBe('Camp Ash!');
    expect(bytes[9]).toBe(0);
    expect(labelChunks('x'.repeat(40)).length).toBe(7); // 24 characters + the terminator
  });
});

describe('camp store', () => {
  const base = (): Omit<CampState, 'actions'> => ({ pieces: {}, mine: emptyMine(), chest: null, rested: null, notes: [], placing: null, menu: false, labeling: null, selfId: 9 });
  it('areas add pieces, placements note, removals drop them and close their chest', () => {
    let s = base();
    const fire = record(11, PIECE.campfire, 0, 100000, 1000, 100000, 1 | 8, 60000, 0, 'Ash', '');
    s = { ...s, ...reduceCampEvent(s, ev(CAMP_EV.area, [1, 0, 0, 0, 0, 1, 0, ...fire]), 0) };
    expect(Object.keys(s.pieces)).toEqual(['11']);
    expect(safeByFire(s.pieces, 1005, 1000, 0)?.id).toBe(11);
    expect(safeByFire(s.pieces, 1000 + CAMPS.fire.safeRadiusM + 1, 1000, 0)).toBeNull();
    expect(safeByFire(s.pieces, 1005, 1000, 61000)).toBeNull(); // burnt out
    const chest = record(12, PIECE.chest, 0, 100200, 1000, 100000, 1, 0, 0, 'Ash', '');
    s = { ...s, ...reduceCampEvent(s, ev(CAMP_EV.piece, chest, { value: 1, entityId: 9 }), 0) };
    expect(s.notes.at(-1)?.text).toContain(CAMPS.pieces[PIECE.chest - 1].name);
    s = { ...s, ...reduceCampEvent(s, ev(CAMP_EV.chest, new TextEncoder().encode(JSON.stringify({ piece: 12, lock: 0, owner: 'Ash', mine: true, open: true, slots: [], shared: false }))), 0) };
    expect(s.chest?.piece).toBe(12);
    const rm = new Uint8Array(8);
    rm[0] = 12;
    s = { ...s, ...reduceCampEvent(s, ev(CAMP_EV.removed, rm, { value: 1 }), 0) };
    expect(s.pieces[12]).toBeUndefined();
    expect(s.chest).toBeNull();
  });
  it('Rested starts and ends; refusals become notes', () => {
    let s = base();
    s = { ...s, ...reduceCampEvent(s, ev(CAMP_EV.rested, new TextEncoder().encode(JSON.stringify({ staminaBonus: 25, regenMult: 2, manaRegenMult: 1.5, fire: true })), { value: 600 }), 1000) };
    expect(s.rested?.until).toBe(601000);
    s = { ...s, ...reduceCampEvent(s, ev(CAMP_EV.rested, [], { value: 0 }), 2000) };
    expect(s.rested).toBeNull();
    s = { ...s, ...reduceCampEvent(s, ev(CAMP_EV.refused, [1], { value: 7 }), 0) };
    expect(s.notes.at(-1)?.text).toMatch(/someone else's camp/);
  });
});
