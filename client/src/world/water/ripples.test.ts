// Playtest 2: rain rings the water (water.ts RIPPLE_GLSL and its CPU twin).
import { describe, expect, it } from 'vitest';
import { createWaterMaterial, makeWaterUniforms, rainRing, rainRipples, ringProfile, ringRadius } from './water';

function maxSlope(time: number, rain: number): number {
  let m = 0;
  for (let x = 0; x < 6; x += 0.05) for (let z = 0; z < 6; z += 0.05) m = Math.max(m, Math.hypot(...rainRipples(x, z, time, rain)));
  return m;
}

describe('rain ripples', () => {
  it('a ring spreads out and fades as it ages', () => {
    const crest = (t: number) => {
      let best = -1;
      let at = 0;
      for (let r = 0; r < 0.5; r += 0.001) {
        const v = ringProfile(r - ringRadius(t), t);
        if (v > best) [best, at] = [v, r];
      }
      return { at, best };
    };
    const young = crest(0.1);
    const old = crest(0.7);
    expect(old.at).toBeGreaterThan(young.at + 0.15);
    expect(old.best).toBeLessThan(young.best);
    expect(Math.abs(ringProfile(0.2, 0.5))).toBe(0); // nothing far from the crest
  });

  it('still water when it is dry, rings when it rains', () => {
    expect(Math.abs(maxSlope(1.3, 0))).toBe(0);
    const heavy = maxSlope(1.3, 1);
    expect(heavy).toBeGreaterThan(0.3);
    expect(heavy).toBeLessThan(2.5);
  });

  it('light rain drops fewer rings than heavy rain', () => {
    let light = 0;
    let heavy = 0;
    for (let cx = 0; cx < 40; cx++)
      for (let cz = 0; cz < 40; cz++) {
        // the ring's crest at t0 = 0.25 cycles into the cell's drop: sample around the cell
        for (const [fx, fz] of [[0.5, 0.5], [0.3, 0.6], [0.65, 0.35], [0.4, 0.4]]) {
          if (Math.hypot(...rainRing(cx + fx, cz + fz, 0.25, 0.2)) > 1e-6) light++;
          if (Math.hypot(...rainRing(cx + fx, cz + fz, 0.25, 1)) > 1e-6) heavy++;
        }
      }
    expect(heavy).toBeGreaterThan(light * 2);
    expect(light).toBeGreaterThan(0);
  });

  it('the water shader takes uRain', () => {
    const u = makeWaterUniforms();
    expect(u.uRain.value).toBe(0);
    for (const sea of [false, true]) {
      const m = createWaterMaterial(u, sea);
      expect(m.uniforms.uRain).toBe(u.uRain);
      expect(m.fragmentShader).toContain('uniform float uRain;');
      expect(m.fragmentShader).toMatch(/if \(uRain > 0\.0 && dist < 30\.0\) g \+= rainRipples\(vWPos\.xz\)/);
      expect(m.fragmentShader).not.toContain('texture2D(uRipple'); // procedural: no textures
    }
  });
});
