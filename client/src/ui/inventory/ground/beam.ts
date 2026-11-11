// The light over a dropped item (playtest 2 ground loot, Nicole: "make the
// godray of the rarity color way more captivating to look at, like energy
// flowing down from the heavens"). Three cheap additive pieces per drop, all
// in the rarity's colour (Bitchin': a slowly cycling rainbow):
//   beam   a camera-facing vertical ribbon (one cylindrical billboard, 12
//          segments so it can bend): a soft white-hot core in a glowing
//          falloff, streaks of noise and bright bands streaming DOWN into
//          the item, fading out toward the sky, brightest where it lands,
//          its top swaying a little with the wind, a gentle pulse (never a
//          flash: the pulse is +-15 % over ~4 s);
//   motes  points falling down the beam and spiralling in onto the item;
//   splash a ring on the ground where the energy lands: a soft glow and
//          ripples running outward.
// Height, width, brightness and mote count rise with rarity (common: no
// beam, the sparkles are its shimmer). Visible from afar: rare+ pickups ride
// the snapshot's mid ring (200 m, server snapshots.go), the beam fades out
// near that distance and when the camera is inside it, and fog dims it
// (never to nothing: a light in the mist still reads). Low quality: no
// motes and one noise octave. One program per piece type, uniforms per
// rarity: 8 materials each, shared by every drop of that rarity.

import * as THREE from 'three';
import type { QualityTier } from '../../../stores/qualityStore';
import { rarityColor } from '../items';

export interface BeamParams {
  /** Draw a beam at all (common: no). */
  visible: boolean;
  /** Metres from the item to where it fades into the sky. */
  height: number;
  /** Core width at the ground (m). */
  width: number;
  /** Overall brightness. */
  intensity: number;
  /** How fast the energy streams down (pattern units/s). */
  flow: number;
  /** Falling motes (0 on Low). */
  motes: number;
  /** Ground splash radius (m). */
  ring: number;
  /** Bitchin': rainbow. */
  holo: boolean;
  /** Beyond this the beam has faded out (m). */
  far: number;
}

const BY_RARITY: readonly Omit<BeamParams, 'motes' | 'holo' | 'visible' | 'far'>[] = [
  { height: 0, width: 0, intensity: 0, flow: 0, ring: 0 },
  { height: 2.4, width: 0.22, intensity: 0.42, flow: 0.55, ring: 0.45 },
  { height: 9, width: 0.3, intensity: 0.62, flow: 0.7, ring: 0.65 },
  { height: 15, width: 0.38, intensity: 0.78, flow: 0.8, ring: 0.8 },
  { height: 24, width: 0.5, intensity: 0.95, flow: 0.9, ring: 1.0 },
  { height: 32, width: 0.58, intensity: 1.05, flow: 1.0, ring: 1.15 },
  { height: 38, width: 0.66, intensity: 1.12, flow: 1.05, ring: 1.25 },
  { height: 46, width: 0.75, intensity: 1.2, flow: 1.1, ring: 1.4 },
];
const MOTES = [0, 0, 8, 12, 16, 20, 22, 26];

/** The beam over a drop of rarity r (0 common .. 7 Bitchin') at a quality tier. Pure. */
export function beamParams(rarity: number, tier: QualityTier = 'high'): BeamParams {
  const r = Math.max(0, Math.min(7, rarity | 0));
  const b = BY_RARITY[r];
  const motes = tier === 'low' ? 0 : Math.round(MOTES[r] * (tier === 'medium' ? 0.6 : 1));
  return { ...b, visible: r >= 1, motes, holo: r === 7, far: r >= 2 ? 210 : 70 };
}

// ---- shaders ----

const FOG_V = `
#ifdef USE_FOG
  vFogDepth = -mv.z;
#endif`;
const FOG_F_PARS = `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
float fogDim() {
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float f = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float f = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  return 1.0 - 0.78 * f; // dimmed, never erased: a light in the mist
#else
  return 1.0;
#endif
}`;
const HOLO = `
vec3 holoRgb(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }`;

const BEAM_VERT = `
uniform float uTime;
uniform float uHeight;
uniform float uWidth;
uniform float uSway;
uniform float uFar;
varying vec2 vUv;
varying float vFade;
#ifdef USE_FOG
  varying float vFogDepth;
#endif
void main() {
  vec3 base = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 toCam = cameraPosition - base;
  vec2 flat2 = toCam.xz;
  float fl = length(flat2);
  vec2 n = fl > 1e-4 ? flat2 / fl : vec2(0.0, 1.0);
  vec3 right = vec3(n.y, 0.0, -n.x);
  float v = position.y;
  // a little wider up high, where the light spreads
  float w = uWidth * (1.0 + 0.9 * v);
  vec3 sway = vec3(sin(uTime * 0.31 + base.x * 0.13), 0.0, cos(uTime * 0.23 + base.z * 0.11)) * uSway * v * v;
  // the object's Y scale shortens the ribbon from below (LootLayer: a new drop's beam strikes down from the sky)
  float sy = length(modelMatrix[1].xyz);
  vec3 wp = base + right * position.x * w + vec3(0.0, v * uHeight * sy, 0.0) + sway;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = vec2(position.x * 2.0, v);
  float d = length(toCam);
  vFade = smoothstep(0.7, 2.6, fl) * (1.0 - smoothstep(uFar * 0.7, uFar, d));
  ${FOG_V}
}`;

const BEAM_FRAG = `
uniform float uTime;
uniform float uHeight;
uniform float uIntensity;
uniform float uFlow;
uniform vec3 uColor;
uniform float uHolo;
varying vec2 vUv;
varying float vFade;
${FOG_F_PARS}
${HOLO}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  if (vFade <= 0.001) discard;
  float x = abs(vUv.x);
  float y = vUv.y * uHeight;
  // + time: the pattern moves DOWN (energy pouring into the item)
  float t = uTime * uFlow;
  float s1 = vnoise(vec2(vUv.x * 3.0, y * 0.45 + t * 2.2));
#ifdef LOW
  float streak = smoothstep(0.35, 1.0, s1);
  float band = 0.0;
#else
  float s2 = vnoise(vec2(vUv.x * 7.0 + 3.1, y * 1.3 + t * 3.6));
  float streak = smoothstep(0.4, 1.0, s1 * 0.6 + s2 * 0.5);
  float band = pow(0.5 + 0.5 * sin(y * 0.8 + t * 5.0), 8.0);
#endif
  float core = exp(-x * x * 9.0);
  float halo = exp(-x * 2.6) * 0.45;
  float top = 1.0 - smoothstep(0.35, 1.0, vUv.y);
  float land = 1.0 + 1.4 * (1.0 - smoothstep(0.0, 0.12, vUv.y));
  float pulse = 0.87 + 0.13 * sin(uTime * 1.5);
  float a = (core * (0.5 + 0.7 * streak + 0.45 * band) + halo * (0.35 + 0.55 * streak)) * top * land * pulse * uIntensity * vFade * fogDim();
  a *= smoothstep(1.0, 0.82, x); // the ribbon's edges never show
  vec3 col = uColor;
  if (uHolo > 0.5) col = mix(holoRgb(vUv.y * 1.6 - uTime * 0.18 + vUv.x * 0.15), vec3(1.0), 0.2);
  col = mix(col, vec3(1.0), core * 0.5);
  gl_FragColor = vec4(col * a, a);
}`;

const MOTE_VERT = `
attribute vec3 aSeed; // phase, radius, speed
uniform float uTime;
uniform float uHeight;
uniform float uSize;
uniform float uFar;
varying float vA;
#ifdef USE_FOG
  varying float vFogDepth;
#endif
void main() {
  vec3 base = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float h = min(uHeight, 9.0 + uHeight * 0.25); // motes fall from the lower part, where you can see them
  float k = fract(aSeed.x - uTime * aSeed.z / h); // 1 at the top -> 0 at the item
  float ang = aSeed.x * 40.0 + k * 9.0;
  float r = aSeed.y * (0.15 + 0.85 * k);
  vec3 wp = base + vec3(cos(ang) * r, k * h + 0.15, sin(ang) * r);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(cameraPosition - base);
  vA = smoothstep(1.0, 0.75, k) * smoothstep(0.0, 0.08, k) * (1.0 - smoothstep(uFar * 0.5, uFar * 0.7, d));
  gl_PointSize = uSize * (0.6 + 0.6 * k) * (420.0 / max(1.0, -mv.z));
  ${FOG_V}
}`;

const MOTE_FRAG = `
uniform vec3 uColor;
uniform float uHolo;
uniform float uTime;
varying float vA;
${FOG_F_PARS}
${HOLO}
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = max(0.0, 1.0 - dot(p, p)) * vA * fogDim();
  if (a < 0.01) discard;
  vec3 col = uHolo > 0.5 ? holoRgb(uTime * 0.2 + vA) : uColor;
  gl_FragColor = vec4(mix(col, vec3(1.0), 0.45) * a, a);
}`;

const RING_VERT = `
varying vec2 vP;
#ifdef USE_FOG
  varying float vFogDepth;
#endif
void main() {
  vP = position.xz * 2.0; // -1..1
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  ${FOG_V}
}`;

const RING_FRAG = `
uniform float uTime;
uniform float uIntensity;
uniform vec3 uColor;
uniform float uHolo;
varying vec2 vP;
${FOG_F_PARS}
${HOLO}
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float glow = exp(-r * r * 6.0) * 0.8;
  float ripple = 0.0;
#ifndef LOW
  for (int i = 0; i < 2; i++) {
    float ph = fract(uTime * 0.45 + float(i) * 0.5);
    float d = abs(r - ph);
    ripple += smoothstep(0.08, 0.0, d) * (1.0 - ph) * 0.7;
  }
#else
  ripple = smoothstep(0.1, 0.0, abs(r - fract(uTime * 0.45))) * 0.4;
#endif
  float a = (glow + ripple) * (1.0 - smoothstep(0.75, 1.0, r)) * uIntensity * fogDim();
  vec3 col = uHolo > 0.5 ? holoRgb(r * 0.8 - uTime * 0.2) : uColor;
  gl_FragColor = vec4(mix(col, vec3(1.0), glow * 0.4) * a, a);
}`;

// ---- geometry ----

let beamGeo: THREE.BufferGeometry | null = null;
/** The billboard ribbon: x -0.5..0.5 across, y 0..1 up, 12 segments (bends with the sway). */
export function beamGeometry(): THREE.BufferGeometry {
  if (beamGeo) return beamGeo;
  const segs = 12;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const v = i / segs;
    pos.push(-0.5, v, 0, 0.5, v, 0);
    if (i < segs) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // The shader places it; a generous sphere so it is culled only when far out of view.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, 0), 30);
  beamGeo = g;
  return g;
}

const moteGeos = new Map<number, THREE.BufferGeometry>();
export function moteGeometry(n: number): THREE.BufferGeometry {
  let g = moteGeos.get(n);
  if (g) return g;
  const pos = new Float32Array(Math.max(1, n) * 3);
  const seed = new Float32Array(Math.max(1, n) * 3);
  for (let i = 0; i < n; i++) {
    seed[i * 3] = (i * 0.618034) % 1;
    seed[i * 3 + 1] = 0.12 + ((i * 0.3819) % 1) * 0.35;
    seed[i * 3 + 2] = 1.6 + ((i * 0.7548) % 1) * 1.8;
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 6, 0), 12);
  moteGeos.set(n, g);
  return g;
}

let ringGeo: THREE.BufferGeometry | null = null;
/** A unit ground quad (x, z in -0.5..0.5), scaled per drop to its splash. */
export function ringGeometry(): THREE.BufferGeometry {
  if (ringGeo) return ringGeo;
  ringGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  return ringGeo;
}

// ---- materials ----

export interface BeamMaterials {
  beam: THREE.ShaderMaterial[];
  motes: THREE.ShaderMaterial[];
  ring: THREE.ShaderMaterial[];
}

const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true } as const;

/** The 8 x 3 materials for a quality tier (shared by every drop; dispose when the tier changes). */
export function makeBeamMaterials(tier: QualityTier): BeamMaterials {
  const low = tier === 'low';
  const defines = low ? { LOW: '' } : {};
  const beam: THREE.ShaderMaterial[] = [];
  const motes: THREE.ShaderMaterial[] = [];
  const ring: THREE.ShaderMaterial[] = [];
  for (let r = 0; r < 8; r++) {
    const p = beamParams(r, tier);
    const color = new THREE.Color(rarityColor(r));
    const holo = { value: p.holo ? 1 : 0 };
    const common = { ...THREE.UniformsLib.fog, uTime: { value: 0 }, uColor: { value: color }, uHolo: holo };
    beam.push(
      new THREE.ShaderMaterial({
        name: 'lodestone-loot-beam',
        uniforms: { ...THREE.UniformsUtils.clone(common), uHeight: { value: p.height }, uWidth: { value: p.width }, uSway: { value: 0.35 + p.height * 0.02 }, uFar: { value: p.far }, uIntensity: { value: p.intensity }, uFlow: { value: p.flow } },
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        defines,
        side: THREE.DoubleSide,
        ...additive,
      }),
    );
    motes.push(
      new THREE.ShaderMaterial({
        name: 'lodestone-loot-motes',
        uniforms: { ...THREE.UniformsUtils.clone(common), uHeight: { value: p.height }, uSize: { value: 0.07 + r * 0.008 }, uFar: { value: p.far } },
        vertexShader: MOTE_VERT,
        fragmentShader: MOTE_FRAG,
        ...additive,
      }),
    );
    ring.push(
      new THREE.ShaderMaterial({
        name: 'lodestone-loot-splash',
        uniforms: { ...THREE.UniformsUtils.clone(common), uIntensity: { value: Math.min(1, p.intensity * 0.9) } },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        defines,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        ...additive,
      }),
    );
  }
  return { beam, motes, ring };
}

/** Per frame: the clock, and Bitchin's colour (its shaders cycle hues themselves). */
export function tickBeamMaterials(m: BeamMaterials, nowS: number): void {
  for (const list of [m.beam, m.motes, m.ring]) for (const x of list) x.uniforms.uTime.value = nowS;
}

export function disposeBeamMaterials(m: BeamMaterials): void {
  for (const list of [m.beam, m.motes, m.ring]) for (const x of list) x.dispose();
}

// ---- sparkles (Nicole: "dropped loot should sparkle") ----
// A few tiny four-point glints around each dropped item, twinkling one at a
// time (each its own phase and rate, short and soft: a glitter, never a
// flash), more and brighter with rarity, in the rarity's colour.
export const SPARKLE_N = [3, 4, 5, 6, 7, 8, 8, 9];
const sparkleGeos = new Map<number, THREE.BufferGeometry>();
export function sparkleGeometry(n: number): THREE.BufferGeometry {
  let g = sparkleGeos.get(n);
  if (g) return g;
  const pos = new Float32Array(n * 3);
  const ph = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + i * 1.7;
    const r = 0.18 + ((i * 0.618) % 1) * 0.22;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 0.3 + ((i * 0.381) % 1) * 0.45;
    pos[i * 3 + 2] = Math.sin(a) * r;
    ph[i * 2] = i * 2.399; // phase
    ph[i * 2 + 1] = 0.7 + ((i * 0.737) % 1) * 0.9; // rate
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 2));
  sparkleGeos.set(n, g);
  return g;
}
export function sparkleMaterial(color: THREE.Color, size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'lodestone-loot-sparkle',
    uniforms: { uTime: { value: 0 }, uColor: { value: color }, uSize: { value: size } },
    vertexShader: `
      attribute vec2 aPhase;
      uniform float uTime;
      uniform float uSize;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float s = sin(uTime * aPhase.y * 3.0 + aPhase.x);
        float tw = pow(max(0.0, s), 4.0); // a short glint, then a soft rest
        vA = tw;
        gl_PointSize = uSize * (0.45 + 1.2 * tw) * (420.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vA;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float cross = max(1.0 - abs(p.x) * 7.0, 0.0) * (1.0 - abs(p.y)) + max(1.0 - abs(p.y) * 7.0, 0.0) * (1.0 - abs(p.x));
        float core = max(0.0, 1.0 - length(p) * 2.2);
        float a = clamp(cross + core, 0.0, 1.0) * (0.45 + 0.55 * vA);
        if (a < 0.02) discard;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.55 * core) * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Shader warm-up (world/warmExtras.ts): one beam, mote, splash and sparkle
 * object per program (Low and the rest differ by a define), so the first
 * drop in view never links a program mid-fight. Kept for the session.
 */
let warmKept: THREE.Object3D[] | null = null;
export function lootWarmObjects(): THREE.Object3D[] {
  if (warmKept) return warmKept;
  const out: THREE.Object3D[] = [];
  for (const tier of ['high', 'low'] as const) {
    const m = makeBeamMaterials(tier);
    out.push(new THREE.Mesh(beamGeometry(), m.beam[4]), new THREE.Points(moteGeometry(4), m.motes[4]), new THREE.Mesh(ringGeometry(), m.ring[4]));
  }
  out.push(new THREE.Points(sparkleGeometry(3), sparkleMaterial(new THREE.Color('#ffffff'), 0.2)));
  for (const o of out) o.frustumCulled = false;
  warmKept = out;
  return out;
}
