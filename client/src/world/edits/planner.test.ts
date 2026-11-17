import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { harvestDef, maxHp, rollDrops, scaleFactor } from './harvestDefs';
import { TerrainOverlay } from './overlay';
import { costFor, itemsFor, planSwing, type PlanWorld } from './planner';

const goldenPath = fileURLToPath(new URL('../../../../contracts/golden/world_edits_plan.json', import.meta.url));

function fake(o: TerrainOverlay, forbid: (x: number, z: number) => boolean = () => false, water = 0): PlanWorld {
  return {
    base: (x) => 50 + (((x % 7) + 7) % 7) * 0.1,
    water: () => water,
    allowed: (x, z) => !forbid(x, z),
    delta: (x, z) => o.delta(x, z),
  };
}

function applyPlan(o: TerrainOverlay, changes: { x: number; z: number; d: number }[]): void {
  for (const c of changes) o.setVertex(c.x, c.z, c.d);
}

describe('dig planner (twin of server/pkg/worldedit/dig.go)', () => {
  it('replays the Go golden swing for swing', () => {
    const g = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as {
      steps: { op: 'dig' | 'fill'; x: number; z: number; lowered: number; raised: number; refused: number }[];
      result: { x: number; z: number; d: number }[];
    };
    const o = new TerrainOverlay();
    const w = fake(o, (x) => x < 8);
    for (const s of g.steps) {
      const { plan, reason } = planSwing(w, s.op, s.x, s.z);
      const refused = reason === 'ok' ? 0 : reason === 'forbidden' ? 1 : reason === 'limit' ? 2 : 3;
      expect(refused, `${s.op} ${s.x},${s.z}`).toBe(s.refused);
      if (!plan) continue;
      expect([plan.lowered, plan.raised], `${s.op} ${s.x},${s.z}`).toEqual([s.lowered, s.raised]);
      applyPlan(o, plan.changes);
    }
    const got: { x: number; z: number; d: number }[] = [];
    for (const [x0, x1, z0, z1] of [[270, 340, 280, 440], [690, 710, 690, 710]]) {
      for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (o.delta(x, z)) got.push({ x, z, d: o.delta(x, z) });
    }
    expect(got).toEqual(g.result);
  });

  it('keeps a pit walkable, never below water, and refuses protected ground', () => {
    const o = new TerrainOverlay();
    const w = fake(o, (x) => x > 500);
    for (let i = 0; i < 40; i++) {
      const { plan } = planSwing(w, 'dig', 100.5, 100.5);
      if (!plan) break;
      applyPlan(o, plan.changes);
    }
    expect(o.delta(100, 100)).toBe(-24);
    for (let z = 80; z < 120; z++) for (let x = 80; x < 120; x++) expect(Math.abs(o.delta(x, z) - o.delta(x + 1, z))).toBeLessThanOrEqual(4);
    expect(planSwing(w, 'dig', 505.5, 100.5).reason).toBe('forbidden');
    const wet = fake(new TerrainOverlay(), () => false, 49.9); // ground within 0.4 m of the water
    const r = planSwing(wet, 'dig', 20.5, 20.5);
    if (r.plan) for (const c of r.plan.changes) expect(50 + (c.x % 7) * 0.1 + c.d * 0.25).toBeGreaterThanOrEqual(49.9 + 0.3 - 1e-9);
  });

  it('prices volume in dirt', () => {
    expect(itemsFor(10, 4)).toEqual({ items: 2, rest: 2 });
    expect(costFor(1)).toBe(1);
    expect(costFor(13)).toBe(3);
  });
});

describe('harvest rules', () => {
  it('trees need an axe, rocks a pickaxe, bushes anything; tufts cannot be broken', () => {
    expect(harvestDef(1, 3)!.tool).toBe('tool:axe');
    expect(harvestDef(2, 0)!.tool).toBe('tool:pickaxe');
    expect(harvestDef(3, 0)!.tool).toBe('');
    expect(harvestDef(4, 0)).toBeNull();
    expect(harvestDef(1, 99)).toBeNull();
    const d = harvestDef(1, 0)!;
    expect(maxHp(d, 255)).toBeGreaterThan(maxHp(d, 0));
    expect(scaleFactor(0)).toBeCloseTo(0.7, 9);
  });
  it('rolls at least two logs from a tree', () => {
    let n = 0;
    let s = 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 100; i++) n += rollDrops(harvestDef(1, 3)!, 200, rnd).filter((d) => d.item === 'wood:log').reduce((a, d) => a + d.qty, 0);
    expect(n).toBeGreaterThanOrEqual(200);
  });
});
