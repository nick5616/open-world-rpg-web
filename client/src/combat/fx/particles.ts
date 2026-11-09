// GPU particle system shared by every spell (ported from wizard-wars
// client/src/components/spells/fx/particles.ts).
//
// Two draw calls for ALL particles in the game (one additive pool for
// light/fire/magic, one alpha-blended pool for smoke/mist/black fire),
// however many spells are live. Each particle is written ONCE, at spawn,
// into a ring buffer (start position, velocity, colour, spawn time,
// lifetime, size, gravity, drag, shape); the vertex shader evaluates the
// closed-form motion (drag-damped velocity + gravity) from uTime - spawn,
// so the CPU never touches a particle again and only the slice of the ring
// written this frame is uploaded.
//
// Shapes: 0 soft glow, 1 velocity-stretched spark streak, 2 four-point star
// glint, 3 soft billowing puff (grows over life: smoke, mist, black fire).
//
// Lodestone changes: uHdr (bright cores feed the bloom on medium and up),
// the emission counter for the per-frame budget (core.ts), and sprites are
// faded near the camera so your own cast never fogs the first-person view.

import * as THREE from 'three';
import { budget, fxTime } from './core';

export const SHAPE_GLOW = 0;
export const SHAPE_SPARK = 1;
export const SHAPE_STAR = 2;
export const SHAPE_PUFF = 3;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uScale;
uniform float uMaxPoint;
uniform vec2 uResolution;
attribute vec3 aVel;
attribute vec3 aColor;
attribute vec2 aTime;
attribute vec4 aParams;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying vec2 vDir;
varying float vStretch;
varying float vHot;
varying float vSeed;
void main() {
  float age = uTime - aTime.x;
  float t = age / aTime.y;
  if (age < 0.0 || t >= 1.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float drag = aParams.z;
  float e = exp(-drag * age);
  float k = drag > 0.0001 ? (1.0 - e) / drag : age;
  vec3 p = position + aVel * k;
  p.y += 0.5 * aParams.y * age * age;
  vec3 v = aVel * e;
  v.y += aParams.y * age;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * mv;
  gl_Position = clip;

  float shape = aParams.w;
  float grow = shape > 2.5 ? (0.55 + t * 1.3) : (shape > 1.5 ? (1.0 - t * 0.5) : (1.0 - t * 0.75));
  float sizePx = aParams.x * 2.2 * grow * uScale / max(0.05, -mv.z);

  float stretch = 1.0;
  vec2 dir = vec2(1.0, 0.0);
  if (shape > 0.5 && shape < 1.5 && clip.w > 0.0) {
    vec4 clip2 = projectionMatrix * modelViewMatrix * vec4(p + v * 0.045, 1.0);
    if (clip2.w > 0.0) {
      vec2 d = (clip2.xy / clip2.w - clip.xy / clip.w) * uResolution * 0.5;
      float len = length(d);
      if (len > 0.001) dir = d / len;
      stretch = clamp(1.0 + len / max(sizePx, 1.0), 1.0, 9.0);
    }
  }
  vDir = dir;
  vStretch = stretch;
  // Cap sprites at a fraction of the screen: anything bigger is a particle
  // practically touching the lens, a blurry blob AND the worst overdraw.
  gl_PointSize = min(sizePx * stretch, min(uMaxPoint, uResolution.y * 0.22));

  vColor = aColor;
  vShape = shape;
  vSeed = fract(aTime.x * 17.31 + position.x * 3.7);
  vAlpha = smoothstep(0.0, shape > 2.5 ? 0.15 : 0.05, t) * (1.0 - smoothstep(0.45, 1.0, t));
  // Readability: fade anything within ~2 m of the camera.
  vAlpha *= smoothstep(0.6, 2.2, -mv.z);
  vHot = 1.0 - smoothstep(0.0, 0.35, t);
}
`;

const FRAG = /* glsl */ `
uniform float uAdditive;
uniform float uHdr;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying vec2 vDir;
varying float vStretch;
varying float vHot;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  c.y = -c.y;
  float a;
  if (vShape < 0.5) {
    float d = dot(c, c);
    a = exp(-d * 4.0) * (1.0 - smoothstep(0.7, 1.0, d));
  } else if (vShape < 1.5) {
    float along = dot(c, vDir);
    float across = dot(c, vec2(-vDir.y, vDir.x)) * vStretch;
    float d = along * along + across * across;
    a = 1.0 - smoothstep(0.0, 1.0, d);
    a *= a;
  } else if (vShape < 2.5) {
    float d = length(c);
    float ang = vSeed * 1.57;
    vec2 r = vec2(c.x * cos(ang) - c.y * sin(ang), c.x * sin(ang) + c.y * cos(ang));
    float cross = max(exp(-abs(r.x) * 16.0), exp(-abs(r.y) * 16.0)) * (1.0 - d);
    a = max(exp(-d * d * 14.0), cross);
  } else {
    // Soft billow: two offset gaussians so puffs read as irregular cloud.
    vec2 o = vec2(cos(vSeed * 6.28), sin(vSeed * 6.28)) * 0.28;
    float a1 = exp(-dot(c - o, c - o) * 3.2);
    float a2 = exp(-dot(c + o * 0.8, c + o * 0.8) * 4.0);
    a = max(a1, a2 * 0.85) * (1.0 - smoothstep(0.75, 1.0, dot(c, c)));
    a *= 0.6;
  }
  a *= vAlpha;
  if (a < 0.003) discard;
  vec3 col = vColor;
  if (uAdditive > 0.5) col = mix(col, vec3(1.0), vHot * 0.35) * (1.0 + vHot * 0.8) * uHdr;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SIZES = [3, 3, 3, 2, 4];

export class ParticlePool {
  readonly capacity: number;
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private head = 0;
  private dirtyFrom = Infinity;
  private dirtyTo = -1;
  private wrapped = false;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly color: Float32Array;
  private readonly time: Float32Array;
  private readonly params: Float32Array;
  private readonly attrs: THREE.BufferAttribute[];

  constructor(capacity: number, additive: boolean) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
    this.time = new Float32Array(capacity * 2);
    this.params = new Float32Array(capacity * 4);
    // Park every slot as already dead (spawned far in the past).
    for (let i = 0; i < capacity; i++) {
      this.time[i * 2] = -1e6;
      this.time[i * 2 + 1] = 1;
    }
    const geo = new THREE.BufferGeometry();
    const mk = (arr: Float32Array, size: number) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [mk(this.pos, 3), mk(this.vel, 3), mk(this.color, 3), mk(this.time, 2), mk(this.params, 4)];
    geo.setAttribute('position', this.attrs[0]);
    geo.setAttribute('aVel', this.attrs[1]);
    geo.setAttribute('aColor', this.attrs[2]);
    geo.setAttribute('aTime', this.attrs[3]);
    geo.setAttribute('aParams', this.attrs[4]);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 600 },
        uMaxPoint: { value: 256 },
        uResolution: { value: new THREE.Vector2(1280, 720) },
        uAdditive: { value: additive ? 1 : 0 },
        uHdr: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 20 : 19;
    this.points.name = additive ? 'fx-glow' : 'fx-smoke';
  }

  /**
   * Spawn one particle. Positional args (no options object): called
   * thousands of times a second, zero allocations per particle.
   */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, life: number, size: number, gravity = 0, drag = 0, shape = SHAPE_GLOW, delay = 0): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    const i3 = i * 3;
    const i2 = i * 2;
    const i4 = i * 4;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.color[i3] = color.r;
    this.color[i3 + 1] = color.g;
    this.color[i3 + 2] = color.b;
    this.time[i2] = fxTime() + delay;
    this.time[i2 + 1] = Math.max(0.01, life);
    this.params[i4] = size;
    this.params[i4 + 1] = gravity;
    this.params[i4 + 2] = drag;
    this.params[i4 + 3] = shape;
    if (i < this.dirtyFrom) this.dirtyFrom = i;
    if (i > this.dirtyTo) this.dirtyTo = i;
    budget.emitted++;
  }

  /** Uploads only the slice of the ring written since the last frame. */
  flush(): void {
    if (this.dirtyTo < 0) return;
    for (let a = 0; a < this.attrs.length; a++) {
      const attr = this.attrs[a];
      const s = SIZES[a];
      attr.clearUpdateRanges();
      // Wrapped within one frame: the written region may be two runs; send it all.
      if (this.wrapped) attr.addUpdateRange(0, this.capacity * s);
      else attr.addUpdateRange(this.dirtyFrom * s, (this.dirtyTo - this.dirtyFrom + 1) * s);
      attr.needsUpdate = true;
    }
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
    this.wrapped = false;
  }

  /** Kills every particle (scene changes, the gallery between shots). */
  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.time[i * 2] = -1e6;
    this.dirtyFrom = 0;
    this.dirtyTo = this.capacity - 1;
  }

  /** Live particles (tests, debug): slots whose spawn + life is after `t`. */
  liveAt(t: number): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.time[i * 2] + this.time[i * 2 + 1] > t && this.time[i * 2] <= t) n++;
    return n;
  }
}

// Additive: fire, sparks, magic, light. Alpha: smoke, mist, debris dust, black fire.
export const glowPool = new ParticlePool(12000, true);
export const smokePool = new ParticlePool(3000, false);
