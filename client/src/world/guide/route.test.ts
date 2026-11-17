import { describe, expect, it } from 'vitest';
import { ARRIVE_M, buildRoadGraph, LEAD_MAX_M, LEAD_MIN_M, leadAt, newWisp, nearestNode, planRoute, pointAt, project, shortestPath, stepWisp, straightRoute, type RoadLike } from './route';

const road = (pts: [number, number][]): RoadLike => ({ points: Float32Array.from(pts.flatMap(([x, z]) => [x, 0, z])) });
// An L: east along z=0 to x=400, then south along x=400 to z=300. A side road joins mid-way (T) going north from (200,0).
const L = road([[0, 0], [400, 0], [400, 300]]);
const T = road([[200, -5], [200, -250]]);

describe('road graph', () => {
  const g = buildRoadGraph([L, T]);
  it('resamples long segments and links junctions of different roads', () => {
    expect(g.count).toBeGreaterThan(60);
    const a = nearestNode(g, 0, 0, 20);
    const b = nearestNode(g, 200, -250, 20);
    const path = shortestPath(g, a, b);
    expect(path).not.toBeNull();
    // 200 m east then 250 m north: about 450 m through the junction.
    let len = 0;
    for (let i = 1; i < path!.length; i++) len += Math.hypot(g.x[path![i]] - g.x[path![i - 1]], g.z[path![i]] - g.z[path![i - 1]]);
    expect(len).toBeGreaterThan(440);
    expect(len).toBeLessThan(480);
  });
  it('finds no node far from every road', () => {
    expect(nearestNode(g, 3000, 3000, 100)).toBe(-1);
  });
});

describe('planRoute', () => {
  const g = buildRoadGraph([L]);
  it('follows the road when you are on it and the goal is near it', () => {
    const r = planRoute(g, { x: 5, z: 3 }, { x: 405, z: 290 });
    expect(r.usesRoad).toBe(true);
    // via the corner at (400, 0): close to the road length, not the 480 m diagonal
    expect(r.length).toBeGreaterThan(690);
    expect(r.pts.some((p) => Math.abs(p.x - 400) < 12 && Math.abs(p.z) < 12)).toBe(true);
  });
  it('goes straight over the terrain when you are off the road', () => {
    const r = planRoute(g, { x: 100, z: 200 }, { x: 405, z: 290 });
    expect(r.usesRoad).toBe(false);
    expect(r.pts).toHaveLength(2);
  });
  it('goes straight when the road is a big detour', () => {
    // From the road's start to a goal just beside it but 300 m "up" the line: road 700 m vs straight ~210 m.
    const r = planRoute(g, { x: 5, z: 3 }, { x: 395, z: 40 });
    expect(r.usesRoad).toBe(true); // 390 m along vs 392 m straight: roads are fine
    const far = planRoute(buildRoadGraph([road([[0, 0], [0, 600], [200, 600], [200, 10]])]), { x: 0, z: 5 }, { x: 200, z: 15 });
    expect(far.usesRoad).toBe(false);
  });
  it('with no roads at all the route is the straight line', () => {
    expect(planRoute(null, { x: 0, z: 0 }, { x: 500, z: 0 }).pts).toHaveLength(2);
    expect(straightRoute({ x: 0, z: 0 }, { x: 3, z: 4 }).length).toBeCloseTo(5, 6);
  });
  it('is deterministic', () => {
    const a = planRoute(g, { x: 5, z: 3 }, { x: 405, z: 290 });
    const b = planRoute(buildRoadGraph([L]), { x: 5, z: 3 }, { x: 405, z: 290 });
    expect(a.pts).toEqual(b.pts);
  });
});

describe('the wisp', () => {
  it('keeps 8-15 m ahead of you and waits when you stop', () => {
    const route = straightRoute({ x: 0, z: 0 }, { x: 600, z: 0 });
    const player = { x: 0, z: 0 };
    const w = newWisp(route, player);
    for (let i = 0; i < 20 * 20; i++) stepWisp(w, route, player, 0.05); // 20 s standing still
    const gap = w.s - w.ps;
    expect(gap).toBeGreaterThanOrEqual(LEAD_MIN_M - 0.5);
    expect(gap).toBeLessThanOrEqual(LEAD_MAX_M + 0.01);
    expect(w.waiting).toBe(true);
    // Walk at 6 m/s for 30 s: it stays ahead within the same band.
    let minGap = Infinity;
    let maxGap = 0;
    for (let i = 0; i < 30 * 20; i++) {
      player.x += 6 * 0.05;
      stepWisp(w, route, player, 0.05);
      if (i > 40) {
        minGap = Math.min(minGap, w.s - w.ps);
        maxGap = Math.max(maxGap, w.s - w.ps);
      }
    }
    expect(minGap).toBeGreaterThanOrEqual(LEAD_MIN_M - 1);
    expect(maxGap).toBeLessThanOrEqual(LEAD_MAX_M + 0.5);
  });
  it('runs along a road leg and a terrain leg', () => {
    const g = buildRoadGraph([L]);
    const route = planRoute(g, { x: 5, z: 3 }, { x: 405, z: 290 });
    const player = { x: 5, z: 3 };
    const w = newWisp(route, player);
    let onRoadSeen = 0;
    for (let i = 0; i < 120 * 20; i++) {
      stepWisp(w, route, player, 0.05);
      // the player jogs (6 m/s) after the wisp
      const target = pointAt(route, Math.max(0, w.s - 6)).p;
      const dx = target.x - player.x;
      const dz = target.z - player.z;
      const dd = Math.hypot(dx, dz) || 1;
      const mv = Math.min(dd, 6 * 0.05);
      player.x += (dx / dd) * mv;
      player.z += (dz / dd) * mv;
      if (route.onRoad[pointAt(route, w.s).leg]) onRoadSeen++;
      if (w.mode === 'gone') break;
    }
    expect(onRoadSeen).toBeGreaterThan(100);
    expect(w.mode).toBe('gone');
  });
  it('fades when you arrive and flags when you are lost', () => {
    const route = straightRoute({ x: 0, z: 0 }, { x: 200, z: 0 });
    const w = newWisp(route, { x: 0, z: 0 });
    stepWisp(w, route, { x: 0, z: 0 }, 0.5);
    expect(w.alpha).toBeGreaterThan(0);
    stepWisp(w, route, { x: 200 - ARRIVE_M + 2, z: 0 }, 0.1);
    expect(w.mode).toBe('fade');
    for (let i = 0; i < 40; i++) stepWisp(w, route, { x: 195, z: 0 }, 0.1);
    expect(w.mode).toBe('gone');
    const w2 = newWisp(route, { x: 0, z: 0 });
    stepWisp(w2, route, { x: 50, z: 300 }, 0.1);
    expect(w2.lost).toBe(true);
  });
  it('projects a point onto the route and leads within the band', () => {
    const route = straightRoute({ x: 0, z: 0 }, { x: 100, z: 0 });
    expect(project(route, 40, 7).s).toBeCloseTo(40, 6);
    expect(project(route, 40, 7).d).toBeCloseTo(7, 6);
    for (let t = 0; t < 60; t += 0.7) {
      expect(leadAt(t)).toBeGreaterThanOrEqual(LEAD_MIN_M);
      expect(leadAt(t)).toBeLessThanOrEqual(LEAD_MAX_M);
    }
  });
});
