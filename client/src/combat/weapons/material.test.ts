// Playtest 2 polish: steel reads as steel (weapons/material.ts METAL_GLSL,
// shared with the armor material). metalEnv is the shader's sky reflection
// on the CPU.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ENV_GAIN, METAL_GLSL, METAL_MAX, metalEnv } from './material';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lin = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex); // linear, as the vertex colours
  return [c.r, c.g, c.b];
};
const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const IRON = lin('#8c9198'); // weapons/models.ts METALS.iron base
// world/sky/atmosphere.ts: the hemisphere's sky is the zenith normalised (max channel 1), a saturated blue at noon
const NOON = { sky: [0.42, 0.66, 1] as const, ground: [0.3, 0.28, 0.19] as const, env: ENV_GAIN * 1.3 };
const NIGHT = { sky: [0.3, 0.45, 1] as const, ground: [0.1, 0.1, 0.08] as const, env: ENV_GAIN * 0.25 };

/** The reflection the shader had before (a fifth of the sky's light face-on, the zenith's blue at the horizon). */
function oldEnv(base: readonly number[], metal: number, rough: number, up: number, facing: number, sky: readonly number[], ground: readonly number[], hemi: number) {
  const s = Math.min(1, Math.max(0, (up + 0.35) / 0.9));
  const t = s * s * (3 - 2 * s);
  const fres = Math.pow(1 - facing, 3);
  const k = 0.7 * hemi * metal * (1 - 0.7 * rough) * (0.45 + 0.55 * fres);
  return [0, 1, 2].map((i) => base[i] * (ground[i] + (sky[i] - ground[i]) * t) * k);
}

describe('metal under the game light', () => {
  it('an iron blade facing you reflects a pale horizon, not navy, and much brighter than before', () => {
    const now = metalEnv(IRON, 0.85, 0.5, 0, 1, NOON.sky, NOON.ground, NOON.env);
    const before = oldEnv(IRON, 0.85, 0.5, 0, 1, NOON.sky, NOON.ground, 1.3);
    expect(lum(now)).toBeGreaterThan(2.5 * lum(before));
    expect(now[2] / now[0]).toBeLessThan(1.6); // grey-blue steel
    expect(before[2] / before[0]).toBeGreaterThan(now[2] / now[0]); // the old one was bluer
    // at least what a matte surface of the same colour gets from the sky alone (irradiance / pi)
    const matte = lum(IRON) * lum(NOON.sky) * 1.3 * (1 - METAL_MAX) / Math.PI;
    expect(lum(now)).toBeGreaterThan(matte);
  });

  it('is not flat: faces that reflect the sky, the horizon and the ground differ', () => {
    const at = (up: number) => lum(metalEnv(IRON, 0.85, 0.5, up, 1, NOON.sky, NOON.ground, NOON.env));
    expect(at(0.8)).toBeGreaterThan(at(0));
    expect(at(0)).toBeGreaterThan(1.3 * at(-0.6));
    // grazing angles go toward white (Fresnel), face-on keeps the metal's colour
    expect(lum(metalEnv(IRON, 0.85, 0.2, 0, 0.05, NOON.sky, NOON.ground, NOON.env))).toBeGreaterThan(lum(metalEnv(IRON, 0.85, 0.2, 0, 1, NOON.sky, NOON.ground, NOON.env)));
  });

  it('a rough metal sees a softer sky, not a darker one', () => {
    const smooth = metalEnv(IRON, 0.85, 0.1, -0.2, 1, NOON.sky, NOON.ground, NOON.env);
    const rough = metalEnv(IRON, 0.85, 0.9, -0.2, 1, NOON.sky, NOON.ground, NOON.env);
    expect(lum(rough)).toBeGreaterThan(0.6 * lum(smooth));
  });

  it('follows the hemisphere light: dimmer at night, still steel-coloured', () => {
    const day = metalEnv(IRON, 0.85, 0.5, 0, 1, NOON.sky, NOON.ground, NOON.env);
    const night = metalEnv(IRON, 0.85, 0.5, 0, 1, NIGHT.sky, NIGHT.ground, NIGHT.env);
    expect(lum(night)).toBeLessThan(0.35 * lum(day));
    expect(lum(night)).toBeGreaterThan(0);
  });
});

describe('the shader', () => {
  it('caps metalness, reflects the sky and the scene lights, in both the weapon and the armor material', () => {
    expect(METAL_GLSL.metalness).toContain(`min(mtMetal, ${METAL_MAX.toFixed(3)})`);
    expect(METAL_GLSL.sheen).toContain('pointLights[i]'); // campfires and cave lights
    expect(METAL_GLSL.sheen).toContain('directionalLights[i]'); // the sun and moon
    expect(METAL_GLSL.sheen.startsWith('#include <lights_fragment_end>')).toBe(true);
    for (const f of ['combat/weapons/material.ts', 'combat/armor/material.ts']) {
      const text = readFileSync(path.join(SRC, f), 'utf8');
      for (const part of ['METAL_GLSL.metalness', 'METAL_GLSL.roughness', 'METAL_GLSL.reflection', 'METAL_GLSL.sheen']) expect(text, `${part} in ${f}`).toContain(part);
    }
  });
});
