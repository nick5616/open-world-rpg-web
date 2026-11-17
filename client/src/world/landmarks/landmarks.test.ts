import { describe, expect, it } from 'vitest';
import { birdAt, BIRDS_PER_SITE, duskK, glint, landmarkKindOf, LANDMARK_RANGE, nearestSites, partitionLandmarks, PLUME_HEIGHT, PLUME_PUFFS, puffAt, type BirdPos, type LSite, type Puff } from './landmarks';

const site = (index: number, kind: string, x: number, z: number, o: Partial<LSite> = {}): LSite => ({ index, category: kind === 'bandit_camp' ? 'structure' : 'poi', kind, x, y: 10, z, yaw: 0, ...o });

describe('which sites signal', () => {
  it('maps kinds to signals and never lights up the layers below or above the surface (but sky palaces glint)', () => {
    expect(landmarkKindOf(site(0, 'bandit_camp', 0, 0))).toBe('smoke');
    expect(landmarkKindOf(site(1, 'enemy_camp', 0, 0))).toBe('smoke');
    expect(landmarkKindOf(site(2, 'tower', 0, 0))).toBe('pillar');
    expect(landmarkKindOf(site(3, 'dwarf_door', 0, 0))).toBe('lantern');
    expect(landmarkKindOf(site(4, 'cave_mouth', 0, 0))).toBe('glow');
    expect(landmarkKindOf(site(5, 'sky_palace', 0, 0, { layer: 1 }))).toBe('glint');
    expect(landmarkKindOf(site(6, 'cave_mouth', 0, 0, { layer: 2 }))).toBeNull();
    expect(landmarkKindOf(site(7, 'waypoint', 0, 0))).toBeNull();
  });
  it('partitions in atlas order and picks the nearest within range, deterministically', () => {
    const sites = [site(0, 'bandit_camp', 1000, 0), site(1, 'bandit_camp', 300, 0), site(2, 'bandit_camp', 5000, 0), site(3, 'bandit_camp', 300, 0), site(4, 'tower', 0, 800)];
    const p = partitionLandmarks(sites);
    expect(p.smoke.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(p.pillar).toHaveLength(1);
    const near = nearestSites(p.smoke, 0, 0, LANDMARK_RANGE.smoke.range, 3);
    expect(near.map((s) => s.index)).toEqual([1, 3, 0]); // ties by index, 5 km out of range
    expect(nearestSites(p.smoke, 0, 0, LANDMARK_RANGE.smoke.range, 3)).toEqual(near);
  });
});

describe('motion', () => {
  it('smoke rises to its height, stays finite and thins at the top, and is the same every time', () => {
    const a: Puff = { x: 0, h: 0, z: 0, size: 0, alpha: 0 };
    let maxH = 0;
    for (let t = 0; t < 40; t += 0.5) {
      for (let i = 0; i < PLUME_PUFFS; i++) {
        puffAt(3, i, t, 1, 0, a);
        expect(a.h).toBeGreaterThanOrEqual(2);
        expect(a.h).toBeLessThanOrEqual(PLUME_HEIGHT + 2.01);
        expect(a.alpha).toBeGreaterThanOrEqual(0);
        expect(a.alpha).toBeLessThanOrEqual(0.61);
        expect(Number.isFinite(a.x + a.z + a.size)).toBe(true);
        maxH = Math.max(maxH, a.h);
      }
    }
    expect(maxH).toBeGreaterThan(PLUME_HEIGHT * 0.9);
    const b: Puff = { x: 0, h: 0, z: 0, size: 0, alpha: 0 };
    puffAt(3, 4, 12.25, 1, 0, a);
    puffAt(3, 4, 12.25, 1, 0, b);
    expect(b).toEqual(a);
    // leans downwind
    puffAt(3, 0, 8, 1, 0, a);
    expect(a.x).toBeGreaterThan(0);
  });
  it('birds circle well above the ground without leaving their ring', () => {
    const p: BirdPos = { x: 0, y: 0, z: 0 };
    for (let t = 0; t < 120; t += 3) {
      for (let i = 0; i < BIRDS_PER_SITE; i++) {
        birdAt(1.2, i, t, p);
        const r = Math.hypot(p.x, p.z);
        expect(r).toBeGreaterThan(20);
        expect(r).toBeLessThan(45);
        expect(p.y).toBeGreaterThan(40);
      }
    }
  });
  it('glints twinkle slowly (never faster than a third of a second between 10% and 90%) and the pillar belongs to dusk and night', () => {
    let prev = glint(2, 0, 0);
    let maxStep = 0;
    for (let t = 0.05; t < 30; t += 0.05) {
      const g = glint(2, 0, t);
      maxStep = Math.max(maxStep, Math.abs(g - prev));
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      prev = g;
    }
    expect(maxStep).toBeLessThan(0.2); // smooth: no strobing
    expect(duskK(1)).toBe(0);
    expect(duskK(0)).toBe(1);
    expect(duskK(0.4)).toBeGreaterThan(0.1);
    expect(duskK(0.4)).toBeLessThan(0.9);
  });
});
