import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseChunk } from '@lodestone/worldgen';
import { packGrass, unpackGrass, generateGrass } from './scatter/grassGen';
import { setPrevailingWind, windAt, windGust, windState } from './wind';
import { airmass, skyLighting, makeSkyLighting, skyRadiance, sunTransmittance } from './sky/atmosphere';
import { patchCsmShader } from './sky/sunShadows';
import * as csm from 'three/examples/jsm/csm/CSMShader.js';
import { TERRAIN_LAYERS } from './terrain/terrainMaterial';
import { WORLD_TIERS } from './config';
import { hasWasm, testWorld } from './testing/wasm';
import fs from 'node:fs';
import { DAY_LENGTH_S } from '@lodestone/contracts';

describe('grass packing', () => {
  it('round-trips yaw, scale and tint in one float', () => {
    for (const [y, s, t] of [
      [0, 0, 0],
      [Math.PI, 0.5, 1],
      [6, 1, 0.25],
    ]) {
      const [y2, s2, t2] = unpackGrass(packGrass(y, s, t));
      expect(y2).toBeCloseTo(y, 1);
      expect(s2).toBeCloseTo(s, 2);
      expect(t2).toBeCloseTo(t, 2);
      expect(Math.fround(packGrass(y, s, t))).toBe(packGrass(y, s, t)); // exact in f32
    }
  });
});

describe.skipIf(!hasWasm)('grass generation', () => {
  it('is deterministic, on the ground, and never under water', async () => {
    const { wg, atlas } = await testWorld();
    const c = parseChunk(wg.buildChunkBytes(atlas, 30, 35, 0));
    const a = generateGrass(c, 2);
    const b = generateGrass(c, 2);
    expect(a).toEqual(b);
    expect(a.length % 4).toBe(0);
    for (let i = 0; i < a.length; i += 4) {
      expect(a[i + 1]).toBeCloseTo(wg.collisionHeight(atlas, a[i], a[i + 2]), 3);
      const s = Math.round(a[i + 2] - 35 * 64) * 65 + Math.round(a[i] - 30 * 64);
      expect(c.water[Math.min(s, 65 * 65 - 1)] <= a[i + 1] + 0.05).toBe(true);
    }
  });
});

describe('wind field', () => {
  it('blows away from where WorldSpec windDirection says it comes from', () => {
    setPrevailingWind(0, 4); // from the north (-z): blows toward +z
    const w = windAt(100, 200);
    expect(w.z).toBeGreaterThan(0);
    expect(Math.abs(w.x)).toBeLessThan(1e-9);
    setPrevailingWind(90, 4); // from +x: blows toward -x
    expect(windAt(0, 0).x).toBeLessThan(0);
  });
  it('gusts stay in range and roll downwind over time', () => {
    setPrevailingWind(0, 4);
    for (let t = 0; t < 60; t += 0.7) {
      const g = windGust(10, 20, t);
      expect(g).toBeGreaterThanOrEqual(0.35 - 1e-9);
      expect(g).toBeLessThanOrEqual(1.6 + 1e-9);
    }
    // It changes over time and over space (gust fronts, not a uniform breeze).
    expect(windGust(0, 0, 0)).not.toBeCloseTo(windGust(0, 0, 3), 3);
    expect(windGust(0, 0, 5)).not.toBeCloseTo(windGust(0, 30, 5), 3);
    expect(windState.speed).toBe(4);
  });
});

describe('analytic atmosphere', () => {
  it('airmass is ~1 at the zenith and ~38 at the horizon', () => {
    expect(airmass(1)).toBeCloseTo(1, 2);
    expect(airmass(0)).toBeGreaterThan(30);
    expect(airmass(0)).toBeLessThan(45);
  });
  it('sunlight is white at noon and red at sunset', () => {
    const noon = sunTransmittance(1);
    const sunset = sunTransmittance(0.02);
    expect(noon.r / noon.b).toBeLessThan(1.4);
    expect(sunset.r / Math.max(sunset.b, 1e-6)).toBeGreaterThan(5);
    expect(sunTransmittance(-0.3).r).toBe(0);
  });
  it('the day sky is blue overhead, and night is dark', () => {
    const s = new THREE.Vector3(0.3, 0.8, 0.2).normalize();
    const zen = skyRadiance(new THREE.Vector3(0, 1, 0), s);
    expect(zen.b).toBeGreaterThan(zen.r);
    const night = skyRadiance(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -0.8, 0.6));
    expect(night.b).toBeLessThan(0.05);
  });
  it('day/night lighting: moon light at midnight, sun at noon', () => {
    const noon = skyLighting(0.5 * DAY_LENGTH_S, makeSkyLighting());
    expect(noon.day).toBeGreaterThan(0.9);
    expect(noon.lightIntensity).toBeGreaterThan(2);
    const midnight = skyLighting(0, makeSkyLighting());
    expect(midnight.day).toBeLessThan(0.1);
    expect(midnight.lightIntensity).toBeLessThan(0.3);
    expect(midnight.lightDir.y).toBeGreaterThan(0);
  });
});


describe('CSM patch', () => {
  it('limits non-CSM materials to light 0 among the shadow-casting directional lights', () => {
    patchCsmShader();
    const src = (csm as unknown as { CSMShader: { lights_fragment_begin: string } }).CSMShader.lights_fragment_begin;
    expect(src).toContain('#if ( UNROLLED_LOOP_INDEX == 0 ) || ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )');
    patchCsmShader(); // idempotent
    expect(src.split('UNROLLED_LOOP_INDEX == 0').length).toBe(2);
  });
});

describe('texture build contract', () => {
  it('terrain layers match tools/textures/sets.json and the built manifest', () => {
    const sets = JSON.parse(fs.readFileSync(new URL('../../../tools/textures/sets.json', import.meta.url), 'utf8'));
    expect(sets.terrain.layers).toEqual([...TERRAIN_LAYERS]);
    const manifest = new URL('../../public/textures/terrain/manifest.json', import.meta.url);
    if (fs.existsSync(manifest)) expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).layers).toEqual([...TERRAIN_LAYERS]);
  });
  it('every tier switch exists for every effect', () => {
    for (const t of Object.values(WORLD_TIERS)) {
      expect(typeof t.bloom).toBe('boolean');
      expect(typeof t.godRays).toBe('boolean');
      expect(t.lodSplit).toBeGreaterThan(0.5);
    }
    expect(WORLD_TIERS.low.godRays).toBe(false);
    expect(WORLD_TIERS.high.godRays).toBe(true);
  });
});
