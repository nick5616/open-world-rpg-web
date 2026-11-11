// Playtest 2 immersion pass: ambient life follows the biome, the hour and the
// weather, stays out of caves and water, and wraps around the camera.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AmbientLife, BIOME, LIFE_BY_BIOME, lifeWeights, type LifeInput } from './ambientLife';

const w = (biome: number, hour: number, o: Partial<{ day: number; rain: number; snow: number; under: number; town: boolean }> = {}) =>
  lifeWeights(LIFE_BY_BIOME[biome], hour, o.day ?? (hour > 6 && hour < 19 ? 1 : 0), o.rain ?? 0, o.snow ?? 0, o.under ?? 0, o.town ?? false);

describe('ambient life weights', () => {
  it('birds and butterflies by day, fireflies at night, none underground', () => {
    expect(w(BIOME.meadow, 10).birds).toBeGreaterThan(0.9);
    expect(w(BIOME.meadow, 10).butterflies).toBeGreaterThan(0.9);
    expect(w(BIOME.meadow, 10).fireflies).toBe(0);
    expect(w(BIOME.meadow, 23).birds).toBe(0);
    expect(w(BIOME.meadow, 23).butterflies).toBe(0);
    expect(w(BIOME.wetland, 23).fireflies).toBeGreaterThan(0.9);
    expect(w(BIOME.wetland, 6).fireflies).toBe(0); // gone by dawn
    for (const v of Object.values(w(BIOME.forest, 10, { under: 1 }))) expect(v).toBe(0);
    for (const v of Object.values(w(BIOME.forest, 23, { under: 1 }))) expect(v).toBe(0);
  });

  it('follows the biome: leaves in woods, hawks over the highlands, nothing fluttering on the peaks', () => {
    expect(w(BIOME.forest, 12).leaves).toBeGreaterThan(w(BIOME.meadow, 12).leaves);
    expect(w(BIOME.highlands, 12).hawks).toBeGreaterThan(0.9);
    expect(w(BIOME.snowpeak, 12).butterflies).toBe(0);
    expect(w(BIOME.snowpeak, 23).fireflies).toBe(0);
    expect(w(BIOME.badlands, 23).fireflies).toBe(0);
  });

  it('rain and snow send insects into hiding and thin the birds; towns have fewer, and no leaves', () => {
    expect(w(BIOME.meadow, 10, { rain: 1 }).butterflies).toBe(0);
    expect(w(BIOME.wetland, 23, { rain: 1 }).fireflies).toBe(0);
    expect(w(BIOME.meadow, 10, { rain: 1 }).birds).toBeLessThan(0.5);
    expect(w(BIOME.meadow, 10, { town: true }).butterflies).toBeLessThan(0.5);
    expect(w(BIOME.forest, 10, { town: true }).leaves).toBe(0);
  });
});

describe('the layer', () => {
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const input = (o: Partial<LifeInput> = {}): LifeInput => ({
    camera: cam,
    dt: 0.1,
    hour: 10,
    day: 1,
    rain: 0,
    snow: 0,
    under: 0,
    inTown: false,
    biomeAt: () => BIOME.meadow,
    groundAt: () => 10,
    waterAt: () => -Infinity,
    viewportH: 720,
    ...o,
  });

  it('fills in by day over a few seconds and keeps creatures around the camera, above the ground', () => {
    const l = new AmbientLife();
    for (let i = 0; i < 120; i++) l.update(input());
    expect(l.stats.butterflies).toBeGreaterThan(20);
    expect(l.stats.birds).toBeGreaterThan(0);
    expect(l.stats.fireflies).toBe(0);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const im = (l as unknown as { butterflies: THREE.InstancedMesh }).butterflies;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      expect(Math.abs(p.x - cam.position.x)).toBeLessThan(25);
      expect(p.y).toBeGreaterThan(10.2);
      expect(p.y).toBeLessThan(13);
    }
    // the camera walks 500 m: the swarm comes along (anchors wrap), still above the ground
    cam.position.set(500, 0, 0);
    for (let i = 0; i < 10; i++) l.update(input());
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      expect(Math.abs(p.x - 500)).toBeLessThan(25);
    }
    cam.position.set(0, 0, 0);
    l.dispose();
  });

  it('keeps butterflies off the water and everything out of caves, and Low halves the count', () => {
    const l = new AmbientLife();
    for (let i = 0; i < 120; i++) l.update(input({ waterAt: () => 12 }));
    expect(l.stats.butterflies).toBe(0);
    const u = new AmbientLife();
    for (let i = 0; i < 120; i++) u.update(input({ under: 1 }));
    expect(u.stats.butterflies + u.stats.birds + u.stats.leaves + u.stats.motes + u.stats.fireflies).toBe(0);
    const hi = new AmbientLife();
    const lo = new AmbientLife();
    lo.setScale(0.5);
    for (let i = 0; i < 120; i++) {
      hi.update(input());
      lo.update(input());
    }
    expect(lo.stats.butterflies).toBeLessThan(hi.stats.butterflies * 0.6);
  });
});
