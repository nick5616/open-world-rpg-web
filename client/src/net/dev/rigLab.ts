// Playtest 2 dev page (rig-dev.html): the first-person hands on every weapon
// and the third-person avatar rig in any pose, on a plain backdrop, with no
// zone or world. For close-up evidence of hands and joints (pt2 hands/arms):
//   npx vite --port 5199 in client/, then open /rig-dev.html
// or `node client/scripts/rig-shots.mjs <prefix>` (docs/evidence/<prefix>-*.jpg).
//
// window.__rigLab.fp({ weapon, cast, draw }) and .tp({ weapon, view, action,
// t, emote, riding }) each pose the scene and render one frame.

import * as THREE from 'three';
import { CONTENT } from '@lodestone/contracts';
import { aimOpenHand, CAST_REST, CAST_UP, L_SHOULDER, makeRig, PIVOT, POSES, poseHands, setRigWeapon } from '../../combat/weapons/FirstPersonWeapon';
import { BOW_MAX_DRAW, bowNock, FIST_WRIST, setBowDraw } from '../../combat/weapons/models';
import { packLook, type WeaponKind } from '../../combat/weapons/look';
import { Avatar } from '../avatar';
import { EMOTE_PLAYING, type ActionKind } from '../avatarAnim';
import type { RemoteView } from '../interpolation';
import { TYPE_RIDING } from '../../ui/mounts/events';

const W = 960;
const H = 540;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9bb7d4');
scene.add(new THREE.HemisphereLight('#dfeaff', '#55603f', 1.1));
const sun = new THREE.DirectionalLight('#fff2dc', 2.2);
sun.position.set(3, 6, 2);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 32), new THREE.MeshStandardMaterial({ color: '#6f7d55', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(75, W / H, 0.05, 200);
scene.add(camera);

// ---- first person ----
const rig = makeRig();
camera.add(rig.root);

type FpOpts = { swing?: number; dir?: number; weapon?: WeaponKind; cast?: number; draw?: number; fov?: number; close?: 'r' | 'l' | 'cast'; label?: string };

function fp(o: FpOpts = {}): void {
  avatar.root.visible = false;
  ground.visible = false;
  rig.root.visible = true;
  const kind = o.weapon ?? 'sword';
  camera.fov = 75;
  camera.position.set(0, 1.6, 0);
  camera.rotation.set(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  setRigWeapon(rig, { weapon: kind, material: '', gem: 0 });
  const p = POSES[kind];
  rig.grip.position.set(p.pos[0] - PIVOT.x, p.pos[1] - PIVOT.y, p.pos[2] - PIVOT.z);
  rig.pivot.rotation.set(0, 0, 0);
  if (o.swing !== undefined) {
    // FirstPersonWeapon's melee swing at this fraction (dir 1 forehand)
    const sm = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const sw = o.swing;
    const u1 = sm(0, 0.22, sw);
    const u2 = sm(0.18, 0.6, sw);
    const back = 1 - sm(0.62, 1, sw);
    const k = kind === 'sword' ? 1 : 0.7;
    const d = o.dir ?? 1;
    rig.pivot.rotation.set((0.35 * u1 - 1.05 * u2) * back * k, d * (-0.45 * u1 + 1.5 * u2) * back * k, d * (-0.3 * u1 + 0.6 * u2) * back * k);
  }
  const draw = o.draw ?? 0;
  if (kind === 'bow') {
    setBowDraw(rig.weapon.geometry, draw * BOW_MAX_DRAW, draw > 0);
    rig.rFist.position.copy(bowNock(draw * BOW_MAX_DRAW)).multiplyScalar(p.scale ?? 1);
  }
  poseHands(rig, kind);
  const c = o.cast ?? 0;
  rig.castFist.visible = rig.castArm.visible = c > 0;
  if (c > 0) {
    rig.castFist.position.lerpVectors(CAST_REST, CAST_UP, c);
    aimOpenHand(rig, rig.castFist, rig.castArm, L_SHOULDER);
  }
  camera.updateMatrixWorld(true);
  if (o.close) {
    // A close-up from the eye: a narrow field of view on that hand (the rig stays on the main camera).
    const fist = o.close === 'r' ? rig.rFist : o.close === 'l' ? rig.lFist : rig.castFist;
    const world = fist.getWorldPosition(new THREE.Vector3());
    zoomCam.fov = o.fov ?? 24;
    zoomCam.aspect = camera.aspect;
    zoomCam.position.set(0, 1.6, 0);
    zoomCam.lookAt(world);
    zoomCam.updateProjectionMatrix();
    renderer.render(scene, zoomCam);
    return;
  }
  renderer.render(scene, camera);
}
const zoomCam = new THREE.PerspectiveCamera(24, W / H, 0.02, 200);
scene.add(zoomCam);

// ---- third person ----
const avatar = new Avatar(7, { nameplate: false });
scene.add(avatar.root);
const view: RemoteView = { id: 7, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, kind: 1, name: 'Lab', level: 1, healthPct: 100, activity: 0, partyId: 0, typeId: 0, ring: 0 as never, delayMs: 0, mode: 'interp' };

const SPEC: Partial<Record<ActionKind, { durMs: number; color: string | null }>> = {
  slash: { durMs: 520, color: null },
  thrust: { durMs: 520, color: null },
  cast: { durMs: 700, color: '#ff8a3c' },
  castStaff: { durMs: 700, color: '#7fd3ff' },
  castBig: { durMs: 1200, color: '#c08cff' },
  bow: { durMs: 600, color: null },
  draw: { durMs: 3000, color: null },
  parry: { durMs: 450, color: null },
  mine: { durMs: 520, color: null },
};

type TpOpts = { weapon?: WeaponKind | ''; view?: 'front' | 'side' | 'back' | 'left' | 'threeq'; action?: ActionKind; t?: number; emote?: number; instrument?: string; riding?: boolean; speed?: number; dist?: number; label?: string; at?: [number, number, number] };

function tp(o: TpOpts = {}): void {
  rig.root.visible = false;
  ground.visible = true;
  avatar.root.visible = true;
  const weapon = o.weapon === undefined ? 'sword' : o.weapon;
  view.typeId = (weapon ? packLook({ weapon, material: '', gem: 0 }) : 0) | (o.riding ? TYPE_RIDING : 0);
  view.speed = o.speed ?? 0;
  avatar.anim.resetMotion();
  // settle the idle/locomotion pose
  const dt = 1 / 60;
  for (let i = 0; i < 90; i++) avatar.update(view, camera, dt); // walks in place: the animator reads `speed`
  if (o.instrument) {
    const id = CONTENT.instruments.list.find((x) => x.pose === o.instrument)?.id ?? 0;
    avatar.anim.emote(EMOTE_PLAYING, id);
  } else if (o.emote) avatar.anim.emote(o.emote);
  if (o.action) {
    const s = SPEC[o.action] ?? { durMs: 600, color: null };
    avatar.anim.trigger({ kind: o.action, durMs: s.durMs, color: s.color, dir: 1, hold: o.action === 'draw' });
    const steps = Math.round(((o.t ?? 0.4) * s.durMs) / 1000 / dt);
    for (let i = 0; i < steps; i++) avatar.update(view, camera, dt);
  } else for (let i = 0; i < 40; i++) avatar.update(view, camera, dt);
  const dist = o.dist ?? 3.2;
  // The avatar faces -Z (its right is +X): the camera's bearing from it.
  const a = { front: 0, side: Math.PI / 2, back: Math.PI, left: -Math.PI / 2, threeq: Math.PI / 4 }[o.view ?? 'front'];
  const cy = o.riding ? 2.0 : 1.15;
  const at = o.at ?? [0, cy, 0];
  camera.fov = 40;
  camera.aspect = tileAspect;
  camera.position.set(at[0] + Math.sin(a) * dist, at[1] + (o.at ? 0.05 : 0.15), at[2] - Math.cos(a) * dist);
  camera.lookAt(at[0], at[1], at[2]);
  camera.updateProjectionMatrix();
  avatar.update(view, camera, 0);
  renderer.render(scene, camera);
}

// ---- contact sheets: one image, a grid of views ----
let tileAspect = W / H;
function sheet(cols: number, rows: number, items: ({ fp: FpOpts } | { tp: TpOpts })[]): void {
  const w = Math.floor(W / cols);
  const h = Math.floor(H / rows);
  renderer.setScissorTest(true);
  renderer.setClearColor('#222');
  renderer.setScissor(0, 0, W, H);
  renderer.setViewport(0, 0, W, H);
  renderer.clear();
  labels.innerHTML = '';
  items.forEach((it, i) => {
    const x = (i % cols) * w;
    const y = H - (Math.floor(i / cols) + 1) * h;
    renderer.setViewport(x + 1, y + 1, w - 2, h - 2);
    renderer.setScissor(x + 1, y + 1, w - 2, h - 2);
    tileAspect = (w - 2) / (h - 2);
    camera.aspect = tileAspect;
    if ('fp' in it) fp(it.fp);
    else tp(it.tp);
    const label = ('fp' in it ? it.fp.label : it.tp.label) ?? '';
    const d = document.createElement('div');
    d.textContent = label;
    d.style.cssText = `position:absolute;left:${x + 6}px;top:${H - y - h + 4}px;font:600 12px system-ui;color:#fff;text-shadow:0 1px 2px #000`;
    labels.appendChild(d);
  });
  renderer.setScissorTest(false);
  tileAspect = W / H;
  camera.aspect = tileAspect;
}
const labels = document.createElement('div');
labels.style.cssText = 'position:absolute;left:0;top:0;width:960px;height:540px;pointer-events:none';
document.body.style.position = 'relative';
document.body.appendChild(labels);

/** Per weapon: the angle (deg) between the grip axis and the forearm, and the wrist's bend away from the fist's own wrist direction. */
function diag(): Record<string, { gripToForearm: number; wristBend: number }> {
  const out: Record<string, { gripToForearm: number; wristBend: number }> = {};
  const cases: [string, FpOpts][] = (['sword', 'spear', 'bow', 'staff', 'wand'] as WeaponKind[]).map((k) => [k, { weapon: k, draw: k === 'bow' ? 0.7 : 0 }]);
  for (const w of ['sword', 'wand'] as WeaponKind[]) for (const d of [1, -1]) for (const sw of [0.15, 0.3, 0.45, 0.6]) cases.push([`${w} swing ${d > 0 ? 'fore' : 'back'} ${sw}`, { weapon: w, swing: sw, dir: d }]);
  for (const [name, o] of cases) {
    fp(o);
    const fist = rig.rFist;
    fist.updateMatrixWorld(true);
    const axis = new THREE.Vector3(0, 1, 0).transformDirection(fist.matrixWorld);
    const fore = new THREE.Vector3(0, 1, 0).transformDirection(rig.rArm.matrixWorld); // wrist to shoulder
    const wristDir = FIST_WRIST.clone().normalize().transformDirection(fist.matrixWorld);
    out[name] = { gripToForearm: Math.round(THREE.MathUtils.radToDeg(axis.angleTo(fore.clone().negate()))), wristBend: Math.round(THREE.MathUtils.radToDeg(wristDir.angleTo(fore))) };
  }
  return out;
}

(window as unknown as { __rigLab: unknown }).__rigLab = { fp, tp, sheet, diag, ready: true };
