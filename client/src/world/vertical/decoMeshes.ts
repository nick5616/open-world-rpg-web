// Decorations of the vertical world (CR 038) from the descriptor: one
// InstancedMesh per kind per layer (crystals, spires, mushrooms, flora,
// stalactites, stalagmites, vines, obsidian, vents, camps, island trees and
// rocks, ruin pillars, shrines), merged one-draw meshes for waterfalls,
// light shafts, wind columns and clouds, and the set pieces (tunnel portals,
// Depths gates, sky lift crystals, sky palaces). Procedural low-poly
// geometry, a few draws per layer; everything is placed by worldgen on the
// real floor and ceiling.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DECO, DECO_HANG, DECO_LIGHT, LAYER_DEPTHS, LAYER_SKY, LAYER_SURFACE, LAYER_UNDER, UPDRAFT_KINDS, type Deco, type VerticalWorld } from '@lodestone/worldgen';
import { TINT_RGB } from './layerMesh';
import { verticalUniforms } from './verticalMaterials';

export interface LightEmitter {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  intensity: number;
  distance: number;
  layer: number;
}

export interface DecoSet {
  /** Per layer 0..3: everything drawn for that layer. */
  groups: THREE.Group[];
  emitters: LightEmitter[];
  /** Materials the CSM should shadow (islands' trees, rocks, palaces). */
  sunMaterials: THREE.Material[];
  dispose(): void;
}

const yawOf = (d: Deco) => (d.yaw / 65536) * Math.PI * 2;

function prism(r: number, h: number, sides = 6, tip = 0.35): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r * 0.75, r, h, sides, 1, false);
  g.translate(0, h / 2, 0);
  const t = new THREE.ConeGeometry(r * 0.75, h * tip, sides);
  t.translate(0, h + (h * tip) / 2, 0);
  const m = mergeGeometries([g.toNonIndexed(), t.toNonIndexed()])!;
  m.computeVertexNormals();
  return m;
}

/** A cluster of 5 crystals leaning out from a common base (unit height). */
function crystalCluster(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const spec = [
    [0, 0, 0, 0.13, 1.0],
    [0.12, 0.03, 0.4, 0.09, 0.62],
    [-0.1, -0.06, -0.45, 0.08, 0.55],
    [0.05, 0.11, 0.6, 0.07, 0.45],
    [-0.06, 0.1, -0.2, 0.06, 0.4],
  ];
  for (const [ox, oz, tilt, r, h] of spec) {
    const p = prism(r, h, 6, 0.3);
    p.rotateZ(tilt);
    p.rotateY(ox * 9);
    p.translate(ox, 0, oz);
    parts.push(p);
  }
  return mergeGeometries(parts)!;
}

function mushroom(): THREE.BufferGeometry {
  const stem = new THREE.CylinderGeometry(0.07, 0.1, 0.62, 7);
  stem.translate(0, 0.31, 0);
  const cap = new THREE.SphereGeometry(0.36, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.55, 1);
  cap.translate(0, 0.6, 0);
  return mergeGeometries([stem.toNonIndexed(), cap.toNonIndexed()])!;
}

function fern(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const c = new THREE.ConeGeometry(0.05, 1, 4);
    c.translate(0, 0.5, 0);
    c.rotateZ(0.35 + (i % 2) * 0.2);
    c.rotateY((i / 5) * Math.PI * 2);
    parts.push(c.toNonIndexed());
  }
  return mergeGeometries(parts)!;
}

function cone(down: boolean): THREE.BufferGeometry {
  const c = new THREE.ConeGeometry(0.22, 1, 7);
  if (down) c.rotateX(Math.PI);
  c.translate(0, down ? -0.5 : 0.5, 0);
  return c;
}

function tree(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.05, 0.08, 0.5, 6);
  trunk.translate(0, 0.25, 0);
  const parts = [trunk.toNonIndexed()];
  for (const [x, y, z, r] of [
    [0, 0.62, 0, 0.3],
    [0.14, 0.52, 0.08, 0.22],
    [-0.12, 0.55, -0.06, 0.22],
    [0.02, 0.8, -0.02, 0.2],
  ]) {
    const s = new THREE.IcosahedronGeometry(r, 0);
    s.translate(x, y, z);
    parts.push(s.toNonIndexed());
  }
  return mergeGeometries(parts)!;
}

/** Color a merged geometry's parts: first `n` vertices one colour, the rest another. */
function twoTone(g: THREE.BufferGeometry, split: number, a: THREE.Color, b: THREE.Color): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = i < split ? a : b;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** An emissive-tinted material: instance colour = albedo and glow. */
function glowMaterial(glow: number, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.1, ...opts });
  const vc = !!opts.vertexColors;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlowGain = verticalUniforms.uGlowGain;
    // Our own tint varying: the instance colour (and the vertex colour) as glow.
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGlowTint;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vGlowTint = vec3(1.0);
#ifdef USE_INSTANCING_COLOR
vGlowTint *= instanceColor.rgb;
#endif
${vc ? 'vGlowTint *= color.rgb;' : ''}`,
    );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlowGain;\nvarying vec3 vGlowTint;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlowTint * ${glow.toFixed(2)} * uGlowGain;`);
  };
  m.customProgramCacheKey = () => `vt-glow2-${glow}-${vc ? 1 : 0}`;
  return m;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, list: Deco[], place: (d: Deco, m: THREE.Matrix4) => void, color?: (d: Deco) => THREE.Color): THREE.InstancedMesh | null {
  if (!list.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4();
  list.forEach((d, i) => {
    place(d, m);
    im.setMatrixAt(i, m);
    if (color) im.setColorAt(i, color(d));
  });
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.frustumCulled = false;
  return im;
}

const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
function compose(m: THREE.Matrix4, x: number, y: number, z: number, yaw: number, sx: number, sy = sx, sz = sx): THREE.Matrix4 {
  tmpQ.setFromAxisAngle(UP, yaw);
  return m.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
}

function tintColor(t: number, k = 1): THREE.Color {
  const c = TINT_RGB[t] ?? TINT_RGB[9];
  return new THREE.Color(c[0] * k, c[1] * k, c[2] * k);
}

// ---- set pieces

function portalGeometry(): THREE.BufferGeometry {
  // Two leaning standing stones and a capstone, runes in a glowing band (vertex colour > 1 = glow).
  const stone = new THREE.Color(0.32, 0.31, 0.3);
  const rune = new THREE.Color(0.3, 2.4, 2.4);
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const p = new THREE.BoxGeometry(1.8, 9, 1.6, 1, 4, 1);
    p.translate(s * 4.2, 4.5, 0);
    p.rotateZ(-s * 0.06);
    parts.push(twoTone(p.toNonIndexed(), 0, stone, stone));
    const band = new THREE.BoxGeometry(1.9, 0.35, 1.7);
    band.translate(s * 4.15, 6.2, 0);
    parts.push(twoTone(band.toNonIndexed(), 0, rune, rune));
  }
  const cap = new THREE.BoxGeometry(11, 1.6, 2.1);
  cap.translate(0, 9.6, 0);
  parts.push(twoTone(cap.toNonIndexed(), 0, stone, stone));
  const glyph = new THREE.TorusGeometry(1.1, 0.12, 6, 18);
  glyph.translate(0, 9.6, 1.08);
  parts.push(twoTone(glyph.toNonIndexed(), 0, rune, rune));
  // Rubble ring.
  for (let i = 0; i < 9; i++) {
    const r = new THREE.DodecahedronGeometry(0.6 + (i % 3) * 0.35, 0);
    const a = (i / 9) * Math.PI * 2;
    r.translate(Math.cos(a) * 7.5, 0.3, Math.sin(a) * 4 - 2);
    parts.push(twoTone(r.toNonIndexed(), 0, stone, stone));
  }
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

function palaceGeometry(): THREE.BufferGeometry {
  // Unit radius 1: a stepped platform, a keep with a great dome, four towers
  // with spires, connecting walls, a grand gate (the entrance site faces +z).
  const marble = new THREE.Color(0.86, 0.85, 0.8);
  const gold = new THREE.Color(1.0, 0.78, 0.35);
  const deep = new THREE.Color(0.25, 0.32, 0.5);
  const glowc = new THREE.Color(1.6, 1.3, 0.7);
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, c: THREE.Color) => parts.push(twoTone(g.toNonIndexed(), 0, c, c));
  for (let s = 0; s < 3; s++) {
    const p = new THREE.CylinderGeometry(0.95 - s * 0.12, 1.0 - s * 0.12, 0.05, 32);
    p.translate(0, 0.025 + s * 0.05, 0);
    add(p, marble);
  }
  const keep = new THREE.CylinderGeometry(0.32, 0.36, 0.55, 16);
  keep.translate(0, 0.42, 0);
  add(keep, marble);
  const drum = new THREE.CylinderGeometry(0.27, 0.27, 0.12, 16);
  drum.translate(0, 0.75, 0);
  add(drum, marble);
  const dome = new THREE.SphereGeometry(0.28, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.translate(0, 0.81, 0);
  add(dome, gold);
  const lantern = new THREE.CylinderGeometry(0.03, 0.04, 0.16, 8);
  lantern.translate(0, 1.16, 0);
  add(lantern, glowc);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 0.68;
    const z = Math.sin(a) * 0.68;
    const tw = new THREE.CylinderGeometry(0.09, 0.11, 0.78, 10);
    tw.translate(x, 0.54, z);
    add(tw, marble);
    const sp = new THREE.ConeGeometry(0.12, 0.42, 10);
    sp.translate(x, 1.14, z);
    add(sp, deep);
    const ring = new THREE.TorusGeometry(0.105, 0.012, 4, 12);
    ring.rotateX(Math.PI / 2);
    ring.translate(x, 0.9, z);
    add(ring, gold);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const w = new THREE.BoxGeometry(0.06, 0.26, 0.92);
    w.rotateY(-a);
    w.translate(Math.cos(a + Math.PI / 4) * 0.48 * Math.SQRT2 * 0.68, 0.28, Math.sin(a + Math.PI / 4) * 0.48 * Math.SQRT2 * 0.68);
    add(w, marble);
  }
  // The gate: an arch toward +z.
  const gate = new THREE.BoxGeometry(0.34, 0.36, 0.1);
  gate.translate(0, 0.3, 0.42);
  add(gate, marble);
  const door = new THREE.BoxGeometry(0.16, 0.24, 0.02);
  door.translate(0, 0.25, 0.48);
  add(door, glowc);
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

function liftGeometry(): THREE.BufferGeometry {
  const stone = new THREE.Color(0.5, 0.5, 0.52);
  const cry = new THREE.Color(0.4, 1.6, 1.8);
  const base = new THREE.CylinderGeometry(1.8, 2.2, 0.8, 8);
  base.translate(0, 0.4, 0);
  const c = new THREE.OctahedronGeometry(0.9, 0);
  c.scale(1, 2.2, 1);
  c.translate(0, 3.2, 0);
  const g = mergeGeometries([twoTone(base.toNonIndexed(), 0, stone, stone), twoTone(c.toNonIndexed(), 0, cry, cry)])!;
  g.computeVertexNormals();
  return g;
}

function gateGeometry(): THREE.BufferGeometry {
  // A ring of black spikes around the chasm, ember-red.
  const rock = new THREE.Color(0.08, 0.06, 0.06);
  const ember = new THREE.Color(1.8, 0.4, 0.08);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const h = 2.5 + ((i * 37) % 7) * 0.7;
    const s = new THREE.ConeGeometry(0.7, h, 5);
    s.rotateZ(0.25);
    s.rotateY(-a);
    s.translate(Math.cos(a) * 1.05, h / 2, Math.sin(a) * 1.05);
    parts.push(twoTone(s.toNonIndexed(), 0, rock, rock));
    const e = new THREE.ConeGeometry(0.2, 0.6, 4);
    e.translate(Math.cos(a) * 1.0, 0.3, Math.sin(a) * 1.0);
    parts.push(twoTone(e.toNonIndexed(), 0, ember, ember));
  }
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

// ---- merged one-draw effects

/** Falling water ribbons (three crossed strips each), streaks scrolling down. */
function waterfalls(list: Deco[], lava: boolean): THREE.Mesh | null {
  if (!list.length) return null;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const d of list) {
    const w = lava ? 2.2 : Math.max(3.5, Math.min(14, d.size * 0.06 + 3.5));
    const len = d.size;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI + yawOf(d);
      const dx = Math.cos(a) * w * 0.5;
      const dz = Math.sin(a) * w * 0.5;
      const b = pos.length / 3;
      pos.push(d.x - dx, d.y, d.z - dz, d.x + dx, d.y, d.z + dz, d.x - dx * 1.6, d.y - len, d.z - dz * 1.6, d.x + dx * 1.6, d.y - len, d.z + dz * 1.6);
      uv.push(0, 0, 1, 0, 0, len, 1, len);
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: verticalUniforms.uTime },
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
uniform float uTime; varying vec2 vUv; varying vec3 vW;
float h1(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  float x = vUv.x;
  float edge = smoothstep(0.0, 0.25, x) * smoothstep(1.0, 0.75, x);
  float col = floor(x * 14.0);
  float sp = 9.0 + h1(col) * 6.0;
  float s = fract(vUv.y * 0.08 - uTime * sp * 0.08 + h1(col * 3.1));
  float streak = smoothstep(0.0, 0.25, s) * smoothstep(1.0, 0.55, s);
  float top = smoothstep(0.0, 2.0, vUv.y);
  // The fall frays into spray and mist as it drops (a long one into the clouds).
  float fray = 1.0 - smoothstep(30.0, 260.0, vUv.y) * 0.75;
  ${lava ? 'vec3 c = mix(vec3(1.8, 0.45, 0.08), vec3(2.6, 1.0, 0.25), streak);' : 'vec3 c = mix(vec3(0.42, 0.62, 0.7), vec3(0.9, 1.0, 1.05), streak);'}
  float a = edge * top * fray * (${lava ? '0.95' : '0.16 + 0.3 * streak'});
  gl_FragColor = vec4(c, a);
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: lava ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return mesh;
}

/** Cenote light: a soft beam from the shaft's top down to the lake (daylight only). */
function lightShafts(list: Deco[], radius: (d: Deco) => number): THREE.Mesh | null {
  if (!list.length) return null;
  const parts: THREE.BufferGeometry[] = [];
  for (const d of list) {
    const r = radius(d);
    const c = new THREE.CylinderGeometry(r * 0.95, r * 0.75, d.size, 24, 1, true);
    c.translate(d.x, d.y + d.size / 2, d.z);
    const uv = c.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i)); // 0 bottom .. 1 top
    parts.push(c);
  }
  const g = mergeGeometries(parts)!;
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: verticalUniforms.uTime, uDay: verticalUniforms.uDayGlow },
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vN; varying vec3 vW; void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: /* glsl */ `
uniform float uTime; uniform vec3 uDay; varying vec2 vUv; varying vec3 vN; varying vec3 vW;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec3 V = normalize(cameraPosition - vW);
  float facing = pow(clamp(1.0 - abs(dot(V, vN)), 0.0, 1.0), 1.6);
  float soft = 1.0 - facing;
  float band = 0.6 + 0.4 * sin(vUv.x * 40.0 + uTime * 0.2) * sin(vUv.x * 17.0 - uTime * 0.13);
  float motes = step(0.9965, h(floor(vec2(vUv.x * 300.0, vUv.y * 200.0 - uTime * 3.0))));
  float a = soft * band * smoothstep(0.0, 0.25, vUv.y) * 0.22 + motes * 0.5;
  gl_FragColor = vec4(uDay * 1.6 + vec3(0.02), a * min(1.0, length(uDay) * 1.4));
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

/** Wind columns: open cylinders of upward-scrolling streaks; lifts brighter and teal. */
export function windColumns(v: VerticalWorld): THREE.Mesh | null {
  if (!v.updrafts.length) return null;
  const parts: THREE.BufferGeometry[] = [];
  for (const u of v.updrafts) {
    const h = u.top - u.bottom;
    const c = new THREE.CylinderGeometry(u.r, u.r, h, 14, 1, true);
    c.translate(u.x, u.bottom + h / 2, u.z);
    const n = c.attributes.position.count;
    const kind = new Float32Array(n).fill(u.kind);
    const len = new Float32Array(n).fill(h);
    c.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    c.setAttribute('aLen', new THREE.BufferAttribute(len, 1));
    parts.push(c);
  }
  void UPDRAFT_KINDS;
  const g = mergeGeometries(parts)!;
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: verticalUniforms.uTime },
    vertexShader: /* glsl */ `attribute float aKind; attribute float aLen; varying vec2 vUv; varying float vKind; varying float vLen; varying vec3 vW; varying vec3 vN;
void main(){ vUv = uv; vKind = aKind; vLen = aLen; vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: /* glsl */ `
uniform float uTime; varying vec2 vUv; varying float vKind; varying float vLen; varying vec3 vW; varying vec3 vN;
float h1(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  vec3 V = normalize(cameraPosition - vW);
  float rim = 1.0 - abs(dot(V, vN));
  float lift = vKind == 1.0 ? 1.0 : 0.0;
  float col = floor(vUv.x * 18.0);
  float y = vUv.y * vLen;
  float sp = (lift > 0.5 ? 16.0 : 8.0) * (0.8 + 0.4 * h1(col));
  float s = fract((y - uTime * sp) / (14.0 + 10.0 * h1(col * 7.0)) + vUv.x * 3.0);
  float streak = smoothstep(0.0, 0.15, s) * smoothstep(0.5, 0.2, s);
  float fade = smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
  vec3 c = mix(vec3(0.85, 0.95, 1.0), vec3(0.35, 1.3, 1.4), lift);
  float a = (0.03 + 0.22 * streak * (0.4 + rim)) * fade * (lift > 0.5 ? 1.3 : 1.0);
  gl_FragColor = vec4(c, a);
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return mesh;
}

/** Cloud banks under the archipelagos: soft billboards, lit by the sun colour. */
export function cloudBanks(list: Deco[]): { mesh: THREE.InstancedMesh; uniforms: { uSun: { value: THREE.Color }; uAmb: { value: THREE.Color } } } | null {
  if (!list.length) return null;
  const geo = new THREE.PlaneGeometry(1, 1);
  const uniforms = { uSun: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.6, 0.7, 0.85) } };
  const m = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uTime: verticalUniforms.uTime },
    vertexShader: /* glsl */ `varying vec2 vUv; varying float vSeed;
void main(){
  vUv = uv;
  vec4 c = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(vec3(instanceMatrix[0].x, instanceMatrix[0].y, instanceMatrix[0].z));
  vSeed = fract(c.x * 0.0137 + c.z * 0.0071);
  vec3 r = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 u = vec3(0.0, 1.0, 0.0);
  vec3 p = c.xyz + (r * position.x + u * position.y * 0.45) * s;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uSun; uniform vec3 uAmb; uniform float uTime; varying vec2 vUv; varying float vSeed;
float hh(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float nn(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hh(i), hh(i+vec2(1,0)), f.x), mix(hh(i+vec2(0,1)), hh(i+vec2(1,1)), f.x), f.y); }
void main(){
  vec2 p = vUv - 0.5;
  float d = length(p * vec2(1.0, 1.6));
  float n = nn(vUv * 4.0 + vSeed * 17.0 + uTime * 0.01) * 0.6 + nn(vUv * 9.0 - vSeed * 5.0) * 0.4;
  float a = smoothstep(0.5, 0.12, d + (n - 0.5) * 0.35);
  float top = clamp(vUv.y * 1.3, 0.0, 1.0);
  vec3 c = uAmb * (0.75 + 0.25 * n) + uSun * (0.35 + 0.55 * top);
  gl_FragColor = vec4(c, a * 0.88);
}`,
    transparent: true,
    depthWrite: false,
  });
  const im = new THREE.InstancedMesh(geo, m, list.length);
  const mm = new THREE.Matrix4();
  list.forEach((d, i) => im.setMatrixAt(i, compose(mm, d.x, d.y, d.z, 0, d.size * 1.9)));
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false;
  im.renderOrder = 3;
  return { mesh: im, uniforms };
}

export function buildDecos(v: VerticalWorld): DecoSet & { clouds: ReturnType<typeof cloudBanks>; winds: THREE.Mesh | null } {
  const groups = [0, 1, 2, 3].map((l) => {
    const g = new THREE.Group();
    g.name = `vertical-${['surface', 'sky', 'under', 'depths'][l]}`;
    return g;
  });
  const byLayer = (layer: number, kinds: number[]) => v.decos.filter((d) => d.layer === layer && kinds.includes(d.kind));
  const disposables: { dispose(): void }[] = [];
  const sunMaterials: THREE.Material[] = [];
  const add = (layer: number, o: THREE.Object3D | null) => {
    if (!o) return;
    groups[layer].add(o);
    if (o instanceof THREE.Mesh) {
      disposables.push(o.geometry);
      disposables.push(o.material as THREE.Material);
    }
  };

  const crystalMat = glowMaterial(1.15, { color: 0x2a3040, roughness: 0.18, metalness: 0.05, transparent: false }); // dim albedo: the glow keeps its hue
  const clusterGeo = crystalCluster();
  const spireGeo = prism(0.16, 1, 6, 0.25);
  const mushGeo = mushroom();
  const fernGeo = fern();
  const softGlow = glowMaterial(0.9, { roughness: 0.6 });
  // A faint cold self-light: rock silhouettes read in the dark instead of holes.
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6a6660, emissive: 0x2c4450, roughness: 0.92, flatShading: true });
  const deepRockMat = new THREE.MeshStandardMaterial({ color: 0x1a1110, emissive: 0x2a0b05, roughness: 0.35, metalness: 0.25, flatShading: true });
  const stalGeoDown = cone(true);
  const stalGeoUp = cone(false);
  for (const layer of [LAYER_UNDER, LAYER_DEPTHS]) {
    const deep = layer === LAYER_DEPTHS;
    const ground = (d: Deco) => (d.flags & DECO_HANG) === 0;
    add(layer, instanced(clusterGeo, crystalMat, byLayer(layer, [DECO.crystal]).filter(ground), (d, m) => compose(m, d.x, d.y - 0.2, d.z, yawOf(d), d.size), (d) => tintColor(d.tint)));
    add(
      layer,
      instanced(
        clusterGeo,
        crystalMat,
        byLayer(layer, [DECO.crystal]).filter((d) => !ground(d)),
        (d, m) => {
          m.makeRotationX(Math.PI);
          m.scale(tmpS.set(d.size * 0.7, d.size * 0.7, d.size * 0.7));
          m.setPosition(d.x, d.y + 0.2, d.z);
          return m;
        },
        (d) => tintColor(d.tint),
      ),
    );
    add(layer, instanced(spireGeo, crystalMat, byLayer(layer, [DECO.spire]), (d, m) => compose(m, d.x, d.y - 0.3, d.z, yawOf(d), d.size * 0.9, d.size, d.size * 0.9), (d) => tintColor(d.tint)));
    add(layer, instanced(mushGeo, softGlow, byLayer(layer, [DECO.mushroom]), (d, m) => compose(m, d.x, d.y, d.z, yawOf(d), d.size), (d) => tintColor(d.tint, 0.9)));
    add(layer, instanced(fernGeo, softGlow, byLayer(layer, [DECO.flora]), (d, m) => compose(m, d.x, d.y, d.z, yawOf(d), d.size * 0.8, d.size, d.size * 0.8), (d) => tintColor(d.tint, 0.55)));
    add(layer, instanced(stalGeoDown, deep ? deepRockMat : rockMat, byLayer(layer, [DECO.stalactite]), (d, m) => compose(m, d.x, d.y + 0.5, d.z, yawOf(d), d.size * 0.35, d.size, d.size * 0.35)));
    add(layer, instanced(stalGeoUp, deep ? deepRockMat : rockMat, byLayer(layer, [DECO.stalagmite]), (d, m) => compose(m, d.x, d.y - 0.4, d.z, yawOf(d), d.size * 0.4, d.size, d.size * 0.4)));
    add(layer, instanced(prism(0.3, 1, 5, 0.4), deepRockMat, byLayer(layer, [DECO.obsidian]), (d, m) => compose(m, d.x, d.y - 0.3, d.z, yawOf(d), d.size * 0.5, d.size, d.size * 0.5)));
    add(layer, waterfalls(byLayer(layer, [DECO.waterfall]), false));
    add(layer, waterfalls(byLayer(layer, [DECO.lavafall]), true));
  }
  // Great columns, floor to roof (hosts collide with them: server/pkg/vertical).
  const colGeo = new THREE.CylinderGeometry(0.85, 1.0, 1, 12, 6);
  colGeo.translate(0, 0.5, 0);
  {
    const p = colGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      // Flared at the floor and the roof, knotted in between.
      const y = p.getY(i);
      const k = 1 + 0.55 * Math.pow(Math.abs(y - 0.5) * 2, 3) + 0.08 * Math.sin(y * 23 + p.getX(i) * 3);
      p.setX(i, p.getX(i) * k);
      p.setZ(i, p.getZ(i) * k);
    }
    colGeo.computeVertexNormals();
  }
  for (const layer of [LAYER_UNDER, LAYER_DEPTHS]) {
    const cols = (globalThis as { __vtNoCols?: boolean }).__vtNoCols ? [] : v.columns.filter((c) => c.layer === layer);
    if (!cols.length) continue;
    const im = new THREE.InstancedMesh(colGeo, layer === LAYER_DEPTHS ? deepRockMat : rockMat, cols.length);
    const mm = new THREE.Matrix4();
    cols.forEach((c, i) => im.setMatrixAt(i, compose(mm, c.x, c.y0 - 1, c.z, (i * 1.7) % 6.28, c.r, c.y1 - c.y0 + 2, c.r)));
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    add(layer, im);
  }
  // Vines down the cenote shafts.
  const vineGeo = new THREE.BoxGeometry(0.4, 1, 0.12);
  vineGeo.translate(0, -0.5, 0);
  add(LAYER_UNDER, instanced(vineGeo, new THREE.MeshStandardMaterial({ color: 0x2f5a2a, roughness: 0.9 }), byLayer(LAYER_UNDER, [DECO.vines]), (d, m) => compose(m, d.x, d.y, d.z, yawOf(d), 1, d.size, 1)));
  add(LAYER_UNDER, lightShafts(byLayer(LAYER_UNDER, [DECO.lightshaft]), (d) => v.shafts[d.aux]?.r ?? 10));
  // Vents and embers (the Depths), shrines.
  const ventMat = glowMaterial(2.2, { roughness: 0.8, color: 0x1a1010 });
  const ventGeo = new THREE.CylinderGeometry(0.25, 0.6, 0.6, 7, 1, true);
  ventGeo.translate(0, 0.3, 0);
  add(LAYER_DEPTHS, instanced(ventGeo, ventMat, byLayer(LAYER_DEPTHS, [DECO.vent, DECO.embers]), (d, m) => compose(m, d.x, d.y, d.z, yawOf(d), d.size), () => new THREE.Color(1.0, 0.35, 0.08)));
  const shrineGeo = (() => {
    const base = new THREE.BoxGeometry(2.2, 1.2, 1.4);
    base.translate(0, 0.6, 0);
    const horn = new THREE.ConeGeometry(0.3, 2.4, 5);
    horn.translate(-0.8, 2.2, 0);
    const horn2 = horn.clone();
    horn2.translate(1.6, 0, 0);
    const orb = new THREE.IcosahedronGeometry(0.45, 1);
    orb.translate(0, 1.7, 0);
    const g = mergeGeometries([base.toNonIndexed(), horn.toNonIndexed(), horn2.toNonIndexed(), orb.toNonIndexed()])!;
    return g;
  })();
  add(LAYER_DEPTHS, instanced(shrineGeo, glowMaterial(1.2, { color: 0x140c18 }), byLayer(LAYER_DEPTHS, [DECO.shrine]), (d, m) => compose(m, d.x, d.y, d.z, yawOf(d), d.size / 3), () => new THREE.Color(0.7, 0.2, 1.0)));
  // Camps.
  const campParts = (() => {
    const fire = new THREE.ConeGeometry(0.35, 0.9, 6);
    fire.translate(0, 0.45, 0);
    const tent = new THREE.ConeGeometry(1.4, 2.2, 6);
    tent.translate(0, 1.1, 0);
    const lantern = new THREE.BoxGeometry(0.3, 0.45, 0.3);
    lantern.translate(0, 1.6, 0);
    const pole = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 5);
    pole.translate(0, 0.8, 0);
    return { fire, tent, lantern: mergeGeometries([lantern.toNonIndexed(), pole.toNonIndexed()])! };
  })();
  for (const layer of [LAYER_UNDER, LAYER_DEPTHS]) {
    add(layer, instanced(campParts.fire, glowMaterial(2.5, { color: 0x331100 }), byLayer(layer, [DECO.campfire]), (d, m) => compose(m, d.x, d.y, d.z, 0, 1), () => new THREE.Color(1.0, 0.5, 0.12)));
    add(layer, instanced(campParts.tent, new THREE.MeshStandardMaterial({ color: 0x8a6a46, roughness: 0.95 }), byLayer(layer, [DECO.tent]), (d, m) => compose(m, d.x, d.y, d.z, yawOf(d), d.size / 3)));
    add(layer, instanced(campParts.lantern, glowMaterial(2.0, { color: 0x221a10 }), byLayer(layer, [DECO.lantern]), (d, m) => compose(m, d.x, d.y, d.z, 0, 1), () => new THREE.Color(1.0, 0.75, 0.35)));
  }
  // Depths gates.
  add(LAYER_UNDER, instanced(gateGeometry(), glowMaterial(1.0, { vertexColors: true, roughness: 0.5 }), byLayer(LAYER_UNDER, [DECO.gate]), (d, m) => compose(m, d.x, d.y - 0.5, d.z, yawOf(d), d.size), () => new THREE.Color(1, 1, 1)));
  // Surface: tunnel portals and sky lift crystals.
  const portalMat = glowMaterial(1.0, { vertexColors: true, roughness: 0.85 });
  add(
    LAYER_SURFACE,
    instanced(portalGeometry(), portalMat, byLayer(LAYER_SURFACE, [DECO.portal]), (d, m) => compose(m, d.x, d.y - 0.6, d.z, -yawOf(d) + Math.PI / 2, d.size / 8.5), () => new THREE.Color(1, 1, 1)),
  );
  add(LAYER_SURFACE, instanced(liftGeometry(), glowMaterial(1.0, { vertexColors: true, roughness: 0.3 }), byLayer(LAYER_SURFACE, [DECO.lift]), (d, m) => compose(m, d.x, d.y - 0.3, d.z, 0, 1.4), () => new THREE.Color(1, 1, 1)));
  const geyserGeo = new THREE.TorusGeometry(1.6, 0.6, 6, 10);
  geyserGeo.rotateX(Math.PI / 2);
  add(LAYER_SURFACE, instanced(geyserGeo, rockMat, byLayer(LAYER_SURFACE, [DECO.geyser]), (d, m) => compose(m, d.x, d.y + 0.1, d.z, 0, d.size / 6)));
  // Sky: trees, rocks, ruin pillars, palaces, waterfalls off the rims, clouds, wind.
  const leaf = new THREE.Color(0.17, 0.33, 0.12);
  const bark = new THREE.Color(0.3, 0.2, 0.12);
  const treeGeo = twoTone(tree(), 36, bark, leaf);
  const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  sunMaterials.push(treeMat);
  const isl = new THREE.MeshStandardMaterial({ color: 0x6d6a66, roughness: 0.92, flatShading: true });
  sunMaterials.push(isl);
  add(LAYER_SKY, instanced(treeGeo, treeMat, byLayer(LAYER_SKY, [DECO.tree]), (d, m) => compose(m, d.x, d.y - 0.2, d.z, yawOf(d), d.size)));
  add(LAYER_SKY, instanced(new THREE.DodecahedronGeometry(0.5, 0), isl, byLayer(LAYER_SKY, [DECO.rock]), (d, m) => compose(m, d.x, d.y, d.z, yawOf(d), d.size, d.size * 0.6, d.size)));
  const pillarGeo = new THREE.CylinderGeometry(0.42, 0.5, 1, 9);
  pillarGeo.translate(0, 0.5, 0);
  const marbleMat = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.7 });
  sunMaterials.push(marbleMat);
  add(LAYER_SKY, instanced(pillarGeo, marbleMat, byLayer(LAYER_SKY, [DECO.pillar]), (d, m) => compose(m, d.x, d.y - 0.3, d.z, yawOf(d), 1.6, d.size, 1.6)));
  const palaceMat = glowMaterial(0.6, { vertexColors: true, roughness: 0.55, metalness: 0.15 });
  sunMaterials.push(palaceMat);
  add(LAYER_SKY, instanced(palaceGeometry(), palaceMat, byLayer(LAYER_SKY, [DECO.palace]), (d, m) => compose(m, d.x, d.y - 1, d.z, yawOf(d), d.size), () => new THREE.Color(1, 1, 1)));
  add(LAYER_SKY, waterfalls(byLayer(LAYER_SKY, [DECO.skyfall]), false));
  const clouds = cloudBanks(byLayer(LAYER_SKY, [DECO.cloud]));
  if (clouds) add(LAYER_SKY, clouds.mesh);
  const winds = windColumns(v);
  if (winds) add(LAYER_SURFACE, winds);

  // Real lights (the cave light pool picks the nearest).
  const emitters: LightEmitter[] = [];
  for (const d of v.decos) {
    if ((d.flags & DECO_LIGHT) === 0) continue;
    const c = d.kind === DECO.campfire || d.kind === DECO.lantern ? new THREE.Color(1.0, 0.62, 0.3) : d.kind === DECO.lavafall || d.kind === DECO.vent || d.kind === DECO.embers || d.kind === DECO.gate ? new THREE.Color(1.0, 0.38, 0.1) : tintColor(d.tint);
    const big = d.kind === DECO.spire || d.kind === DECO.palace || d.kind === DECO.lightshaft;
    emitters.push({
      x: d.x,
      y: d.y + (d.kind === DECO.spire ? d.size * 0.5 : 1.5),
      z: d.z,
      color: c,
      intensity: big ? 60 : d.kind === DECO.campfire ? 30 : 22,
      distance: big ? 70 : 40,
      layer: d.layer,
    });
  }
  return {
    groups,
    emitters,
    sunMaterials,
    clouds,
    winds,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
