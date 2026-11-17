// CR 041 client wire, store, catalogue and cost tests.

import { describe, expect, it } from 'vitest';
import { CAMPS, type Event as ZoneEvent } from '@lodestone/contracts';
import { BUILD_REFUSAL, BUILD_EV, buildArg, BUILD_Y_BIAS, CAMP_EV, CAMP_REFUSAL, decodeArea, decodePiece } from '../camps/events';
import { emptyMine, reduceCampEvent, type CampState } from '../camps/store';
import { CATALOGUE, CATEGORIES, costLines, cycleMaterial, cyclePiece, inCategory, missingText, refundLines, repairLines } from './defs';

const ev = (kind: number, data: number[] | Uint8Array, extra: Partial<ZoneEvent> = {}): ZoneEvent => ({ kind, entityId: 0, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: data instanceof Uint8Array ? data : new Uint8Array(data), ...extra }) as ZoneEvent;
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const base = (): Omit<CampState, 'actions'> => ({ build: null, missing: null, building: null, buildMenu: false, pieces: {}, mine: emptyMine(), chest: null, rested: null, notes: [], placing: null, menu: false, labeling: null, selfId: 9 });

function rec(id: number, kind: number, flags: number, state: number, cond: number): number[] {
  const b: number[] = [];
  const u32 = (v: number) => b.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  u32(id);
  u32(0);
  b.push(kind, 2);
  u32(100100);
  u32(5000);
  u32(100000);
  b.push(flags);
  u32(0);
  b.push(0, 2, 65, 115, 0, state, cond);
  return b;
}

describe('build wire', () => {
  it('decodes record v2 (state, condition, modify flag) in 1101 and in an area', () => {
    const wall = CAMPS.pieces.find((p) => p.key === 'door_stone')!.id;
    const [p, next] = decodePiece(new Uint8Array(rec(5, wall, 1 | 16, 1, 63)), 0, 0);
    expect(next).toBe(rec(5, wall, 1, 1, 63).length);
    expect(p).toMatchObject({ kind: wall, rot: 2, xCm: 100100, yCm: 5000, mine: true, modify: true, state: 1, cond: 63, owner: 'As' });
    const area = [2, 1, 0, 1, 0, 2, 0, ...rec(5, wall, 0, 0, 100), ...rec(6, wall, 0, 1, 40)];
    expect(decodeArea(ev(CAMP_EV.area, area), 0).pieces.map((q) => [q.state, q.cond, q.modify])).toEqual([
      [0, 100, false],
      [1, 40, false],
    ]);
  });

  it('keeps reading v1 areas', () => {
    const r = rec(5, 1, 0, 0, 100).slice(0, -2);
    const a = decodeArea(ev(CAMP_EV.area, [1, 1, 0, 1, 0, 1, 0, ...r]), 0);
    expect(a.pieces[0]).toMatchObject({ state: 0, cond: 100 });
  });

  it('packs the height hint', () => {
    expect(buildArg(null)).toBe(0);
    expect(buildArg(5250)).toBe(5250 + BUILD_Y_BIAS);
    expect(buildArg(-100)).toBeGreaterThan(0);
  });

  it('1820 and 1821 land in the store; 1821 makes the refusal line', () => {
    const info = { pieces: 12, budget: 450, share: true, areaUsed: 30, areaBudget: 1600, comfort: { score: 7, max: 20, tier: 'Cosy', next: { score: 11, name: 'Homely' } }, home: { x: 1, y: 2, z: 3 }, homeCdMs: 0, hearth: null };
    let patch = reduceCampEvent(base(), ev(BUILD_EV.info, json(info), { value: 12 }), 0);
    expect(patch!.build).toMatchObject({ pieces: 12, share: true, comfort: { tier: 'Cosy' } });
    const s = { ...base(), ...patch };
    patch = reduceCampEvent(s, ev(CAMP_EV.refused, [1], { value: 31 }), 0);
    expect(patch!.notes).toHaveLength(0); // the missing list speaks
    patch = reduceCampEvent(s, ev(BUILD_EV.missing, json([{ item: 'wood:log', qty: 6, have: 2 }]), { targetId: 104 }), 0);
    expect(patch!.missing).toMatchObject({ kind: 104 });
    expect(patch!.notes![0].text).toBe('Needs 4 more Logs');
  });

  it('words refusal 3 for a base, not a camp (a green field near a town said "Not inside a settlement")', () => {
    expect(BUILD_REFUSAL[3]).toMatch(/too close/i);
    expect(CAMP_REFUSAL[3]).toBe('Not inside a settlement');
    expect(BUILD_REFUSAL[6]).toBe(CAMP_REFUSAL[6]);
  });

  it('has friendly texts for refusals 24-34', () => {
    for (let r = 24; r <= 34; r++) expect(CAMP_REFUSAL[r], String(r)).toBeTruthy();
  });
});

describe('build catalogue and costs', () => {
  it('groups the structure by base with three materials and sorts categories', () => {
    expect(CATEGORIES.every((c) => inCategory(c).length > 0)).toBe(true);
    const wall = CATALOGUE.find((b) => b.base === 'wall')!;
    expect(wall.variants).toHaveLength(3);
    expect(wall.name).toBe('Wall');
    expect(inCategory('Roof').map((b) => b.base)).toEqual(['roof', 'roof_cap', 'gable']);
    expect(inCategory('Base').map((b) => b.base)).toContain('bed');
  });

  it('cycles materials and pieces', () => {
    const wood = CAMPS.pieces.find((p) => p.key === 'wall_wood')!.id;
    const stone = CAMPS.pieces.find((p) => p.key === 'wall_stone')!.id;
    expect(cycleMaterial(wood)).toBe(stone);
    expect(cycleMaterial(wood, -1)).toBe(CAMPS.pieces.find((p) => p.key === 'wall_sunsteel')!.id);
    expect(cyclePiece(wood)).toBe(CAMPS.pieces.find((p) => p.key === 'half_wall_wood')!.id);
    expect(cyclePiece(wood, -1)).toBe(CAMPS.pieces.find((p) => p.key === 'floor_wood')!.id);
  });

  it('costs, refunds and repairs follow the CR formulas', () => {
    const stone = CAMPS.pieces.find((p) => p.key === 'wall_stone')!;
    const lines = costLines(stone.id, (i) => (i === 'stone:block' ? 1 : 0));
    expect(lines).toEqual([{ item: 'stone:block', need: 4, have: 1 }]);
    expect(missingText(lines)).toBe('Needs 3 more Stones');
    expect(refundLines(stone.id)).toEqual([{ item: 'stone:block', qty: 3 }]); // round(4 * 0.8)
    expect(repairLines(stone.id, 100)).toEqual([]);
    expect(repairLines(stone.id, 0)).toEqual([{ item: 'stone:block', qty: 2 }]); // ceil(4 * .3)
    expect(repairLines(stone.id, 90)).toEqual([{ item: 'stone:block', qty: 1 }]); // min 1
    const roof = CAMPS.pieces.find((p) => p.key === 'roof_wood')!;
    expect(costLines(roof.id, () => 0).map((l) => l.item)).toEqual(['wood:log', 'wood:resin']);
  });
});
