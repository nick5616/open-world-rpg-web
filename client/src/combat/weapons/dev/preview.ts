// Weapon art preview (dev only): every weapon at every detail level under a
// sky-like hemisphere light and a sun, for iterating on the procedural
// models without a zone. Open /src/combat/weapons/dev/preview.html on the
// Vite dev server; ?sunsteel=1&gem=5 picks the look, ?d=1 the detail.

import * as THREE from 'three';
import { weaponGeometry, fistGeometry, type Detail } from '../models';
import { weaponMaterial, tickWeaponMaterial } from '../material';
import { WEAPON_KINDS } from '../look';

const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#8aa6c4');
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x4a5a3a, 1));
const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
sun.position.set(2, 3, 2.5);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 50);
camera.position.set(0, 0.55, 4.6);
camera.lookAt(0, 0.55, 0);

const material = q.get('material') ?? (q.get('sunsteel') ? 'sunsteel' : '');
const gem = Number(q.get('gem') ?? 0);
const detail = Number(q.get('d') ?? 2) as Detail;
const turn = Number(q.get('turn') ?? 0.5);
const items: THREE.Object3D[] = [];
WEAPON_KINDS.forEach((w, i) => {
  const m = new THREE.Mesh(weaponGeometry({ weapon: w, material, gem: w === 'sword' ? gem : (gem + i) % 8 }, detail), weaponMaterial());
  m.position.set(-1.6 + i * 0.8, w === 'spear' ? -0.15 : w === 'staff' ? -0.05 : w === 'wand' ? 0.5 : 0.35, 0);
  if (w === 'spear') m.scale.setScalar(0.75);
  m.rotation.y = turn;
  scene.add(m);
  items.push(m);
});
if (q.get('fist')) {
  const f = new THREE.Mesh(fistGeometry(), weaponMaterial());
  f.position.set(-1.6, 0.35, 0);
  f.rotation.y = turn;
  scene.add(f);
}
if (q.get('zoom')) {
  const k = WEAPON_KINDS.indexOf(q.get('zoom') as (typeof WEAPON_KINDS)[number]);
  const t = items[k];
  const y = Number(q.get('y') ?? 0.4);
  camera.position.set(t.position.x, t.position.y + y, Number(q.get('dist') ?? 0.9));
  camera.lookAt(t.position.x, t.position.y + y, 0);
}
const frame = (t: number) => {
  tickWeaponMaterial(scene, t);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
(window as unknown as { __previewReady: boolean }).__previewReady = true;
