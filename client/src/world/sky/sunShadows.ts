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
    const own = m.onBeforeCompile;
    this.csm.setupMaterial(m);
    const csmHook = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      csmHook.call(m, shader, renderer);
      if (own !== THREE.Material.prototype.onBeforeCompile) own.call(m, shader, renderer);
    };
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
      this.csm.dispose();
      for (const l of this.lights) l.dispose();
    } else if (this.light) {
      this.parent.remove(this.light, this.light.target);
      this.light.dispose();
    }
  }
}
