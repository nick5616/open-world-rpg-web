// Rift runs (CR 040), playtest 6 polish: the arena you can see. The zone
// and the movement ground already had the room (layout.ts) and every shot
// (patterns.ts), but nothing drew them: a run was a beige floorless sky with
// two foes in it and invisible bullets. This layer draws, from riftRuntime:
//
//   - the void around the room (a dark starfield sphere that hides the sky
//     and the world 1.8 km below), the floor with its tile grid and the
//     chapter's colour, a slab under it, energy walls on the four sides;
//   - the room's pillars, pools and spike strips (lowered, glowing as a
//     warning, raised), the door in the north wall (sealed until the room is
//     clear) and, at a checkpoint, the way out beside it;
//   - every shot on the bullet clock (clock.ts): orbs (rings, spirals, fans,
//     walls, bouncers, seekers), lasers (a thin aim line, then the beam),
//     falling rain (a ring that fills, then a flash), and a telegraph where a
//     volley is about to leave; shots fade when the room is clear.
//
// Unlit materials (a realm of its own, the same at noon and at midnight),
// a few instanced meshes and small pools: a handful of draw calls. Mounted
// inside the world canvas by NetPlay; it only shows while you are in a run.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { localPlayer } from '../state/live';
import { drawnRemotes } from '../net/netStore';
import { bulletClock, TICKS_PER_S } from './clock';
import { BULLET_Y, DOOR_Z, EXIT_X, HALF_X, HALF_Z, PILLAR, POOL, SPIKES, spikesUp, type Obstacle } from './layout';
import { clockInput } from './link';
import { bulletPos, bullets, ends, KIND_LASER, KIND_RAIN, KIND_SEEKER, laserAt, rainAt, seekerStep, TICK_HZ } from './patterns';
import { pruneVolleys, riftRuntime, useRift, type Arena, type LiveVolley } from './store';

const WALL_H = 3.2;
const MAX_ORBS = 1200;
const MAX_TELL = 24;
const MAX_LASERS = 12;
const MAX_RAIN = 64;
const MAX_SPIKES = 2;
const SPIKE_COLS = 22;
const SPIKE_ROWS = 3;
const DOOR_W = 3;
const DOOR_H = 3.4;
/** How long before a rain drop lands its ring shows (s). */
const RAIN_WARN_S = 1.1;

const v3 = new THREE.Vector3();
const q = new THREE.Quaternion();
const m4 = new THREE.Matrix4();
const scl = new THREE.Vector3(1, 1, 1);
const col = new THREE.Color();

// ---- materials ----

const VOID_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const VOID_FRAG = `
uniform vec3 uTint;
uniform float uTime;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  // deep below, a faint glow of the chapter at the horizon, black overhead
  float h = d.y;
  vec3 c = mix(vec3(0.012, 0.010, 0.02), uTint * 0.10, 1.0 - smoothstep(0.0, 0.55, abs(h + 0.05)));
  c += uTint * 0.05 * (1.0 - smoothstep(-0.9, 0.0, h));
  // stars: a hashed grid on the direction, a small soft point in each lit cell, twinkling slowly
  vec3 gp = d * 160.0;
  vec3 g = floor(gp);
  float s = hash(g);
  float pt = 1.0 - smoothstep(0.08, 0.2, length(fract(gp) - 0.5));
  float tw = 0.6 + 0.4 * sin(uTime * (0.6 + s * 2.0) + s * 40.0);
  c += vec3(0.9, 0.85, 1.0) * step(0.985, s) * pt * tw * smoothstep(-0.2, 0.3, h);
  // slow drifting embers of the chapter colour
  vec3 mp = d * 60.0 + vec3(0.0, uTime * 0.08, 0.0);
  float m = hash(floor(mp));
  float mpt = 1.0 - smoothstep(0.05, 0.16, length(fract(mp) - 0.5));
  c += uTint * step(0.992, m) * mpt * 0.8;
  gl_FragColor = vec4(c, 1.0);
}`;

const FLOOR_VERT = `
varying vec2 vXZ;
void main() {
  vXZ = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FLOOR_FRAG = `
uniform vec3 uTint;
uniform vec2 uHalf;
uniform float uTime;
uniform float uClear;
varying vec2 vXZ;
float line(float x, float w) { float f = abs(fract(x) - 0.5); return smoothstep(0.5 - w, 0.5, f); }
void main() {
  vec2 p = vXZ;
  // stone tiles 2 m, faint seams, a brighter 4 m grid
  float seams = max(line(p.x * 0.5 + 0.5, 0.03), line(p.y * 0.5 + 0.5, 0.03));
  float grid = max(line(p.x * 0.25 + 0.5, 0.012), line(p.y * 0.25 + 0.5, 0.012));
  vec2 tile = floor(p * 0.5);
  float n = fract(sin(dot(tile, vec2(12.9898, 78.233))) * 43758.5453);
  vec3 c = vec3(0.07, 0.065, 0.085) * (0.85 + 0.3 * n);
  c = mix(c, vec3(0.025, 0.022, 0.035), seams * 0.7);
  c += uTint * grid * (0.16 + 0.06 * sin(uTime * 1.3));
  // the edges glow toward the walls
  vec2 e = uHalf - abs(p);
  float edge = 1.0 - smoothstep(0.0, 1.6, min(e.x, e.y));
  c += uTint * edge * 0.35;
  // the way to the door brightens once the room is clear
  float path = (1.0 - smoothstep(0.6, 1.4, abs(p.x))) * (1.0 - smoothstep(-uHalf.y, uHalf.y, p.y));
  c += uTint * path * uClear * (0.18 + 0.08 * sin(uTime * 3.0 - p.y));
  gl_FragColor = vec4(c, 1.0);
}`;

const WALL_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const WALL_FRAG = `
uniform vec3 uTint;
uniform float uTime;
uniform float uLen;
varying vec2 vUv;
void main() {
  float y = vUv.y;
  float fade = (1.0 - y) * (1.0 - y);
  float scan = 0.55 + 0.45 * sin(vUv.x * uLen * 2.0 - uTime * 2.0 + y * 9.0);
  float base = 1.0 - smoothstep(0.0, 0.08, y);
  float a = fade * (0.18 + 0.12 * scan) + base * 0.6;
  gl_FragColor = vec4(uTint * (0.8 + base), a);
}`;

const RING_FRAG = `
uniform vec3 uColor;
uniform float uFill;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float rim = smoothstep(0.86, 0.95, r) * (1.0 - smoothstep(0.97, 1.0, r));
  float fill = step(r, uFill) * 0.35;
  float a = (rim + fill) * uAlpha;
  gl_FragColor = vec4(uColor, a);
}`;

const POOL_FRAG = `
uniform vec3 uTint;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float w = 0.5 + 0.5 * sin(r * 18.0 - uTime * 2.2 + sin(atan(p.y, p.x + 1e-6) * 3.0 + uTime) * 0.6);
  vec3 c = mix(vec3(0.02, 0.02, 0.04), uTint * 0.45, w * 0.35 + smoothstep(0.75, 1.0, r) * 0.8);
  gl_FragColor = vec4(c, 1.0);
}`;

function unlit(frag: string, uniforms: Record<string, THREE.IUniform>, opts: Partial<THREE.ShaderMaterialParameters> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: WALL_VERT, fragmentShader: frag, uniforms, fog: false, toneMapped: false, ...opts });
}

// ---- the scene ----

interface Rig {
  root: THREE.Group;
  room: THREE.Group;
  tint: { value: THREE.Color };
  time: { value: number };
  clear: { value: number };
  orbs: THREE.InstancedMesh;
  halos: THREE.InstancedMesh;
  tells: THREE.Mesh[];
  lasers: THREE.Mesh[];
  rain: THREE.Mesh[];
  spikes: { mesh: THREE.InstancedMesh; plate: THREE.Mesh; o: Obstacle }[];
  door: { field: THREE.Mesh; mat: THREE.MeshBasicMaterial };
  exit: THREE.Group;
  built: number;
  dispose: () => void;
}

function buildRig(): Rig {
  const root = new THREE.Group();
  root.name = 'rift-arena';
  root.visible = false;
  const tint = { value: new THREE.Color('#ff8a3d') };
  const time = { value: 0 };
  const clear = { value: 0 };
  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T): T => (disposables.push(x), x);

  // The void: drawn after the sky dome, writing depth, so the world below is hidden.
  const voidMat = keep(new THREE.ShaderMaterial({ vertexShader: VOID_VERT, fragmentShader: VOID_FRAG, uniforms: { uTint: tint, uTime: time }, side: THREE.BackSide, fog: false, toneMapped: false }));
  const voidMesh = new THREE.Mesh(keep(new THREE.SphereGeometry(110, 40, 20)), voidMat);
  voidMesh.renderOrder = -5;
  voidMesh.frustumCulled = false;
  root.add(voidMesh);

  // Floor and the slab under it.
  const floorMat = keep(new THREE.ShaderMaterial({ vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, uniforms: { uTint: tint, uHalf: { value: new THREE.Vector2(HALF_X, HALF_Z) }, uTime: time, uClear: clear }, fog: false, toneMapped: false }));
  const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(HALF_X * 2, HALF_Z * 2, 1, 1)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.01;
  root.add(floor);
  const slabMat = keep(new THREE.MeshBasicMaterial({ color: '#0c0a12', fog: false }));
  const slab = new THREE.Mesh(keep(new THREE.CylinderGeometry(1, 0.55, 1, 4, 1)), slabMat);
  slab.rotation.y = Math.PI / 4;
  slab.scale.set(HALF_X * Math.SQRT2 * 1.04, 6, HALF_Z * Math.SQRT2 * 1.04);
  slab.position.y = -3.02;
  root.add(slab);

  // Energy walls (a strip each side; the north one leaves the door's gap).
  const wallGeo = keep(new THREE.PlaneGeometry(1, 1));
  wallGeo.translate(0, 0.5, 0);
  const walls: [number, number, number, number][] = [
    [0, HALF_Z, HALF_X * 2, 0], // south
    [-HALF_X, 0, HALF_Z * 2, Math.PI / 2], // west
    [HALF_X, 0, HALF_Z * 2, -Math.PI / 2], // east
    [-(HALF_X + DOOR_W / 2) / 2, -HALF_Z, HALF_X - DOOR_W / 2, Math.PI], // north, left of the door
    [(HALF_X + DOOR_W / 2) / 2, -HALF_Z, HALF_X - DOOR_W / 2, Math.PI], // north, right of the door
  ];
  for (const [x, z, len, ry] of walls) {
    const mat = keep(unlit(WALL_FRAG, { uTint: tint, uTime: time, uLen: { value: len } }, { transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    const w = new THREE.Mesh(wallGeo, mat);
    w.scale.set(len, WALL_H, 1);
    w.position.set(x, 0, z);
    w.rotation.y = ry;
    w.renderOrder = 6;
    root.add(w);
  }

  // The door: a dark stone frame, a field that is sealed (dim) or open (bright).
  const stoneMat = keep(new THREE.MeshLambertMaterial({ color: '#2a2633' }));
  const post = keep(new THREE.BoxGeometry(0.5, DOOR_H, 0.6));
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(post, stoneMat);
    p.position.set(sx * (DOOR_W / 2 + 0.25), DOOR_H / 2, -HALF_Z);
    root.add(p);
  }
  const lintel = new THREE.Mesh(keep(new THREE.BoxGeometry(DOOR_W + 1, 0.5, 0.6)), stoneMat);
  lintel.position.set(0, DOOR_H + 0.25, -HALF_Z);
  root.add(lintel);
  const doorMat = keep(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide, fog: false, blending: THREE.AdditiveBlending }));
  const field = new THREE.Mesh(keep(new THREE.PlaneGeometry(DOOR_W, DOOR_H)), doorMat);
  field.position.set(0, DOOR_H / 2, -HALF_Z);
  field.renderOrder = 7;
  root.add(field);

  // The way out at a checkpoint: a green ring standing beside the door.
  const exit = new THREE.Group();
  const exitMat = keep(new THREE.MeshBasicMaterial({ color: '#7dffb0', transparent: true, opacity: 0.85, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
  const exitRing = new THREE.Mesh(keep(new THREE.TorusGeometry(1.05, 0.08, 8, 40)), exitMat);
  exitRing.position.y = 1.3;
  exit.add(exitRing);
  const exitDisc = new THREE.Mesh(keep(new THREE.CircleGeometry(1.0, 32)), keep(new THREE.MeshBasicMaterial({ color: '#2fd47a', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, fog: false, blending: THREE.AdditiveBlending })));
  exitDisc.position.y = 1.3;
  exit.add(exitDisc);
  exit.position.set(EXIT_X, 0, DOOR_Z + 0.6);
  exit.visible = false;
  root.add(exit);

  // Obstacles live in their own group, rebuilt per room.
  const room = new THREE.Group();
  root.add(room);

  // Shots: a bright core and a coloured halo per orb.
  const orbGeo = keep(new THREE.SphereGeometry(1, 12, 8));
  const orbs = new THREE.InstancedMesh(orbGeo, keep(new THREE.MeshBasicMaterial({ color: '#fff6ea', fog: false, toneMapped: false })), MAX_ORBS);
  const halos = new THREE.InstancedMesh(orbGeo, keep(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.4, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, toneMapped: false })), MAX_ORBS);
  for (const im of [orbs, halos]) {
    im.count = 0;
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(im);
  }
  halos.renderOrder = 8;
  halos.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ORBS * 3), 3);
  halos.instanceColor.setUsage(THREE.DynamicDrawUsage);

  // Telegraphs and rain rings: flat discs with a fill.
  const discGeo = keep(new THREE.PlaneGeometry(2, 2));
  discGeo.rotateX(-Math.PI / 2);
  const disc = (n: number, color: string) =>
    Array.from({ length: n }, () => {
      const m = new THREE.Mesh(discGeo, keep(unlit(RING_FRAG, { uColor: { value: new THREE.Color(color) }, uFill: { value: 0 }, uAlpha: { value: 1 } }, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
      m.visible = false;
      m.renderOrder = 7;
      root.add(m);
      return m;
    });
  const tells = disc(MAX_TELL, '#ffffff');
  const rain = disc(MAX_RAIN, '#ff5a5a');

  // Lasers: a unit box along +x, scaled to length and width.
  const laserGeo = keep(new THREE.BoxGeometry(1, 1, 1));
  laserGeo.translate(0.5, 0, 0);
  const lasers = Array.from({ length: MAX_LASERS }, () => {
    const m = new THREE.Mesh(laserGeo, keep(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 1, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, toneMapped: false })));
    m.visible = false;
    m.renderOrder = 8;
    root.add(m);
    return m;
  });

  return {
    root,
    room,
    tint,
    time,
    clear,
    orbs,
    halos,
    tells,
    lasers,
    rain,
    spikes: [],
    door: { field, mat: doorMat },
    exit,
    built: -1,
    dispose: () => {
      for (const d of disposables) d.dispose();
      orbs.dispose();
      halos.dispose();
    },
  };
}

/** The room's pillars, pools and spike strips (rebuilt when the arena changes). */
function buildRoom(rig: Rig, a: Arena): void {
  for (const c of [...rig.room.children]) {
    rig.room.remove(c);
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose();
    });
  }
  rig.spikes = [];
  const tint = rig.tint.value;
  for (const o of a.layout.obstacles) {
    if (o.kind === PILLAR) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(o.r * 0.92, o.r, 3.6, 18), new THREE.MeshLambertMaterial({ color: '#2b2737' }));
      body.position.y = 1.8;
      g.add(body);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(o.r * 1.05, o.r * 1.05, 0.25, 18), new THREE.MeshLambertMaterial({ color: '#3a3548' }));
      cap.position.y = 3.65;
      g.add(cap);
      for (const y of [0.35, 2.9]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(o.r * (y < 1 ? 1.0 : 0.93), 0.05, 6, 28), new THREE.MeshBasicMaterial({ color: tint, fog: false, toneMapped: false }));
        band.rotation.x = Math.PI / 2;
        band.position.y = y;
        g.add(band);
      }
      g.position.set(o.x, 0, o.z);
      rig.room.add(g);
    } else if (o.kind === POOL) {
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(o.r * 2, o.r * 2).rotateX(-Math.PI / 2), unlit(POOL_FRAG, { uTint: rig.tint, uTime: rig.time }));
      pool.position.set(o.x, 0.03, o.z);
      rig.room.add(pool);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(o.r, 0.12, 6, 36), new THREE.MeshLambertMaterial({ color: '#34303f' }));
      rim.rotation.x = Math.PI / 2;
      rim.position.set(o.x, 0.08, o.z);
      rig.room.add(rim);
    } else if (o.kind === SPIKES && rig.spikes.length < MAX_SPIKES) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(o.r * 2, o.h * 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#1a1420', transparent: true, opacity: 0.9, fog: false }));
      plate.position.set(o.x, 0.025, o.z);
      rig.room.add(plate);
      const cone = new THREE.ConeGeometry(0.16, 0.7, 5);
      cone.translate(0, 0.35, 0);
      const mesh = new THREE.InstancedMesh(cone, new THREE.MeshLambertMaterial({ color: '#b9b2c8' }), SPIKE_COLS * SPIKE_ROWS);
      mesh.frustumCulled = false;
      rig.room.add(mesh);
      rig.spikes.push({ mesh, plate, o });
    }
  }
}

const tmpPos: [number, number] = [0, 0];

/** Seekers step at 30 Hz toward the player they chase (the zone does the same; it decides hits). */
function stepSeekers(lv: LiveVolley, tick: number, a: Arena, self: number): void {
  if (!lv.seekers) return;
  const target = (): [number, number] => {
    if (lv.v.seed === self) return [localPlayer.pos.x - a.ox, localPlayer.pos.z - a.oz];
    const r = drawnRemotes.views.find((x) => x.id === lv.v.seed);
    return r ? [r.x - a.ox, r.z - a.oz] : [NaN, NaN];
  };
  let n = 0;
  while (lv.stepped < Math.floor(tick) && n++ < 90) {
    lv.stepped++;
    if (lv.stepped <= lv.v.fire) continue;
    const [tx, tz] = target();
    for (const s of lv.seekers) {
      if (Number.isNaN(tx)) seekerStep(lv.v, s, s.x + Math.cos(s.a), s.z + Math.sin(s.a), a.layout);
      else seekerStep(lv.v, s, tx, tz, a.layout);
    }
  }
}

function updateRig(rig: Rig, a: Arena, nowMs: number, elapsed: number): void {
  const st = useRift.getState();
  rig.root.position.set(a.ox, a.oy, a.oz);
  rig.time.value = elapsed;
  rig.clear.value += ((st.cleared ? 1 : 0) - rig.clear.value) * 0.08;
  const tick = bulletClock.now(clockInput(), nowMs);
  pruneVolleys(Math.floor(tick));
  const roomT = (tick - a.startTick) / TICKS_PER_S;
  // A clear room: shots fade over half a second.
  const fade = riftRuntime.clearedAt ? Math.max(0, 1 - (performance.now() - riftRuntime.clearedAt) / 500) : 1;
  const tint = rig.tint.value;

  // Door and the way out.
  const open = st.door > 0;
  rig.door.mat.color.copy(open ? col.set('#fff3cf') : tint);
  rig.door.mat.opacity = open ? 0.55 + 0.15 * Math.sin(elapsed * 4) : 0.18 + 0.05 * Math.sin(elapsed * 2);
  rig.exit.visible = st.door === 2;
  rig.exit.rotation.y = elapsed * 0.6;

  // Spike strips: a grid of cones, down / warning / up.
  for (const s of rig.spikes) {
    const { up, warn } = spikesUp(s.o, roomT);
    const h = up ? 1 : warn ? 0.12 + 0.05 * Math.sin(elapsed * 30) : 0.04;
    let k = 0;
    for (let r = 0; r < SPIKE_ROWS; r++)
      for (let c = 0; c < SPIKE_COLS; c++) {
        const x = s.o.x - s.o.r + ((c + 0.5) / SPIKE_COLS) * s.o.r * 2 + (r % 2 ? 0.2 : -0.2);
        const z = s.o.z - s.o.h + ((r + 0.5) / SPIKE_ROWS) * s.o.h * 2;
        m4.compose(v3.set(x, 0, z), q.identity(), scl.set(1, h, 1));
        s.mesh.setMatrixAt(k++, m4);
      }
    s.mesh.instanceMatrix.needsUpdate = true;
    const pm = s.plate.material as THREE.MeshBasicMaterial;
    pm.color.set(up ? '#5a1820' : warn ? '#c0392b' : '#1a1420');
    pm.opacity = warn ? 0.65 + 0.3 * Math.sin(elapsed * 18) : 0.9;
  }

  // Shots.
  let n = 0;
  let tells = 0;
  let lasers = 0;
  let drops = 0;
  for (const lv of fade > 0.01 ? riftRuntime.volleys : []) {
    const v = lv.v;
    const t = (tick - v.fire) / TICK_HZ;
    const c = v.kind === KIND_SEEKER ? col.set('#d58bff') : col.copy(tint);
    // The telegraph: a ring at the source filling over the windup.
    if (t < 0 && v.windup > 0 && v.kind !== KIND_RAIN && tells < MAX_TELL) {
      const p = 1 + t / (v.windup / 1000);
      if (p > 0) {
        const m = rig.tells[tells++];
        const u = (m.material as THREE.ShaderMaterial).uniforms;
        u.uColor.value.copy(c);
        u.uFill.value = p;
        u.uAlpha.value = 0.9 * fade;
        const r = v.kind === KIND_LASER ? 0.7 : 0.9 + v.radius * 2;
        m.scale.set(r, 1, r);
        m.position.set(v.ox, 0.05, v.oz);
        m.visible = true;
      }
    }
    if (v.kind === KIND_LASER) {
      if (lasers >= MAX_LASERS) continue;
      const L = laserAt(v, Math.max(0, t), a.layout);
      const aiming = t < 0 && t > -(v.windup / 1000);
      if (!L.live && !aiming) continue;
      const m = rig.lasers[lasers++];
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.copy(c).lerp(col.set('#ffffff'), L.live ? 0.5 : 0);
      mat.opacity = (L.live ? 0.95 : 0.35 + 0.2 * Math.sin(elapsed * 25)) * fade;
      const w = L.live ? Math.max(0.25, v.radius * 2) : 0.06;
      m.scale.set(L.length, w, w);
      m.position.set(v.ox, BULLET_Y, v.oz);
      m.rotation.set(0, -L.a, 0);
      m.visible = true;
      continue;
    }
    if (v.kind === KIND_RAIN) {
      for (let i = 0; i < v.count && drops < MAX_RAIN; i++) {
        const d = rainAt(v, i);
        const until = d.land - t;
        if (until > RAIN_WARN_S || until < -0.3) continue;
        const m = rig.rain[drops++];
        const u = (m.material as THREE.ShaderMaterial).uniforms;
        u.uColor.value.copy(c);
        u.uFill.value = until > 0 ? 1 - until / RAIN_WARN_S : 1;
        u.uAlpha.value = (until > 0 ? 0.85 : 1.6 * (1 + until / 0.3)) * fade;
        m.scale.set(d.r, 1, d.r);
        m.position.set(d.x, 0.06, d.z);
        m.visible = true;
      }
      continue;
    }
    if (t < 0 || t > ends(v)) continue;
    if (v.kind === KIND_SEEKER) {
      stepSeekers(lv, tick, a, st.self);
      for (const s of lv.seekers ?? []) {
        if (s.dead || n >= MAX_ORBS) continue;
        placeOrb(rig, n++, s.x, s.z, v.radius, c, fade);
      }
      continue;
    }
    const count = bullets(v);
    for (let i = 0; i < count && n < MAX_ORBS; i++) {
      const p = bulletPos(v, i, t, a.layout, tmpPos);
      if (!p) continue;
      placeOrb(rig, n++, p[0], p[1], v.radius, c, fade);
    }
  }
  rig.orbs.count = n;
  rig.halos.count = n;
  rig.orbs.instanceMatrix.needsUpdate = true;
  rig.halos.instanceMatrix.needsUpdate = true;
  if (rig.halos.instanceColor) rig.halos.instanceColor.needsUpdate = true;
  for (let i = tells; i < MAX_TELL; i++) rig.tells[i].visible = false;
  for (let i = lasers; i < MAX_LASERS; i++) rig.lasers[i].visible = false;
  for (let i = drops; i < MAX_RAIN; i++) rig.rain[i].visible = false;
}

function placeOrb(rig: Rig, i: number, x: number, z: number, r: number, c: THREE.Color, fade: number): void {
  // the core is the shot's hit radius (what you must dodge); the halo only a little wider
  const s = Math.max(0.06, r) * (0.3 + 0.7 * fade);
  m4.compose(v3.set(x, BULLET_Y, z), q.identity(), scl.set(s, s, s));
  rig.orbs.setMatrixAt(i, m4);
  const h = s * 1.45;
  m4.compose(v3.set(x, BULLET_Y, z), q.identity(), scl.set(h, h, h));
  rig.halos.setMatrixAt(i, m4);
  rig.halos.setColorAt(i, col.copy(c).multiplyScalar(fade));
}

export function RiftLayer() {
  const scene = useThree((s) => s.scene);
  const rig = useMemo(buildRig, []);
  useEffect(() => {
    scene.add(rig.root);
    return () => {
      scene.remove(rig.root);
      buildRoom(rig, { layout: { obstacles: [] } } as unknown as Arena); // drops the room's meshes
      rig.dispose();
    };
  }, [scene, rig]);
  useFrame((state) => {
    const a = riftRuntime.arena;
    if (!a) {
      rig.root.visible = false;
      return;
    }
    if (rig.built !== riftRuntime.version) {
      rig.built = riftRuntime.version;
      rig.tint.value.set(a.color || '#ff8a3d');
      rig.clear.value = 0;
      buildRoom(rig, a);
    }
    rig.root.visible = true;
    updateRig(rig, a, performance.now(), state.clock.elapsedTime);
  });
  return null;
}

// ---- the portals in the overworld ----
// An open rift is a torn, swirling oval standing over the ground in its
// chapter's colour with a soft glow under it: before this the "[E] Enter the rift" prompt hung over an empty
// field.

const PORTAL_FRAG = `
uniform vec3 uColor;
uniform float uTime;
uniform float uSeed;
varying vec2 vUv;
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(1.0, 1.0);
  float r = length(p);
  float ang = atan(p.y, p.x + 1e-6);
  // a ragged rim: the oval's edge wobbles
  float rim = 0.86 + 0.06 * sin(ang * 7.0 + uTime * 1.7 + uSeed) + 0.04 * sin(ang * 13.0 - uTime * 2.3);
  if (r > rim + 0.08) discard;
  float edge = 1.0 - smoothstep(rim - 0.1, rim + 0.06, r);
  float swirl = 0.5 + 0.5 * sin(ang * 3.0 + r * 9.0 - uTime * 2.6 + uSeed);
  float core = 1.0 - smoothstep(0.0, rim, r);
  vec3 c = mix(vec3(0.03, 0.02, 0.06), uColor, swirl * 0.55 * (1.0 - core * 0.5));
  c += uColor * smoothstep(rim - 0.18, rim, r) * edge * 1.6;
  c += vec3(1.0) * pow(core, 6.0) * 0.5;
  gl_FragColor = vec4(c, edge);
}`;

const PORTAL_MAX = 4;
const PORTAL_SHOW_M = 320;

interface PortalRig {
  root: THREE.Group;
  items: { g: THREE.Group; face: THREE.Mesh; glow: THREE.Mesh; color: { value: THREE.Color }; seed: { value: number } }[];
  time: { value: number };
  dispose: () => void;
}

function buildPortals(): PortalRig {
  const root = new THREE.Group();
  root.name = 'rift-portals';
  const time = { value: 0 };
  const faceGeo = new THREE.PlaneGeometry(2.6, 3.6);
  faceGeo.translate(0, 2.05, 0);
  const glowGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const mats: THREE.Material[] = [];
  const items = Array.from({ length: PORTAL_MAX }, (_, i) => {
    const color = { value: new THREE.Color('#ff8a3d') };
    const seed = { value: i * 1.7 };
    const faceMat = unlit(PORTAL_FRAG, { uColor: color, uTime: time, uSeed: seed }, { transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const glowMat = unlit(RING_FRAG, { uColor: color, uFill: { value: 1 }, uAlpha: { value: 0.35 } }, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    mats.push(faceMat, glowMat);
    const g = new THREE.Group();
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.renderOrder = 6;
    // the ground glow: a flat disc lifted clear of uneven ground
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.scale.set(1.6, 1, 1.6);
    glow.position.y = 0.35;
    glow.renderOrder = 5;
    g.add(face, glow);
    g.visible = false;
    root.add(g);
    return { g, face, glow, color, seed };
  });
  return {
    root,
    items,
    time,
    dispose: () => {
      faceGeo.dispose();
      glowGeo.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

function updatePortals(pr: PortalRig, camera: THREE.Camera, elapsed: number): void {
  pr.time.value = elapsed;
  const cam = camera.position;
  const now = performance.now();
  const open = riftRuntime.arena
    ? []
    : useRift
        .getState()
        .portals.filter((p) => p.endsInMs - (now - p.at) > 0)
        .map((p) => ({ p, d: Math.hypot(p.x - cam.x, p.z - cam.z) }))
        .filter((e) => e.d < PORTAL_SHOW_M)
        .sort((a, b) => a.d - b.d)
        .slice(0, PORTAL_MAX);
  pr.items.forEach((it, i) => {
    const e = open[i];
    it.g.visible = !!e;
    if (!e) return;
    it.color.value.set(e.p.color || '#ff8a3d');
    it.seed.value = e.p.id * 1.37;
    it.g.position.set(e.p.x, e.p.y, e.p.z);
    // the oval turns to face you (about the vertical), breathing a little
    it.face.rotation.y = Math.atan2(cam.x - e.p.x, cam.z - e.p.z);
    const s = 1 + 0.03 * Math.sin(elapsed * 1.3 + i);
    it.face.scale.set(s, s, s);
  });
}

/** The portals of open rifts in the overworld (hidden while you are in one). */
export function RiftPortals() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const pr = useMemo(buildPortals, []);
  useEffect(() => {
    scene.add(pr.root);
    return () => {
      scene.remove(pr.root);
      pr.dispose();
    };
  }, [scene, pr]);
  useFrame((state) => updatePortals(pr, camera, state.clock.elapsedTime));
  return null;
}
