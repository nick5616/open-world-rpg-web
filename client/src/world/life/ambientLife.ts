// Ambient world life (playtest 2 immersion pass: "the world is empty: no
// birds, no insects, nothing moves but the grass"). Small, cheap, purely
// decorative creatures and motes around the camera, chosen by the biome
// under it, the hour and the weather:
//
//   birds        three flocks wheeling 35-75 m up by day (crows over meadows
//                and woods, hawks soaring over the highlands and badlands);
//                wings flap in bursts and glide between
//   butterflies  fluttering over the grass by day (meadow, wetland, highlands)
//   fireflies    slow, soft glows low over the ground on warm dry nights
//                (wetland, forest, meadow); they pulse over seconds, never
//                blink fast (no flashing)
//   leaves       drifting down and tumbling on the wind in woods
//   motes        pollen and fluff catching the sun on calm days
//
// Everything lives at world positions anchored in a box around the camera
// (an anchor that falls out of the box wraps to the far side and samples the
// ground once), so creatures hold still in the world as you walk instead of
// sliding with the view. One draw call per kind (5), a few hundred instances,
// CPU work a few microseconds a frame; nothing allocates per frame. Hidden
// underground, in towns' streets (butterflies thin, no leaves), in rain or
// snow (birds thin out, insects hide), and per quality (Low halves counts).
// Gameplay never sees any of it.

import * as THREE from 'three';
import { windState } from '../wind';

export const BIOME = { meadow: 0, forest: 1, highlands: 2, snowpeak: 3, badlands: 4, wetland: 5 } as const;

/** Per biome: how much of each kind lives there (0..1). */
export const LIFE_BY_BIOME: Record<number, { birds: number; butterflies: number; fireflies: number; leaves: number; motes: number; hawks: number }> = {
  0: { birds: 1, butterflies: 1, fireflies: 0.6, leaves: 0.15, motes: 1, hawks: 0.2 },
  1: { birds: 0.7, butterflies: 0.35, fireflies: 0.85, leaves: 1, motes: 0.6, hawks: 0 },
  2: { birds: 0.6, butterflies: 0.45, fireflies: 0.2, leaves: 0.1, motes: 0.45, hawks: 1 },
  3: { birds: 0.25, butterflies: 0, fireflies: 0, leaves: 0, motes: 0, hawks: 0.6 },
  4: { birds: 0.3, butterflies: 0.08, fireflies: 0, leaves: 0, motes: 0.25, hawks: 1 },
  5: { birds: 1, butterflies: 0.6, fireflies: 1, leaves: 0.3, motes: 0.7, hawks: 0.1 },
};

export interface LifeInput {
  camera: THREE.Camera;
  dt: number;
  /** Hour of day 0-24. */
  hour: number;
  /** 0 night .. 1 full day (sky lighting). */
  day: number;
  rain: number;
  snow: number;
  /** 0 surface .. 1 underground. */
  under: number;
  /** In a town's radius (fewer butterflies, no leaves). */
  inTown: boolean;
  /** Biome id at a point (null: unknown, treated as meadow). */
  biomeAt: (x: number, z: number) => number | null;
  /** Ground height (null: unknown yet). */
  groundAt: (x: number, z: number) => number | null;
  /** Water surface height at a point (sea, lakes, rivers; -Infinity: none), so nothing sits under water. */
  waterAt: (x: number, z: number) => number;
  /** Drawing-buffer height in CSS px (point sizes). */
  viewportH: number;
}

/** What the scene asks of each kind right now (pure, tested). */
export function lifeWeights(biome: { birds: number; butterflies: number; fireflies: number; leaves: number; motes: number; hawks: number }, hour: number, day: number, rain: number, snow: number, under: number, inTown: boolean) {
  const above = Math.max(0, 1 - under * 3);
  const wet = Math.min(1, rain * 1.5 + snow * 1.5);
  const dry = 1 - wet;
  // dawn chorus to dusk: birds from 5:30 to 20:00, most in the morning and evening
  const birdHours = smoothstep(5.2, 6.4, hour) * (1 - smoothstep(19.4, 20.4, hour));
  const nightK = 1 - smoothstep(0.08, 0.3, day);
  // fireflies: from dusk to the small hours, gone by dawn
  const fireHours = hour >= 19.5 || hour < 3.5 ? 1 : hour < 4.5 ? 1 - (hour - 3.5) : 0;
  return {
    birds: biome.birds * birdHours * (1 - 0.7 * wet) * above,
    hawks: biome.hawks * birdHours * (1 - 0.8 * wet) * above,
    butterflies: biome.butterflies * smoothstep(0.35, 0.7, day) * dry * above * (inTown ? 0.3 : 1),
    fireflies: biome.fireflies * nightK * fireHours * dry * above * (inTown ? 0.4 : 1),
    leaves: biome.leaves * (1 - 0.6 * snow) * above * (inTown ? 0 : 1),
    motes: biome.motes * smoothstep(0.3, 0.8, day) * dry * above * (inTown ? 0.5 : 1),
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Shaders ───────────────────────────────────────────────────────────────

/** Winged things (birds, butterflies): `aWing` = how far out along the wing (0 body .. 1 tip), signed by side. */
const WING_VERT = /* glsl */ `
attribute float aWing;
attribute float aPhase;
uniform float uTime;
uniform float uFlapHz;
uniform float uFlapAmp;
uniform float uGlide;
varying vec3 vCol;
varying float vShade;
void main() {
  float ph = aPhase;
  // flap in bursts: a slow envelope picks flapping or gliding (birds); butterflies always flap
  float burst = mix(1.0, smoothstep(-0.2, 0.4, sin(uTime * 0.55 + ph * 7.0)), uGlide);
  float flap = sin(uTime * uFlapHz + ph * 31.0) * uFlapAmp * (0.15 + 0.85 * burst) + (1.0 - burst) * 0.12;
  vec3 p = position;
  float w = abs(aWing);
  // raise both wings about the body's long axis (z), the tips most
  float ang = flap * (0.55 + 0.45 * w);
  float d = abs(p.x);
  p.x = sign(p.x) * d * cos(ang);
  p.y += d * sin(ang);
  vCol = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vCol = instanceColor;
  #endif
  vShade = 0.75 + 0.25 * (1.0 - w);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}
`;
const WING_FRAG = /* glsl */ `
uniform vec3 uLight;
varying vec3 vCol;
varying float vShade;
void main() {
  gl_FragColor = vec4(vCol * uLight * vShade, 1.0);
}
`;

/** Glowing or sunlit points (fireflies, motes): soft round sprites, `aSeed` per point. */
const POINT_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uSize;
uniform float uScale;
uniform float uPulse;
varying float vA;
varying float vSeed;
void main() {
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // fireflies glow up and fade over 2-5 s each, out of step (no fast blinking)
  float glow = 0.5 + 0.5 * sin(uTime * (1.2 + aSeed * 1.4) + aSeed * 40.0);
  glow = smoothstep(0.25, 1.0, glow);
  vA = mix(1.0, glow, uPulse);
  gl_PointSize = clamp(uSize * (0.7 + 0.6 * aSeed) * uScale / max(-mv.z, 0.1), 1.0, 18.0);
}
`;
const POINT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float a = smoothstep(0.5, 0.0, r);
  a *= a;
  gl_FragColor = vec4(uColor * (0.85 + 0.3 * vSeed), a * uOpacity * vA);
}
`;

// ── Geometry ──────────────────────────────────────────────────────────────

/** A bird seen from below: a slim body and two swept wings with a crooked joint (faces up and down). */
function birdGeometry(): THREE.BufferGeometry {
  // x = right, y = up, z = forward (-z is the flight direction after the instance turn)
  const pos: number[] = [];
  const wing: number[] = [];
  const tri = (a: number[], b: number[], c: number[], wa: number, wb: number, wc: number) => {
    pos.push(...a, ...b, ...c);
    wing.push(wa, wb, wc);
  };
  // body (a thin diamond) and tail
  tri([0, 0, -0.28], [0.05, 0, 0], [-0.05, 0, 0], 0, 0, 0);
  tri([0.05, 0, 0], [0, 0, 0.22], [-0.05, 0, 0], 0, 0, 0);
  tri([0, 0, 0.16], [0.09, 0, 0.32], [-0.09, 0, 0.32], 0, 0, 0);
  for (const s of [1, -1]) {
    // inner wing, then the outer wing swept back from the wrist
    tri([0.04 * s, 0, -0.08], [0.32 * s, 0.02, -0.06], [0.04 * s, 0, 0.08], 0.05 * s, 0.5 * s, 0.05 * s);
    tri([0.32 * s, 0.02, -0.06], [0.3 * s, 0.02, 0.06], [0.04 * s, 0, 0.08], 0.5 * s, 0.5 * s, 0.05 * s);
    tri([0.32 * s, 0.02, -0.06], [0.62 * s, 0.03, 0.08], [0.3 * s, 0.02, 0.06], 0.5 * s, 1 * s, 0.5 * s);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  return g;
}

/** A butterfly: two rounded wing pairs (fore and hind) on a short body. */
function butterflyGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const wing: number[] = [];
  const tri = (a: number[], b: number[], c: number[], wa: number, wb: number, wc: number) => {
    pos.push(...a, ...b, ...c);
    wing.push(wa, wb, wc);
  };
  tri([0, 0, -0.03], [0.006, 0, 0.03], [-0.006, 0, 0.03], 0, 0, 0);
  for (const s of [1, -1]) {
    // forewing (bigger), hindwing (rounder, behind)
    tri([0.005 * s, 0, -0.01], [0.05 * s, 0, -0.035], [0.06 * s, 0, 0.005], 0.1 * s, 0.85 * s, 1 * s);
    tri([0.005 * s, 0, -0.01], [0.06 * s, 0, 0.005], [0.005 * s, 0, 0.005], 0.1 * s, 1 * s, 0.1 * s);
    tri([0.005 * s, 0, 0.005], [0.045 * s, 0, 0.012], [0.03 * s, 0, 0.04], 0.1 * s, 0.8 * s, 0.6 * s);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  return g;
}

/** A leaf: a small diamond, double-sided. */
function leafGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.05, 0.03, 0, 0, 0, 0, 0.045, 0, 0, -0.05, 0, 0, 0.045, -0.03, 0, 0], 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute([0, 0.6, 0, 0, 0, -0.6], 1));
  return g;
}

function wingMaterial(flapHz: number, flapAmp: number, glide: number, side: THREE.Side = THREE.DoubleSide): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: WING_VERT,
    fragmentShader: WING_FRAG,
    uniforms: { uTime: { value: 0 }, uFlapHz: { value: flapHz }, uFlapAmp: { value: flapAmp }, uGlide: { value: glide }, uLight: { value: new THREE.Color(1, 1, 1) } },
    side,
  });
}

function pointMaterial(color: THREE.ColorRepresentation, size: number, pulse: number, additive: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: { uTime: { value: 0 }, uSize: { value: size }, uScale: { value: 600 }, uPulse: { value: pulse }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

// Materials are module-level so the shader warm-up (warmExtras.ts) can compile them before play.
let mats: { bird: THREE.ShaderMaterial; butterfly: THREE.ShaderMaterial; leaf: THREE.ShaderMaterial; firefly: THREE.ShaderMaterial; mote: THREE.ShaderMaterial } | null = null;
function materials() {
  mats ??= {
    bird: wingMaterial(9, 0.75, 1),
    butterfly: wingMaterial(30, 1.1, 0),
    leaf: wingMaterial(2.2, 0.5, 0),
    firefly: pointMaterial(new THREE.Color(2.8, 3.4, 1.2), 0.17, 1, true),
    mote: pointMaterial('#fff6d8', 0.05, 0, false),
  };
  return mats;
}

/** One tiny object per ambient-life program (shader warm-up, WP19b). */
export function ambientLifeWarmObjects(): THREE.Object3D[] {
  const m = materials();
  const out: THREE.Object3D[] = [];
  const bg = birdGeometry();
  for (const mat of [m.bird, m.butterfly, m.leaf]) {
    const im = new THREE.InstancedMesh(bg, mat, 1);
    im.setColorAt(0, new THREE.Color(1, 1, 1));
    out.push(im);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  pg.setAttribute('aSeed', new THREE.Float32BufferAttribute([0], 1));
  out.push(new THREE.Points(pg, m.firefly), new THREE.Points(pg, m.mote));
  return out;
}

// ── The layer ─────────────────────────────────────────────────────────────

/** Anchor box edge around the camera per kind, m (small things live close, or they would be invisible specks). */
const BOX = { butterflies: 34, leaves: 30, fireflies: 48, motes: 22 };

interface Swarm {
  n: number;
  box: number;
  /** Anchor world xz, ground y (NaN: sample again), per-creature phase. */
  ax: Float32Array;
  az: Float32Array;
  gy: Float32Array;
  /** Water surface over the anchor (-Infinity: dry land). */
  wy: Float32Array;
  ph: Float32Array;
}

function swarm(n: number, box: number, r: () => number): Swarm {
  const s: Swarm = { n, box, ax: new Float32Array(n), az: new Float32Array(n), gy: new Float32Array(n).fill(Number.NaN), wy: new Float32Array(n).fill(-Infinity), ph: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    s.ax[i] = (r() - 0.5) * box;
    s.az[i] = (r() - 0.5) * box;
    s.ph[i] = r();
  }
  return s;
}

interface Flock {
  cx: number;
  cz: number;
  cy: number;
  r: number;
  w: number;
  a: number;
  hawk: boolean;
  /** Seconds the flock has existed (they fade in). */
  age: number;
  live: boolean;
}

const BIRDS_PER_FLOCK = 6;
const FLOCKS = 3;

export class AmbientLife {
  readonly group = new THREE.Group();
  private readonly rand = rng(0x5eed);
  private readonly birds: THREE.InstancedMesh;
  private readonly butterflies: THREE.InstancedMesh;
  private readonly leaves: THREE.InstancedMesh;
  private readonly fireflies: THREE.Points;
  private readonly motes: THREE.Points;
  private readonly bf: Swarm;
  private readonly lf: Swarm;
  private readonly ff: Swarm;
  private readonly mt: Swarm;
  private readonly leafFall: Float32Array;
  private readonly ffPos: Float32Array;
  private readonly mtPos: Float32Array;
  private readonly flocks: Flock[] = [];
  private t = 0;
  private biomeAcc = 99;
  /** Eased weights per kind (follow the biome and the hour over a few seconds). */
  readonly weights = { birds: 0, hawks: 0, butterflies: 0, fireflies: 0, leaves: 0, motes: 0 };
  private target = { birds: 0, hawks: 0, butterflies: 0, fireflies: 0, leaves: 0, motes: 0 };
  readonly stats = { birds: 0, butterflies: 0, fireflies: 0, leaves: 0, motes: 0, biome: -1 };
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private scale = 1;

  constructor(readonly capacity = { butterflies: 40, fireflies: 160, leaves: 70, motes: 140 }) {
    const m = materials();
    const r = this.rand;
    this.birds = new THREE.InstancedMesh(birdGeometry(), m.bird, FLOCKS * BIRDS_PER_FLOCK);
    this.butterflies = new THREE.InstancedMesh(butterflyGeometry(), m.butterfly, capacity.butterflies);
    this.leaves = new THREE.InstancedMesh(leafGeometry(), m.leaf, capacity.leaves);
    const paint = (im: THREE.InstancedMesh, cols: string[]) => {
      const c = new THREE.Color();
      for (let i = 0; i < im.count; i++) im.setColorAt(i, c.set(cols[Math.floor(r() * cols.length)]));
      im.instanceColor!.needsUpdate = true;
    };
    paint(this.birds, ['#24242a', '#2c2a2e', '#1e1e24']);
    paint(this.butterflies, ['#f4f0e0', '#f2d14a', '#e8873a', '#7fb7ff', '#f6f6f6', '#d9a8f0', '#f2d14a']);
    paint(this.leaves, ['#6f9a3a', '#8aa83c', '#c9a43a', '#c0702e', '#7c9a3e', '#a4b048']);
    for (const im of [this.birds, this.butterflies, this.leaves]) {
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
    }
    this.bf = swarm(capacity.butterflies, BOX.butterflies, r);
    this.lf = swarm(capacity.leaves, BOX.leaves, r);
    this.ff = swarm(capacity.fireflies, BOX.fireflies, r);
    this.mt = swarm(capacity.motes, BOX.motes, r);
    this.leafFall = new Float32Array(capacity.leaves);
    for (let i = 0; i < capacity.leaves; i++) this.leafFall[i] = r() * 9;
    const points = (n: number, mat: THREE.ShaderMaterial, s: Swarm) => {
      const pos = new Float32Array(n * 3);
      const seed = new Float32Array(n);
      for (let i = 0; i < n; i++) seed[i] = s.ph[i];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      const p = new THREE.Points(g, mat);
      p.frustumCulled = false;
      return { p, pos };
    };
    const f = points(capacity.fireflies, m.firefly, this.ff);
    this.fireflies = f.p;
    this.ffPos = f.pos;
    const mo = points(capacity.motes, m.mote, this.mt);
    this.motes = mo.p;
    this.mtPos = mo.pos;
    // birds, butterflies and leaves also carry a per-instance phase (one attribute, shared layout)
    for (const im of [this.birds, this.butterflies, this.leaves]) {
      const ph = new Float32Array(im.instanceMatrix.count);
      for (let i = 0; i < ph.length; i++) ph[i] = r();
      im.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(ph, 1));
    }
    for (let i = 0; i < FLOCKS; i++) this.flocks.push({ cx: 0, cz: 0, cy: 0, r: 30, w: 0.2, a: 0, hawk: false, age: 0, live: false });
    this.group.name = 'ambient-life';
    this.group.add(this.birds, this.butterflies, this.leaves, this.fireflies, this.motes);
  }

  /** Quality: Low runs half the creatures (1), High all (1). */
  setScale(k: number): void {
    this.scale = Math.max(0.25, Math.min(1, k));
  }

  update(i: LifeInput): void {
    const dt = Math.min(i.dt, 0.1);
    this.t += dt;
    const cam = i.camera.position;
    // the biome under the camera, twice a second; weights ease over ~3 s
    this.biomeAcc += dt;
    if (this.biomeAcc > 0.5) {
      this.biomeAcc = 0;
      const b = i.biomeAt(cam.x, cam.z) ?? 0;
      this.stats.biome = b;
      const w = lifeWeights(LIFE_BY_BIOME[b] ?? LIFE_BY_BIOME[0], i.hour, i.day, i.rain, i.snow, i.under, i.inTown);
      Object.assign(this.target, w);
    }
    const ease = 1 - Math.exp(-dt / 2.5);
    const W = this.weights;
    for (const k of Object.keys(W) as (keyof typeof W)[]) W[k] += (this.target[k] - W[k]) * ease;
    const m = materials();
    for (const mat of [m.bird, m.butterfly, m.leaf, m.firefly, m.mote]) mat.uniforms.uTime.value = this.t;
    // sunlit colour for the solid creatures (night: moonlit, dim)
    const lit = 0.18 + 0.82 * i.day;
    m.bird.uniforms.uLight.value.setRGB(lit * 0.9, lit * 0.92, lit);
    m.butterfly.uniforms.uLight.value.setRGB(lit, lit, lit * 0.97);
    m.leaf.uniforms.uLight.value.setRGB(lit * 0.95, lit, lit * 0.9);
    m.mote.uniforms.uOpacity.value = 0.55 * Math.min(1, W.motes * 1.5);
    m.firefly.uniforms.uOpacity.value = Math.min(1, W.fireflies * 1.4);
    const persp = i.camera as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera) {
      const sc = i.viewportH / (2 * Math.tan((persp.fov * Math.PI) / 360));
      m.firefly.uniforms.uScale.value = sc;
      m.mote.uniforms.uScale.value = sc;
    }
    this.updateBirds(i, dt);
    this.stats.butterflies = this.updateButterflies(i);
    this.stats.leaves = this.updateLeaves(i, dt);
    this.stats.fireflies = this.updatePoints(i, this.ff, this.ffPos, this.fireflies, W.fireflies, 0.25, 2.4, 0.35);
    this.stats.motes = this.updatePoints(i, this.mt, this.mtPos, this.motes, W.motes, 0.5, 4.5, 1.1);
  }

  /** Wrap an anchor into the box around the camera; true if it moved (sample the ground again). */
  private wrap(s: Swarm, k: number, cx: number, cz: number): void {
    const x = s.ax[k];
    const z = s.az[k];
    const B = s.box;
    const H = B / 2;
    s.ax[k] = cx + (((((x - cx + H) % B) + B) % B) - H);
    s.az[k] = cz + (((((z - cz + H) % B) + B) % B) - H);
    if (s.ax[k] !== x || s.az[k] !== z) s.gy[k] = Number.NaN;
  }

  /** The ground under an anchor (sampled once per wrap, with the water over it; NaN while the terrain is not there yet). */
  private ground(i: LifeInput, s: Swarm, k: number): number {
    if (Number.isNaN(s.gy[k])) {
      s.gy[k] = i.groundAt(s.ax[k], s.az[k]) ?? Number.NaN;
      s.wy[k] = i.waterAt(s.ax[k], s.az[k]);
    }
    return s.gy[k];
  }

  private updateButterflies(i: LifeInput): number {
    const s = this.bf;
    const n = Math.floor(s.n * this.weights.butterflies * this.scale + 0.5);
    const cam = i.camera.position;
    let c = 0;
    for (let k = 0; k < n; k++) {
      this.wrap(s, k, cam.x, cam.z);
      const gy = this.ground(i, s, k);
      if (Number.isNaN(gy) || s.wy[k] > gy - 0.05) continue; // none over water
      const t = this.t * (0.6 + s.ph[k] * 0.5) + s.ph[k] * 50;
      // a wandering, jittery flight around the anchor
      const x = s.ax[k] + Math.sin(t * 0.7) * 1.6 + Math.sin(t * 2.3) * 0.35;
      const z = s.az[k] + Math.cos(t * 0.6) * 1.6 + Math.cos(t * 2.9) * 0.35;
      const y = gy + 0.95 + 0.5 * Math.sin(t * 1.3) + 0.12 * Math.sin(t * 6.1);
      const dx = Math.cos(t * 0.7) * 0.7 * 1.6 + Math.cos(t * 2.3) * 2.3 * 0.35;
      const dz = -Math.sin(t * 0.6) * 0.6 * 1.6 - Math.sin(t * 2.9) * 2.9 * 0.35;
      const yaw = Math.atan2(-dx, -dz);
      this.e.set(-0.25 + 0.2 * Math.sin(t * 5), yaw, 0, 'YXZ');
      this.q.setFromEuler(this.e);
      this.m4.compose(this.v.set(x, y, z), this.q, this.s.setScalar(1.8 + s.ph[k] * 0.7));
      this.butterflies.setMatrixAt(c++, this.m4);
    }
    this.butterflies.count = c;
    if (c) this.butterflies.instanceMatrix.needsUpdate = true;
    return c;
  }

  private updateLeaves(i: LifeInput, dt: number): number {
    const s = this.lf;
    const n = Math.floor(s.n * this.weights.leaves * this.scale + 0.5);
    const cam = i.camera.position;
    const wind = 0.4 + windState.speed * 0.25;
    let c = 0;
    for (let k = 0; k < n; k++) {
      this.wrap(s, k, cam.x, cam.z);
      const gy = this.ground(i, s, k);
      if (Number.isNaN(gy)) continue;
      // each leaf falls from ~9 m over ~12 s on the wind, then starts again from the top
      this.leafFall[k] += dt * (0.55 + s.ph[k] * 0.4);
      if (this.leafFall[k] > 9) {
        this.leafFall[k] -= 9;
        s.ax[k] -= windState.dirX * wind * 8;
        s.az[k] -= windState.dirZ * wind * 8;
        s.gy[k] = Number.NaN;
      }
      const f = this.leafFall[k];
      const top = Math.max(gy, s.wy[k]) + 9.5;
      const t = this.t * (0.9 + s.ph[k]) + s.ph[k] * 40;
      const x = s.ax[k] + windState.dirX * wind * f + Math.sin(t * 1.7) * 0.5;
      const z = s.az[k] + windState.dirZ * wind * f + Math.cos(t * 1.3) * 0.5;
      const y = top - f;
      this.e.set(Math.sin(t * 2.1) * 1.3, t * 0.9, Math.cos(t * 1.7) * 1.1, 'XYZ');
      this.q.setFromEuler(this.e);
      this.m4.compose(this.v.set(x, y, z), this.q, this.s.setScalar(1.8 + s.ph[k] * 1.0));
      this.leaves.setMatrixAt(c++, this.m4);
    }
    this.leaves.count = c;
    if (c) this.leaves.instanceMatrix.needsUpdate = true;
    return c;
  }

  private updatePoints(i: LifeInput, s: Swarm, pos: Float32Array, pts: THREE.Points, weight: number, y0: number, y1: number, drift: number): number {
    const n = Math.floor(s.n * weight * this.scale + 0.5);
    pts.visible = n > 0;
    if (!n) return 0;
    const cam = i.camera.position;
    let c = 0;
    for (let k = 0; k < n; k++) {
      this.wrap(s, k, cam.x, cam.z);
      const gy0 = this.ground(i, s, k);
      if (Number.isNaN(gy0)) continue;
      const gy = Math.max(gy0, s.wy[k]);
      const t = this.t * (0.25 + s.ph[k] * 0.3) + s.ph[k] * 60;
      const j = c * 3;
      pos[j] = s.ax[k] + Math.sin(t * 0.9) * drift + windState.dirX * Math.sin(t * 0.3) * drift;
      pos[j + 1] = gy + y0 + (y1 - y0) * (0.5 + 0.5 * Math.sin(t * 0.7 + s.ph[k] * 9));
      pos[j + 2] = s.az[k] + Math.cos(t * 0.8) * drift + windState.dirZ * Math.sin(t * 0.3) * drift;
      c++;
    }
    pts.geometry.setDrawRange(0, c);
    (pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    return c;
  }

  private updateBirds(i: LifeInput, dt: number): void {
    const W = this.weights;
    const cam = i.camera.position;
    let c = 0;
    for (let f = 0; f < FLOCKS; f++) {
      const fl = this.flocks[f];
      const want = f === 2 ? W.hawks : W.birds * (f === 0 ? 1 : 0.7);
      const on = want * this.scale > 0.15 + f * 0.12;
      const far = Math.hypot(fl.cx - cam.x, fl.cz - cam.z);
      if (on && (!fl.live || far > 260)) {
        // a new flock somewhere around, 45-110 m out
        const a = this.rand() * Math.PI * 2;
        const d = 45 + this.rand() * 65;
        fl.cx = cam.x + Math.cos(a) * d;
        fl.cz = cam.z + Math.sin(a) * d;
        const g = i.groundAt(fl.cx, fl.cz);
        fl.hawk = f === 2;
        fl.cy = Math.max(g ?? cam.y, i.waterAt(fl.cx, fl.cz)) + (fl.hawk ? 32 + this.rand() * 20 : 18 + this.rand() * 16);
        fl.r = fl.hawk ? 30 + this.rand() * 20 : 18 + this.rand() * 18;
        fl.w = (fl.hawk ? 0.12 : 0.28) * (this.rand() < 0.5 ? -1 : 1);
        fl.a = this.rand() * Math.PI * 2;
        fl.age = 0;
        fl.live = true;
      }
      if (!fl.live) continue;
      // out of season (dusk, rain, a biome without them): the flock thins away over a few seconds
      fl.age = on ? fl.age + dt : Math.min(fl.age, 3) - dt;
      if (fl.age <= 0) {
        fl.live = false;
        continue;
      }
      fl.a += fl.w * dt;
      // the flock's centre drifts slowly so the circles wander across the sky
      fl.cx += Math.cos(fl.a * 0.3) * 1.5 * dt;
      fl.cz += Math.sin(fl.a * 0.27) * 1.5 * dt;
      const nb = fl.hawk ? 2 : BIRDS_PER_FLOCK;
      for (let b = 0; b < nb; b++) {
        const ph = b * 0.55 + f * 1.7;
        const ang = fl.a - b * (fl.hawk ? 2.6 : 0.18) * Math.sign(fl.w);
        const rr = fl.r + Math.sin(this.t * 0.4 + ph) * 3 + (b % 2) * 2.2;
        const x = fl.cx + Math.cos(ang) * rr;
        const z = fl.cz + Math.sin(ang) * rr;
        const y = fl.cy + Math.sin(this.t * 0.6 + ph * 2) * 1.6 + (b % 3) * 0.9;
        // fly along the circle's tangent, banked into the turn
        const tx = -Math.sin(ang) * Math.sign(fl.w);
        const tz = Math.cos(ang) * Math.sign(fl.w);
        const yaw = Math.atan2(-tx, -tz);
        this.e.set(0, yaw, -0.35 * Math.sign(fl.w), 'YXZ');
        this.q.setFromEuler(this.e);
        const size = (fl.hawk ? 2.8 : 1.7) * Math.min(1, fl.age / 3);
        this.m4.compose(this.v.set(x, y, z), this.q, this.s.setScalar(size));
        this.birds.setMatrixAt(c++, this.m4);
      }
    }
    this.birds.count = c;
    this.stats.birds = c;
    if (c) this.birds.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const o of [this.birds, this.butterflies, this.leaves]) o.geometry.dispose();
    this.fireflies.geometry.dispose();
    this.motes.geometry.dispose();
  }
}
