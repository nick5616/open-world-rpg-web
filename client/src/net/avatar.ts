// Player model (spec 12: "remote players get a third-person model with 3
// LODs and a nameplate"), built imperatively: one THREE.LOD per player,
// geometries and materials shared by every avatar, no React per entity
// (spec 12: the world is not one React component per object). Also the
// local player's own body in third person (scene/LocalAvatar.tsx).
//
// Playtest 2 ("it feels a little lifeless looking at other players"): the
// near figure is a jointed rig (hips, torso, neck, shoulders + elbows, hips
// + knees) posed every frame by AvatarAnimator (avatarAnim.ts: locomotion,
// look, weapon swings, casts with a hand glow, parry, mining, dodge roll,
// hurt, downed). LOD, cheapest first:
//   < 25 m   full rig, every joint animated, hand glow (12-13 draw calls)
//   25-80 m  capsule + head + the weapon on a shoulder pivot: whole-body
//            motion (bob, lean, roll, spin, lying down) and the weapon arm's
//            swing only (4 draw calls, as before playtest 2)
//   > 80 m   one box, no animation at all (the animator isn't even stepped)
// The nameplate is a canvas-texture sprite (no font download, works
// offline), redrawn only when the name, level or activity flags change, and
// scaled with distance so far-ring silhouettes keep a readable label.
// Nothing here allocates per frame.

import * as THREE from 'three';
import { Activity } from '@lodestone/contracts';
import type { RemoteView } from './interpolation';
import { isSpeaking } from '../voice/levels';
import { unpackLook, type WeaponKind } from '../combat/weapons/look';
import { weaponGeometry } from '../combat/weapons/models';
import { weaponMaterial } from '../combat/weapons/material';
import { AvatarAnimator, type AnimInput, type LimbPose, type Pose } from './avatarAnim';
import { MARK_COLOR, drawSwords, pvpMark } from '../ui/pvp/plate';

export const LOD_MID_M = 25;
export const LOD_LOW_M = 80;

/**
 * A crowd cap on full rigs: when more than `max` players were inside the
 * full-rig radius last frame, the radius shrinks (to at least 8 m) until
 * about that many are; it grows back to LOD_MID_M as the crowd thins. One
 * per renderer, stepped once a frame with last frame's count.
 */
export class FullRigBudget {
  radius = LOD_MID_M;
  constructor(readonly max = 32) {}
  step(fullLastFrame: number): number {
    if (fullLastFrame > this.max) this.radius = Math.max(8, this.radius * 0.92);
    else if (fullLastFrame < this.max * 0.75) this.radius = Math.min(LOD_MID_M, this.radius * 1.03 + 0.05);
    return this.radius;
  }
}
const NAMEPLATE_Y = 2.25;

// Rig dimensions (m, rest pose). Feet at y = 0, facing -Z.
const HIP_Y = 0.88;
const TORSO_Y = 0.04; // lower-spine pivot above the hips
const SHOULDER = { x: 0.36, y: 0.5 }; // in the torso frame (1.42 m)
const NECK_Y = 0.62; // in the torso frame (1.54 m)
const UPPER_ARM = 0.32;
const FOREARM = 0.3;
const THIGH = 0.44;
const SHIN = 0.44;
const HIP_X = 0.13;

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
  chest: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  visor: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  forearm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  bodyMid: THREE.BufferGeometry;
  headMid: THREE.BufferGeometry;
  low: THREE.BufferGeometry;
  visorMat: THREE.Material;
  legMat: THREE.Material;
  skinMat: THREE.Material;
  hand: THREE.BufferGeometry;
  /** WP10: the glider wing shown while the activity bit says gliding. */
  glider: THREE.BufferGeometry;
  gliderMat: THREE.Material;
  glowTex: THREE.Texture;
} | null = null;
const bodyMats = new Map<number, THREE.MeshStandardMaterial>();
const glowMats = new Map<string, THREE.SpriteMaterial>();

/** A limb segment: a rounded box hanging from its joint (pivot at the top). */
function segment(w: number, len: number, d: number): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(Math.min(w, d) / 2, Math.max(0.01, len - Math.min(w, d)), 3, 8);
  g.translate(0, -len / 2, 0);
  return g;
}

function glowTexture(): THREE.Texture {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = c?.getContext?.('2d') ?? null;
  if (!c || !ctx) return new THREE.Texture();
  c.width = c.height = 64;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function res() {
  if (!shared) {
    shared = {
      chest: new THREE.CapsuleGeometry(0.25, 0.36, 4, 12),
      head: new THREE.SphereGeometry(0.2, 16, 12),
      visor: new THREE.BoxGeometry(0.26, 0.08, 0.06),
      upperArm: segment(0.13, UPPER_ARM + 0.04, 0.13),
      forearm: segment(0.11, FOREARM + 0.03, 0.11),
      thigh: segment(0.16, THIGH + 0.04, 0.16),
      shin: segment(0.13, SHIN + 0.02, 0.13),
      bodyMid: new THREE.CapsuleGeometry(0.3, 0.75, 2, 4),
      headMid: new THREE.SphereGeometry(0.2, 6, 4),
      low: new THREE.BoxGeometry(0.6, 1.8, 0.4),
      visorMat: new THREE.MeshStandardMaterial({ color: 0x1b1f2a, roughness: 0.3, metalness: 0.4 }),
      // playtest 2: legs and head read apart from the coloured tunic (same draw calls)
      legMat: new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.85 }),
      // playtest 2: the same skin and shirt as your first-person arms (FirstPersonArms SKIN / SLEEVE)
      skinMat: new THREE.MeshStandardMaterial({ color: 0xc9a27e, roughness: 0.7 }),
      hand: new THREE.SphereGeometry(0.06, 10, 8),
      glider: new THREE.BoxGeometry(2.2, 0.04, 0.9),
      gliderMat: new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.8, side: THREE.DoubleSide }),
      glowTex: glowTexture(),
    };
    shared.low.translate(0, 0.9, 0);
  }
  return shared;
}

/**
 * The tunic: the navy shirt of your first-person sleeves (playtest 2: "I have
 * a blue shirt and a white skin hand, make me look like that"), with a slight
 * per-player shade (golden-ratio spread over 12 slots) so a crowd isn't clones.
 */
export const SHIRT = 0x3b4a6b;
function bodyMat(id: number): THREE.MeshStandardMaterial {
  const hueSlot = Math.floor(((id * 0.618033988749895) % 1) * 12);
  let m = bodyMats.get(hueSlot);
  if (!m) {
    const c = new THREE.Color(SHIRT);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(hsl.h + (hueSlot - 6) * 0.01, hsl.s + ((hueSlot % 3) - 1) * 0.04, hsl.l + ((hueSlot % 4) - 1.5) * 0.02);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
    bodyMats.set(hueSlot, m);
  }
  return m;
}

/** One additive sprite material per glow colour (spells, forms), shared by every avatar. */
function glowMat(color: string): THREE.SpriteMaterial {
  let m = glowMats.get(color);
  if (!m) {
    m = new THREE.SpriteMaterial({ map: res().glowTex, color: new THREE.Color(color), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    glowMats.set(color, m);
  }
  return m;
}

/**
 * pt/ux: how a player holds each weapon, in the hanging arm's frame (the
 * hand at the end of the arm; the character faces -Z): where the weapon's
 * +Y points and where its +Z faces. The bow goes in the left hand.
 */
const HOLD: Record<WeaponKind, { up: [number, number, number]; face: [number, number, number]; left?: boolean }> = {
  // playtest 2: angled out ahead of the (bent) forearm, so a third-person
  // camera behind the player sees the blade instead of it hiding along the arm
  sword: { up: [0.3, 0.3, -1], face: [1, 0, 0] },
  spear: { up: [0.08, 0.5, -1], face: [1, 0, 0] },
  bow: { up: [0, 1, -0.15], face: [0, 0, 1], left: true },
  staff: { up: [0.05, 1, -0.3], face: [1, 0, 0] },
  wand: { up: [0.25, 0.3, -1], face: [1, 0, 0] },
};
/** Mid LOD: the weapon hangs this far below its shoulder pivot (the old one-piece arm's hand). */
const MID_HAND_Y = -0.66;

function holdQuat(kind: WeaponKind): THREE.Quaternion {
  const h = HOLD[kind];
  const y = new THREE.Vector3(...h.up).normalize();
  const z = new THREE.Vector3(...h.face);
  z.addScaledVector(y, -z.dot(y)).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, z), y, z));
}

interface Arm {
  shoulder: THREE.Group;
  elbow: THREE.Group;
  hand: THREE.Group;
  glow: THREE.Sprite;
}
interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
}

export interface AvatarOptions {
  /** Draw the floating name/level plate (off for your own body). */
  nameplate?: boolean;
}

export class Avatar {
  readonly root = new THREE.Group();
  readonly anim = new AvatarAnimator();
  /** pt/ux: the equipped weapon (snapshot typeId, weapons/look.ts): in the hand (high LOD) and on the shoulder pivot (mid LOD). */
  private weaponHi: THREE.Mesh;
  private weaponMid: THREE.Mesh;
  /** The weapon look typeId shown (pt/ux packLook; CR 022: the gem tints its swing FX). */
  weaponType = -1;
  /** The weapon kind in hand (classifies Event 214 actions). */
  weaponKind: WeaponKind | null = null;
  /** The three figures (high, mid, low); only the one in use is in the scene graph. */
  private levels: THREE.Object3D[] = [];
  private shown = -1;
  private plate: THREE.Sprite | null = null;
  private plateCanvas: HTMLCanvasElement | null = null;
  private plateTex: THREE.CanvasTexture | null = null;
  private plateName = '\u0000';
  private plateLevel = -1;
  private plateAct = -1;
  private plateMark = '';
  private high: THREE.Group;
  private glider: THREE.Mesh;
  // the rig
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private neck = new THREE.Group();
  private armL: Arm;
  private armR: Arm;
  private legL: Leg;
  private legR: Leg;
  // mid LOD motion
  private midBody = new THREE.Group();
  private midArmR = new THREE.Group();
  private midArmL = new THREE.Group();
  /** Distance band chosen this frame: 0 full, 1 simplified, 2 none. */
  animLevel = 0;
  private readonly input: AnimInput = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, activity: 0, healthPct: 100 };

  constructor(
    readonly id: number,
    opts: AvatarOptions = {},
  ) {
    const r = res();
    const mat = bodyMat(id);
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material = mat) => {
      const x = new THREE.Mesh(g, m);
      x.castShadow = true;
      return x;
    };

    // ---- high: the jointed rig
    const high = new THREE.Group();
    this.body.position.y = HIP_Y;
    this.body.rotation.order = 'YXZ';
    high.add(this.body);
    this.torso.position.y = TORSO_Y;
    this.torso.rotation.order = 'YXZ';
    this.body.add(this.torso);
    const chest = mesh(r.chest);
    chest.position.y = 0.25;
    this.torso.add(chest);
    this.neck.position.y = NECK_Y;
    this.torso.add(this.neck);
    const head = mesh(r.head, r.skinMat);
    head.position.y = 0.12;
    const visor = mesh(r.visor, r.visorMat);
    visor.position.set(0, 0.15, -0.18); // yaw 0 faces -Z (camera convention)
    this.neck.add(head, visor);
    const arm = (side: number): Arm => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * SHOULDER.x, SHOULDER.y, 0);
      const upper = mesh(r.upperArm);
      const elbow = new THREE.Group();
      elbow.position.y = -UPPER_ARM;
      const fore = mesh(r.forearm);
      const hand = new THREE.Group();
      hand.position.y = -FOREARM;
      const palm = mesh(r.hand, r.skinMat);
      palm.scale.set(1, 1.15, 0.8);
      hand.add(palm);
      const glow = new THREE.Sprite(glowMat('#ffffff'));
      glow.visible = false;
      glow.renderOrder = 5;
      hand.add(glow);
      elbow.add(fore, hand);
      shoulder.add(upper, elbow);
      this.torso.add(shoulder);
      return { shoulder, elbow, hand, glow };
    };
    this.armL = arm(-1);
    this.armR = arm(1);
    const leg = (side: number): Leg => {
      const hip = new THREE.Group();
      hip.position.set(side * HIP_X, 0, 0);
      const thigh = mesh(r.thigh, r.legMat);
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      knee.add(mesh(r.shin, r.legMat));
      hip.add(thigh, knee);
      this.body.add(hip);
      return { hip, knee };
    };
    this.legL = leg(-1);
    this.legR = leg(1);
    this.high = high;
    // WP10: a simple wing above the head, held by the raised arms while gliding.
    this.glider = new THREE.Mesh(r.glider, r.gliderMat);
    this.glider.position.set(0, 2.25, 0);
    this.glider.visible = false;
    this.root.add(this.glider);

    // ---- mid: capsule + head, whole-body motion, the weapon on a shoulder pivot
    const mid = new THREE.Group();
    this.midBody.position.y = HIP_Y;
    this.midBody.rotation.order = 'YXZ';
    mid.add(this.midBody);
    const bodyMid = new THREE.Mesh(r.bodyMid, mat);
    bodyMid.position.y = 0.85 - HIP_Y;
    bodyMid.castShadow = true;
    const headMid = new THREE.Mesh(r.headMid, mat);
    headMid.position.y = 1.62 - HIP_Y;
    const visorMid = new THREE.Mesh(r.visor, r.visorMat);
    visorMid.position.set(0, 1.65 - HIP_Y, -0.18);
    this.midArmR.position.set(0.38, 1.38 - HIP_Y, 0);
    this.midArmL.position.set(-0.38, 1.38 - HIP_Y, 0);
    this.midBody.add(bodyMid, headMid, visorMid, this.midArmR, this.midArmL);

    this.weaponHi = new THREE.Mesh(undefined, weaponMaterial());
    this.weaponHi.castShadow = true;
    this.weaponHi.visible = false;
    this.weaponMid = new THREE.Mesh(undefined, weaponMaterial());
    this.weaponMid.visible = false;

    const low = new THREE.Mesh(r.low, mat);

    // Manual LOD (not THREE.LOD): the figures not in use stay out of the
    // graph, so neither the world-matrix pass nor the renderer walks them.
    this.levels = [high, mid, low];

    if (opts.nameplate !== false) {
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
  }

  /** Which LOD level is showing (0 high, 1 mid, 2 low): for tests and captures. */
  get lodLevel(): number {
    return Math.max(0, this.shown);
  }

  /** pt/ux: show the weapon a player entity's typeId names (only rebuilt when it changes). */
  setWeapon(typeId: number): void {
    this.weaponType = typeId;
    const look = unpackLook(typeId);
    this.weaponKind = look.weapon;
    this.weaponHi.removeFromParent();
    this.weaponMid.removeFromParent();
    if (!look.weapon) {
      this.weaponHi.visible = this.weaponMid.visible = false;
      return;
    }
    const h = HOLD[look.weapon];
    const q = holdQuat(look.weapon);
    this.weaponHi.geometry = weaponGeometry(look, 2); // playtest 2: the same model as in first person
    this.weaponHi.quaternion.copy(q);
    this.weaponHi.position.set(0, 0, 0);
    (h.left ? this.armL : this.armR).hand.add(this.weaponHi);
    this.weaponMid.geometry = weaponGeometry(look, 0);
    this.weaponMid.quaternion.copy(q);
    this.weaponMid.position.set(0, MID_HAND_Y, 0);
    (h.left ? this.midArmL : this.midArmR).add(this.weaponMid);
    this.weaponHi.visible = this.weaponMid.visible = true;
  }

  /** The weapon in the hand, for tests and captures (null when none). */
  get weaponMesh(): THREE.Mesh | null {
    return this.weaponHi.visible ? this.weaponHi : null;
  }

  /** The current pose (tests, captures). */
  get pose(): Pose {
    return this.anim.pose;
  }

  /**
   * Per frame: place, pick the animation band from the camera distance,
   * step the animator and pose the rig. `typeId` is the weapon look.
   */
  update(v: RemoteView, camera: THREE.Camera, dt: number, fullM: number = LOD_MID_M): void {
    this.root.position.set(v.x, v.y, v.z);
    this.root.rotation.y = v.yaw;
    if ((v.typeId ?? 0) !== this.weaponType) this.setWeapon(v.typeId ?? 0);

    const d = camera.position.distanceTo(this.root.position);
    // 1 m of hysteresis at each band edge: no flicker for someone standing on it
    const s = this.shown;
    const mid = fullM + (s === 0 ? 1 : s === 1 ? -1 : 0);
    const low = LOD_LOW_M + (s === 1 ? 1 : s === 2 ? -1 : 0);
    this.animLevel = d < mid ? 0 : d < low ? 1 : 2;
    if (this.animLevel !== this.shown) {
      if (this.shown >= 0) this.root.remove(this.levels[this.shown]);
      this.root.add(this.levels[this.animLevel]);
      this.shown = this.animLevel;
    }
    const glider = (v.activity & Activity.gliding) !== 0;
    this.glider.visible = glider;
    if (this.animLevel < 2) {
      const inp = this.input;
      inp.x = v.x;
      inp.y = v.y;
      inp.z = v.z;
      inp.yaw = v.yaw;
      inp.pitch = v.pitch;
      inp.speed = v.speed;
      inp.activity = v.activity;
      inp.healthPct = v.healthPct;
      const p = this.anim.update(inp, dt);
      this.glider.visible = p.glider;
      if (this.animLevel === 0) this.applyFull(p);
      else this.applyMid(p);
    }

    if (this.plate) {
      // Roughly constant on-screen size (about a twelfth of the view width
      // at 75 degrees FOV), never smaller than 0.6 m up close (playtest 2: a
      // player beside you had a nameplate wider than they were).
      const w = Math.min(60, Math.max(0.6, d * 0.12));
      this.plate.scale.set(w, w / 4, 1);
      this.plate.position.y = NAMEPLATE_Y + w / 8;
      this.drawPlate(v);
    }
  }

  private applyFull(p: Pose): void {
    this.body.position.y = HIP_Y + p.bodyY;
    this.body.rotation.set(p.bodyPitch, p.bodyYaw, p.bodyRoll);
    this.torso.rotation.set(p.torsoPitch, p.torsoYaw, 0);
    this.neck.rotation.x = p.headPitch;
    poseArm(this.armR, p.armR, 1);
    poseArm(this.armL, p.armL, -1);
    poseLeg(this.legR, p.legR, 1);
    poseLeg(this.legL, p.legL, -1);
    this.glowHand(this.armL, p.glowL, p);
    this.glowHand(this.armR, p.glowR, p);
  }

  private glowHand(a: Arm, on: boolean, p: Pose): void {
    const show = on && p.glow > 0.02 && !!p.glowColor;
    a.glow.visible = show;
    if (!show) return;
    const m = glowMat(p.glowColor!);
    if (a.glow.material !== m) a.glow.material = m;
    const s = 0.25 + 0.35 * p.glow;
    a.glow.scale.set(s, s, s);
  }

  private applyMid(p: Pose): void {
    this.midBody.position.y = HIP_Y + p.bodyY;
    this.midBody.rotation.set(p.bodyPitch + p.torsoPitch * 0.5, p.bodyYaw + p.torsoYaw, p.bodyRoll);
    this.midArmR.rotation.set(p.armR.swing + p.armR.bend * 0.5, 0, p.armR.spread);
    this.midArmL.rotation.set(p.armL.swing + p.armL.bend * 0.5, 0, -p.armL.spread);
  }

  private drawPlate(v: RemoteView): void {
    // WP11: someone we hear shows "speaking" from our own analyser at once,
    // without waiting for the zone's activity bit to round-trip.
    // CR 022: a player's casting bit means "holding a spell or a dash": their pose shows it, not the plate.
    const shown = v.kind === 1 ? v.activity & ~Activity.casting : v.activity;
    const act = isSpeaking(v.name) ? shown | Activity.speaking : shown;
    const mark = pvpMark(v.typeId); // playtest 2 (CR 019): red crossed swords = flagged for PvP, gold = dueling
    if (v.name === this.plateName && v.level === this.plateLevel && act === this.plateAct && mark === this.plateMark) return;
    this.plateName = v.name;
    this.plateLevel = v.level;
    this.plateAct = act;
    this.plateMark = mark;
    const labels = activityLabels(act);
    const c = this.plateCanvas?.getContext('2d');
    if (!c || !this.plateTex) return;
    c.clearRect(0, 0, 512, 128);
    c.fillStyle = 'rgba(8,10,16,0.55)';
    c.beginPath();
    c.roundRect(16, 6, 480, 64, 14);
    c.fill();
    c.font = '600 40px system-ui, "Segoe UI", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#f1f3f5';
    const label = `${v.name || '?'}  ·  ${v.level}`;
    c.fillText(label, mark ? 276 : 256, 39);
    if (mark) drawSwords(c, Math.max(44, 276 - Math.min(400, c.measureText(label).width) / 2 - 30), 39, 44, MARK_COLOR[mark]);
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
    this.plateTex?.dispose();
    (this.plate?.material as THREE.SpriteMaterial | undefined)?.dispose();
  }
}

function poseArm(a: Arm, l: LimbPose, side: number): void {
  // 'XYZ': spread (z) first, then the twist, then the swing about the shoulder.
  a.shoulder.rotation.set(l.swing, side * l.twist, side * l.spread);
  a.elbow.rotation.x = l.bend;
}

function poseLeg(g: Leg, l: LimbPose, side: number): void {
  g.hip.rotation.set(l.swing, 0, side * l.spread);
  g.knee.rotation.x = -l.bend;
}
