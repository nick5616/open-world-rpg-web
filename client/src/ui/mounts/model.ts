// The spirit steed (playtest 2 mounts, CR 027): a low-poly, horse-like
// figure built from boxes and capsules, translucent and softly glowing in
// its colour (events.ts STEED_COLOURS). Feet at y = 0, facing -Z. Legs walk,
// trot and gallop phase-locked to ground speed (four-beat walk, diagonal
// trot, rotary gallop, blended by speed so feet never slide), the body bobs
// and rocks with the gait, the head nods, the mane ripples and the tail
// streams more the faster it goes. One rig per steed (yours under you,
// others' under them, standing ones in the SteedLayer); geometry shared,
// one material set per colour; nothing allocates per frame.

import * as THREE from 'three';
import { STEED_COLOURS } from './events';

/** Where a rider's hips sit (m above the hooves). */
export const SADDLE_Y = 1.68;
/** The rider's hands on the reins, in the steed's frame. */
export const REINS_HAND = new THREE.Vector3(0, 1.86, -0.36);

const TAU = Math.PI * 2;
const HIP_Y = 1.12;
const UPPER = 0.5;
const LOWER = 0.52;

let geo: {
  body: THREE.BufferGeometry;
  neck: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  ear: THREE.BufferGeometry;
  upper: THREE.BufferGeometry;
  lower: THREE.BufferGeometry;
  hoof: THREE.BufferGeometry;
  mane: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  saddle: THREE.BufferGeometry;
  aura: THREE.Texture;
} | null = null;

function seg(w: number, len: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, len, d);
  g.translate(0, -len / 2, 0);
  return g;
}

function auraTexture(): THREE.Texture {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = c?.getContext?.('2d') ?? null;
  if (!c || !ctx) return new THREE.Texture();
  c.width = c.height = 64;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shared() {
  if (!geo) {
    const body = new THREE.CapsuleGeometry(0.3, 1.15, 4, 10);
    body.rotateX(Math.PI / 2);
    body.scale(1, 1.08, 1);
    const neck = new THREE.BoxGeometry(0.26, 0.82, 0.34);
    neck.translate(0, 0.38, 0);
    const head = new THREE.BoxGeometry(0.24, 0.26, 0.6);
    head.translate(0, 0, -0.22);
    const ear = new THREE.ConeGeometry(0.05, 0.16, 4);
    ear.translate(0, 0.08, 0);
    const mane = new THREE.BoxGeometry(0.05, 0.22, 0.16);
    mane.translate(0, 0.1, 0);
    const tail = new THREE.BoxGeometry(0.1, 0.34, 0.1);
    tail.translate(0, -0.17, 0);
    const saddle = new THREE.BoxGeometry(0.5, 0.1, 0.5);
    geo = { body, neck, head, ear, upper: seg(0.15, UPPER, 0.18), lower: seg(0.11, LOWER, 0.12), hoof: new THREE.BoxGeometry(0.15, 0.09, 0.17), mane, tail, saddle, aura: auraTexture() };
  }
  return geo;
}

interface Mats {
  body: THREE.MeshStandardMaterial;
  glow: THREE.MeshBasicMaterial;
  aura: THREE.SpriteMaterial;
}
const mats = new Map<number, Mats>();
const saddleMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8 });
const reinMat = new THREE.LineBasicMaterial({ color: 0x3a2616 });

/** Materials for colour i; `ghost` copies for fading (arrivals, bolting) are per rig. */
function matsFor(i: number): Mats {
  const k = Math.max(0, Math.min(STEED_COLOURS.length - 1, i | 0));
  let m = mats.get(k);
  if (!m) {
    const c = STEED_COLOURS[k];
    m = {
      body: new THREE.MeshStandardMaterial({ color: c.body, emissive: c.body, emissiveIntensity: 0.38, roughness: 0.45, metalness: 0.05, transparent: true, opacity: 0.86 }),
      glow: new THREE.MeshBasicMaterial({ color: c.glow, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      aura: new THREE.SpriteMaterial({ map: shared().aura, color: c.glow, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    };
    mats.set(k, m);
  }
  return m;
}

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  /** Gait phase offsets: walk, trot, gallop. */
  off: [number, number, number];
  front: boolean;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class SteedRig {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly headG = new THREE.Group();
  private readonly legs: Leg[] = [];
  private readonly mane: THREE.Mesh[] = [];
  private readonly tail: THREE.Group[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly glows: THREE.Mesh[] = [];
  private readonly aura: THREE.Sprite;
  private readonly saddle: THREE.Mesh;
  private readonly reins: THREE.Line;
  private readonly reinPts: Float32Array;
  private colour = -1;
  private opacity = 1;
  private own: Mats | null = null;
  private phase = 0;
  private time = 0;
  /** Gait name for captures: idle, walk, trot, gallop. */
  gait: 'idle' | 'walk' | 'trot' | 'gallop' = 'idle';

  constructor(colour = 0, opts: { saddle?: boolean; reins?: boolean } = {}) {
    const g = shared();
    const m = matsFor(colour);
    const mesh = (gg: THREE.BufferGeometry, glow = false) => {
      const x = new THREE.Mesh(gg, glow ? m.glow : m.body);
      if (glow) this.glows.push(x);
      else {
        x.castShadow = true;
        this.meshes.push(x);
      }
      return x;
    };
    this.body.position.y = 1.28;
    this.root.add(this.body);
    this.body.add(mesh(g.body));
    // neck and head
    this.neck.position.set(0, 0.12, -0.7);
    this.neck.rotation.x = -0.55;
    this.body.add(this.neck);
    this.neck.add(mesh(g.neck));
    this.headG.position.set(0, 0.78, 0);
    this.headG.rotation.x = -0.1;
    this.neck.add(this.headG);
    this.headG.add(mesh(g.head));
    for (const s of [-1, 1]) {
      const ear = mesh(g.ear);
      ear.position.set(s * 0.08, 0.12, 0.02);
      this.headG.add(ear);
    }
    // mane: glowing tufts along the neck's crest
    for (let i = 0; i < 6; i++) {
      const t = mesh(g.mane, true);
      t.position.set(0, 0.1 + i * 0.13, 0.16);
      this.neck.add(t);
      this.mane.push(t);
    }
    // tail: a chain of glowing segments
    let parent: THREE.Object3D = this.body;
    for (let i = 0; i < 4; i++) {
      const j = new THREE.Group();
      j.position.set(0, i === 0 ? 0.18 : -0.3, i === 0 ? 0.88 : 0);
      if (i === 0) j.rotation.x = -0.7;
      parent.add(j);
      j.add(mesh(g.tail, true));
      this.tail.push(j);
      parent = j;
    }
    // legs: [x, z, front]
    const L: [number, number, boolean, [number, number, number]][] = [
      [-0.18, -0.55, true, [0.25, 0.5, 0.4]], // left fore
      [0.18, -0.55, true, [0.75, 0, 0.55]], // right fore
      [-0.18, 0.6, false, [0, 0, 0]], // left hind
      [0.18, 0.6, false, [0.5, 0.5, 0.15]], // right hind
    ];
    for (const [x, z, front, off] of L) {
      const hip = new THREE.Group();
      hip.position.set(x, HIP_Y - 1.28, z);
      this.body.add(hip);
      hip.add(mesh(g.upper));
      const knee = new THREE.Group();
      knee.position.y = -UPPER;
      hip.add(knee);
      knee.add(mesh(g.lower));
      const hoof = mesh(g.hoof);
      hoof.position.y = -LOWER;
      knee.add(hoof);
      this.legs.push({ hip, knee, off, front });
    }
    this.saddle = new THREE.Mesh(g.saddle, saddleMat);
    this.saddle.position.set(0, 0.32, -0.12);
    this.saddle.visible = opts.saddle !== false;
    this.body.add(this.saddle);
    this.reinPts = new Float32Array(9);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.reinPts, 3));
    this.reins = new THREE.Line(rg, reinMat);
    this.reins.frustumCulled = false;
    this.reins.visible = !!opts.reins;
    this.root.add(this.reins);
    this.aura = new THREE.Sprite(m.aura);
    this.aura.scale.set(3.2, 2.4, 1);
    this.aura.position.y = 1.1;
    this.aura.renderOrder = 4;
    this.root.add(this.aura);
    this.colour = colour;
  }

  /** Show colour i (STEED_COLOURS index). */
  setColour(i: number): void {
    if (i === this.colour) return;
    this.colour = i;
    this.own = null;
    this.applyMats();
  }

  /** Fade (materializing, bolting): 0 invisible .. 1 solid. */
  setOpacity(a: number): void {
    const v = Math.max(0, Math.min(1, a));
    if (Math.abs(v - this.opacity) < 0.01) return;
    this.opacity = v;
    if (v < 0.999 && !this.own) {
      const b = matsFor(this.colour);
      this.own = { body: b.body.clone(), glow: b.glow.clone(), aura: b.aura.clone() };
      this.applyMats();
    }
    if (this.own) {
      this.own.body.opacity = 0.86 * v;
      this.own.glow.opacity = 0.9 * v;
      this.own.aura.opacity = 0.35 + 0.4 * (1 - v) * (v > 0.02 ? 1 : 0);
    }
    this.root.visible = v > 0.01;
  }

  private applyMats(): void {
    const m = this.own ?? matsFor(this.colour);
    for (const x of this.meshes) x.material = m.body;
    for (const x of this.glows) x.material = m.glow;
    this.aura.material = m.aura;
  }

  /**
   * Advance dt seconds at ground speed `speed` (m/s); `air` = mid-jump
   * (legs tucked), `vy` its vertical speed. `reins`: draw them to the
   * rider's hands.
   */
  update(dt: number, speed: number, air = false, vy = 0): void {
    dt = Math.min(0.1, Math.max(0, dt));
    this.time += dt;
    const sp = Math.max(0, speed);
    const walkW = 1 - smooth(3, 5.5, sp);
    const gallopW = smooth(9.5, 12.5, sp);
    const trotW = Math.max(0, 1 - walkW - gallopW);
    this.gait = sp < 0.25 ? 'idle' : gallopW > 0.5 ? 'gallop' : trotW > 0.5 ? 'trot' : 'walk';
    const stride = 1.7 * walkW + 2.6 * trotW + 4.2 * gallopW; // m per cycle
    this.phase = (this.phase + (dt * sp) / stride) % 1000;
    const amp = Math.min(1, sp / 2) * (0.38 * walkW + 0.5 * trotW + 0.72 * gallopW);
    const idle = sp < 0.25;
    for (const l of this.legs) {
      const off = l.off[0] * walkW + l.off[1] * trotW + l.off[2] * gallopW;
      const a = TAU * (this.phase + off);
      const s = Math.sin(a);
      const lift = Math.max(0, Math.sin(a + 0.9));
      if (air) {
        l.hip.rotation.x = l.front ? 0.9 : -0.7;
        l.knee.rotation.x = l.front ? -1.6 : 1.3;
      } else if (idle) {
        l.hip.rotation.x = 0.02 * Math.sin(this.time * 1.3 + off * 6);
        l.knee.rotation.x = 0;
      } else {
        l.hip.rotation.x = s * amp * (l.front ? 1 : 0.85);
        l.knee.rotation.x = (l.front ? -1 : 1) * lift * (0.5 + 0.9 * amp);
      }
    }
    // body: bob with each beat, rock fore and aft at a gallop
    const beat = Math.sin(TAU * this.phase * 2);
    const rock = Math.sin(TAU * this.phase);
    this.body.position.y = 1.28 + (idle ? 0.012 * Math.sin(this.time * 1.6) : -Math.abs(beat) * 0.05 * (trotW + gallopW) + 0.02);
    this.body.rotation.x = air ? Math.max(-0.35, Math.min(0.3, -vy * 0.05)) : rock * 0.07 * gallopW;
    // head nods with the gait, lifts when idle
    this.headG.rotation.x = -0.1 + (idle ? 0.05 * Math.sin(this.time * 0.7) : rock * (0.08 + 0.12 * gallopW));
    this.neck.rotation.x = -0.55 - 0.25 * gallopW + (idle ? 0.03 * Math.sin(this.time * 0.5) : 0);
    // mane ripples, tail streams out behind with speed
    const flow = Math.min(1, sp / 13);
    for (let i = 0; i < this.mane.length; i++) this.mane[i].rotation.x = 0.35 * flow + Math.sin(this.time * (5 + 6 * flow) - i * 0.9) * (0.12 + 0.22 * flow);
    for (let i = 0; i < this.tail.length; i++) {
      const base = i === 0 ? 0.7 + 1.0 * flow : 0.15 * flow;
      this.tail[i].rotation.x = -base + Math.sin(this.time * (3 + 5 * flow) - i * 1.1) * (0.08 + 0.18 * flow);
      this.tail[i].rotation.z = Math.sin(this.time * 2.1 - i * 0.7) * 0.15 * (1 - flow * 0.5);
    }
    this.aura.material.rotation = this.time * 0.2;
    if (this.reins.visible) this.reinsTo(REINS_HAND);
  }

  private readonly tmp = new THREE.Vector3();

  /** Reins from the bit (both sides of the head) to the hands (steed frame). */
  reinsTo(hand: THREE.Vector3): void {
    this.root.updateMatrixWorld();
    const inv = this.tmp;
    this.headG.updateWorldMatrix(true, false);
    inv.set(0, -0.08, -0.4).applyMatrix4(this.headG.matrixWorld);
    this.root.worldToLocal(inv);
    const p = this.reinPts;
    p[0] = inv.x - 0.13;
    p[1] = inv.y;
    p[2] = inv.z;
    p[3] = hand.x;
    p[4] = hand.y;
    p[5] = hand.z;
    p[6] = inv.x + 0.13;
    p[7] = inv.y;
    p[8] = inv.z;
    (this.reins.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.reins.geometry.dispose();
    if (this.own) {
      this.own.body.dispose();
      this.own.glow.dispose();
      this.own.aura.dispose();
    }
  }
}
