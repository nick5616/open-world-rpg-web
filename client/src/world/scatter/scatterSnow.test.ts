// Playtest 2: grass and trees whiten under settled snow (scatterMaterials snowMix).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createBillboardMaterial, createScatterMaterial, scatterSnowUniforms, snowMix, SNOW_MIX_GLSL } from './scatterMaterials';

type Shader = { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string };
function compiled(doubleSided: boolean): Shader {
  const m = createScatterMaterial({ fade: new THREE.Vector4(-1, 0, 0, 0), sway: 0, flutter: 0, doubleSided });
  const shader: Shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  m.onBeforeCompile(shader as never, null as never);
  return shader;
}

describe('scatter snow', () => {
  it('no snow, no white', () => {
    for (const g of [0, 1]) for (const f of [0, 1]) expect(snowMix(0, g, f, 1, 1)).toBe(0);
  });

  it('grass whitens mostly toward the tips', () => {
    const root = snowMix(1, 1, 1, 0, 1);
    const tip = snowMix(1, 1, 1, 1, 1);
    expect(tip).toBeGreaterThan(0.8);
    expect(root).toBeLessThan(0.3);
    expect(snowMix(0.5, 1, 1, 1, 1)).toBeLessThan(tip);
  });

  it('leaves partly on upward faces, bark barely', () => {
    const leafUp = snowMix(1, 0, 1, 0.5, 1);
    const leafSide = snowMix(1, 0, 1, 0.5, 0);
    const barkUp = snowMix(1, 0, 0, 0.5, 1);
    expect(leafUp).toBeGreaterThan(0.4);
    expect(leafUp).toBeLessThan(0.7);
    expect(leafSide).toBe(0);
    expect(barkUp).toBeLessThan(0.15);
    expect(barkUp).toBeGreaterThan(0);
  });

  it('the GLSL twin computes the same curve', () => {
    // Same constants in the same order: smoothstep(0.1, 0.8, cover), 0.2 + 0.65 * smoothstep(0.15, 1.0, h), mix(0.1, 0.55, foliage) * smoothstep(0.2, 0.9, up).
    expect(SNOW_MIX_GLSL).toContain('smoothstep(0.1, 0.8, cover)');
    expect(SNOW_MIX_GLSL).toContain('0.2 + 0.65 * smoothstep(0.15, 1.0, h)');
    expect(SNOW_MIX_GLSL).toContain('mix(0.1, 0.55, foliage) * smoothstep(0.2, 0.9, up)');
  });

  it('the patched shaders carry the shared snow uniform', () => {
    for (const ds of [false, true]) {
      const s = compiled(ds);
      expect(s.uniforms.uSnowCover).toBe(scatterSnowUniforms.uSnowCover);
      expect(s.vertexShader).toContain('uniform float uSnowCover;');
      expect(s.vertexShader).toContain(`vSnow = lsSnowMix(uSnowCover, ${ds ? '1.0' : '0.0'}, aFoliage`);
      expect(s.fragmentShader).toContain('varying float vSnow;');
      expect(s.fragmentShader).toMatch(/#include <color_fragment>\s*diffuseColor\.rgb = mix\(diffuseColor\.rgb, vec3\(0\.82, 0\.86, 0\.92\), vSnow\);/);
    }
    const m = createScatterMaterial({ fade: new THREE.Vector4(), sway: 0, flutter: 0, doubleSided: true });
    expect(m.customProgramCacheKey()).toBe('lodestone-scatter-3-ds');
    const light = { uSunDir: { value: new THREE.Vector3() }, uLightColor: { value: new THREE.Color() }, uAmbient: { value: new THREE.Color() } };
    const bb = createBillboardMaterial(new THREE.Texture(), 0, 1, new THREE.Vector4(), light) as unknown as THREE.ShaderMaterial;
    expect(bb.uniforms.uSnowCover).toBe(scatterSnowUniforms.uSnowCover);
    expect(bb.fragmentShader).toContain('lsSnowMix(uSnowCover');
  });
});
