// Remote player model (spec 12: "remote players get a third-person model with
// 3 LODs and a nameplate"), built imperatively: one THREE.LOD per player,
// geometries and materials shared by every avatar, no React per entity
// (spec 12: the world is not one React component per object).
//
// LOD distances: full figure with swinging limbs within 25 m, a 4-sided
// capsule and head to 90 m, a single box beyond (the far ring is 200-600 m,
// where a player is a few pixels tall). The nameplate is a canvas-texture
// sprite (no font download, works offline), redrawn only when the name, level
// or activity flags change, and scaled with distance so far-ring silhouettes
// keep a readable label.

import * as THREE from 'three';
import { Activity } from '@lodestone/contracts';
import type { RemoteView } from './interpolation';

const LOD_MID_M = 25;
const LOD_LOW_M = 90;
const NAMEPLATE_Y = 2.25;

const ACTIVITY_LABELS: [number, string][] = [
  [Activity.climbing, 'climbing'],
  [Activity.gliding, 'gliding'],
  [Activity.swimming, 'swimming'],
  [Activity.casting, 'casting'],
  [Activity.emoting, 'emoting'],
  [Activity.typing, 'typing…'],
  [Activity.speaking, 'speaking'],
  [Activity.airborne, 'airborne'],
];

export function activityLabels(bits: number): string[] {
  return ACTIVITY_LABELS.filter(([b]) => (bits & b) !== 0).map(([, l]) => l);
}

// Shared resources: created on first use, never disposed (a handful of small
// buffers; the same rule as wizard-wars' cached PBR materials).
let shared: {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  limb: THREE.BufferGeometry;
  visor: THREE.BufferGeometry;
  bodyMid: THREE.BufferGeometry;
  headMid: THREE.BufferGeometry;
  low: THREE.BufferGeometry;
  visorMat: THREE.Material;
} | null = null;
const bodyMats = new Map<number, THREE.MeshStandardMaterial>();

function res() {
  if (!shared) {
    const limb = new THREE.BoxGeometry(0.12, 0.7, 0.12);
    limb.translate(0, -0.35, 0); // pivot at the top (shoulder / hip)
    shared = {
      body: new THREE.CapsuleGeometry(0.27, 0.6, 4, 12),
      head: new THREE.SphereGeometry(0.2, 16, 12),
      limb,
      visor: new THREE.BoxGeometry(0.26, 0.08, 0.06),
      bodyMid: new THREE.CapsuleGeometry(0.3, 0.75, 2, 4),
      headMid: new THREE.SphereGeometry(0.2, 6, 4),
      low: new THREE.BoxGeometry(0.6, 1.8, 0.4),
      visorMat: new THREE.MeshStandardMaterial({ color: 0x1b1f2a, roughness: 0.3, metalness: 0.4 }),
    };
    shared.low.translate(0, 0.9, 0);
  }
  return shared;
}

/** Stable per-player color from the entity id (golden-ratio hue spread). */
function bodyMat(id: number): THREE.MeshStandardMaterial {
  const hueSlot = Math.floor(((id * 0.618033988749895) % 1) * 12);
  let m = bodyMats.get(hueSlot);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hueSlot / 12, 0.55, 0.52), roughness: 0.7 });
    bodyMats.set(hueSlot, m);
  }
  return m;
}

export class Avatar {
  readonly root = new THREE.Group();
  private lod = new THREE.LOD();
  private limbs: THREE.Mesh[] = [];
  private plate: THREE.Sprite;
  private plateCanvas: HTMLCanvasElement;
  private plateTex: THREE.CanvasTexture;
  private plateKey = '';
  private phase = 0;

  constructor(readonly id: number) {
    const r = res();
    const mat = bodyMat(id);

    const high = new THREE.Group();
    const body = new THREE.Mesh(r.body, mat);
    body.position.y = 1.0;
    const head = new THREE.Mesh(r.head, mat);
    head.position.y = 1.62;
    const visor = new THREE.Mesh(r.visor, r.visorMat);
    visor.position.set(0, 1.65, -0.18); // yaw 0 faces -Z (camera convention)
    high.add(body, head, visor);
    for (const [x, y] of [
      [-0.38, 1.38],
      [0.38, 1.38],
      [-0.13, 0.78],
      [0.13, 0.78],
    ]) {
      const limb = new THREE.Mesh(r.limb, mat);
      limb.position.set(x, y, 0);
      high.add(limb);
      this.limbs.push(limb);
    }
    for (const m of high.children) m.castShadow = true;

    const mid = new THREE.Group();
    const bodyMid = new THREE.Mesh(r.bodyMid, mat);
    bodyMid.position.y = 0.85;
    const headMid = new THREE.Mesh(r.headMid, mat);
    headMid.position.y = 1.62;
    const visorMid = new THREE.Mesh(r.visor, r.visorMat);
    visorMid.position.set(0, 1.65, -0.18);
    mid.add(bodyMid, headMid, visorMid);

    const low = new THREE.Mesh(r.low, mat);

    this.lod.addLevel(high, 0);
    this.lod.addLevel(mid, LOD_MID_M);
    this.lod.addLevel(low, LOD_LOW_M);
    this.root.add(this.lod);

    this.plateCanvas = document.createElement('canvas');
    this.plateCanvas.width = 512;
    this.plateCanvas.height = 128;
    this.plateTex = new THREE.CanvasTexture(this.plateCanvas);
    this.plateTex.colorSpace = THREE.SRGBColorSpace;
    this.plate = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.plateTex, depthTest: false, transparent: true }));
    this.plate.renderOrder = 10;
    this.plate.position.y = NAMEPLATE_Y;
    this.root.add(this.plate);
  }

  /** Which LOD level is showing (0 high, 1 mid, 2 low): for tests and captures. */
  get lodLevel(): number {
    return this.lod.getCurrentLevel();
  }

  update(v: RemoteView, camera: THREE.Camera, dt: number): void {
    this.root.position.set(v.x, v.y, v.z);
    this.root.rotation.y = v.yaw;

    // Walk cycle on the high LOD: limbs swing with speed; airborne tucks legs.
    const airborne = (v.activity & Activity.airborne) !== 0;
    this.phase += dt * (2.2 + v.speed * 1.4);
    const amp = airborne ? 0 : Math.min(v.speed / 5, 1) * 0.7;
    const s = Math.sin(this.phase) * amp;
    this.limbs[0].rotation.x = s;
    this.limbs[1].rotation.x = -s;
    this.limbs[2].rotation.x = airborne ? -0.6 : -s;
    this.limbs[3].rotation.x = airborne ? -0.3 : s;

    // Roughly constant on-screen size (about a fifth of the view width at
    // 75 degrees FOV), never smaller than 1.6 m up close.
    const d = camera.position.distanceTo(this.root.position);
    const w = Math.min(160, Math.max(1.6, d * 0.32));
    this.plate.scale.set(w, w / 4, 1);
    this.plate.position.y = NAMEPLATE_Y + w / 8;
    this.drawPlate(v);
  }

  private drawPlate(v: RemoteView): void {
    const labels = activityLabels(v.activity);
    const key = `${v.name}|${v.level}|${labels.join(',')}`;
    if (key === this.plateKey) return;
    this.plateKey = key;
    const c = this.plateCanvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, 512, 128);
    c.fillStyle = 'rgba(8,10,16,0.55)';
    c.beginPath();
    c.roundRect(16, 6, 480, 64, 14);
    c.fill();
    c.font = '600 40px system-ui, "Segoe UI", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#f1f3f5';
    c.fillText(`${v.name || '?'}  ·  ${v.level}`, 256, 39);
    if (labels.length) {
      c.font = '500 28px system-ui, "Segoe UI", sans-serif';
      const text = labels.join('  ');
      const w = Math.min(480, c.measureText(text).width + 28);
      c.fillStyle = 'rgba(40,90,160,0.75)';
      c.beginPath();
      c.roundRect(256 - w / 2, 80, w, 40, 12);
      c.fill();
      c.fillStyle = '#e7f5ff';
      c.fillText(text, 256, 101);
    }
    this.plateTex.needsUpdate = true;
  }

  dispose(): void {
    this.plateTex.dispose();
    (this.plate.material as THREE.SpriteMaterial).dispose();
  }
}
