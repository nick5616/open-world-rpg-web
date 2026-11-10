// Post-processing chain (spec 12 "The Valheim bar: light first"):
//
//   scene (HDR, half float, MSAA per tier)
//   -> atmosphere: exposure, height fog with sun in-scattering, aerial haze
//   -> god rays (high tier, half resolution, radial blur from the sun masked by depth)
//   -> bloom (medium/high: sun, gems, spells)
//   -> filmic tone mapping (ACES)
//   -> grade (lift/gamma/gain, saturation, warmth per time of day and biome)
//
// Built on `postprocessing` directly (one EffectPass merges the cheap
// effects into a single full-screen shader). The wizard-wars client lists the
// same library; its scene never mounted a composer, so the chain is new here.
// Fog lives in post rather than in every material: one formula for all
// materials (and other packages' materials) for the price of one pass, and
// it can use the analytic sky colour per pixel so distant terrain dissolves
// into exactly the sky behind it.

import * as THREE from 'three';
import { BlendFunction, BloomEffect, Effect, EffectAttribute, EffectComposer, EffectPass, FXAAEffect, GodRaysEffect, RenderPass, ToneMappingEffect, ToneMappingMode, type Pass } from 'postprocessing';
import { SKY_GLSL, SKY_STYLE_GLSL } from '../sky/atmosphere';
import { StyleEffect } from './styleEffect';
// Playtest 2: spell shockwave distortion, shake and flashes (combat/fx/screen.ts).
import { SpellScreenEffect } from '../../combat/fx/screen';

const FOG_FRAG = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uExposure;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBase;
uniform float uHaze;
// Playtest 2 styles: linear distance fog (start, end m; 0 = off), how far the
// fog colour climbs the sky at the horizon, and moonlit in-scatter at night.
uniform vec4 uFogRange;
uniform vec3 uMoonColor;
${SKY_GLSL}
${SKY_STYLE_GLSL}
vec3 fogColour(vec3 d) {
  return lsSkyStyle(skyAmbient(normalize(vec3(d.x, max(d.y, 0.03), d.z)), uSunDir), d.y);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 col = inputColor.rgb;
  if (depth < 0.999999) {
    vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vp /= vp.w;
    vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
    vec3 rd = wp - uCamPos;
    float L = length(rd);
    vec3 d = rd / max(L, 1e-4);
    // Exponential height fog, integrated analytically along the ray.
    float b = uFogFalloff;
    float base = uFogDensity * exp(-b * (uCamPos.y - uFogBase));
    // k clamped: looking down from high up, exp(-k) overflowed to Inf, and
    // Inf * a vanishing base is NaN (black squares once bloom spreads it).
    float k = clamp(b * d.y * L, -60.0, 60.0);
    float fh = abs(k) > 1e-4 ? base * L * (1.0 - exp(-k)) / k : base * L;
    float T = exp(-(max(fh, 0.0) + uHaze * L));
    if (uFogRange.y > 0.0) T = min(T, 1.0 - smoothstep(uFogRange.x, uFogRange.y, L));
    // Fog colour: the sky's Rayleigh + ambient light at the horizon in this
    // direction (no Mie aureole: that is concentrated near the sun disc and
    // turned the whole fog bank into a white-gold wall at dawn).
    vec3 sky = fogColour(d);
    // Sun in-scattering with a broad forward lobe: haze brightens toward the
    // sun, which is what makes god rays and valley fog read as lit air.
    float mu = dot(d, uSunDir);
    float g = 0.55;
    float pm = (1.0 - g * g) / (4.0 * PI_ * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
    vec3 inscatter = uSunColor * pm * 0.5;
    // Moonlight in the night fog (opposite the sun), so valley fog glows faintly blue.
    float mm = dot(d, -uSunDir);
    inscatter += uMoonColor * (0.25 + (1.0 - g * g) / (4.0 * PI_ * pow(1.0 + g * g - 2.0 * g * mm, 1.5)));
    col = col * T + (sky + inscatter) * (1.0 - T);
  } else if (uFogRange.z > 0.0) {
    // Retro: the fog colour climbs the sky at the horizon (the far plane is a wall of fog).
    vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    vec3 d = normalize((uCamWorld * vec4(vp.xyz / vp.w, 0.0)).xyz);
    col = mix(col, fogColour(d), uFogRange.z * (1.0 - smoothstep(0.0, 0.3, d.y)));
  }
  outputColor = vec4(col * uExposure, inputColor.a);
}
`;

export class AtmosphereFogEffect extends Effect {
  constructor() {
    super('AtmosphereFogEffect', FOG_FRAG, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['uInvProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamPos', new THREE.Uniform(new THREE.Vector3())],
        ['uSunDir', new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
        ['uSunColor', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uExposure', new THREE.Uniform(1)],
        ['uFogDensity', new THREE.Uniform(0.002)],
        ['uFogFalloff', new THREE.Uniform(1 / 45)],
        ['uFogBase', new THREE.Uniform(0)],
        ['uHaze', new THREE.Uniform(1 / 9000)],
        ['uFogRange', new THREE.Uniform(new THREE.Vector4(0, 0, 0, 0))],
        ['uMoonColor', new THREE.Uniform(new THREE.Color(0, 0, 0))],
        ['uSkyStyle', new THREE.Uniform(new THREE.Vector4(1, 1, 0, 0))],
      ]),
    });
  }
  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!;
  }
  setCamera(camera: THREE.PerspectiveCamera): void {
    (this.u('uInvProj').value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (this.u('uCamWorld').value as THREE.Matrix4).copy(camera.matrixWorld);
    (this.u('uCamPos').value as THREE.Vector3).copy(camera.position);
  }
}

const GRADE_FRAG = /* glsl */ `
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform float uSaturation;
uniform float uContrast;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = clamp(inputColor.rgb, 0.0, 1.0);
  c = c * uGain + uLift * (1.0 - c);
  c = pow(max(c, vec3(0.0)), 1.0 / uGamma);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = (c - 0.18) * uContrast + 0.18;
  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`;

/** Lift/gamma/gain grade (the parametric stand-in for per-biome LUTs; same knobs a LUT bakes). */
export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uLift', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['uGamma', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uGain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uSaturation', new THREE.Uniform(1.05)],
        ['uContrast', new THREE.Uniform(1.04)],
      ]),
    });
  }
  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!;
  }
}

export interface PostConfig {
  multisampling: number;
  bloom: boolean;
  godRays: boolean;
  /** Playtest 2 graphics settings: an FXAA pass after the main one. */
  fxaa?: boolean;
  /** Playtest 2: the spell screen effect (medium and up, every style; combat/fx/screen.ts). */
  spellScreen?: boolean;
}

export class PostFX {
  readonly composer: EffectComposer;
  readonly fog = new AtmosphereFogEffect();
  readonly grade = new GradeEffect();
  /** Playtest 2 visual styles: outlines, posterize, vignette, dithered quantize (styleEffect.ts). */
  readonly style = new StyleEffect();
  readonly sunSource: THREE.Mesh;
  readonly godRays: GodRaysEffect | null = null;
  readonly bloom: BloomEffect | null = null;
  /** Full-screen passes (the shader warm-up compiles their materials too). */
  readonly passes: Pass[] = [];
  /** The god-ray weight the chain was built with (styles scale it). */
  readonly godRayWeight = 0.22;

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    readonly scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
    cfg: PostConfig,
  ) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: cfg.multisampling });
    this.composer.addPass(new RenderPass(scene, camera));
    // Light source for the god rays: a disc toward the sun, never part of the
    // scene (the sky dome draws the visible sun); the effect renders it alone
    // against the scene depth, so terrain and trees mask the rays.
    this.sunSource = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, depthWrite: false, fog: false }));
    this.sunSource.frustumCulled = false;
    // The spell effect transforms UVs (shockwaves, shake), so it goes first.
    const effects: Effect[] = cfg.spellScreen ? [new SpellScreenEffect(camera), this.fog] : [this.fog];
    if (cfg.godRays) {
      this.godRays = new GodRaysEffect(camera, this.sunSource, { resolutionScale: 0.5, density: 0.9, decay: 0.93, weight: this.godRayWeight, exposure: 0.32, samples: 48, clampMax: 0.8, blur: true });
      effects.push(this.godRays);
    }
    if (cfg.bloom) {
      this.bloom = new BloomEffect({ mipmapBlur: true, intensity: 0.45, luminanceThreshold: 1.25, luminanceSmoothing: 0.3, radius: 0.65 });
      effects.push(this.bloom);
    }
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    effects.push(this.grade);
    effects.push(this.style);
    const main = new EffectPass(camera, ...effects);
    this.composer.addPass(main);
    this.passes.push(main);
    if (cfg.fxaa) {
      const aa = new EffectPass(camera, new FXAAEffect());
      this.composer.addPass(aa);
      this.passes.push(aa);
    }
  }

  /** Per frame: sun disc placement (inside the far plane) and fog camera matrices. */
  update(sunDir: THREE.Vector3, sunColor: THREE.Color, sunVisible: number): void {
    const far = this.camera.far * 0.9;
    this.sunSource.position.copy(this.camera.position).addScaledVector(sunDir, far);
    // ~1.6 degrees across: big enough to seed rays at half resolution, small
    // enough that the rays stay rays instead of a screen-wide glow.
    this.sunSource.scale.setScalar(far * 0.014);
    this.sunSource.updateMatrixWorld();
    (this.sunSource.material as THREE.MeshBasicMaterial).color.copy(sunColor).multiplyScalar(sunVisible);
    this.fog.setCamera(this.camera);
  }

  /**
   * Shader warm-up (WP19b, warmup.ts): one full-screen triangle per pass
   * material, so renderer.compileAsync links the post programs in parallel
   * with the scene's instead of the first composer.render linking them
   * synchronously. Call after setSize.
   */
  warmObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    for (const p of this.passes) {
      const m = p.fullscreenMaterial;
      if (m) {
        const mesh = new THREE.Mesh(tri, m);
        mesh.frustumCulled = false;
        out.push(mesh);
      }
    }
    return out;
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.sunSource.geometry.dispose();
    (this.sunSource.material as THREE.Material).dispose();
  }
}
