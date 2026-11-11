// The light over dropped items (playtest 2 ground loot, Nicole: "make the
// godray of the rarity color way more captivating to look at, like energy
// flowing down from the heavens"). Four pieces, each ONE draw call for every
// drop in view (instanced / batched: 40 drops cost what one does), all in
// the rarity's colour (Bitchin': a slowly cycling rainbow):
//   beam     a camera-facing vertical ribbon per drop (a cylindrical
//            billboard, 12 segments so it can bend): a white-hot thread in a
//            coloured column of light in a soft glow, streaks of noise and
//            bright bands streaming DOWN into the item, fading out toward the
//            sky, brightest where it lands, its top swaying with the wind, a
//            gentle pulse (+-13 % over ~4 s: never a flash). A new drop's
//            beam strikes down from the sky as it lands;
//   motes    points falling down the beam and spiralling in onto the item;
//   splash   a ring on the ground where the energy lands: a soft glow and
//            ripples running outward;
//   sparkles a few twinkling four-point glints around every drop, common
//            ones too (Nicole: "dropped loot should sparkle").
// Height, width, brightness and mote count rise with rarity (common: no
// beam, the sparkles are its shimmer). Visible from afar: rare+ pickups ride
// the snapshot's mid ring (200 m, server snapshots.go), the beam fades out
// near that distance and when the camera stands inside it, and fog dims it
// (never to nothing: a light in the mist still reads). Premultiplied
// blending (the colour adds light, a little alpha dims what is behind) keeps
// the colour against a bright sky. Low quality: no motes, one noise octave,
// one ripple.

import * as THREE from 'three';
import type { QualityTier } from '../../../stores/qualityStore';
import { rarityColor } from '../items';

export interface BeamParams {
  /** Draw a beam at all (common: no). */
  visible: boolean;
  /** Metres from the item to where it fades into the sky. */
  height: number;
  /** Ribbon width at the ground (m): the hot core is a sliver of it, the rest its glow. */
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
  { height: 2.6, width: 0.55, intensity: 0.5, flow: 0.55, ring: 0.5 },
  { height: 10, width: 0.85, intensity: 0.7, flow: 0.7, ring: 0.75 },
  { height: 16, width: 1.05, intensity: 0.85, flow: 0.8, ring: 0.9 },
  { height: 26, width: 1.3, intensity: 1.0, flow: 0.9, ring: 1.1 },
  { height: 34, width: 1.45, intensity: 1.1, flow: 1.0, ring: 1.25 },
  { height: 40, width: 1.6, intensity: 1.18, flow: 1.05, ring: 1.35 },
  { height: 48, width: 1.8, intensity: 1.25, flow: 1.1, ring: 1.5 },
];
const MOTES = [0, 0, 8, 12, 16, 20, 22, 26];
export const SPARKLE_N = [3, 4, 5, 6, 7, 8, 8, 9];

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
const FOG_V_PARS = `
#ifdef USE_FOG
  varying float vFogDepth;
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

// beam: per instance iPos (ground), iBeam (height, width, intensity, flow), iColor (rgb, holo), iStrike (0..1 landed)
const BEAM_VERT = `
attribute vec3 iPos;
attribute vec4 iBeam;
attribute vec4 iColor;
attribute float iStrike;
uniform float uTime;
uniform float uWind;
varying vec2 vUv;
varying float vFade;
varying vec4 vColor;
varying vec3 vBeam; // height, intensity, flow
${FOG_V_PARS}
void main() {
  vec3 base = iPos;
  vec3 toCam = cameraPosition - base;
  vec2 flat2 = toCam.xz;
  float fl = length(flat2);
  vec2 n = fl > 1e-4 ? flat2 / fl : vec2(0.0, 1.0);
  vec3 right = vec3(n.y, 0.0, -n.x);
  float v = position.y;
  float h = iBeam.x;
  // a little wider up high, where the light spreads
  float w = iBeam.y * (1.0 + 0.9 * v);
  float sway = (0.25 + uWind * 1.1 + h * 0.015) * v * v;
  vec3 sw = vec3(sin(uTime * 0.31 + base.x * 0.13), 0.0, cos(uTime * 0.23 + base.z * 0.11)) * sway;
  // striking down: the ribbon's lower end descends from the top as iStrike goes 0 -> 1
  float s = max(0.02, iStrike);
  vec3 wp = base + right * position.x * w + vec3(0.0, h * (1.0 - s) + v * h * s, 0.0) + sw;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = vec2(position.x * 2.0, v);
  float far = h > 3.0 ? 210.0 : 70.0;
  vFade = smoothstep(0.7, 2.6, fl) * (1.0 - smoothstep(far * 0.7, far, length(toCam))) * step(0.001, h);
  vColor = iColor;
  vBeam = vec3(h, iBeam.z, iBeam.w);
  ${FOG_V}
}`;

const BEAM_FRAG = `
uniform float uTime;
varying vec2 vUv;
varying float vFade;
varying vec4 vColor;
varying vec3 vBeam;
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
  float y = vUv.y * vBeam.x;
  // + time: the pattern moves DOWN (energy pouring into the item)
  float t = uTime * vBeam.z;
  float s1 = vnoise(vec2(vUv.x * 3.0, y * 0.45 + t * 2.2));
#ifdef LOW
  float streak = smoothstep(0.35, 1.0, s1);
  float band = 0.0;
#else
  float s2 = vnoise(vec2(vUv.x * 7.0 + 3.1, y * 1.3 + t * 3.6));
  float streak = smoothstep(0.4, 1.0, s1 * 0.6 + s2 * 0.5);
  float band = pow(0.5 + 0.5 * sin(y * 0.8 + t * 5.0), 8.0);
#endif
  // a white-hot thread in a coloured column of light in a soft glow
  // the item hovers in the lowest 2.5 m: the column thins there so the light frames it instead of hiding it
  float clear = vBeam.x > 3.0 ? mix(0.22, 1.0, smoothstep(0.35, 2.6, y)) : 1.0;
  float core = exp(-x * x * 90.0) * clear;
  float body = exp(-x * x * 11.0) * mix(0.55, 1.0, clear);
  float halo = exp(-x * 3.4) * 0.45;
  float energy = 0.45 + 0.85 * streak + 0.6 * band;
  float top = 1.0 - smoothstep(0.3, 1.0, vUv.y);
  float land = 1.0 + 1.6 * (1.0 - smoothstep(0.0, 0.3, y)); // brightest where it lands (the bottom 30 cm)
  float pulse = 0.87 + 0.13 * sin(uTime * 1.5);
  float k = top * land * pulse * vBeam.y * vFade * fogDim() * smoothstep(1.0, 0.85, x);
  vec3 col = vColor.a > 0.5 ? holoRgb(vUv.y * 1.6 - uTime * 0.18 + vUv.x * 0.15) : vColor.rgb;
  // premultiplied: the colour adds light, alpha dims what is behind a little
  // (so the beam keeps its colour against a bright sky)
  vec3 rgb = (col * (body * energy * 0.9 + halo * (0.55 + 0.6 * streak)) + vec3(1.0) * core * (0.55 + 0.4 * streak)) * k;
  float a = clamp((body * 0.35 + core * 0.2) * k, 0.0, 0.6);
  gl_FragColor = vec4(rgb, a);
}`;

// splash: per instance iPos, iRing (radius, intensity), iColor, iStrike
const RING_VERT = `
attribute vec3 iPos;
attribute vec2 iRing;
attribute vec4 iColor;
attribute float iStrike;
varying vec2 vP;
varying vec4 vColor;
varying float vI;
${FOG_V_PARS}
void main() {
  vP = position.xz * 2.0; // -1..1
  float r = iRing.x * (0.3 + 0.7 * iStrike);
  vec4 mv = viewMatrix * vec4(iPos + vec3(position.x * 2.0 * r, 0.04, position.z * 2.0 * r), 1.0);
  gl_Position = projectionMatrix * mv;
  vColor = iColor;
  vI = iRing.y * step(0.001, iRing.x);
  ${FOG_V}
}`;

const RING_FRAG = `
uniform float uTime;
varying vec2 vP;
varying vec4 vColor;
varying float vI;
${FOG_F_PARS}
${HOLO}
void main() {
  float r = length(vP);
  if (r > 1.0 || vI <= 0.0) discard;
  float glow = exp(-r * r * 6.0) * 0.8;
  float ripple = 0.0;
#ifndef LOW
  for (int i = 0; i < 2; i++) {
    float ph = fract(uTime * 0.45 + float(i) * 0.5);
    ripple += smoothstep(0.08, 0.0, abs(r - ph)) * (1.0 - ph) * 0.7;
  }
#else
  ripple = smoothstep(0.1, 0.0, abs(r - fract(uTime * 0.45))) * 0.4;
#endif
  float a = (glow + ripple) * (1.0 - smoothstep(0.75, 1.0, r)) * vI * fogDim();
  vec3 col = vColor.a > 0.5 ? holoRgb(r * 0.8 - uTime * 0.2) : vColor.rgb;
  gl_FragColor = vec4(mix(col, vec3(1.0), glow * 0.35) * a, a * 0.3);
}`;

// motes: one point per mote of every drop; aBase (drop), aSeed (phase, radius, speed), aMote (height, size, landed), aColor
const MOTE_VERT = `
attribute vec3 aBase;
attribute vec3 aSeed;
attribute vec3 aMote;
attribute vec4 aColor;
uniform float uTime;
varying float vA;
varying vec4 vColor;
${FOG_V_PARS}
void main() {
  float h = min(aMote.x, 9.0 + aMote.x * 0.25); // motes fall from the lower part, where you can see them
  float k = fract(aSeed.x - uTime * aSeed.z / max(h, 1.0)); // 1 at the top -> 0 at the item
  float ang = aSeed.x * 40.0 + k * 9.0;
  float r = aSeed.y * (0.15 + 0.85 * k);
  vec3 wp = aBase + vec3(cos(ang) * r, k * h + 0.15, sin(ang) * r);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(cameraPosition - aBase);
  vA = smoothstep(1.0, 0.75, k) * smoothstep(0.0, 0.08, k) * (1.0 - smoothstep(90.0, 130.0, d)) * aMote.z;
  gl_PointSize = aMote.y * (0.6 + 0.6 * k) * (420.0 / max(1.0, -mv.z));
  vColor = aColor;
  ${FOG_V}
}`;

const MOTE_FRAG = `
uniform float uTime;
varying float vA;
varying vec4 vColor;
${FOG_F_PARS}
${HOLO}
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = max(0.0, 1.0 - dot(p, p)) * vA * fogDim();
  if (a < 0.01) discard;
  vec3 col = vColor.a > 0.5 ? holoRgb(uTime * 0.2 + vA) : vColor.rgb;
  gl_FragColor = vec4(mix(col, vec3(1.0), 0.45) * a, a * 0.2);
}`;

// sparkles: aBase (drop), aOff (local offset), aPhase (phase, rate), aColor (rgb, holo), aSize
const SPARKLE_VERT = `
attribute vec3 aBase;
attribute vec3 aOff;
attribute vec2 aPhase;
attribute vec4 aColor;
attribute float aSize;
uniform float uTime;
varying float vA;
varying vec4 vColor;
void main() {
  vec4 mv = viewMatrix * vec4(aBase + aOff, 1.0);
  float s = sin(uTime * aPhase.y * 3.0 + aPhase.x);
  float tw = pow(max(0.0, s), 4.0); // a short glint, then a soft rest
  float d = length(cameraPosition - aBase);
  vA = tw * (1.0 - smoothstep(30.0, 42.0, d));
  vColor = aColor;
  gl_PointSize = aSize * (0.45 + 1.2 * tw) * (420.0 / max(1.0, -mv.z)) * step(0.001, 1.0 - smoothstep(30.0, 42.0, d));
  gl_Position = projectionMatrix * mv;
}`;

const SPARKLE_FRAG = `
uniform float uTime;
varying float vA;
varying vec4 vColor;
${HOLO}
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float cross = max(1.0 - abs(p.x) * 7.0, 0.0) * (1.0 - abs(p.y)) + max(1.0 - abs(p.y) * 7.0, 0.0) * (1.0 - abs(p.x));
  float core = max(0.0, 1.0 - length(p) * 2.2);
  float a = clamp(cross + core, 0.0, 1.0) * (0.45 + 0.55 * vA);
  if (a < 0.02) discard;
  vec3 col = vColor.a > 0.5 ? holoRgb(uTime * 0.18) : vColor.rgb;
  gl_FragColor = vec4(mix(col, vec3(1.0), 0.55 * core) * a, a);
}`;

// ---- materials ----

/** Premultiplied light: the colour adds, alpha dims the background a little (colour holds in daylight). */
const premultiplied = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  fog: true,
} as const;

export interface LightMaterials {
  beam: THREE.ShaderMaterial;
  ring: THREE.ShaderMaterial;
  motes: THREE.ShaderMaterial;
  sparkle: THREE.ShaderMaterial;
}

/** The four programs for a quality tier (Low: a define). */
export function makeLightMaterials(tier: QualityTier): LightMaterials {
  const defines = tier === 'low' ? { LOW: '' } : {};
  const u = () => ({ ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: { value: 0 }, uWind: { value: 0 } });
  return {
    beam: new THREE.ShaderMaterial({ name: 'lodestone-loot-beam', uniforms: u(), vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, defines, side: THREE.DoubleSide, ...premultiplied }),
    ring: new THREE.ShaderMaterial({ name: 'lodestone-loot-splash', uniforms: u(), vertexShader: RING_VERT, fragmentShader: RING_FRAG, defines, polygonOffset: true, polygonOffsetFactor: -2, ...premultiplied }),
    motes: new THREE.ShaderMaterial({ name: 'lodestone-loot-motes', uniforms: u(), vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG, ...premultiplied }),
    sparkle: new THREE.ShaderMaterial({ name: 'lodestone-loot-sparkle', uniforms: { uTime: { value: 0 } }, vertexShader: SPARKLE_VERT, fragmentShader: SPARKLE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  };
}

// ---- the batch ----

/** One drop's light, as LootLayer hands it over every frame. */
export interface LightDrop {
  id: number;
  rarity: number;
  /** Ground point (the beam's foot, the splash). */
  x: number;
  y: number;
  z: number;
  /** Beam strike progress 0..1 (1: landed and lit; a drop still in its arc is left out). */
  strike: number;
  /** Where the sparkles sit above the ground (hovering items: around the item). */
  sparkleY: number;
  /** Sparkle spread (the item's size). */
  sparkleScale: number;
  /** No splash ring (ores and gems in a cave wall). */
  noRing?: boolean;
}

const RIBBON_SEGS = 12;
function ribbon(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= RIBBON_SEGS; i++) {
    const v = i / RIBBON_SEGS;
    pos.push(-0.5, v, 0, 0.5, v, 0);
    if (i < RIBBON_SEGS) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function colorOf(r: number): [number, number, number, number] {
  const c = new THREE.Color(rarityColor(r));
  return [c.r, c.g, c.b, r >= 7 ? 1 : 0];
}
const COLORS = Array.from({ length: 8 }, (_, r) => colorOf(r));

/**
 * Every drop's beam, splash, motes and sparkles in four draw calls. update()
 * rebuilds the buffers only when the set of lit drops changes (a drop
 * appears, lands, goes); otherwise it rewrites the few strike values still
 * animating.
 */
export class LootLights {
  readonly group = new THREE.Group();
  readonly mats: LightMaterials;
  private readonly beam: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly motes: THREE.Points;
  private readonly sparkles: THREE.Points;
  private sig = '';
  private strikes: { beam: THREE.InstancedBufferAttribute; ring: THREE.InstancedBufferAttribute } | null = null;
  /** Instances drawn (tests, headless checks). */
  counts = { beams: 0, rings: 0, motes: 0, sparkles: 0 };

  constructor(readonly tier: QualityTier) {
    this.mats = makeLightMaterials(tier);
    const mk = <T extends THREE.Object3D>(o: T, order: number, name: string) => {
      o.frustumCulled = false;
      o.renderOrder = order;
      o.name = name;
      this.group.add(o);
      return o;
    };
    this.beam = mk(new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.mats.beam), 2, 'loot-beams');
    this.ring = mk(new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.mats.ring), 1, 'loot-splashes');
    this.motes = mk(new THREE.Points(new THREE.BufferGeometry(), this.mats.motes), 3, 'loot-motes');
    this.sparkles = mk(new THREE.Points(new THREE.BufferGeometry(), this.mats.sparkle), 3, 'loot-sparkles');
    this.group.name = 'loot-lights';
    this.rebuild([]);
  }

  update(drops: readonly LightDrop[], nowS: number, wind: number): void {
    for (const m of [this.mats.beam, this.mats.ring, this.mats.motes]) {
      m.uniforms.uTime.value = nowS;
      m.uniforms.uWind.value = wind;
    }
    this.mats.sparkle.uniforms.uTime.value = nowS;
    let sig = '';
    for (const d of drops) sig += `${d.id}:${d.rarity}:${d.strike >= 1 ? 2 : d.strike > 0 ? 1 : 0},`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.rebuild(drops);
    } else if (this.strikes) {
      // only the strikes animate between rebuilds
      let i = 0;
      let dirty = false;
      const b = this.strikes.beam.array as Float32Array;
      for (const d of drops) {
        if (!beamParams(d.rarity).visible) continue;
        if (b[i] !== d.strike) {
          b[i] = d.strike;
          dirty = true;
        }
        i++;
      }
      if (dirty) {
        (this.strikes.ring.array as Float32Array).set(b.subarray(0, (this.strikes.ring.array as Float32Array).length));
        this.strikes.beam.needsUpdate = true;
        this.strikes.ring.needsUpdate = true;
      }
    }
  }

  private rebuild(drops: readonly LightDrop[]): void {
    const lit = drops.filter((d) => beamParams(d.rarity, this.tier).visible);
    // beams and rings share the instance order (the strike values are copied across)
    const n = Math.max(1, lit.length);
    const iPos = new Float32Array(n * 3);
    const iBeam = new Float32Array(n * 4);
    const iColor = new Float32Array(n * 4);
    const iStrike = new Float32Array(n);
    const iRing = new Float32Array(n * 2);
    lit.forEach((d, i) => {
      const p = beamParams(d.rarity, this.tier);
      iPos.set([d.x, d.y, d.z], i * 3);
      iBeam.set([p.height, p.width, p.intensity, p.flow], i * 4);
      iColor.set(COLORS[Math.max(0, Math.min(7, d.rarity))], i * 4);
      iStrike[i] = d.strike;
      iRing.set([d.noRing ? 0 : p.ring, Math.min(1, p.intensity * 0.9)], i * 2);
    });
    const bg = new THREE.InstancedBufferGeometry();
    bg.copy(ribbon() as unknown as THREE.InstancedBufferGeometry);
    const strikeB = new THREE.InstancedBufferAttribute(iStrike, 1);
    bg.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
    bg.setAttribute('iBeam', new THREE.InstancedBufferAttribute(iBeam, 4));
    bg.setAttribute('iColor', new THREE.InstancedBufferAttribute(iColor, 4));
    bg.setAttribute('iStrike', strikeB);
    bg.instanceCount = lit.length;
    const rg = new THREE.InstancedBufferGeometry();
    rg.copy(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2) as unknown as THREE.InstancedBufferGeometry);
    const strikeR = new THREE.InstancedBufferAttribute(Float32Array.from(iStrike), 1);
    rg.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
    rg.setAttribute('iRing', new THREE.InstancedBufferAttribute(iRing, 2));
    rg.setAttribute('iColor', new THREE.InstancedBufferAttribute(iColor, 4));
    rg.setAttribute('iStrike', strikeR);
    rg.instanceCount = lit.length;
    this.strikes = { beam: strikeB, ring: strikeR };

    // motes: only landed drops
    let nm = 0;
    for (const d of lit) if (d.strike >= 1) nm += beamParams(d.rarity, this.tier).motes;
    const mBase = new Float32Array(Math.max(1, nm) * 3);
    const mSeed = new Float32Array(Math.max(1, nm) * 3);
    const mMote = new Float32Array(Math.max(1, nm) * 3);
    const mColor = new Float32Array(Math.max(1, nm) * 4);
    let k = 0;
    for (const d of lit) {
      if (d.strike < 1) continue;
      const p = beamParams(d.rarity, this.tier);
      for (let i = 0; i < p.motes; i++, k++) {
        mBase.set([d.x, d.y, d.z], k * 3);
        mSeed.set([(i * 0.618034 + d.id * 0.137) % 1, 0.12 + ((i * 0.3819) % 1) * 0.35, 1.6 + ((i * 0.7548) % 1) * 1.8], k * 3);
        mMote.set([p.height, 0.07 + d.rarity * 0.008, 1], k * 3);
        mColor.set(COLORS[d.rarity], k * 4);
      }
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, nm) * 3), 3));
    mg.setAttribute('aBase', new THREE.BufferAttribute(mBase, 3));
    mg.setAttribute('aSeed', new THREE.BufferAttribute(mSeed, 3));
    mg.setAttribute('aMote', new THREE.BufferAttribute(mMote, 3));
    mg.setAttribute('aColor', new THREE.BufferAttribute(mColor, 4));
    mg.setDrawRange(0, nm);

    // sparkles: every drop (common too), landed
    let ns = 0;
    for (const d of drops) if (d.strike >= 1 || !beamParams(d.rarity).visible) ns += SPARKLE_N[Math.max(0, Math.min(7, d.rarity))];
    const sBase = new Float32Array(Math.max(1, ns) * 3);
    const sOff = new Float32Array(Math.max(1, ns) * 3);
    const sPh = new Float32Array(Math.max(1, ns) * 2);
    const sCol = new Float32Array(Math.max(1, ns) * 4);
    const sSize = new Float32Array(Math.max(1, ns));
    k = 0;
    for (const d of drops) {
      if (!(d.strike >= 1 || !beamParams(d.rarity).visible)) continue;
      const r = Math.max(0, Math.min(7, d.rarity));
      const cnt = SPARKLE_N[r];
      for (let i = 0; i < cnt; i++, k++) {
        const a = (i / cnt) * Math.PI * 2 + i * 1.7 + d.id;
        const rr = (0.18 + ((i * 0.618) % 1) * 0.22) * d.sparkleScale;
        sBase.set([d.x, d.y, d.z], k * 3);
        sOff.set([Math.cos(a) * rr, d.sparkleY + 0.3 + ((i * 0.381) % 1) * 0.45 * d.sparkleScale, Math.sin(a) * rr], k * 3);
        sPh.set([i * 2.399 + d.id, 0.7 + ((i * 0.737) % 1) * 0.9], k * 2);
        sCol.set(COLORS[r], k * 4);
        sSize[k] = r >= 2 ? 0.2 : 0.16;
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, ns) * 3), 3));
    sg.setAttribute('aBase', new THREE.BufferAttribute(sBase, 3));
    sg.setAttribute('aOff', new THREE.BufferAttribute(sOff, 3));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(sPh, 2));
    sg.setAttribute('aColor', new THREE.BufferAttribute(sCol, 4));
    sg.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
    sg.setDrawRange(0, ns);

    for (const [o, g] of [
      [this.beam, bg],
      [this.ring, rg],
      [this.motes, mg],
      [this.sparkles, sg],
    ] as const) {
      o.geometry.dispose();
      o.geometry = g;
    }
    this.beam.visible = this.ring.visible = lit.length > 0;
    this.motes.visible = nm > 0;
    this.sparkles.visible = ns > 0;
    this.counts = { beams: lit.length, rings: lit.filter((d) => !d.noRing).length, motes: nm, sparkles: ns };
  }

  dispose(): void {
    for (const o of [this.beam, this.ring, this.motes, this.sparkles]) o.geometry.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
  }
}

/**
 * Shader warm-up (world/warmExtras.ts): the four programs on High and on Low
 * (they differ by a define) with a lit drop each, so the first drop in view
 * never links a program mid-fight. Kept for the session.
 */
let warmKept: THREE.Object3D[] | null = null;
export function lootWarmObjects(): THREE.Object3D[] {
  if (warmKept) return warmKept;
  const out: THREE.Object3D[] = [];
  for (const tier of ['high', 'low'] as const) {
    const l = new LootLights(tier);
    l.update([{ id: 1, rarity: 4, x: 0, y: -1000, z: 0, strike: 1, sparkleY: 0, sparkleScale: 1 }], 0, 0);
    out.push(l.group);
  }
  warmKept = out;
  return out;
}
