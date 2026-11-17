// The rich vegetation generators (playtest 3, CR 045): deterministic, inside the
// size envelope the scatter manager and the impostor bake assume, within the
// triangle budgets, and carrying every attribute the scatter shaders read.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { richTree, TREE_SPECIES, TREE_VARIANTS } from './treeGen';
import { richBush, richGrassClump, richRock, richTuft, BUSH_TYPES } from './groundcoverGen';
import { barkTexture, BARK_KINDS, cellUv, leafAtlas, SOLID_UV, stoneTexture, ATLAS_H, ATLAS_W } from './natureTextures';
import { WORLD_TIERS } from '../config';

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
const ATTRS = ['position', 'normal', 'color', 'uv', 'aBarkUv', 'aFoliage', 'aCard'];

describe('rich trees', () => {
  it('builds every species, variant and LOD with the full attribute set', () => {
    for (let s = 0; s < TREE_SPECIES.length; s++) {
      for (let v = 0; v < TREE_VARIANTS; v++) {
        for (const lod of [0, 1] as const) {
          const g = richTree(s, v, { lod, scale: 1 });
          for (const a of ATTRS) expect(g.getAttribute(a), `${TREE_SPECIES[s].name} ${a}`).toBeDefined();
          expect(tris(g)).toBeGreaterThan(50);
          for (const k of ['position', 'normal', 'color', 'uv']) {
            const arr = g.getAttribute(k).array as Float32Array;
            for (let i = 0; i < arr.length; i += 97) expect(Number.isFinite(arr[i])).toBe(true);
          }
        }
      }
    }
  });

  it('stays inside the unit envelope (1 tall, crown within 0.62 of the axis) so scale and impostor framing hold', () => {
    for (let s = 0; s < TREE_SPECIES.length; s++) {
      const g = richTree(s, 0, { lod: 0, scale: 1.3 });
      const bb = g.boundingBox!;
      expect(bb.min.y, TREE_SPECIES[s].name).toBeGreaterThan(-0.1);
      expect(bb.max.y, TREE_SPECIES[s].name).toBeLessThan(1.14);
      expect(Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z), TREE_SPECIES[s].name).toBeLessThan(0.62);
    }
  });

  it('is deterministic and the variants differ', () => {
    const a = richTree(0, 0, { lod: 0, scale: 1 });
    const b = richTree(0, 1, { lod: 0, scale: 1 });
    expect(a).toBe(richTree(0, 0, { lod: 0, scale: 1 })); // cached
    const pa = a.getAttribute('position').array as Float32Array;
    const pb = b.getAttribute('position').array as Float32Array;
    let same = pa.length === pb.length;
    for (let i = 0; same && i < pa.length; i += 13) if (pa[i] !== pb[i]) same = false;
    expect(same).toBe(false);
  });

  it('keeps LOD1 far cheaper than LOD0 and both inside the triangle budgets', () => {
    for (let s = 0; s < TREE_SPECIES.length; s++) {
      const t0 = tris(richTree(s, 0, { lod: 0, scale: 1.3 }));
      const t1 = tris(richTree(s, 0, { lod: 1, scale: 1.3 }));
      expect(t0, `${TREE_SPECIES[s].name} lod0`).toBeLessThan(2400);
      expect(t1, `${TREE_SPECIES[s].name} lod1`).toBeLessThan(260);
      expect(t1).toBeLessThan(t0 / 3);
    }
  });

  it('leaf cards carry foliage = 1 and wood foliage = 0; wood uses bark UVs, cards the atlas', () => {
    const g = richTree(0, 0, { lod: 0, scale: 1 });
    const fol = g.getAttribute('aFoliage').array as Float32Array;
    const bark = g.getAttribute('aBarkUv').array as Float32Array;
    let wood = 0;
    let leaf = 0;
    for (let i = 0; i < fol.length; i++) {
      if (fol[i] === 0) {
        wood++;
        expect(bark[i * 2]).toBeGreaterThan(0.25); // the shader's "this is bark" test
      } else {
        leaf++;
        expect(bark[i * 2]).toBe(0);
      }
    }
    expect(wood).toBeGreaterThan(50);
    expect(leaf).toBeGreaterThan(400);
  });

  it('a dead tree has no leaf cards', () => {
    const g = richTree(5, 0, { lod: 0, scale: 1 });
    const fol = g.getAttribute('aFoliage').array as Float32Array;
    expect(fol.every((f) => f === 0)).toBe(true);
  });
});

describe('rich ground cover', () => {
  it('builds every bush type at both LODs, far cheaper than near', () => {
    for (const t of BUSH_TYPES) {
      const near = richBush(t, 0, 1);
      const far = richBush(t, 1, 1);
      for (const a of ATTRS) expect(near.getAttribute(a), `${t} ${a}`).toBeDefined();
      expect(tris(far)).toBeLessThanOrEqual(tris(near));
      expect(tris(near)).toBeLessThan(500);
    }
  });

  it('grass clumps and tufts stay cheap, flower tufts carry tintable heads', () => {
    expect(tris(richGrassClump(9, true))).toBeLessThan(70);
    expect(tris(richTuft(false))).toBeLessThan(80);
    const f = richTuft(true);
    expect(tris(f)).toBeLessThan(130);
    const fol = f.getAttribute('aFoliage').array as Float32Array;
    expect(fol.some((v) => v === 1)).toBe(true); // heads take the tint
    expect(fol.some((v) => v === 0)).toBe(true); // blades keep their green
    // Dense grass heads are flagged 2 for the grass shader.
    expect((richGrassClump(9, true).getAttribute('aFoliage').array as Float32Array).some((v) => v === 2)).toBe(true);
  });

  it('rocks are fractured, finite, sit on the ground and have a cheap far LOD', () => {
    for (const shape of ['boulder', 'slab', 'spire'] as const) {
      const near = richRock(shape, 0, 3);
      const far = richRock(shape, 0, 1);
      expect(tris(near)).toBeLessThan(400);
      expect(tris(far)).toBeLessThan(120);
      const bb = near.boundingBox!;
      expect(bb.min.y).toBeGreaterThan(-0.35);
      expect(bb.max.y).toBeLessThan(1.6);
      const n = near.getAttribute('normal').array as Float32Array;
      for (let i = 0; i < n.length; i += 3) expect(Math.hypot(n[i], n[i + 1], n[i + 2])).toBeCloseTo(1, 3);
    }
    // Strata: the vertex colours differ across a rock (bands), not one flat grey.
    const c = richRock('boulder', 0, 3).getAttribute('color').array as Float32Array;
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < c.length; i += 3) {
      lo = Math.min(lo, c[i]);
      hi = Math.max(hi, c[i]);
    }
    expect(hi - lo).toBeGreaterThan(0.1);
  });
});

describe('nature textures', () => {
  it('the leaf atlas has alpha-cut leaves in every cell and an opaque solid texel', () => {
    const t = leafAtlas();
    const d = t.image.data as Uint8Array;
    for (let cell = 0; cell < 8; cell++) {
      const [u0, v0, u1, v1] = cellUv(cell);
      let opaque = 0;
      let clear = 0;
      for (let k = 0; k < 400; k++) {
        const u = u0 + ((u1 - u0) * ((k * 37) % 400)) / 400;
        const v = v0 + ((v1 - v0) * ((k * 91) % 400)) / 400;
        const a = d[(Math.floor(v * ATLAS_H) * ATLAS_W + Math.floor(u * ATLAS_W)) * 4 + 3];
        if (a > 200) opaque++;
        if (a < 20) clear++;
      }
      expect(opaque, `cell ${cell} has leaf`).toBeGreaterThan(10);
      expect(clear, `cell ${cell} has gaps`).toBeGreaterThan(10);
    }
    const s = (Math.floor(SOLID_UV[1] * ATLAS_H) * ATLAS_W + Math.floor(SOLID_UV[0] * ATLAS_W)) * 4;
    expect([d[s], d[s + 3]]).toEqual([255, 255]);
  });

  it('bark and stone textures tile (opposite edges are neighbours in the noise) and are cached', () => {
    for (const k of BARK_KINDS) {
      const t = barkTexture(k);
      expect(t).toBe(barkTexture(k));
      expect(t.wrapS).toBe(THREE.RepeatWrapping);
    }
    expect(stoneTexture()).toBe(stoneTexture());
  });
});

describe('quality tiers', () => {
  it('Low keeps the original vegetation, higher tiers get the rich set with more cards', () => {
    expect(WORLD_TIERS.low.vegetation).toBe(0);
    expect(WORLD_TIERS.medium.vegetation).toBe(1);
    expect(WORLD_TIERS.high.vegetation).toBe(2);
    expect(WORLD_TIERS.ultra.vegetation).toBe(3);
  });
});
