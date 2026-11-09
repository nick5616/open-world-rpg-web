// Screen-space spell feedback for medium and up (high/ultra "go all out"):
// shockwave distortion rings, camera shake and short full-screen flashes,
// as ONE postprocessing Effect merged into the world's EffectPass (no extra
// pass, a few ALU per pixel; world/post/postfx.ts adds it when the shader
// tier is not low). Shake is a UV offset in post, so it never touches the
// camera rig (the camera agent's) and can't desync aim: the crosshair, an
// HTML overlay, stays put and the shake is a couple of pixels.
//
// Readability caps: flashes are at most 18% (a tint, never a white-out),
// shake decays in ~0.25 s, distortion only around the impact, and
// prefers-reduced-motion turns shake off.

import * as THREE from 'three';
import { Effect } from 'postprocessing';
import { budget } from './core';
import { reducedMotion } from './quality';

const MAX_WAVES = 4;

interface Wave {
  x: number;
  y: number;
  z: number;
  t0: number;
  dur: number;
  strength: number;
  radius: number;
}

const state = {
  waves: [] as Wave[],
  shake: 0,
  flash: new THREE.Color(0, 0, 0),
  flashA: 0,
  /** A held tint at the screen edges (your own shield). */
  tint: new THREE.Color(0, 0, 0),
  tintA: 0,
  /** Seconds; set by the FX engine every frame. */
  now: 0,
};
for (let i = 0; i < MAX_WAVES; i++) state.waves.push({ x: 0, y: 0, z: 0, t0: -99, dur: 1, strength: 0, radius: 1 });

/** A shockwave from a world point (distortion ring) plus shake scaled by distance to `cam`. */
export function screenKick(x: number, y: number, z: number, strength: number, cam: THREE.Vector3 | null, radius = 0.35, dur = 0.55): void {
  const p = budget.profile;
  if (p.distortion > 0) {
    let w = state.waves[0];
    for (const c of state.waves) if (c.t0 + c.dur < w.t0 + w.dur) w = c;
    w.x = x;
    w.y = y;
    w.z = z;
    w.t0 = state.now;
    w.dur = dur;
    w.strength = strength * p.distortion;
    w.radius = radius;
  }
  if (cam) {
    const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
    screenShake(strength * Math.max(0, 1 - d / 40));
  }
}

export function screenShake(a: number): void {
  if (reducedMotion()) return;
  state.shake = Math.min(1.2, Math.max(state.shake, a * budget.profile.shake));
}

export function screenFlash(color: THREE.Color, a: number): void {
  const k = Math.min(0.18, a * budget.profile.flash * (reducedMotion() ? 0.5 : 1));
  if (k <= state.flashA) return;
  state.flash.copy(color);
  state.flashA = k;
}

export function screenTint(color: THREE.Color | null, a = 0): void {
  if (color) state.tint.copy(color);
  state.tintA = color ? Math.min(0.5, a) : 0;
}

export function screenTick(now: number, dt: number): void {
  state.now = now;
  state.shake = Math.max(0, state.shake - dt * 4.5);
  state.flashA = Math.max(0, state.flashA - dt * 1.4);
}

/** For tests and the debug handle. */
export function screenState(): { shake: number; flashA: number; waves: number } {
  return { shake: state.shake, flashA: state.flashA, waves: state.waves.filter((w) => state.now - w.t0 < w.dur).length };
}

const FRAG = /* glsl */ `
uniform vec4 uWave[${MAX_WAVES}];   // xy uv centre, z radius (uv units), w strength (0 = off)
uniform vec2 uShake;
uniform float uAspect;
uniform vec4 uFlash;
uniform vec4 uTint;

void mainUv(inout vec2 uv) {
  uv += uShake;
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    vec4 w = uWave[i];
    if (w.w <= 0.0) continue;
    vec2 d = uv - w.xy;
    d.x *= uAspect;
    float r = length(d);
    float band = exp(-pow((r - w.z) / 0.035, 2.0));
    if (band < 0.002) continue;
    uv -= (d / max(r, 1e-4)) * vec2(1.0 / uAspect, 1.0) * band * w.w * 0.02;
  }
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  c += uFlash.rgb * uFlash.a;
  vec2 e = uv * 2.0 - 1.0;
  float edge = smoothstep(0.55, 1.25, length(e * vec2(1.0, 0.8)));
  c = mix(c, c + uTint.rgb, edge * uTint.a);
  outputColor = vec4(c, inputColor.a);
}
`;

const tmpV = new THREE.Vector3();
const tmpSize = new THREE.Vector2();

export class SpellScreenEffect extends Effect {
  constructor(private readonly camera: THREE.Camera) {
    super('SpellScreenEffect', FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ['uWave', new THREE.Uniform(Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()))],
        ['uShake', new THREE.Uniform(new THREE.Vector2())],
        ['uAspect', new THREE.Uniform(1)],
        ['uFlash', new THREE.Uniform(new THREE.Vector4())],
        ['uTint', new THREE.Uniform(new THREE.Vector4())],
      ]),
    });
  }

  override update(renderer: THREE.WebGLRenderer): void {
    const size = renderer.getSize(tmpSize);
    this.uniforms.get('uAspect')!.value = size.y > 0 ? size.x / size.y : 1;
    const waves = this.uniforms.get('uWave')!.value as THREE.Vector4[];
    for (let i = 0; i < MAX_WAVES; i++) {
      const w = state.waves[i];
      const k = (state.now - w.t0) / w.dur;
      const out = waves[i];
      if (k < 0 || k >= 1 || w.strength <= 0) {
        out.w = 0;
        continue;
      }
      tmpV.set(w.x, w.y, w.z).project(this.camera);
      if (tmpV.z > 1 || tmpV.z < -1) {
        out.w = 0;
        continue;
      }
      out.set(tmpV.x * 0.5 + 0.5, tmpV.y * 0.5 + 0.5, w.radius * (0.15 + k), w.strength * (1 - k) * (1 - k));
    }
    const sh = this.uniforms.get('uShake')!.value as THREE.Vector2;
    const a = state.shake * state.shake * 0.006;
    sh.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
    const f = this.uniforms.get('uFlash')!.value as THREE.Vector4;
    f.set(state.flash.r, state.flash.g, state.flash.b, state.flashA);
    const t = this.uniforms.get('uTint')!.value as THREE.Vector4;
    t.set(state.tint.r, state.tint.g, state.tint.b, state.tintA);
  }
}
