// Town animals (playtest 4, CR 050): chickens pecking about the farms, a dog
// or two trotting the streets (one follows a passer-by a few steps), cats
// on the doorsteps. Client-side ambience: which animals a settlement has is
// planned from its id (animalsPlan.ts: every client agrees, nothing on the
// wire), they are simulated only while the settlement is near the camera,
// and they cost four instanced draws in all (chickens, dog bodies, dog
// legs, cats), halved in number on the Low tier. Original blocky models in
// the townsfolk's style, tinted per animal. Chickens roost at night and in
// the rain, cats shelter in the rain.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Towns } from '@lodestone/worldgen';
import type { GroundQuery } from '../../sim/ground';
import { ANIMAL, followGoal, peckPitch, planAnimals, trotLeg, type AnimalSpec } from './animalsPlan';
import { STEP_OUT_M } from './npcLife';

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
const dogBodyGeo = () =>
  merged([
    cbox(0.6, 0.26, 0.24, 0, 0.5, 0, W),
    cbox(0.22, 0.2, 0.18, 0.38, 0.64, 0, W),
    cbox(0.14, 0.1, 0.11, 0.52, 0.6, 0, [0.75, 0.7, 0.66]),
    cbox(0.04, 0.05, 0.06, 0.6, 0.62, 0, [0.15, 0.12, 0.12]),
    cbox(0.06, 0.12, 0.04, 0.34, 0.78, 0.08, [0.7, 0.66, 0.62]),
    cbox(0.06, 0.12, 0.04, 0.34, 0.78, -0.08, [0.7, 0.66, 0.62]),
    cbox(0.3, 0.06, 0.07, -0.43, 0.66, 0, [0.9, 0.86, 0.8], 0.65),
  ]);
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
    this.group.add(this.chickens, this.dogs, this.dogLegs, this.cats);
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
    const animals = planAnimals({ id: Number(st.id & 0xffffffffn), size: st.size, x: st.x, z: st.z, farms, doors }, low).map((spec): Animal => {
      const tint = (spec.kind === ANIMAL.chicken ? CHICKEN_TINT : spec.kind === ANIMAL.dog ? DOG_TINT : CAT_TINT)[spec.seed % (spec.kind === ANIMAL.chicken ? 5 : spec.kind === ANIMAL.dog ? 4 : 5)];
      const home = spec.kind === ANIMAL.chicken ? farms[spec.home] : { x: spec.x, z: spec.z };
      return { spec, si, x: spec.x, y: 0, z: spec.z, yaw: (spec.seed % 628) / 100, tx: spec.x, tz: spec.z, moving: false, until: 0, ph: (spec.seed % 100) / 10, peckT: (spec.seed % 50) / 10, rng: spec.seed || 1, follow: 0, cooldown: 0, hx: home.x, hz: home.z, tint, yAt: -1e9 };
    });
    return { animals, streets };
  }

  private groundY(x: number, z: number): number {
    const g = this.ground.heightAt(x, z);
    return this.ground.floorAt ? this.ground.floorAt(x, g + 2, z) : g;
  }

  /** Per frame. `hour` 0-24, `rain` 0..1, `player` the local player's feet and velocity. */
  update(camera: THREE.Camera, dt: number, nowMs: number, hour: number, rain: number, low: boolean, player: { x: number; y: number; z: number; vx: number; vz: number }): void {
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
          const bob = a.moving ? Math.abs(Math.sin(a.ph)) * 0.035 : 0;
          q.setFromAxisAngle(up, -a.yaw);
          m.compose(p.set(a.x, a.y + bob, a.z), q, s.set(1, 1, 1));
          this.dogs.setMatrixAt(nd, m);
          this.dogs.setColorAt(nd, a.tint);
          for (let leg = 0; leg < 4; leg++) {
            const ang = a.moving ? trotLeg(a.ph, leg) : 0;
            const lm = this.dogLegs;
            const x = leg < 2 ? 0.22 : -0.22;
            const z = leg % 2 === 0 ? 0.08 : -0.08;
            r.copy(m).multiply(t.makeTranslation(x, 0.38, z)).multiply(this.r2.makeRotationZ(ang));
            lm.setMatrixAt(nd * 4 + leg, r);
            lm.setColorAt(nd * 4 + leg, a.tint);
          }
          nd++;
        } else {
          if (wet || nk >= MAX_CAT) continue;
          // Sitting cats breathe; a fleeing cat is a low streak.
          const breathe = 1 + Math.sin(nowMs / 700 + a.spec.seed) * 0.015;
          q.setFromAxisAngle(up, -a.yaw);
          m.compose(p.set(a.x, a.y, a.z), q, a.moving ? s.set(1.25, 0.65, 1) : s.set(1, breathe, 1));
          this.cats.setMatrixAt(nk, m);
          this.cats.setColorAt(nk++, a.tint);
        }
      }
    }
    this.finish(this.chickens, nc);
    this.finish(this.dogs, nd);
    this.finish(this.dogLegs, nd * 4);
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
  private step(a: Animal, S: Settle, dt: number, nowMs: number, pl: { x: number; z: number; vx: number; vz: number }, dc: number): void {
    const kind = a.spec.kind;
    const toP = Math.hypot(a.x - pl.x, a.z - pl.z);
    let speed = 0;
    if (kind === ANIMAL.chicken) {
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
      if (toP < 2.4 && !a.moving) {
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

  dispose(): void {
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
