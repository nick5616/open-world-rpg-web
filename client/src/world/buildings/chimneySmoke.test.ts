// Playtest 2 immersion pass: chimney smoke follows the hearths' day and
// gathers the nearest chimneys only.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ChimneySmoke, hearthActivity, SMOKE_MAX_CHIMNEYS, SMOKE_PER, SMOKE_RANGE_M } from './chimneySmoke';

describe('chimney smoke', () => {
  it('burns most at breakfast and supper, least in the small hours, never out', () => {
    expect(hearthActivity(7.5)).toBeGreaterThan(hearthActivity(12.5));
    expect(hearthActivity(19)).toBeGreaterThan(hearthActivity(15));
    expect(hearthActivity(3)).toBeLessThan(hearthActivity(12.5));
    for (let h = 0; h < 24; h += 0.5) {
      expect(hearthActivity(h)).toBeGreaterThan(0.1);
      expect(hearthActivity(h)).toBeLessThanOrEqual(1);
    }
  });

  it('plumes rise from the nearest chimneys in range, capped', () => {
    const s = new ChimneySmoke();
    const cam = new THREE.PerspectiveCamera();
    const near: number[] = [];
    for (let i = 0; i < SMOKE_MAX_CHIMNEYS + 10; i++) near.push(i * 3, 20, 0);
    const far = new Float32Array([SMOKE_RANGE_M + 50, 20, 0]);
    s.update(cam, 0.3, 8, 1, 0, 0, () => [new Float32Array(near), far]);
    expect(s.stats.chimneys).toBe(SMOKE_MAX_CHIMNEYS);
    expect((s.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(SMOKE_MAX_CHIMNEYS * SMOKE_PER);
    expect(s.mesh.visible).toBe(true);
    s.update(cam, 0.3, 8, 1, 0, 0, () => [far]);
    expect(s.stats.chimneys).toBe(0);
    expect(s.mesh.visible).toBe(false);
    s.dispose();
  });
});
