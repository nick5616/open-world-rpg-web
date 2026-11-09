// Fixed pools of short-lived spell visuals (adapted from wizard-wars
// fx/FxLayer.tsx): shockwave rings, flash sprites, pooled light pulses,
// ground decals (scorch, magic circles, zones), domes, beams, shells,
// instanced erupting spikes and bolt ribbons. Nothing is created or
// destroyed per cast: a slot is recycled (the oldest is stolen when a pool
// is full) and an idle slot is just `visible = false`.
//
// Lodestone change: the ground is not flat. Every ground decal is a small
// grid whose vertices sample the terrain when it is placed (conform()), so
// rings, sigils and zones hug hillsides instead of floating or clipping
// (playtest 2's scorch lesson in NightLayer, generalised); spikes stand on
// the sampled height.

import * as THREE from 'three';
import type { GroundQuery } from '../../sim/ground';
import { budget, fxTime, GEO, glowTexture, scorchTexture } from './core';
import { createBeamMaterial, createCircleMaterial, createDomeMaterial, createRingMaterial, createShellMaterial, createZoneMaterial, type BeamMat, type CircleMat, type DomeMat, type RingMat, type ShellMat, type ZoneMat } from './materials';
import { newBoltSlot, RibbonBuffer, crackle, type BoltSlot } from './bolts';
import type { SpikeStyle } from './spellVisual';

export const SPIKE_STYLES: SpikeStyle[] = ['ice', 'crystal', 'bramble', 'stone', 'void', 'light'];

/** Pool sizes (caps on concurrent effects; the oldest is recycled past them). */
export const POOL = { rings: 32, flashes: 32, scorches: 16, sigils: 16, zones: 12, domes: 2, beams: 12, shells: 10, bolts: 24 };

interface Slot {
  on: boolean;
  start: number;
  dur: number;
  gen: number;
}

/** A held slot: writes only land while the generation matches (a stolen slot is somebody else's). */
export interface Held<T extends Slot> {
  s: T;
  gen: number;
}
export const alive = <T extends Slot>(h: Held<T> | null): h is Held<T> => !!h && h.s.gen === h.gen && h.s.on;

function take<T extends Slot>(arr: T[]): T {
  let oldest = arr[0];
  for (const s of arr) {
    if (!s.on) return s;
    if (s.start < oldest.start) oldest = s;
  }
  return oldest;
}

interface RingSlot extends Slot {
  mesh: THREE.Mesh;
  mat: RingMat;
  w: number;
  op: number;
}
interface FlashSlot extends Slot {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  s0: number;
  s1: number;
  op: number;
}
export interface DecalSlot<M extends THREE.Material = THREE.Material> extends Slot {
  mesh: THREE.Mesh;
  mat: M;
  op: number;
}
interface LightSlot extends Slot {
  light: THREE.PointLight;
  i0: number;
  /** Held by a projectile (moves with it; released by the holder). */
  held: boolean;
}
export interface BeamSlot extends Slot {
  mesh: THREE.Mesh;
  mat: BeamMat;
}
export interface ShellSlot extends Slot {
  mesh: THREE.Mesh;
  mat: ShellMat;
}
export interface DomeSlot extends Slot {
  mesh: THREE.Mesh;
  mat: DomeMat;
}
interface Spike {
  x: number;
  y: number;
  z: number;
  h: number;
  w: number;
  q: THREE.Quaternion;
  start: number;
  rise: number;
  hold: number;
  sink: number;
}
interface SpikeSet {
  mesh: THREE.InstancedMesh;
  spikes: Spike[];
  n: number;
}
export interface BoltHeld extends BoltSlot, Slot {}

export interface RingOpts {
  radius?: number;
  duration?: number;
  width?: number;
  opacity?: number;
  /** Upright ring facing this direction (walls, frontal blasts) instead of on the ground. */
  normal?: THREE.Vector3 | null;
  y?: number;
}
export interface FlashOpts {
  size?: number;
  duration?: number;
  opacity?: number;
  grow?: number;
}
export interface SpikeOpts {
  height: number;
  width: number;
  tiltX?: number;
  tiltZ?: number;
  yaw?: number;
  delay?: number;
  rise?: number;
  hold?: number;
  sink?: number;
  /** Height above the ground. */
  y?: number;
}
export interface BoltOpts {
  segs?: number;
  jitter?: number;
  forks?: number;
  width?: number;
  duration?: number;
  every?: number;
  alpha?: number;
  flicker?: boolean;
}

export function createSpikeMaterial(style: SpikeStyle): THREE.Material {
  switch (style) {
    case 'ice':
      return new THREE.MeshStandardMaterial({ color: '#cfefff', emissive: '#3d9cff', emissiveIntensity: 0.55, roughness: 0.08, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.88 });
    case 'crystal':
      return new THREE.MeshStandardMaterial({ color: '#a8dcff', emissive: '#4fa4e0', emissiveIntensity: 0.6, roughness: 0.05, metalness: 0.2, flatShading: true, transparent: true, opacity: 0.9 });
    case 'bramble':
      return new THREE.MeshStandardMaterial({ color: '#3b6a26', emissive: '#4fa82a', emissiveIntensity: 0.18, roughness: 0.85, flatShading: true });
    case 'stone':
      return new THREE.MeshStandardMaterial({ color: '#7a6646', emissive: '#2a1a08', emissiveIntensity: 0.2, roughness: 0.95, flatShading: true });
    case 'void':
      return new THREE.MeshStandardMaterial({ color: '#12001f', emissive: '#7a2cff', emissiveIntensity: 0.9, roughness: 0.4, flatShading: true });
    case 'light':
      return new THREE.MeshStandardMaterial({ color: '#fff4d0', emissive: '#ffcc55', emissiveIntensity: 1.2, roughness: 0.2, metalness: 0.4, flatShading: true });
  }
}

function spikeGeometry(style: SpikeStyle): THREE.BufferGeometry {
  return style === 'crystal' || style === 'light' ? GEO.cone6 : style === 'stone' ? GEO.cone5 : style === 'void' ? GEO.cone4 : GEO.cone5;
}

/** Flat grid template (plane -1..1, laid on XZ) for conforming decals. */
function decalGeometry(n: number): { geo: THREE.BufferGeometry; tpl: Float32Array } {
  const geo = new THREE.PlaneGeometry(2, 2, n, n).rotateX(-Math.PI / 2);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  p.setUsage(THREE.DynamicDrawUsage);
  const tpl = new Float32Array(p.array as Float32Array);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  return { geo, tpl };
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpE = new THREE.Euler();
const tmpM = new THREE.Matrix4();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpCam = new THREE.Vector3();

export class FxPrims {
  readonly group = new THREE.Group();
  ground: GroundQuery | null = null;
  readonly rings: RingSlot[] = [];
  readonly flashes: FlashSlot[] = [];
  readonly scorches: DecalSlot<THREE.MeshBasicMaterial>[] = [];
  readonly sigils: DecalSlot<CircleMat>[] = [];
  readonly zones: DecalSlot<ZoneMat>[] = [];
  readonly domes: DomeSlot[] = [];
  readonly beams: BeamSlot[] = [];
  readonly shells: ShellSlot[] = [];
  readonly lights: LightSlot[] = [];
  readonly bolts: BoltHeld[] = [];
  readonly ribbons: RibbonBuffer;
  readonly spikes = {} as Record<SpikeStyle, SpikeSet>;
  private readonly tpl = new Map<THREE.BufferGeometry, Float32Array>();
  private readonly disposables: { dispose(): void }[] = [];

  constructor(lightCount: number, spikeCap: number, boltSegments: number, grid: number) {
    this.group.name = 'spell-fx';
    const mkDecal = <M extends THREE.Material>(mat: M, n: number, order: number): DecalSlot<M> => {
      const { geo, tpl } = decalGeometry(n);
      this.tpl.set(geo, tpl);
      this.disposables.push(geo, mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      this.group.add(mesh);
      return { mesh, mat, on: false, start: 0, dur: 1, gen: 0, op: 1 };
    };
    for (let i = 0; i < POOL.rings; i++) {
      const d = mkDecal(createRingMaterial(), Math.max(6, grid >> 1), 18);
      this.rings.push({ ...d, w: 0.06 });
    }
    for (let i = 0; i < POOL.flashes; i++) {
      const mat = new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, color: '#ffffff' });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.frustumCulled = false;
      sprite.renderOrder = 21;
      this.disposables.push(mat);
      this.group.add(sprite);
      this.flashes.push({ sprite, mat, on: false, start: 0, dur: 1, gen: 0, s0: 1, s1: 1, op: 1 });
    }
    for (let i = 0; i < POOL.scorches; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: scorchTexture(), transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      this.scorches.push(mkDecal(mat, Math.max(6, grid >> 1), 2));
    }
    for (let i = 0; i < POOL.sigils; i++) this.sigils.push(mkDecal(createCircleMaterial(), grid, 4));
    for (let i = 0; i < POOL.zones; i++) this.zones.push(mkDecal(createZoneMaterial(), grid, 3));
    for (let i = 0; i < POOL.domes; i++) {
      const mat = createDomeMaterial();
      const mesh = new THREE.Mesh(GEO.sphere, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 17;
      this.disposables.push(mat);
      this.group.add(mesh);
      this.domes.push({ mesh, mat, on: false, start: 0, dur: 1, gen: 0 });
    }
    for (let i = 0; i < POOL.beams; i++) {
      const mat = createBeamMaterial();
      const mesh = new THREE.Mesh(GEO.beam, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 22;
      this.disposables.push(mat);
      this.group.add(mesh);
      this.beams.push({ mesh, mat, on: false, start: 0, dur: 1, gen: 0 });
    }
    for (let i = 0; i < POOL.shells; i++) {
      const mat = createShellMaterial();
      const mesh = new THREE.Mesh(GEO.sphere, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 16;
      this.disposables.push(mat);
      this.group.add(mesh);
      this.shells.push({ mesh, mat, on: false, start: 0, dur: 1, gen: 0 });
    }
    // Pooled point lights: the count never changes (no material recompiles);
    // idle ones sit at intensity 0 (wizard-wars LightPool rule).
    for (let i = 0; i < lightCount; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2);
      light.name = 'fx-light';
      this.group.add(light);
      this.lights.push({ light, on: false, start: 0, dur: 1, gen: 0, i0: 0, held: false });
    }
    for (const style of SPIKE_STYLES) {
      const mat = createSpikeMaterial(style);
      const mesh = new THREE.InstancedMesh(spikeGeometry(style), mat, spikeCap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.name = `fx-spikes-${style}`;
      this.disposables.push(mat);
      this.group.add(mesh);
      const spikes: Spike[] = [];
      for (let i = 0; i < spikeCap; i++) spikes.push({ x: 0, y: 0, z: 0, h: 1, w: 0.2, q: new THREE.Quaternion(), start: 0, rise: 0.1, hold: 0.4, sink: 0.3 });
      this.spikes[style] = { mesh, spikes, n: 0 };
    }
    for (let i = 0; i < POOL.bolts; i++) this.bolts.push({ ...newBoltSlot(), gen: 0 });
    this.ribbons = new RibbonBuffer(boltSegments);
    this.disposables.push(this.ribbons.mesh.geometry, this.ribbons.material);
    this.group.add(this.ribbons.mesh);
  }

  // ── Ground ──────────────────────────────────────────────────────────────
  heightAt(x: number, z: number, nearY?: number): number {
    const g = this.ground;
    if (!g) return nearY ?? 0;
    const q = nearY !== undefined && g.atLevel ? g.atLevel(nearY + 1) : g;
    return q.heightAt(x, z);
  }

  /** Lays a decal grid on the terrain: centre (x, z), half sizes sx/sz, turned by yaw. */
  conform(mesh: THREE.Mesh, x: number, y: number, z: number, sx: number, sz: number, yaw: number, lift: number): void {
    const geo = mesh.geometry;
    const tpl = this.tpl.get(geo)!;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const cy = this.ground ? this.heightAt(x, z, y) : y;
    for (let i = 0; i < arr.length; i += 3) {
      const lx = tpl[i] * sx;
      const lz = tpl[i + 2] * sz;
      const wx = lx * c + lz * s;
      const wz = -lx * s + lz * c;
      arr[i] = wx;
      arr[i + 2] = wz;
      arr[i + 1] = (this.ground ? this.heightAt(x + wx, z + wz, y) : y) - cy + lift;
    }
    pos.needsUpdate = true;
    geo.boundingSphere!.radius = Math.max(sx, sz) * 1.5 + 2;
    mesh.position.set(x, cy, z);
  }

  // ── One-shots ───────────────────────────────────────────────────────────
  ring(x: number, y: number, z: number, color: THREE.Color, o: RingOpts = {}): void {
    const s = take(this.rings);
    s.on = true;
    s.gen++;
    s.start = fxTime();
    s.dur = o.duration ?? 0.5;
    s.w = o.width ?? 0.06;
    s.op = o.opacity ?? 1;
    const r = Math.max(0.05, o.radius ?? 3);
    if (o.normal) {
      // Upright: a plain disc facing `normal` (the template is flat; scale it).
      const arr = (s.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      const tpl = this.tpl.get(s.mesh.geometry)!;
      for (let i = 0; i < arr.length; i++) arr[i] = tpl[i] * r;
      s.mesh.geometry.getAttribute('position').needsUpdate = true;
      s.mesh.position.set(x, o.y ?? y, z);
      s.mesh.quaternion.setFromUnitVectors(UP, o.normal);
    } else {
      s.mesh.quaternion.identity();
      this.conform(s.mesh, x, y, z, r, r, 0, 0.08);
    }
    s.mat.uniforms.uColor.value = (s.mat.uniforms.uColor.value as THREE.Color).copy(color);
    s.mesh.visible = true;
  }

  flash(x: number, y: number, z: number, color: THREE.Color, o: FlashOpts = {}): void {
    const s = take(this.flashes);
    s.on = true;
    s.gen++;
    s.start = fxTime();
    s.dur = o.duration ?? 0.22;
    s.s0 = o.size ?? 3;
    s.s1 = s.s0 * (o.grow ?? 1.6);
    s.op = o.opacity ?? 1;
    s.sprite.position.set(x, y, z);
    s.mat.color.copy(color);
    s.sprite.visible = true;
  }

  light(x: number, y: number, z: number, color: THREE.Color, intensity = 30, distance = 12, duration = 0.3): void {
    if (this.lights.length === 0) return;
    // Free one, else steal the dimmest unheld pulse.
    let best: LightSlot | null = null;
    for (const l of this.lights) {
      if (l.held) continue;
      if (!l.on) {
        best = l;
        break;
      }
      if (!best || l.light.intensity < best.light.intensity) best = l;
    }
    if (!best) return;
    best.on = true;
    best.gen++;
    best.start = fxTime();
    best.dur = duration;
    best.i0 = intensity;
    best.light.color.copy(color);
    best.light.distance = distance;
    best.light.intensity = intensity;
    best.light.position.set(x, y, z);
  }

  /** A light that follows something until released (projectiles). Only a free slot, never a steal. */
  holdLight(color: THREE.Color, intensity: number, distance: number): Held<LightSlot> | null {
    for (const l of this.lights) {
      if (l.on || l.held) continue;
      l.held = true;
      l.on = true;
      l.gen++;
      l.start = fxTime();
      l.light.color.copy(color);
      l.light.distance = distance;
      l.light.intensity = intensity;
      return { s: l, gen: l.gen };
    }
    return null;
  }

  releaseLight(h: Held<LightSlot> | null): void {
    if (!h || h.s.gen !== h.gen) return;
    h.s.held = false;
    h.s.on = false;
    h.s.light.intensity = 0;
  }

  scorch(x: number, y: number, z: number, radius: number, duration = 5, opacity = 0.85): void {
    const s = take(this.scorches);
    s.on = true;
    s.gen++;
    s.start = fxTime();
    s.dur = duration;
    s.op = opacity;
    this.conform(s.mesh, x, y, z, radius, radius, Math.random() * Math.PI * 2, 0.05);
    s.mesh.visible = true;
  }

  spike(style: SpikeStyle, x: number, z: number, gy: number, o: SpikeOpts): void {
    const set = this.spikes[style];
    if (set.spikes.length === 0) return;
    // Full: recycle the oldest (index 0 after compaction is not guaranteed oldest; good enough).
    const idx = set.n < set.spikes.length ? set.n++ : Math.floor(Math.random() * set.spikes.length);
    const s = set.spikes[idx];
    tmpE.set(o.tiltX ?? 0, o.yaw ?? Math.random() * Math.PI * 2, o.tiltZ ?? 0, 'YXZ');
    s.q.setFromEuler(tmpE);
    s.x = x;
    s.y = this.heightAt(x, z, gy) + (o.y ?? 0) - 0.05;
    s.z = z;
    s.h = o.height;
    s.w = o.width;
    s.start = fxTime() + (o.delay ?? 0);
    s.rise = o.rise ?? 0.12;
    s.hold = o.hold ?? 0.45;
    s.sink = o.sink ?? 0.35;
  }

  /** A crown of spikes bursting outward around (x, z). */
  spikeRing(style: SpikeStyle, x: number, z: number, gy: number, radius: number, count: number, height: number, o: Partial<SpikeOpts> = {}): void {
    const n = Math.max(3, Math.round(count * Math.min(1, budget.profile.density + 0.25)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const r = radius * (0.75 + Math.random() * 0.35);
      const lean = 0.35 + Math.random() * 0.35;
      this.spike(style, x + Math.cos(a) * r, z + Math.sin(a) * r, gy, {
        height: height * (0.7 + Math.random() * 0.6),
        width: height * 0.16 * (0.8 + Math.random() * 0.5),
        yaw: Math.atan2(Math.cos(a), Math.sin(a)),
        tiltX: lean,
        delay: (o.delay ?? 0) + Math.random() * 0.05,
        rise: o.rise,
        hold: o.hold,
        sink: o.sink,
        y: o.y,
      });
    }
  }

  /** A tight bouquet of spikes at (x, z). */
  spikeCluster(style: SpikeStyle, x: number, z: number, gy: number, spread: number, count: number, height: number, o: Partial<SpikeOpts> = {}): void {
    const n = Math.max(2, Math.round(count * Math.min(1, budget.profile.density + 0.25)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = i === 0 ? 0 : spread * Math.sqrt(Math.random());
      const hh = i === 0 ? height : height * (0.45 + Math.random() * 0.45);
      this.spike(style, x + Math.cos(a) * r, z + Math.sin(a) * r, gy, {
        height: hh,
        width: hh * 0.18,
        yaw: Math.atan2(Math.cos(a), Math.sin(a)),
        tiltX: i === 0 ? 0 : 0.25 + (r / Math.max(0.01, spread)) * 0.45,
        delay: (o.delay ?? 0) + (i === 0 ? 0 : Math.random() * 0.08),
        rise: o.rise,
        hold: o.hold,
        sink: o.sink,
        y: o.y,
      });
    }
  }

  /** A lightning bolt a -> b, re-crackled every `every` s for `duration` s. */
  bolt(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: THREE.Color, o: BoltOpts = {}): Held<BoltHeld> {
    const s = take(this.bolts);
    s.on = true;
    s.gen++;
    s.start = fxTime();
    s.dur = o.duration ?? 0.3;
    s.ax = ax;
    s.ay = ay;
    s.az = az;
    s.bx = bx;
    s.by = by;
    s.bz = bz;
    const L = Math.hypot(bx - ax, by - ay, bz - az);
    s.segs = o.segs ?? Math.max(4, Math.min(40, Math.round(L * 1.4)));
    s.jitter = o.jitter ?? Math.min(1.6, 0.25 + L * 0.06);
    s.forks = o.forks ?? 2;
    s.width = o.width ?? 0.08;
    s.color.copy(color);
    s.alpha = o.alpha ?? 1;
    s.every = o.every ?? 0.045;
    s.flicker = o.flicker ?? true;
    s.next = s.start + s.every;
    crackle(s);
    return { s, gen: s.gen };
  }

  // ── Held slots (the engine's ongoing effects drive them) ────────────────
  holdSigil(): Held<DecalSlot<CircleMat>> {
    return this.hold(this.sigils);
  }
  holdZone(): Held<DecalSlot<ZoneMat>> {
    return this.hold(this.zones);
  }
  holdBeam(): Held<BeamSlot> {
    return this.hold(this.beams);
  }
  holdShell(): Held<ShellSlot> {
    return this.hold(this.shells);
  }
  holdDome(): Held<DomeSlot> {
    return this.hold(this.domes);
  }
  private hold<T extends Slot & { mesh: THREE.Object3D }>(arr: T[]): Held<T> {
    const s = take(arr);
    s.on = true;
    s.gen++;
    s.start = fxTime();
    s.dur = Infinity;
    s.mesh.visible = true;
    return { s, gen: s.gen };
  }
  release<T extends Slot & { mesh: THREE.Object3D }>(h: Held<T> | null): void {
    if (!h || h.s.gen !== h.gen) return;
    h.s.on = false;
    h.s.mesh.visible = false;
  }

  /** Places a beam from a to b with radius w. */
  placeBeam(b: BeamSlot, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number): void {
    tmpP.set(bx - ax, by - ay, bz - az);
    const len = Math.max(0.01, tmpP.length());
    tmpP.divideScalar(len);
    b.mesh.position.set(ax, ay, az);
    b.mesh.quaternion.setFromUnitVectors(UP, tmpP);
    b.mesh.scale.set(w, len, w);
    b.mat.uniforms.uLength.value = len;
  }

  // ── Per frame ───────────────────────────────────────────────────────────
  update(t: number, camera: THREE.Camera): void {
    camera.getWorldPosition(tmpCam);
    for (const s of this.rings) {
      if (!s.on) continue;
      const k = (t - s.start) / s.dur;
      if (k >= 1) {
        s.on = false;
        s.mesh.visible = false;
        continue;
      }
      const e = 1 - Math.pow(1 - k, 3);
      s.mat.uniforms.uR.value = 0.04 + e * 0.92;
      s.mat.uniforms.uW.value = s.w * (1 + k * 1.5);
      s.mat.uniforms.uOpacity.value = s.op * (1 - k) * (1 - k);
    }
    for (const s of this.flashes) {
      if (!s.on) continue;
      const k = (t - s.start) / s.dur;
      if (k >= 1) {
        s.on = false;
        s.sprite.visible = false;
        continue;
      }
      const size = s.s0 + (s.s1 - s.s0) * Math.sqrt(k);
      s.sprite.scale.set(size, size, 1);
      // Readability: a flash at your own hand never whites out the view.
      const d = s.sprite.position.distanceTo(tmpCam);
      const near = Math.min(1, Math.max(0.15, (d - size * 0.5) / 4));
      s.mat.opacity = s.op * (1 - k * k) * near;
    }
    for (const l of this.lights) {
      if (!l.on || l.held) continue;
      const k = (t - l.start) / l.dur;
      if (k >= 1) {
        l.on = false;
        l.light.intensity = 0;
        continue;
      }
      l.light.intensity = l.i0 * (1 - k) * (1 - k);
    }
    for (const s of this.scorches) {
      if (!s.on) continue;
      const k = (t - s.start) / s.dur;
      if (k >= 1) {
        s.on = false;
        s.mesh.visible = false;
        continue;
      }
      s.mat.opacity = s.op * Math.min(1, k * 12) * (1 - Math.pow(k, 3));
    }
    for (const style of SPIKE_STYLES) {
      const set = this.spikes[style];
      if (set.n === 0 && set.mesh.count === 0) continue;
      let n = 0;
      for (let i = 0; i < set.n; i++) {
        const s = set.spikes[i];
        const age = t - s.start;
        const total = s.rise + s.hold + s.sink;
        if (age >= total) {
          // swap-remove (the Spike objects themselves are reused)
          const last = set.spikes[set.n - 1];
          set.spikes[set.n - 1] = s;
          set.spikes[i] = last;
          set.n--;
          i--;
          continue;
        }
        if (age < 0) continue;
        let sy: number;
        let drop = 0;
        if (age < s.rise) {
          const k = age / s.rise;
          const c = 1.9; // ease-out-back: shoots up and slightly overshoots
          sy = 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
        } else if (age < s.rise + s.hold) sy = 1;
        else {
          const k = (age - s.rise - s.hold) / s.sink;
          sy = 1 - k * 0.35;
          drop = k * k * s.h;
        }
        tmpP.set(s.x, s.y - drop, s.z);
        tmpS.set(s.w, Math.max(0.001, s.h * sy), s.w);
        tmpM.compose(tmpP, s.q, tmpS);
        set.mesh.setMatrixAt(n++, tmpM);
      }
      set.mesh.count = n;
      if (n > 0) set.mesh.instanceMatrix.needsUpdate = true;
    }
    // Bolts: re-crackle, flicker, fade; all into the one ribbon buffer.
    this.ribbons.begin();
    for (const b of this.bolts) {
      if (!b.on) continue;
      const age = t - b.start;
      if (age >= b.dur) {
        b.on = false;
        continue;
      }
      if (b.every > 0 && t >= b.next) {
        b.next = t + b.every;
        crackle(b);
      }
      const fade = Math.min(1, (1 - age / b.dur) * 1.5);
      const flick = b.flicker && Math.random() < 0.2 ? 0.35 : 1;
      this.ribbons.addSlot(b, b.width, b.alpha * fade * flick);
    }
    this.ribbons.end();
  }

  /** Every pooled object off (tests, scene changes). */
  clear(): void {
    for (const arr of [this.rings, this.flashes, this.scorches, this.sigils, this.zones, this.domes, this.beams, this.shells] as (Slot & { mesh?: THREE.Object3D; sprite?: THREE.Object3D })[][]) {
      for (const s of arr) {
        s.on = false;
        s.gen++;
        (s.mesh ?? s.sprite)!.visible = false;
      }
    }
    for (const l of this.lights) {
      l.on = false;
      l.held = false;
      l.light.intensity = 0;
    }
    for (const b of this.bolts) b.on = false;
    for (const style of SPIKE_STYLES) this.spikes[style].n = 0;
  }

  /** Counts for the debug handle and the bench. */
  stats(): Record<string, number> {
    const on = (a: Slot[]) => a.reduce((n, s) => n + (s.on ? 1 : 0), 0);
    let spikes = 0;
    for (const style of SPIKE_STYLES) spikes += this.spikes[style].n;
    return { rings: on(this.rings), flashes: on(this.flashes), scorches: on(this.scorches), sigils: on(this.sigils), zones: on(this.zones), domes: on(this.domes), beams: on(this.beams), shells: on(this.shells), lights: on(this.lights), bolts: on(this.bolts), boltSegments: this.ribbons.segments, spikes };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
