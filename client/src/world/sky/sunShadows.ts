// Sun (or moon) light with cascaded shadow maps (spec 12: sun only, 2
// cascades on medium, 3 on high, none on low), built on three's CSM addon.
//
// CSM makes one DirectionalLight per cascade and patches the global
// lights_fragment_begin chunk so materials set up with csm.setupMaterial()
// pick the right cascade. Every *other* lit material (the first-person arms,
// later remote players and FX from other packages) would still sum all N
// cascade lights and come out N times too bright. We patch the non-CSM branch
// of that chunk too, so plain materials use light 0 (the nearest cascade,
// shadowed near the camera, unshadowed beyond it) and ignore the others.
// Other packages therefore need no CSM code at all; materials that want
// far shadows call `sunShadows.setupMaterial(m)`.

import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import * as csmShaderModule from 'three/examples/jsm/csm/CSMShader.js';

// @types/three declares CSMShader as a type only; at runtime it is a mutable object of chunk strings.
const CSMShader = (csmShaderModule as unknown as { CSMShader: { lights_fragment_begin: string } }).CSMShader;

const NON_CSM_LOOP = /\n#if \( NUM_DIR_LIGHTS > 0 \) && defined\( RE_Direct \) && !defined\( USE_CSM \) && !defined\( CSM_CASCADES \)([\s\S]*?)#pragma unroll_loop_end\n\n#endif/;

let patched = false;
/** Make non-CSM materials use only directional light 0 among the shadow casters. Exported for tests. */
export function patchCsmShader(): void {
  if (patched) return;
  const src = CSMShader.lights_fragment_begin;
  const m = src.match(NON_CSM_LOOP);
  if (!m) throw new Error('three CSMShader layout changed: update sunShadows.ts NON_CSM_LOOP');
  const body = m[1].replace(
    /RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/,
    `#if ( UNROLLED_LOOP_INDEX == 0 ) || ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif`,
  );
  CSMShader.lights_fragment_begin = src.replace(m[1], body);
  patched = true;
}

type Hook = THREE.Material['onBeforeCompile'];
/** Each material's own onBeforeCompile, before any shadow rig wrapped it. */
const ORIGINAL_HOOK = new WeakMap<THREE.Material, Hook>();
/** The shader object of each material's current program (its live uniforms). */
const LAST_SHADER = new WeakMap<THREE.Material, { uniforms: Record<string, THREE.IUniform> }>();

export interface ShadowConfig {
  cascades: number;
  distance: number;
  mapSize: number;
}

/**
 * The scene's one directional light. With cascades = 0 it is a single
 * unshadowed DirectionalLight; otherwise a CSM rig. Rebuilt on tier change.
 */
export class SunShadows {
  readonly csm: CSM | null;
  readonly light: THREE.DirectionalLight | null;
  private readonly lights: THREE.DirectionalLight[];
  private readonly materials = new Set<THREE.Material>();

  constructor(
    private readonly parent: THREE.Object3D,
    camera: THREE.PerspectiveCamera,
    cfg: ShadowConfig,
  ) {
    if (cfg.cascades > 0) {
      patchCsmShader();
      this.csm = new CSM({
        camera,
        parent,
        cascades: cfg.cascades,
        maxFar: cfg.distance,
        mode: 'practical',
        shadowMapSize: cfg.mapSize,
        // Terrain is large and smooth: a small normal bias beats acne without peter-panning grass.
        shadowBias: -0.0002,
        lightNear: 1,
        lightFar: 3000,
        lightMargin: 400,
        lightIntensity: 3,
      });
      this.csm.fade = true;
      for (const l of this.csm.lights) {
        l.shadow.normalBias = 0.6;
        l.shadow.radius = 2;
      }
      this.light = null;
      this.lights = this.csm.lights;
    } else {
      this.csm = null;
      this.light = new THREE.DirectionalLight(0xffffff, 3);
      parent.add(this.light, this.light.target);
      this.lights = [this.light];
    }
  }

  /** Opt a material into cascade selection (terrain, scatter). Safe to call with shadows off. */
  setupMaterial(m: THREE.Material): void {
    if (!this.csm || this.materials.has(m)) return;
    this.materials.add(m);
    // The material's own hook, from before any rig wrapped it (a rebuilt rig
    // must not wrap the previous rig's wrapper).
    if (!ORIGINAL_HOOK.has(m)) ORIGINAL_HOOK.set(m, m.onBeforeCompile);
    const own = ORIGINAL_HOOK.get(m)!;
    this.csm.setupMaterial(m);
    const csmHook = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      csmHook.call(m, shader, renderer);
      if (own !== THREE.Material.prototype.onBeforeCompile) own.call(m, shader, renderer);
      LAST_SHADER.set(m, shader);
    };
    // Playtest 2 graphics settings: a rebuilt rig with the same cascade count
    // gives the material the same program key, so three.js reuses its program
    // without calling onBeforeCompile again. Hand this rig the live shader
    // object so it keeps updating the cascade uniforms.
    const prev = LAST_SHADER.get(m);
    if (prev?.uniforms.CSM_cascades) (this.csm.shaders as unknown as Map<THREE.Material, unknown>).set(m, prev); // @types says string; it holds shader objects
  }

  forget(m: THREE.Material): void {
    if (this.csm && this.materials.delete(m)) this.csm.shaders.delete(m);
  }

  /** Per frame: light direction (toward the light), colour, intensity; camera-following cascades. */
  update(camera: THREE.Camera, towardLight: THREE.Vector3, color: THREE.Color, intensity: number): void {
    if (this.csm) {
      this.csm.lightDirection.copy(towardLight).negate();
      for (const l of this.lights) {
        l.color.copy(color);
        l.intensity = intensity;
      }
      this.csm.update();
    } else if (this.light) {
      const p = camera.position;
      this.light.position.set(p.x + towardLight.x * 100, p.y + towardLight.y * 100, p.z + towardLight.z * 100);
      this.light.target.position.copy(p);
      this.light.color.copy(color);
      this.light.intensity = intensity;
    }
  }

  /** After a camera projection change (resize, fov). */
  updateFrustums(): void {
    this.csm?.updateFrustums();
  }

  dispose(): void {
    if (this.csm) {
      this.csm.remove();
      // Not csm.dispose(): it deletes the cascade uniforms from the live
      // shader objects, and a material whose program key does not change
      // (the next rig has the same cascade count) keeps that program and its
      // uniforms, so the next draw threw in WebGLUniforms.upload. Restore the
      // materials' own hooks and defines instead; the next rig re-adds them.
      for (const m of this.materials) {
        m.onBeforeCompile = ORIGINAL_HOOK.get(m) ?? THREE.Material.prototype.onBeforeCompile;
        if (m.defines) {
          delete m.defines.USE_CSM;
          delete m.defines.CSM_CASCADES;
          delete m.defines.CSM_FADE;
        }
        m.needsUpdate = true;
      }
      this.csm.shaders.clear();
      this.materials.clear();
      for (const l of this.lights) l.dispose();
    } else if (this.light) {
      this.parent.remove(this.light, this.light.target);
      this.light.dispose();
    }
  }
}
