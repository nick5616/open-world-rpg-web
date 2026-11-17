// Playtest 3 dev page (build-dev.html): a small house placed through the real
// build rules (rules.ts checkBuild, so every piece is one the zone would
// take) and drawn by the real renderer (renderer.ts), by day and by night,
// with the ghost green and red. No zone, no world: flat ground.
//
// window.__buildLab.shot({ time: 'day' | 'night', view, ghost }) poses the
// scene and renders one frame.

import * as THREE from 'three';
import { CAMPS } from '@lodestone/contracts';
import { flameMat } from '../../../systems/NightLayer';
import type { CampPiece } from '../../camps/events';
import type { BP } from '../geometry';
import { BuildRenderer, ghostMesh } from '../renderer';
import { checkBuild, type BuildEnv } from '../rules';

const W = 1280;
const H = 720;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, W / H, 0.1, 400);
const hemi = new THREE.HemisphereLight('#dfeaff', '#55603f', 1.1);
const sun = new THREE.DirectionalLight('#fff2dc', 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -16;
sun.shadow.camera.right = 16;
sun.shadow.camera.top = 16;
sun.shadow.camera.bottom = -16;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0004;
scene.add(hemi, sun, sun.target);

// Ground: a mown meadow with a worn path, a few trees for scale.
const gg = new THREE.PlaneGeometry(160, 160, 80, 80);
gg.rotateX(-Math.PI / 2);
const gcol: number[] = [];
const gp = gg.getAttribute('position');
for (let i = 0; i < gp.count; i++) {
  const x = gp.getX(i) + 1003;
  const z = gp.getZ(i) + 1004;
  const n = Math.sin(x * 0.7) * Math.cos(z * 0.9) * 0.5 + Math.sin(x * 0.17 + z * 0.23) * 0.5;
  const path = Math.exp(-Math.pow((x - 1003) / 1.6, 2)) * (z > 1004 ? 1 : 0);
  const c = new THREE.Color('#5d7a3c').lerp(new THREE.Color('#7a8f48'), 0.5 + 0.5 * n).lerp(new THREE.Color('#8f7a55'), Math.min(1, path));
  gcol.push(c.r, c.g, c.b);
}
gg.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 3));
const ground = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
ground.receiveShadow = true;
ground.position.set(1003, -0.001, 1004);
scene.add(ground);
const treeMat = [new THREE.MeshStandardMaterial({ color: '#2f5a2b', roughness: 1, flatShading: true }), new THREE.MeshStandardMaterial({ color: '#4a3a28', roughness: 1 })];
for (const [x, z, s] of [[1015, 998, 1.3], [992, 1012, 1.1], [1018, 1012, 1], [995, 996, 1.4], [1010, 1020, 1.2], [1000, 1022, 1]]) {
  const t = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 2, 6), treeMat[1]);
  trunk.position.y = 1;
  const crown = new THREE.Mesh(new THREE.ConeGeometry(1.6, 4.6, 7), treeMat[0]);
  crown.position.y = 4;
  trunk.castShadow = crown.castShadow = true;
  t.add(trunk, crown);
  t.scale.setScalar(s);
  t.position.set(x, 0, z);
  scene.add(t);
}

// ---- the house, through the rules ----
const env: BuildEnv = { heightAt: () => 0, waterAt: () => -100, noBuild: () => 0, structure: () => false };
const id = (key: string): number => {
  const p = CAMPS.pieces.find((q) => q.key === key);
  if (!p) throw new Error(`no piece ${key}`);
  return p.id;
};
const bps: BP[] = [];
const refused: string[] = [];
/** [key, rot, x m, z m, y m | null (a first foundation: the rules pick)] */
type Step = [string, number, number, number, number | null];
function put(steps: Step[]): void {
  for (const [key, rot, x, z, y] of steps) {
    const r = checkBuild({ kind: id(key), rot, x: Math.round(x * 100), y: Math.round((y ?? 0) * 100), z: Math.round(z * 100), hasY: y !== null, owner: 'me', party: 0, feetX: x, feetY: 5, feetZ: z }, bps, env);
    if (r.reason !== 0) {
      refused.push(`${key} rot ${rot} at ${x},${z},${y}: reason ${r.reason}`);
      continue;
    }
    bps.push({ id: bps.length + 1, kind: id(key), rot, x: Math.round(x * 100), y: r.y, z: Math.round(z * 100), state: 0, owner: 'me', party: 0, lock: 0 });
  }
}
const M = (mat: 'wood' | 'stone' | 'sunsteel', base: string) => `${base}_${mat}`;
// Foundations: 3 x 2 cells of stone.
for (const x of [1001, 1003, 1005]) for (const z of [1001, 1003]) put([[M('stone', 'foundation'), 0, x, z, x === 1001 && z === 1001 ? null : 0]]);
// Walls (stone below, wood above the sill is the roof's job): north, south, west, east.
put([
  [M('stone', 'wall'), 0, 1001, 1000, 0],
  [M('stone', 'window'), 0, 1003, 1000, 0],
  [M('stone', 'wall'), 0, 1005, 1000, 0],
  [M('stone', 'wall'), 4, 1001, 1004, 0],
  [M('stone', 'door'), 4, 1003, 1004, 0],
  [M('stone', 'window'), 4, 1005, 1004, 0],
  [M('stone', 'window'), 6, 1000, 1001, 0],
  [M('stone', 'wall'), 6, 1000, 1003, 0],
  [M('stone', 'wall'), 2, 1006, 1001, 0],
  [M('stone', 'window'), 2, 1006, 1003, 0],
]);
// Gable roof along x: wood shingles. North slopes rot 2, south slopes rot 6, caps on the ridge.
for (const x of [1001, 1003, 1005]) put([[M('wood', 'roof'), 2, x, 1001, 2.5], [M('wood', 'roof'), 6, x, 1003, 2.5], [M('wood', 'roof_cap'), 0, x, 1002, 3.75]]);
put([
  [M('stone', 'gable'), 2, 1000, 1001, 2.5],
  [M('stone', 'gable'), 6, 1000, 1003, 2.5],
  [M('stone', 'gable'), 2, 1006, 1001, 2.5],
  [M('stone', 'gable'), 6, 1006, 1003, 2.5],
]);
// A watch deck on the east: pillars, a floor, half walls, stairs up from the south.
put([
  [M('wood', 'pillar'), 0, 1006, 1002, 0],
  [M('wood', 'pillar'), 0, 1008, 1002, 0],
  [M('wood', 'floor'), 0, 1007, 1003, 2.5],
  [M('wood', 'half_wall'), 0, 1007, 1002, 2.5],
  [M('wood', 'half_wall'), 2, 1008, 1003, 2.5],
  [M('wood', 'stairs'), 6, 1007, 1006, 0],
]);
// A front yard: a wooden fence with a gate, an iron-strapped (sunsteel) pillar pair.
put([
  [M('wood', 'fence'), 0, 999, 1010, 0],
  [M('wood', 'fence'), 0, 1001, 1010, 0],
  [M('wood', 'gate'), 0, 1003, 1010, 0],
  [M('wood', 'fence'), 0, 1005, 1010, 0],
  [M('wood', 'fence'), 0, 1007, 1010, 0],
  [M('sunsteel', 'pillar'), 0, 1002, 1010, 0],
  [M('sunsteel', 'pillar'), 0, 1004, 1010, 0],
]);
// Furnishings (y 0: the foundations' tops).
put([
  ['bed', 0, 1001.5, 1001, 0],
  ['hearth', 2, 1001, 1003, 0],
  ['rug', 0, 1003, 1003, 0],
  ['table', 0, 1003.5, 1001, 0],
  ['bench', 0, 1005, 1002.5, 0],
  ['big_chest', 0, 1005, 1003.5, 0],
  ['cook', 0, 1005, 1001, 0],
  ['lantern', 0, 1004, 1002, 0],
  ['banner', 0, 1001, 1000, 0],
  ['trophy', 0, 1005, 1000, 0],
  ['wall_torch', 4, 1001, 1004, 0],
  ['wall_torch', 6, 1000, 1003, 0],
]);

const pieces: CampPiece[] = bps.map((b) => ({
  id: b.id,
  kind: b.kind,
  rot: b.rot,
  xCm: b.x,
  yCm: b.y,
  zCm: b.z,
  x: b.x / 100,
  y: b.y / 100,
  z: b.z / 100,
  mine: true,
  shared: false,
  party: false,
  burning: false,
  burnEnd: 0,
  used: 0,
  owner: 'me',
  label: '',
  state: id('door_stone') === b.kind || id('gate_wood') === b.kind ? 0 : 0,
  cond: b.kind === id('wall_stone') && b.x === 100100 ? 40 : 100,
  modify: true,
}));
// One door open, one worn wall.
const door = pieces.find((p) => p.kind === id('door_stone'));
if (door) door.state = 1;

const build = new BuildRenderer(true);
scene.add(build.root);
build.sync(pieces, 1003, 1004);

const ghostRoot = new THREE.Group();
scene.add(ghostRoot);

type Time = 'day' | 'night';
function lighting(t: Time): void {
  if (t === 'day') {
    scene.background = new THREE.Color('#9dbbdc');
    scene.fog = new THREE.Fog('#b9cde4', 60, 220);
    hemi.color.set('#dfeaff');
    hemi.groundColor.set('#55603f');
    hemi.intensity = 1.1;
    sun.color.set('#fff2dc');
    sun.intensity = 2.6;
    sun.position.set(1003 + 18, 22, 1004 + 12);
    renderer.toneMappingExposure = 1;
  } else {
    scene.background = new THREE.Color('#0d1424');
    scene.fog = new THREE.Fog('#0d1424', 25, 130);
    hemi.color.set('#566a98');
    hemi.groundColor.set('#1b2018');
    hemi.intensity = 0.55;
    sun.color.set('#8fa8ff');
    sun.intensity = 0.55;
    sun.position.set(1003 - 14, 26, 1004 + 10);
    renderer.toneMappingExposure = 1.15;
  }
  sun.target.position.set(1003, 0, 1003);
}

const views: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {
  front: { pos: [1009.5, 2.6, 1015.5], look: [1003.8, 1.9, 1003] },
  corner: { pos: [1012.5, 4.6, 1010.5], look: [1004.5, 2.0, 1002.5] },
  close: { pos: [1008.5, 1.7, 1013], look: [1003, 1.4, 1004] },
  inside: { pos: [1002.2, 1.7, 1002.8], look: [1004.6, 1.0, 1000.8] },
};

function shot(o: { time?: Time; view?: string; ghost?: 'both' | 'none' } = {}): { pieces: number; refused: string[] } {
  const time = o.time ?? 'day';
  lighting(time);
  const v = views[o.view ?? 'front'];
  camera.position.set(...v.pos);
  camera.lookAt(...v.look);
  camera.updateMatrixWorld(true);
  flameMat.uniforms.uTime.value = 3.1;
  build.frame(3.1, camera.position.x, camera.position.y, camera.position.z, time === 'night' ? 1 : 0, true);
  ghostRoot.clear();
  if (o.ghost === 'both') {
    // Green: a stone wall that snaps onto a free foundation edge; red: one floating in the air.
    const ok = ghostMesh(id('wall_stone'), true);
    ok.position.set(1005, 0, 1008);
    ghostRoot.add(ok);
    const bad = ghostMesh(id('wall_stone'), false);
    bad.position.set(1001, 1.3, 1008);
    ghostRoot.add(bad);
    const bad2 = ghostMesh(id('floor_wood'), false);
    bad2.position.set(1009, 0.2, 1011);
    ghostRoot.add(bad2);
  }
  renderer.render(scene, camera);
  return { pieces: bps.length, refused };
}

(window as unknown as { __buildLab: unknown }).__buildLab = { ready: true, shot, refused: () => refused, count: () => bps.length, tris: () => renderer.info.render.triangles, calls: () => renderer.info.render.calls };
shot();
