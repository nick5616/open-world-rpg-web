// Town animals (playtest 4, CR 050): chickens pecking about the farms, a dog
// or two trotting the streets (one follows a passer-by a few steps), cats
// on the doorsteps. Client-side ambience: which animals a settlement has is
// planned from its id (animalsPlan.ts: every client agrees, nothing on the
// wire), they are simulated only while the settlement is near the camera,
// and they cost four instanced draws in all (chickens, dog bodies, dog
// legs, cats), halved in number on the Low tier. Original blocky models in
// the townsfolk's style, tinted per animal. Chickens roost at night and in
// the rain, cats shelter in the rain.
//
// Playtest 5 (CR 054): dogs and cats have names (animalNames.ts) and can be
// petted (petting.ts): the animal walks to a spot in front of you, sits (a
// dog) or arches (a cat), leans in, wags its tail faster, tilts its head,
// and now and then rolls over; hearts rise. A dog's head and tail are their
// own instanced meshes so they can tilt and wag: six draws in all with dogs
// in view (chickens, dog bodies, legs, heads, tails, cats) plus the hearts.
// Another player's petting (Event 1970) brings this client's copy of that
// animal over to them the same way.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Towns } from '@lodestone/worldgen';
import type { GroundQuery } from '../../sim/ground';
import { ANIMAL, followGoal, peckPitch, planAnimals, trotLeg, type AnimalSpec } from './animalsPlan';
import { STEP_OUT_M } from './npcLife';
import { kindOrdinals, nameAll } from './animalNames';
import { PET_DUR_S, PET_REACH_M, PET_STAND_M, animalKey, forwardOfYaw, petBeat, petState, rollAngle, rollsOver, type RemotePet } from './petting';
import { PetHearts } from './petHearts';
import { drawnRemotes } from '../../net/netStore';
import { view } from '../../state/live';
import { useViewStore } from '../../stores/viewStore';

const ACTIVE_M = 95;
const MAX_CHICKEN = 48;
const MAX_DOG = 12;
const MAX_CAT = 24;

const col = (list: number[][]) => list.map((c) => new THREE.Color(c[0], c[1], c[2]));
const CHICKEN_TINT = col([[1, 1, 1], [0.92, 0.76, 0.56], [0.72, 0.46, 0.3], [0.38, 0.32, 0.32], [0.85, 0.6, 0.35]]);
const DOG_TINT = col([[0.86, 0.66, 0.4], [0.3, 0.26, 0.26], [0.92, 0.9, 0.84], [0.52, 0.34, 0.2]]);
const CAT_TINT = col([[0.95, 0.6, 0.26], [0.52, 0.52, 0.56], [0.22, 0.22, 0.24], [0.95, 0.9, 0.78], [0.62, 0.46, 0.3]]);

type G = THREE.BufferGeometry;
/** A box with a baked colour (r, g, b): tinted per instance by the instance colour. */
function cbox(w: number, h: number, d: number, x: number, y: number, z: number, c: [number, number, number], rotZ = 0): G {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function merged(gs: G[]): G {
  const m = mergeGeometries(gs.map((x) => x.toNonIndexed()), false)!;
  gs.forEach((x) => x.dispose());
  m.deleteAttribute('uv');
  return m;
}
function mesh(geo: G, name: string, max: number): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, vertexColors: true }), max);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  m.count = 0;
  m.name = name;
  m.castShadow = false;
  m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}

const W: [number, number, number] = [1, 1, 1];
const chickenGeo = () =>
  merged([
    cbox(0.3, 0.2, 0.18, 0, 0.27, 0, W),
    cbox(0.1, 0.2, 0.07, -0.18, 0.36, 0, [0.85, 0.85, 0.85], 0.45),
    cbox(0.1, 0.12, 0.09, 0.17, 0.4, 0, W),
    cbox(0.06, 0.03, 0.04, 0.24, 0.385, 0, [1, 0.7, 0.2]),
    cbox(0.05, 0.05, 0.025, 0.17, 0.48, 0, [1, 0.2, 0.15]),
    cbox(0.02, 0.15, 0.02, 0.02, 0.075, 0.045, [0.9, 0.7, 0.3]),
    cbox(0.02, 0.15, 0.02, 0.02, 0.075, -0.045, [0.9, 0.7, 0.3]),
  ]);
/** Neck pivot (the head turns about it) and tail root (the tail wags about it), in the dog's frame. */
const NECK: [number, number] = [0.28, 0.6];
const TAIL_ROOT: [number, number] = [-0.36, 0.62];
const dogBodyGeo = () => merged([cbox(0.6, 0.26, 0.24, 0, 0.5, 0, W)]);
const dogHeadGeo = () =>
  merged([
    cbox(0.22, 0.2, 0.18, 0.38 - NECK[0], 0.64 - NECK[1], 0, W),
    cbox(0.14, 0.1, 0.11, 0.52 - NECK[0], 0.6 - NECK[1], 0, [0.75, 0.7, 0.66]),
    cbox(0.04, 0.05, 0.06, 0.6 - NECK[0], 0.62 - NECK[1], 0, [0.15, 0.12, 0.12]),
    cbox(0.06, 0.12, 0.04, 0.34 - NECK[0], 0.78 - NECK[1], 0.08, [0.7, 0.66, 0.62]),
    cbox(0.06, 0.12, 0.04, 0.34 - NECK[0], 0.78 - NECK[1], -0.08, [0.7, 0.66, 0.62]),
  ]);
const dogTailGeo = () => merged([cbox(0.3, 0.06, 0.07, -0.43 - TAIL_ROOT[0], 0.66 - TAIL_ROOT[1], 0, [0.9, 0.86, 0.8], 0.65)]);
const dogLegGeo = () => merged([cbox(0.075, 0.34, 0.075, 0, -0.17, 0, [0.82, 0.78, 0.74])]);
const catGeo = () =>
  merged([
    cbox(0.2, 0.28, 0.18, 0, 0.15, 0, W),
    cbox(0.14, 0.13, 0.13, 0.06, 0.35, 0, W),
    cbox(0.04, 0.06, 0.035, 0.07, 0.45, 0.05, [0.85, 0.8, 0.78]),
    cbox(0.04, 0.06, 0.035, 0.07, 0.45, -0.05, [0.85, 0.8, 0.78]),
    cbox(0.05, 0.05, 0.28, -0.1, 0.03, 0.15, [0.9, 0.85, 0.8]),
    cbox(0.02, 0.02, 0.02, 0.14, 0.355, 0.035, [0.2, 0.2, 0.2]),
    cbox(0.02, 0.02, 0.02, 0.14, 0.355, -0.035, [0.2, 0.2, 0.2]),
  ]);

interface Animal {
  spec: AnimalSpec;
  si: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  tx: number;
  tz: number;
  moving: boolean;
  until: number;
  ph: number;
  peckT: number;
  rng: number;
  follow: number;
  cooldown: number;
  hx: number;
  hz: number;
  tint: THREE.Color;
  yAt: number;
  /** Index in the settlement's plan (the wire key's low byte) and name ('' chickens). */
  idx: number;
  name: string;
  /** Petting (CR 054): from another player (Event 1970), joy and sit blend 0..1, the roll angle, wag and head clocks. */
  remote: RemotePet | null;
  petStart: number;
  petPlan: boolean;
  wasPet: boolean;
  joy: number;
  sit: number;
  roll: number;
  wag: number;
  heartAt: number;
  /** Where the petter stands (the head turns toward it). */
  lookX: number;
  lookZ: number;
}

interface Settle {
  animals: Animal[];
  streets: number[]; // x, z pairs
}

const rand = (a: Animal): number => {
  a.rng = (Math.imul(a.rng, 1664525) + 1013904223) >>> 0;
  return a.rng / 4294967296;
};

export class TownAnimals {
  readonly group = new THREE.Group();
  private readonly chickens = mesh(chickenGeo(), 'animals-chickens', MAX_CHICKEN);
  private readonly dogs = mesh(dogBodyGeo(), 'animals-dogs', MAX_DOG);
  private readonly dogLegs = mesh(dogLegGeo(), 'animals-dog-legs', MAX_DOG * 4);
  private readonly dogHeads = mesh(dogHeadGeo(), 'animals-dog-heads', MAX_DOG);
  private readonly dogTails = mesh(dogTailGeo(), 'animals-dog-tails', MAX_DOG);
  private readonly hearts = new PetHearts();
  private readonly bm = new THREE.Matrix4();
  private readonly hm = new THREE.Matrix4();
  private readonly lm = new THREE.Matrix4();
  private readonly tmp = new THREE.Matrix4();
  private readonly tmp2 = new THREE.Matrix4();
  private readonly v3 = new THREE.Vector3();
  private readonly cats = mesh(catGeo(), 'animals-cats', MAX_CAT);
  private readonly settles = new Map<number, Settle>();
  private readonly m = new THREE.Matrix4();
  private readonly r = new THREE.Matrix4();
  private readonly t = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private lowSeen = false;
  /** Debug: animals drawn last frame by kind. */
  readonly stats = { chickens: 0, dogs: 0, cats: 0 };

  constructor(
    private readonly towns: Towns,
    private readonly ground: GroundQuery & { floorAt?: (x: number, y: number, z: number) => number },
    private readonly isDwarf: (settlement: number) => boolean,
  ) {
    this.group.name = 'town-animals';
    this.group.add(this.chickens, this.dogs, this.dogLegs, this.dogHeads, this.dogTails, this.cats, this.hearts.object);
  }

  private plan(si: number, low: boolean): Settle {
    const st = this.towns.settlements[si];
    const farms: { x: number; z: number }[] = [];
    for (let i = st.npcFirst; i < st.npcFirst + st.npcCount; i++) {
      const n = this.towns.npcs[i];
      if (n.role === 5) farms.push({ x: n.workX, z: n.workZ });
    }
    const doors: { x: number; z: number }[] = [];
    for (let b = st.buildingFirst; b < st.buildingFirst + st.buildingCount; b++) {
      const bd = this.towns.buildings[b];
      if (bd.floors === 0) continue;
      const out = bd.hz + STEP_OUT_M - 0.4;
      // A step to the side of the door, so the cat is not in the way.
      const u = bd.doorU + bd.doorW * 0.5 + 0.9;
      doors.push({ x: bd.x + u * bd.c + out * bd.s, z: bd.z + u * bd.s - out * bd.c });
    }
    const streets: number[] = [];
    for (let r = st.roadFirst; r < st.roadFirst + st.roadCount; r++) {
      const rd = this.towns.roads[r];
      if (rd.cls !== 1) continue;
      for (let k = 0; k + 2 < rd.points.length; k += 3 * 2) streets.push(rd.points[k], rd.points[k + 2]);
    }
    const sid = Number(st.id & 0xffffffffn);
    const plan = planAnimals({ id: sid, size: st.size, x: st.x, z: st.z, farms, doors }, low);
    const names = nameAll(plan.map((p) => p.kind), sid);
    const ords = kindOrdinals(plan.map((p) => p.kind));
    const animals = plan.map((spec, pi): Animal => {
      const idx = (spec.kind << 6) | ords[pi]; // the wire key's low byte: stable on every quality tier
      const tint = (spec.kind === ANIMAL.chicken ? CHICKEN_TINT : spec.kind === ANIMAL.dog ? DOG_TINT : CAT_TINT)[spec.seed % (spec.kind === ANIMAL.chicken ? 5 : spec.kind === ANIMAL.dog ? 4 : 5)];
      const home = spec.kind === ANIMAL.chicken ? farms[spec.home] : { x: spec.x, z: spec.z };
      return { spec, si, x: spec.x, y: 0, z: spec.z, yaw: (spec.seed % 628) / 100, tx: spec.x, tz: spec.z, moving: false, until: 0, ph: (spec.seed % 100) / 10, peckT: (spec.seed % 50) / 10, rng: spec.seed || 1, follow: 0, cooldown: 0, hx: home.x, hz: home.z, tint, yAt: -1e9, idx, name: names[pi], remote: null, petStart: 0, petPlan: false, wasPet: false, joy: 0, sit: 0, roll: 0, wag: (spec.seed % 100) / 7, heartAt: 0, lookX: 0, lookZ: 0 };
    });
    return { animals, streets };
  }

  /** The dog, in whatever it is doing: trotting, standing, sitting, leaning in with a tilted head and a wagging tail, or rolled onto its back. */
  private drawDog(a: Animal, i: number, nowMs: number): void {
    const { q, p, s, up, bm, hm, lm, tmp, tmp2 } = this;
    const SIT = 0.75;
    const sit = a.sit * (1 - a.roll / Math.PI);
    const bob = a.moving ? Math.abs(Math.sin(a.ph)) * 0.035 : 0;
    q.setFromAxisAngle(up, -a.yaw);
    bm.compose(p.set(a.x, a.y + bob, a.z), q, s.set(1, 1, 1));
    if (sit > 0.001) {
      // Tip about the rump's bottom edge (the haunches settle) and sink onto the ground.
      bm.multiply(tmp.makeTranslation(0, -0.31 * sit, 0)).multiply(tmp.makeTranslation(-0.3, 0.37, 0)).multiply(tmp2.makeRotationZ(SIT * sit)).multiply(tmp.makeTranslation(0.3, -0.37, 0));
    }
    if (a.roll > 0.001) bm.multiply(tmp.makeTranslation(0, 0.4, 0)).multiply(tmp2.makeRotationX(a.roll)).multiply(tmp.makeTranslation(0, -0.4, 0));
    this.dogs.setMatrixAt(i, bm);
    this.dogs.setColorAt(i, a.tint);
    // Head: turns about the neck; tilts and nods up into the hand when happy.
    const tilt = a.joy * (0.34 + 0.07 * Math.sin(nowMs / 520 + a.spec.seed));
    const nod = a.moving ? 0.05 * Math.sin(a.ph * 2) : a.joy * (0.12 + 0.05 * Math.sin(nowMs / 260)) + sit * 0.08;
    // Turn toward whoever is petting it (in the dog's own frame: its heading is a.yaw).
    let turn = 0;
    if (a.joy > 0.05) {
      let d = Math.atan2(a.lookZ - a.z, a.lookX - a.x) - a.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      turn = Math.max(-1.1, Math.min(1.1, d)) * Math.min(1, a.joy * 1.4);
    }
    hm.copy(bm).multiply(tmp.makeTranslation(NECK[0], NECK[1], 0)).multiply(tmp2.makeRotationY(-turn)).multiply(tmp2.makeRotationX(tilt)).multiply(tmp.makeRotationZ(nod));
    this.dogHeads.setMatrixAt(i, hm);
    this.dogHeads.setColorAt(i, a.tint);
    // Tail: a lazy wag, a brisk one on the move, a fast wide one when petted.
    const amp = (a.moving ? 0.35 : 0.2) + 0.55 * a.joy;
    lm.copy(bm).multiply(tmp.makeTranslation(TAIL_ROOT[0], TAIL_ROOT[1], 0)).multiply(tmp2.makeRotationY(Math.sin(a.wag) * amp)).multiply(tmp.makeRotationZ(0.35 * a.joy));
    this.dogTails.setMatrixAt(i, lm);
    this.dogTails.setColorAt(i, a.tint);
    const flat = a.roll / Math.PI;
    for (let leg = 0; leg < 4; leg++) {
      const front = leg < 2;
      let ang = (a.moving ? trotLeg(a.ph, leg) : 0) * (1 - sit);
      ang += front ? -SIT * sit : 0.65 * sit;
      if (flat > 0.01) ang += Math.sin(nowMs / 110 + leg * 1.7) * 0.55 * flat;
      lm.copy(bm).multiply(tmp.makeTranslation(front ? 0.22 : -0.22, 0.38, leg % 2 === 0 ? 0.08 : -0.08)).multiply(tmp2.makeRotationZ(ang));
      this.dogLegs.setMatrixAt(i * 4 + leg, lm);
      this.dogLegs.setColorAt(i * 4 + leg, a.tint);
    }
    this.publish(a, hm, 0.1, 0.18, bm, -0.12, 0.68);
    this.maybeHeart(a, nowMs, hm, 0.12, 0.26);
  }

  /** The head-top and rump anchors (world) of the animal the local player is petting; the camera and hand follow them. */
  private publish(a: Animal, headM: THREE.Matrix4, hx: number, hy: number, backM: THREE.Matrix4, bx: number, by: number): void {
    if (!petState.active || petState.key !== animalKey(a.si, a.idx)) return;
    const v = this.v3;
    v.set(hx, hy, 0).applyMatrix4(headM);
    petState.head.x = v.x;
    petState.head.y = v.y;
    petState.head.z = v.z;
    v.set(bx, by, 0).applyMatrix4(backM);
    petState.back.x = v.x;
    petState.back.y = v.y;
    petState.back.z = v.z;
    petState.centre.x = a.x;
    petState.centre.y = a.y;
    petState.centre.z = a.z;
  }

  /** A heart now and then from a happy animal's head (headM * (x, y, 0)). */
  private maybeHeart(a: Animal, nowMs: number, headM: THREE.Matrix4, x: number, y: number): void {
    if (a.joy < 0.45 || nowMs < a.heartAt) return;
    a.heartAt = nowMs + 260 + (a.spec.seed % 90);
    const v = this.v3.set(x, y, 0).applyMatrix4(headM);
    this.hearts.spawn(v.x, v.y, v.z, ((a.spec.seed >> 3) % 7) / 3 - 1);
  }

  /** The animals within `reach` m (horizontal) of (x, z) that can be petted now: dogs and cats that are not running off. */
  pettables(x: number, z: number, reach = PET_REACH_M): { key: number; kind: number; name: string; x: number; y: number; z: number; settlement: number; seed: number }[] {
    const out: { key: number; kind: number; name: string; x: number; y: number; z: number; settlement: number; seed: number }[] = [];
    for (const [si, S] of this.settles) {
      for (const a of S.animals) {
        if (a.spec.kind === ANIMAL.chicken) continue;
        if (Math.abs(a.x - x) > reach || Math.abs(a.z - z) > reach || Math.hypot(a.x - x, a.z - z) > reach) continue;
        if (a.spec.kind === ANIMAL.cat && a.moving && a.sit < 0.5 && a.joy < 0.1) continue; // a cat streaking away
        out.push({ key: animalKey(si, a.idx), kind: a.spec.kind, name: a.name, x: a.x, y: a.y + (a.spec.kind === ANIMAL.dog ? 0.45 : 0.25), z: a.z, settlement: si, seed: a.spec.seed });
      }
    }
    return out;
  }

  /** Every dog and cat of the active settlements (owners' barks). */
  named(): { key: number; kind: number; name: string; x: number; z: number; seed: number; si: number; idx: number }[] {
    const out: { key: number; kind: number; name: string; x: number; z: number; seed: number; si: number; idx: number }[] = [];
    for (const [si, S] of this.settles) for (const a of S.animals) if (a.name) out.push({ key: animalKey(si, a.idx), kind: a.spec.kind, name: a.name, x: a.x, z: a.z, seed: a.spec.seed, si, idx: a.idx });
    return out;
  }

  /** Another player started (`on`) or stopped petting animal `key`: this client's copy goes to them, or lets go. */
  remotePet(key: number, entityId: number, on: boolean, x: number, z: number, nowMs: number): void {
    const si = key >>> 8;
    const S = this.settles.get(si);
    const a = S?.animals.find((an) => animalKey(an.si, an.idx) === key);
    if (!a) return; // not planned here (this client has not met that town yet): nothing to move
    if (on) a.remote = { entityId, from: nowMs, until: nowMs + PET_DUR_S * 1000, x, z };
    else if (a.remote && a.remote.entityId === entityId) a.remote.until = nowMs;
  }

  /** The name of the animal a look ray points at within `maxM` (for the nameplate), with a point above its head. */
  lookedAt(eye: THREE.Vector3, fwd: THREE.Vector3, maxM = 8): { name: string; kind: number; x: number; y: number; z: number; d: number } | null {
    let best: { name: string; kind: number; x: number; y: number; z: number; d: number } | null = null;
    let bestScore = 0.93;
    for (const S of this.settles.values()) {
      for (const a of S.animals) {
        if (a.spec.kind === ANIMAL.chicken || !a.name) continue;
        const hy = a.y + (a.spec.kind === ANIMAL.dog ? 0.55 + 0.25 * a.sit : 0.3);
        const dx = a.x - eye.x;
        const dy = hy - eye.y;
        const dz = a.z - eye.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > maxM || d < 0.3) continue;
        const cos = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d;
        if (cos < bestScore) continue;
        bestScore = cos;
        best = { name: a.name, kind: a.spec.kind, x: a.x, y: hy + (a.spec.kind === ANIMAL.dog ? 0.42 : 0.3), z: a.z, d };
      }
    }
    return best;
  }

  private groundY(x: number, z: number): number {
    const g = this.ground.heightAt(x, z);
    return this.ground.floorAt ? this.ground.floorAt(x, g + 2, z) : g;
  }

  /** Per frame. `hour` 0-24, `rain` 0..1, `player` the local player's feet and velocity. */
  update(camera: THREE.Camera, dt: number, nowMs: number, hour: number, rain: number, low: boolean, player: { x: number; y: number; z: number; vx: number; vz: number; yaw: number }): void {
    const cam = camera.position;
    if (low !== this.lowSeen) {
      this.settles.clear(); // the tier changed: plan again with the other counts
      this.lowSeen = low;
    }
    const night = hour < 6 || hour >= 19;
    const wet = rain > 0.5;
    let nc = 0;
    let nd = 0;
    let nk = 0;
    const { m, r, t, q, p, s, up } = this;
    for (const st of this.towns.settlements) {
      if (Math.hypot(st.x - cam.x, st.z - cam.z) - st.radius > ACTIVE_M) continue;
      if (this.isDwarf(st.index) || st.y > this.ground.heightAt(st.x, st.z) + 60) continue; // underground and sky towns: none
      let S = this.settles.get(st.index);
      if (!S) {
        S = this.plan(st.index, low);
        this.settles.set(st.index, S);
      }
      for (const a of S.animals) {
        const dc = Math.hypot(a.x - cam.x, a.z - cam.z);
        if (dc > ACTIVE_M + 30) continue;
        this.step(a, S, dt, nowMs, player, dc);
        if (nowMs - a.yAt > 250 || dc < 25) {
          a.y = this.groundY(a.x, a.z);
          a.yAt = nowMs;
        }
        const k = a.spec.kind;
        if (k === ANIMAL.chicken) {
          if (night || wet || nc >= MAX_CHICKEN) continue;
          // Peck: tip forward about the hips.
          const pitch = a.moving ? 0 : peckPitch(a.peckT, 3.2 + (a.spec.seed % 10) / 10);
          const bob = a.moving ? Math.abs(Math.sin(a.ph * 2)) * 0.03 : 0;
          q.setFromAxisAngle(up, -a.yaw);
          m.compose(p.set(a.x, a.y + bob, a.z), q, s.set(0.9, 0.9, 0.9));
          m.multiply(t.makeTranslation(0, 0.2, 0)).multiply(r.makeRotationZ(pitch)).multiply(t.makeTranslation(0, -0.2, 0));
          this.chickens.setMatrixAt(nc, m);
          this.chickens.setColorAt(nc++, a.tint);
        } else if (k === ANIMAL.dog) {
          if (nd >= MAX_DOG) continue;
          this.drawDog(a, nd, nowMs);
          nd++;
        } else {
          if (wet || nk >= MAX_CAT) continue;
          // Sitting cats breathe; a fleeing cat is a low streak; a petted cat arches its back into the hand, purring.
          const breathe = 1 + Math.sin(nowMs / 700 + a.spec.seed) * 0.015;
          const purr = a.joy > 0.2 ? Math.sin(nowMs / 28) * 0.006 * a.joy : 0;
          q.setFromAxisAngle(up, -a.yaw);
          const arch = a.joy;
          m.compose(p.set(a.x, a.y, a.z), q, a.moving ? s.set(1.25, 0.65, 1) : s.set(1 - 0.14 * arch, breathe + 0.2 * arch + purr, 1 + 0.06 * arch));
          if (arch > 0.01) {
            // Lean into the hand: tip the shoulders toward it about the hips.
            m.multiply(t.makeTranslation(-0.05, 0.05, 0)).multiply(r.makeRotationZ(0.16 * arch)).multiply(t.makeTranslation(0.05, -0.05, 0));
            this.publish(a, m, 0.07, 0.42, m, -0.06, 0.3);
            this.maybeHeart(a, nowMs, m, 0.07, 0.46);
          }
          this.cats.setMatrixAt(nk, m);
          this.cats.setColorAt(nk++, a.tint);
        }
      }
    }
    this.finish(this.chickens, nc);
    this.finish(this.dogs, nd);
    this.finish(this.dogLegs, nd * 4);
    this.finish(this.dogHeads, nd);
    this.finish(this.dogTails, nd);
    this.hearts.update(dt);
    this.finish(this.cats, nk);
    this.stats.chickens = nc;
    this.stats.dogs = nd;
    this.stats.cats = nk;
  }

  private readonly r2 = new THREE.Matrix4();

  private finish(mesh: THREE.InstancedMesh, n: number): void {
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** One animal's behaviour: chickens peck and shuffle about their farm, dogs trot between street points (and tag along), cats sit and slip away from close visitors. */
  private step(a: Animal, S: Settle, dt: number, nowMs: number, pl: { x: number; z: number; vx: number; vz: number; yaw: number }, dc: number): void {
    const kind = a.spec.kind;
    const toP = Math.hypot(a.x - pl.x, a.z - pl.z);
    let speed = 0;
    const pet = kind === ANIMAL.chicken ? null : this.petOf(a, nowMs, pl);
    this.petMood(a, pet, dt, nowMs);
    if (pet) {
      // Being petted: walk to a spot in front of the petter, turn side-on and stay (a dog sits, a cat arches).
      a.follow = 0;
      // In third person the camera hangs behind your shoulder: stand it a little to the other side so the body does not hide it.
      const side = !pet.remote && view.third ? -useViewStore.getState().shoulder * 0.65 : 0;
      const gx = pet.px + pet.fx * PET_STAND_M + pet.fz * side;
      const gz = pet.pz + pet.fz * PET_STAND_M - pet.fx * side;
      const dg = Math.hypot(gx - a.x, gz - a.z);
      if (pet.remote && dg > 14) {
        a.x = gx;
        a.z = gz;
      }
      a.tx = gx;
      a.tz = gz;
      a.moving = a.moving ? dg > 0.15 : dg > 0.3;
      if (a.moving) speed = kind === ANIMAL.cat ? 3 : 2.4;
      else {
        // Stand side-on to the petter, head to their left (so the strokes sweep across their view), the head turned toward them.
        let dy = Math.atan2(-pet.fx, pet.fz) - a.yaw; // heading of the petter's left: (fz, -fx)
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        a.yaw += dy * Math.min(1, dt * 6);
      }
      a.lookX = pet.px;
      a.lookZ = pet.pz;
    } else if (kind === ANIMAL.chicken) {
      a.peckT += dt;
      if (a.moving) speed = 1.0;
      else if (nowMs > a.until) {
        const ang = rand(a) * Math.PI * 2;
        const rr = rand(a) * 4;
        a.tx = a.hx + Math.cos(ang) * rr;
        a.tz = a.hz + Math.sin(ang) * rr;
        a.moving = true;
      }
      if (toP < 2.2 && !a.moving) {
        // Startled: scoot away a few metres.
        const away = Math.atan2(a.z - pl.z, a.x - pl.x);
        a.tx = a.x + Math.cos(away) * 2.5;
        a.tz = a.z + Math.sin(away) * 2.5;
        a.moving = true;
      }
      if (toP < 2.2) speed = 2.2;
    } else if (kind === ANIMAL.dog) {
      const pSpeed = Math.hypot(pl.vx, pl.vz);
      if (a.spec.follower && a.follow === 0 && nowMs > a.cooldown && toP < 9 && toP > 3 && pSpeed > 0.8) {
        a.follow = nowMs + 9000 + rand(a) * 5000;
      }
      if (a.follow > 0) {
        if (nowMs > a.follow || toP > 28) {
          a.follow = 0;
          a.cooldown = nowMs + 70_000;
          a.moving = false;
          a.until = nowMs + 2000;
        } else {
          const g = followGoal(a.x, a.z, pl.x, pl.z, 2.6);
          a.tx = g.x;
          a.tz = g.z;
          a.moving = !g.arrived;
          if (a.moving) speed = Math.min(3.4, 1.2 + toP * 0.6);
        }
      } else if (a.moving) speed = 2.3;
      else if (nowMs > a.until) {
        // A street point 8-30 m away (or a spot about the square when the town has none).
        let bx = a.hx;
        let bz = a.hz;
        let found = false;
        const n = S.streets.length / 2;
        for (let tries = 0; tries < 8 && n > 0 && !found; tries++) {
          const k = Math.floor(rand(a) * n);
          const d = Math.hypot(S.streets[k * 2] - a.x, S.streets[k * 2 + 1] - a.z);
          if (d > 8 && d < 30) {
            bx = S.streets[k * 2];
            bz = S.streets[k * 2 + 1];
            found = true;
          }
        }
        if (!found) {
          const ang = rand(a) * Math.PI * 2;
          bx = a.hx + Math.cos(ang) * 9;
          bz = a.hz + Math.sin(ang) * 9;
        }
        a.tx = bx;
        a.tz = bz;
        a.moving = true;
      }
    } else {
      // Cats: sit; a close visitor sends them trotting 6 m off, where they sit again.
      if (!a.moving && ((toP < 2.4 && Math.hypot(pl.vx, pl.vz) > 2.2) || toP < 0.9)) {
        const away = Math.atan2(a.z - pl.z, a.x - pl.x) + (rand(a) - 0.5);
        a.tx = a.x + Math.cos(away) * 6;
        a.tz = a.z + Math.sin(away) * 6;
        a.moving = true;
      }
      if (a.moving) speed = 3.6;
    }
    if (a.moving && speed > 0) {
      const dx = a.tx - a.x;
      const dz = a.tz - a.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) {
        a.moving = false;
        a.until = nowMs + (kind === ANIMAL.chicken ? 2500 + rand(a) * 5000 : kind === ANIMAL.dog ? 3000 + rand(a) * 8000 : 0);
      } else {
        const stepLen = Math.min(d, speed * dt);
        a.x += (dx / d) * stepLen;
        a.z += (dz / d) * stepLen;
        // Turn toward travel (short way round, quickly).
        let dy = Math.atan2(dz, dx) - a.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        a.yaw += dy * Math.min(1, dt * 8);
        a.ph += dt * speed * (kind === ANIMAL.dog ? 4.4 : 5);
      }
    } else if (a.moving) a.moving = false;
    void dc;
  }

  /** The petting this animal is in, from you (petState) or another player (Event 1970): seconds in, where the petter stands, which way they face. */
  private petOf(a: Animal, nowMs: number, pl: { x: number; z: number; yaw: number }): { t: number; px: number; pz: number; fx: number; fz: number; remote: boolean } | null {
    if (petState.active && petState.key === animalKey(a.si, a.idx)) {
      const f = forwardOfYaw(pl.yaw);
      if (!a.wasPet) {
        a.petStart = petState.startedAt;
        a.petPlan = rollsOver(a.spec.seed, a.petStart, a.spec.kind);
      }
      return { t: petState.t, px: pl.x, pz: pl.z, fx: f.x, fz: f.z, remote: false };
    }
    const r = a.remote;
    if (!r) return null;
    if (nowMs >= r.until) {
      a.remote = null;
      return null;
    }
    const v = drawnRemotes.views.find((x) => x.id === r.entityId);
    const px = v ? v.x : r.x;
    const pz = v ? v.z : r.z;
    const f = v ? forwardOfYaw(v.yaw) : { x: Math.cos(a.yaw + Math.PI), z: Math.sin(a.yaw + Math.PI) };
    if (!a.wasPet) {
      a.petStart = r.from;
      a.petPlan = rollsOver(a.spec.seed, r.from, a.spec.kind);
    }
    return { t: (nowMs - r.from) / 1000, px, pz, fx: f.x, fz: f.z, remote: true };
  }

  /** Contentment, sitting, the roll and the wag clock, eased toward what the petting asks. */
  private petMood(a: Animal, pet: { t: number } | null, dt: number, nowMs: number): void {
    const dog = a.spec.kind === ANIMAL.dog;
    let joyT = 0;
    if (pet) {
      joyT = petBeat(pet.t).joy;
      a.wasPet = true;
      a.roll = a.petPlan ? rollAngle(pet.t) : 0;
    } else {
      if (a.wasPet) {
        a.wasPet = false;
        a.until = nowMs + 1800; // sit a moment longer, then wander on
      }
      a.roll += (0 - a.roll) * Math.min(1, dt * 6);
    }
    const settled = pet ? !a.moving : a.joy > 0.12;
    a.joy += (joyT - a.joy) * Math.min(1, dt * 5);
    a.sit += ((dog && settled ? 1 : 0) - a.sit) * Math.min(1, dt * 4);
    a.wag += dt * (a.moving ? 9 : 4 + 11 * a.joy);
  }

  dispose(): void {
    this.hearts.dispose();
    this.group.traverse((o) => {
      const mm = o as THREE.InstancedMesh;
      if (mm.isInstancedMesh) {
        mm.geometry.dispose();
        (mm.material as THREE.Material).dispose();
        mm.dispose();
      }
    });
  }
}
