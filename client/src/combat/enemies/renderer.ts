// The enemy renderer (playtest 2 enemy models): every enemy and summoned
// ally on screen, drawn instanced. One InstancedMesh per (part geometry,
// material) — a pack of five wolves is one draw per wolf part, two hundred
// slimes are three draws — so the draw-call count follows the number of
// distinct variants in view, not the number of enemies.
//
// LOD (camera distance, x the model's size for big ones):
//   full  < FULL_M (shrinks under a crowd: FULL_MAX rigs at most): every
//         joint posed by pose.ts, head tracking, every part drawn
//   mid   < MID_M: the variant's rest pose merged into one geometry, moved
//         by the body joint only (bob, squash, lean, the death fall)
//   far   beyond: one shared low box tinted with the enemy colour
// Enemies outside the view frustum are animated (cheap, pure) but not
// drawn. Nothing allocates per frame: enemy records, pose buffers and
// matrices are reused, the batches only grow (doubling) when a crowd needs it.

import * as THREE from 'three';
import type { RemoteView } from '../../net/interpolation';
import { COMBAT } from '@lodestone/contracts';
import { enemyInfo } from '../events';
import { EnemyAnimator, attackAnim, defaultAttack, type AnimInput } from './anim';
import { isPetTypeId, modelSpec, petSpec, summonSpec, type ModelSpec, type Rig } from './spec';
import { modelFor, farGeometry, type MatKind, type Model } from './models';
import { MAX_JOINTS, POSE_STRIDE } from './rigs';
import { writePose, type PoseCtx } from './pose';
import { auraMaterials, barMaterials, enemyMat, enemyUniforms } from './material';
import { PartBuilder, rng } from './geometry';
import { flashProfile } from '../flashSafety';

export const FULL_M = 38;
export const MID_M = 95;
export const FULL_MAX = 48;
/** The zone holds flyers this far above the ground (combat ai.go stepMove). */
const FLY_M = 1.5;
const BAR_M = 45;

/** Locomotion tuning per rig (at size 1): full-cycle speed and metres per cycle. */
const GAIT: Record<Rig, { ref: number; stride: number }> = {
  slime: { ref: 3, stride: 1.1 },
  quadruped: { ref: 5, stride: 1.5 },
  crawler: { ref: 4.5, stride: 0.9 },
  biped: { ref: 4, stride: 1.7 },
  floater: { ref: 4, stride: 2 },
  winged: { ref: 5, stride: 2 },
};

const STATUS = new Map(COMBAT.statuses.map((s) => [s.id, s]));

interface Batch {
  mesh: THREE.InstancedMesh;
  src: THREE.BufferGeometry;
  mat: THREE.Material;
  fx: THREE.InstancedBufferAttribute;
  cap: number;
  n: number;
  shadow: boolean;
  colored: boolean;
}

interface Enemy {
  id: number;
  ally: boolean;
  /** CR 029: a tamed pet (an ally with real health and a collar). */
  pet: boolean;
  typeId: number;
  spec: ModelSpec;
  model: Model;
  anim: EnemyAnimator;
  pose: Float32Array;
  phase: number;
  side: number;
  look: number;
  lookPitch: number;
  /** Drawn position / yaw (held through hitstop) and the last view seen. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  health: number;
  name: string;
  seen: number;
  /** The view vanished (corpse removed, ally expired): play out the death, then drop. */
  gone: boolean;
  deathFx: boolean;
  label: THREE.Sprite | null;
  lod: number;
}

export interface EnemyRenderStats {
  enemies: number;
  drawn: number;
  full: number;
  mid: number;
  far: number;
  culled: number;
  batches: number;
  drawCalls: number;
  instances: number;
  debris: number;
  fullRadius: number;
  updateMs: number;
}

const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _mid = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _world: THREE.Matrix4[] = Array.from({ length: MAX_JOINTS }, () => new THREE.Matrix4());
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _camPos = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _col = new THREE.Color();
const _fx = [0, 0, 0, 0];
const _input: AnimInput = { speed: 0, yaw: 0, y: 0, healthPct: 100, winding: false };

const MAX_DEBRIS = 256;

export class EnemyRenderer {
  readonly root = new THREE.Group();
  private enemies = new Map<number, Enemy>();
  private batches = new Map<string, Batch>();
  private batchList: Batch[] = [];
  private frame = 0;
  private fullRadius = FULL_M;
  private fullLast = 0;
  private ctx: PoseCtx;
  // overlays
  private barBack: THREE.InstancedMesh;
  private barFill: THREE.InstancedMesh;
  private auraStrong: THREE.InstancedMesh;
  private auraSoft: THREE.InstancedMesh;
  private barCap = 0;
  private auraCap = 0;
  // death debris (opaque, jelly, glowing)
  private debrisMeshes: THREE.InstancedMesh[] = [];
  private dPos = new Float32Array(MAX_DEBRIS * 3);
  private dVel = new Float32Array(MAX_DEBRIS * 3);
  private dLife = new Float32Array(MAX_DEBRIS);
  private dMax = new Float32Array(MAX_DEBRIS);
  private dSize = new Float32Array(MAX_DEBRIS);
  private dGround = new Float32Array(MAX_DEBRIS);
  private dKind = new Uint8Array(MAX_DEBRIS); // 0 chunk, 1 jelly, 2 glow, 3 puff (rises, grows)
  private dCol = new Float32Array(MAX_DEBRIS * 3);
  private dNext = 0;
  /** iFx.w of glowing death motes (-1 none .. 0 full glow) and the debris count multiplier: the flash profile. */
  private debrisGlow = -0.8;
  private debrisCount = 0.6;
  private lastStats: EnemyRenderStats = { enemies: 0, drawn: 0, full: 0, mid: 0, far: 0, culled: 0, batches: 0, drawCalls: 0, instances: 0, debris: 0, fullRadius: FULL_M, updateMs: 0 };
  /** Where the head tracking looks (the local player's chest), set by the layer each frame. */
  readonly target = new THREE.Vector3();

  constructor() {
    this.root.name = 'enemies';
    this.ctx = { a: null as unknown as EnemyAnimator, spec: null as unknown as ModelSpec, look: 0, lookPitch: 0, phase: 0, side: 1, drop: 0.5 };
    const bm = barMaterials();
    const bar = new THREE.PlaneGeometry(1, 0.06);
    this.barBack = new THREE.InstancedMesh(bar, bm.back, 1);
    this.barFill = new THREE.InstancedMesh(bar, bm.fill, 1);
    this.barBack.renderOrder = 10;
    this.barFill.renderOrder = 11;
    const ring = new THREE.RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2);
    const am = auraMaterials();
    this.auraStrong = new THREE.InstancedMesh(ring, am.strong, 1);
    this.auraSoft = new THREE.InstancedMesh(ring, am.soft, 1);
    for (const m of [this.barBack, this.barFill, this.auraStrong, this.auraSoft]) {
      m.frustumCulled = false;
      m.count = 0;
      this.root.add(m);
    }
    this.growOverlays(64);
    // debris: a faceted chunk (opaque / jelly) and a glowing mote, tinted per instance
    const chunk = new PartBuilder(rng(9)).ball(0.5, '#ffffff', { detail: 0, jitter: 0.1 }).build('enemy#debris');
    const mote = new PartBuilder(rng(9)).ball(0.5, '#ffffff', { detail: 0, glow: 1, jitter: 0 }).build('enemy#mote');
    for (const [g, kind] of [
      [chunk, 'opaque'],
      [chunk, 'jelly'],
      [mote, 'opaque'],
    ] as const) {
      const geo = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'color', 'glow']) geo.setAttribute(k, g.getAttribute(k));
      geo.setAttribute('iFx', new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 4), 4));
      const im = new THREE.InstancedMesh(geo, enemyMat(kind), MAX_DEBRIS);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
      this.debrisMeshes.push(im);
      this.root.add(im);
    }
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** Telegraph Event 204: attack id, wind-up and active ms. */
  telegraph(id: number, attackId: number, windupMs: number, activeMs?: number): void {
    const e = this.enemies.get(id);
    if (!e) return;
    const a = attackAnim(attackId);
    e.anim.telegraph(a, windupMs || a.windupMs, activeMs || a.activeMs);
  }

  /** A confirmed (or predicted) hit on this enemy: flash + flinch. */
  hit(id: number, heavy = false): boolean {
    const e = this.enemies.get(id);
    if (!e) return false;
    e.anim.hit(heavy);
    return true;
  }

  /** A hit with no target id (the old spark): the nearest enemy within 2.5 m. */
  hitNear(x: number, y: number, z: number): void {
    let best: Enemy | null = null;
    let bd = 2.5;
    for (const e of this.enemies.values()) {
      const d = Math.hypot(e.x - x, e.y - (y - 1), e.z - z);
      if (d < bd && !e.ally) {
        bd = d;
        best = e;
      }
    }
    best?.anim.hit();
  }

  /** Event 201. */
  die(id: number): void {
    this.enemies.get(id)?.anim.die();
  }

  /** Event 206: holds (freeze, petrify), staggers (stun, knockback, airborne). */
  status(id: number, statusId: number, durationMs?: number): void {
    const e = this.enemies.get(id);
    const s = STATUS.get(statusId);
    if (!e || !s) return;
    const ms = durationMs ?? s.durationMs;
    if (s.key === 'freeze' || s.key === 'petrify') e.anim.hold(ms / 1000);
    else if (s.key === 'stun' || s.key === 'knockback' || s.key === 'airborne' || s.key === 'pull') e.anim.staggerNow(Math.min(900, Math.max(350, ms)));
  }

  /** A parry (Event 207 value 2): the attacker reels. */
  stagger(id: number, ms?: number): void {
    this.enemies.get(id)?.anim.staggerNow(ms);
  }

  /** The animator of an entity (tests, the gallery). */
  animator(id: number): EnemyAnimator | null {
    return this.enemies.get(id)?.anim ?? null;
  }

  stats(): EnemyRenderStats {
    return this.lastStats;
  }

  // ── Per frame ───────────────────────────────────────────────────────────

  /**
   * Draw `views` (enemies kind 2, allies kind 7). `frozen`: hitstop (the
   * struck enemy holds its position and pose; the flash still runs).
   */
  update(views: readonly RemoteView[], camera: THREE.Camera, dt: number, nowMs: number, frozen = false): void {
    const t0 = performance.now();
    this.frame++;
    enemyUniforms.uTime.value = nowMs / 1000;
    // Playtest 2 calm kills: the tell's pulse, the death edge and the motes' glow follow the flash profile.
    const fp = flashProfile();
    enemyUniforms.uTellW.value = fp.tellHz * Math.PI * 2;
    enemyUniforms.uTellDepth.value = fp.tellDepth;
    enemyUniforms.uEdge.value = fp.deathEdge;
    this.debrisGlow = fp.debrisGlow - 1;
    this.debrisCount = fp.debrisCount;
    for (const b of this.batchList) b.n = 0;
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    camera.getWorldPosition(_camPos);
    _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    // crowd cap on full rigs
    if (this.fullLast > FULL_MAX) this.fullRadius = Math.max(10, this.fullRadius * 0.92);
    else if (this.fullLast < FULL_MAX * 0.75) this.fullRadius = Math.min(FULL_M, this.fullRadius * 1.03 + 0.05);

    const st = this.lastStats;
    st.enemies = st.drawn = st.full = st.mid = st.far = st.culled = 0;
    let bars = 0;
    let strong = 0;
    let soft = 0;

    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      if (v.kind !== 2 && v.kind !== 7) continue;
      let e = this.enemies.get(v.id);
      const ally = v.kind === 7;
      // Playtest 6 polish: an ally whose view dropped out for a moment (you teleported and your pet followed a
      // tick later) started fading out; when the view came back the same entry was reused, dead, and the pet
      // stayed invisible for good (its "[E] Pet" prompt still up). A view that returns gets a fresh body.
      if (e && (e.typeId !== (v.typeId ?? 0) || (e.gone && !e.anim.alive))) {
        this.drop(e);
        e = undefined;
      }
      if (!e) {
        e = this.make(v, ally);
        this.enemies.set(v.id, e);
      }
      e.seen = this.frame;
      e.gone = false;
      if (!(frozen && e.anim.struck)) {
        e.x = v.x;
        e.y = v.y;
        e.z = v.z;
        e.yaw = v.yaw;
      }
      e.health = v.healthPct;
      if (e.label && v.name !== e.name) this.relabel(e, v.name);
      _input.speed = v.speed;
      _input.yaw = v.yaw;
      _input.y = v.y;
      _input.healthPct = ally ? Math.max(1, v.healthPct) : v.healthPct;
      _input.winding = (v.activity & 8) !== 0;
      e.anim.update(_input, dt, frozen && e.anim.struck);
    }
    // vanished views: dying ones finish their animation in place, the rest go
    for (const e of this.enemies.values()) {
      if (e.seen === this.frame) continue;
      if (!e.gone) {
        e.gone = true;
        if (e.ally && e.anim.alive) e.anim.die(); // an ally's time ran out: it fades
        else if (e.anim.alive) {
          this.drop(e);
          continue;
        }
      }
      _input.speed = 0;
      _input.yaw = e.yaw;
      _input.y = e.y;
      _input.healthPct = 0;
      _input.winding = false;
      e.anim.update(_input, dt);
      if (e.anim.death >= 1) this.drop(e);
    }

    let full = 0;
    for (const e of this.enemies.values()) {
      st.enemies++;
      const sp = e.spec;
      const m = e.model;
      const a = e.anim;
      if (!a.alive && !e.deathFx) {
        e.deathFx = true;
        this.spawnDeath(e);
      }
      const s = sp.scale;
      const dx = e.x - _camPos.x;
      const dy = e.y - _camPos.y;
      const dz = e.z - _camPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      _sphere.center.set(e.x, e.y + m.height * s * 0.5, e.z);
      _sphere.radius = Math.max(m.height * 0.6, m.radius) * s + 0.5;
      const visible = _frustum.intersectsSphere(_sphere);
      // overlays (even for the culled: a bar can be on screen with the body just off it... not worth it: skip)
      if (!visible) {
        st.culled++;
        continue;
      }
      const big = sp.boss || s >= 2;
      const reach = big ? 2.2 : 1;
      const lod = dist < this.fullRadius * reach ? 0 : dist < MID_M * reach ? 1 : 2;
      e.lod = lod;
      st.drawn++;
      // per-instance effects
      _fx[0] = a.flash;
      // the tell: a pulsing warm rim that builds through the wind-up (the pose carries most of it), eyes and runes flare
      _fx[1] = a.state === 'windup' ? 0.06 + 0.22 * a.windup : 0;
      _fx[2] = a.dissolve;
      _fx[3] = a.attackWeight * 1.5 + (a.state === 'windup' ? a.tremble : 0);
      // a hot edge on the break-up only for demons (embers) and stone (sparks); jelly and flesh just melt
      if (!a.alive && sp.deathFx !== 'smoke' && sp.deathFx !== 'shatter') _fx[3] = -1;
      if (e.ally) {
        _fx[1] = 0;
        if (e.health < 15 && a.alive && !e.pet) _fx[2] = 0.125 * (1 - Math.cos((nowMs / 1000) * fp.allyFadeHz * Math.PI * 2)); // fades in and out at the end (<= 2 Hz; it flickered at 2.7 Hz)
      }
      _q.setFromAxisAngle(_yAxis, e.yaw);
      const lift = sp.flyer ? m.flyLift * s : 0;
      _root.compose(_p.set(e.x, e.y - lift, e.z), _q, _s.set(s, s, s));
      if (lod === 0) {
        full++;
        st.full++;
        this.trackLook(e, dt);
        const c = this.ctx;
        c.a = a;
        c.spec = sp;
        c.look = e.look;
        c.lookPitch = e.lookPitch;
        c.phase = e.phase;
        c.side = e.side;
        c.drop = m.joints[0].pos[1] - 0.15 + (sp.flyer ? (FLY_M - lift) / s : 0);
        writePose(m.rig, c, e.pose);
        const joints = m.joints;
        for (let j = 0; j < joints.length; j++) {
          jointLocal(joints[j].pos, e.pose, j, _local);
          const par = joints[j].parent;
          _world[j].multiplyMatrices(par < 0 ? _root : _world[par], _local);
        }
        for (let p = 0; p < m.parts.length; p++) {
          const pt = m.parts[p];
          this.push(this.batch(pt.geo, pt.mat, false), _world[pt.joint]);
        }
      } else if (lod === 1) {
        st.mid++;
        // the body joint's motion only, around its rest pivot
        const c = this.ctx;
        c.a = a;
        c.spec = sp;
        c.look = 0;
        c.lookPitch = 0;
        c.phase = e.phase;
        c.side = e.side;
        c.drop = m.joints[0].pos[1] - 0.15 + (sp.flyer ? (FLY_M - lift) / s : 0);
        writePose(m.rig, c, e.pose);
        const j0 = m.joints[0].pos;
        jointLocal(j0, e.pose, 0, _local);
        _inv.makeTranslation(-j0[0], -j0[1], -j0[2]);
        _mid.multiplyMatrices(_root, _local).multiply(_inv);
        this.push(this.batch(m.mid, m.midMat, false), _mid);
      } else {
        st.far++;
        const k = a.alive ? 1 : 1 - a.death;
        _root.compose(_p.set(e.x, e.y, e.z), _q, _s.set(m.radius * 1.4 * s * k, m.height * s * k, m.radius * 1.4 * s * k));
        const b = this.batch(farGeometry(), 'opaque', true);
        _col.set(sp.color);
        b.mesh.setColorAt(b.n, _col);
        this.push(b, _root);
      }
      // aura rings (elites, elementals, bosses)
      if (a.alive && lod < 2 && ((e.ally && !e.pet) || sp.elite || sp.boss || sp.element < 8)) {
        const strongRing = sp.elite || sp.boss;
        const r = m.foot * s * (sp.boss ? 1.45 : 1.2) * (1 + 0.04 * Math.sin(nowMs / 260 + e.phase));
        _q.setFromAxisAngle(_yAxis, nowMs / 1400 + e.phase);
        _root.compose(_p.set(e.x, e.y + 0.05 - (sp.flyer ? FLY_M : 0), e.z), _q, _s.set(r, 1, r));
        _col.set(sp.element < 8 || e.ally ? (e.ally && !e.pet ? sp.color : sp.accent) : sp.boss ? '#ff6040' : '#ffd060');
        if (strongRing) {
          if (strong >= this.auraCap) this.growOverlays(this.auraCap * 2);
          this.auraStrong.setMatrixAt(strong, _root);
          this.auraStrong.setColorAt(strong++, _col);
        } else {
          if (soft >= this.auraCap) this.growOverlays(this.auraCap * 2);
          this.auraSoft.setMatrixAt(soft, _root);
          this.auraSoft.setColorAt(soft++, _col);
        }
      }
      // health bar (billboard)
      // (not when it is right on top of the camera: up close a world-space bar filled the screen)
      const showBar = a.alive && (dist < BAR_M || sp.boss) && lod < 2 && dist > 1.2;
      if (showBar) {
        if (bars >= this.barCap) this.growOverlays(this.barCap * 2);
        const w = e.ally ? 0.7 : Math.max(1, s * 0.6);
        // Roughly constant on-screen size: shrinks up close (a thick block filled the view at 1-2 m), grows far out.
        const sc = Math.min(Math.max(0.3, dist / 12), Math.max(1, dist / 18));
        const y = e.y - (sp.flyer ? m.flyLift * s : 0) + m.height * s + 0.25;
        _q.copy(camera.quaternion);
        _root.compose(_p.set(e.x, y, e.z), _q, _s.set(w * sc, sc, 1));
        this.barBack.setMatrixAt(bars, _root);
        const fw = Math.max(0.001, (e.health / 100) * w);
        _p.addScaledVector(_camRight, (-(w - fw) / 2) * sc);
        _root.compose(_p, _q, _s.set(fw * sc, sc, 1));
        this.barFill.setMatrixAt(bars, _root);
        _col.set(e.pet ? '#5fd16b' : e.ally ? sp.color : sp.boss ? '#ff4040' : sp.elite ? '#ffb020' : '#d04040');
        this.barFill.setColorAt(bars, _col);
        bars++;
        if (e.label) {
          e.label.visible = true;
          e.label.position.set(e.x, y + 0.26 * sc, e.z);
          e.label.scale.set(1.6 * sc, 0.3 * sc, 1);
        }
      } else if (e.label) e.label.visible = false;
    }
    this.fullLast = full;
    st.fullRadius = this.fullRadius;
    // finish the batches
    let calls = 0;
    let inst = 0;
    for (const b of this.batchList) {
      b.mesh.count = b.n;
      b.mesh.visible = b.n > 0;
      if (b.n > 0) {
        calls++;
        inst += b.n;
        b.mesh.instanceMatrix.clearUpdateRanges();
        b.mesh.instanceMatrix.addUpdateRange(0, b.n * 16);
        b.mesh.instanceMatrix.needsUpdate = true;
        b.fx.clearUpdateRanges();
        b.fx.addUpdateRange(0, b.n * 4);
        b.fx.needsUpdate = true;
        if (b.colored && b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      }
    }
    for (const [mesh, n] of [
      [this.barBack, bars],
      [this.barFill, bars],
      [this.auraStrong, strong],
      [this.auraSoft, soft],
    ] as const) {
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        calls++;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    st.debris = this.stepDebris(dt);
    if (st.debris) calls += 3;
    st.batches = this.batchList.length;
    st.drawCalls = calls;
    st.instances = inst;
    st.updateMs = performance.now() - t0;
  }

  dispose(): void {
    for (const e of [...this.enemies.values()]) this.drop(e);
    for (const b of this.batchList) {
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.batches.clear();
    this.batchList = [];
    this.root.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private make(v: RemoteView, ally: boolean): Enemy {
    const typeId = v.typeId ?? 0;
    const pet = ally && isPetTypeId(typeId); // CR 029
    const spec = pet ? petSpec(typeId) : ally ? summonSpec(typeId) : modelSpec(enemyInfo(v));
    const model = modelFor(spec);
    const g = GAIT[spec.rig];
    // allies have no telegraph: the casting bit winds up their one attack (a bite, a bow shot, a bolt)
    const allyKind = spec.style === 'wraith_hound' ? 'bite' : spec.style === 'gale_phantom' ? 'shoot' : 'cast';
    const fallback = pet ? defaultAttack(spec.key) : ally ? { key: 'ally', kind: allyKind, windupMs: 250, activeMs: 100, recoveryMs: 400 } as const : defaultAttack(spec.key);
    const anim = new EnemyAnimator({ refSpeed: g.ref * Math.sqrt(spec.scale), stride: g.stride * spec.scale, deathMs: spec.deathMs, fallback });
    const h = (v.id * 2654435761) >>> 0;
    const e: Enemy = {
      id: v.id,
      ally,
      pet,
      typeId,
      spec,
      model,
      anim,
      pose: new Float32Array(MAX_JOINTS * POSE_STRIDE),
      phase: (h % 1000) / 97,
      side: h & 1 ? 1 : -1,
      look: 0,
      lookPitch: 0,
      x: v.x,
      y: v.y,
      z: v.z,
      yaw: v.yaw,
      health: v.healthPct,
      name: '',
      seen: this.frame,
      gone: false,
      deathFx: false,
      label: null,
      lod: 0,
    };
    if (v.name) this.relabel(e, v.name);
    return e;
  }

  private drop(e: Enemy): void {
    this.enemies.delete(e.id);
    if (e.label) {
      this.root.remove(e.label);
      (e.label.material as THREE.SpriteMaterial).map?.dispose();
      (e.label.material as THREE.SpriteMaterial).dispose();
      e.label = null;
    }
  }

  private relabel(e: Enemy, name: string): void {
    e.name = name;
    if (e.label) {
      this.root.remove(e.label);
      (e.label.material as THREE.SpriteMaterial).map?.dispose();
      (e.label.material as THREE.SpriteMaterial).dispose();
      e.label = null;
    }
    if (!name || typeof document === 'undefined') return;
    e.label = labelSprite(name, e.pet ? '#ffe9a8' : e.ally ? '#d8ffe0' : e.spec.boss ? '#ff8080' : e.spec.elite ? '#ffd27a' : '#f1f3f5');
    this.root.add(e.label);
  }

  /** Smoothed head turn toward the target (the local player), clamped to what a neck can do. */
  private trackLook(e: Enemy, dt: number): void {
    const tx = this.target.x - e.x;
    const tz = this.target.z - e.z;
    const d = Math.hypot(tx, tz);
    let ly = 0;
    let lp = 0;
    if (d < 25 && d > 0.3 && e.anim.alive && !e.ally) {
      let a = Math.atan2(-tx, -tz) - e.yaw;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      ly = Math.abs(a) < 1.9 ? Math.max(-0.9, Math.min(0.9, a)) : 0;
      lp = Math.max(-0.45, Math.min(0.45, Math.atan2(this.target.y - (e.y + e.model.height * e.spec.scale * 0.8), d)));
    }
    const k = 1 - Math.exp(-dt / 0.25);
    e.look += (ly - e.look) * k;
    e.lookPitch += (lp - e.lookPitch) * k;
  }

  private batch(geo: THREE.BufferGeometry, kind: MatKind, colored: boolean): Batch {
    const key = geo.uuid;
    let b = this.batches.get(key + kind);
    if (!b) {
      b = { mesh: null as unknown as THREE.InstancedMesh, src: geo, mat: enemyMat(kind), fx: null as unknown as THREE.InstancedBufferAttribute, cap: 0, n: 0, shadow: kind !== 'spectral', colored };
      this.alloc(b, 16);
      this.batches.set(key + kind, b);
      this.batchList.push(b);
    }
    if (b.n >= b.cap) this.alloc(b, b.cap * 2);
    return b;
  }

  /** (Re)create a batch's instanced mesh with room for `cap` (a wrapper geometry sharing the part's attributes + its own iFx). */
  private alloc(b: Batch, cap: number): void {
    const geo = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'color', 'glow']) {
      const at = b.src.getAttribute(k);
      if (at) geo.setAttribute(k, at);
    }
    geo.boundingSphere = b.src.boundingSphere;
    const fx = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    fx.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iFx', fx);
    const mesh = new THREE.InstancedMesh(geo, b.mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (b.colored) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    mesh.frustumCulled = false; // culled per enemy above
    mesh.castShadow = b.shadow;
    mesh.receiveShadow = false;
    mesh.count = 0;
    if (b.mesh) {
      // keep what was written this frame
      (mesh.instanceMatrix.array as Float32Array).set((b.mesh.instanceMatrix.array as Float32Array).subarray(0, b.n * 16));
      (fx.array as Float32Array).set((b.fx.array as Float32Array).subarray(0, b.n * 4));
      if (b.colored && b.mesh.instanceColor && mesh.instanceColor) (mesh.instanceColor.array as Float32Array).set((b.mesh.instanceColor.array as Float32Array).subarray(0, b.n * 3));
      this.root.remove(b.mesh);
      b.mesh.geometry.dispose(); // (the part's own attributes re-upload on the new wrapper)
      b.mesh.dispose();
    }
    b.mesh = mesh;
    b.fx = fx;
    b.cap = cap;
    this.root.add(mesh);
  }

  private push(b: Batch, m: THREE.Matrix4): void {
    const i = b.n++;
    m.toArray(b.mesh.instanceMatrix.array as Float32Array, i * 16);
    const a = b.fx.array as Float32Array;
    a[i * 4] = _fx[0];
    a[i * 4 + 1] = _fx[1];
    a[i * 4 + 2] = _fx[2];
    a[i * 4 + 3] = _fx[3];
  }

  private growOverlays(cap: number): void {
    const grow = (old: THREE.InstancedMesh, n: number, colored: boolean): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(old.geometry, old.material, n);
      m.renderOrder = old.renderOrder;
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      (m.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
      if (colored) {
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        if (old.instanceColor) (m.instanceColor.array as Float32Array).set(old.instanceColor.array as Float32Array);
      }
      this.root.remove(old);
      this.root.add(m);
      return m;
    };
    if (cap > this.barCap) {
      this.barBack = grow(this.barBack, cap, false);
      this.barFill = grow(this.barFill, cap, true);
      this.barCap = cap;
    }
    if (cap > this.auraCap) {
      this.auraStrong = grow(this.auraStrong, cap, true);
      this.auraSoft = grow(this.auraSoft, cap, true);
      this.auraCap = cap;
    }
  }

  // ── Death debris ────────────────────────────────────────────────────────

  private emit(kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, color: string, ground: number): void {
    const i = this.dNext;
    this.dNext = (this.dNext + 1) % MAX_DEBRIS;
    this.dKind[i] = kind;
    this.dPos[i * 3] = x;
    this.dPos[i * 3 + 1] = y;
    this.dPos[i * 3 + 2] = z;
    this.dVel[i * 3] = vx;
    this.dVel[i * 3 + 1] = vy;
    this.dVel[i * 3 + 2] = vz;
    this.dSize[i] = size;
    this.dLife[i] = life;
    this.dMax[i] = life;
    this.dGround[i] = ground;
    _col.set(color);
    this.dCol[i * 3] = _col.r;
    this.dCol[i * 3 + 1] = _col.g;
    this.dCol[i * 3 + 2] = _col.b;
  }

  private spawnDeath(e: Enemy): void {
    if (e.lod === 2) return;
    const sp = e.spec;
    const s = sp.scale;
    const h = e.model.height * s;
    const r = rng(e.id);
    // flyers come down from their hover: dust and splats land on the ground
    const gy = e.y - (sp.flyer ? FLY_M : 0);
    const cy = e.y - (sp.flyer ? e.model.flyLift * s : 0) + h * 0.45;
    const n = Math.max(3, Math.round(Math.min(18, 8 + 5 * s) * this.debrisCount));
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const sp2 = 1.5 + r() * 2.5;
      const up = 1.5 + r() * 3;
      switch (sp.deathFx) {
        case 'splat':
          this.emit(1, e.x, gy + 0.25 * s, e.z, Math.cos(a) * sp2, up, Math.sin(a) * sp2, (0.08 + r() * 0.1) * s, 0.9 + r() * 0.4, sp.color, gy);
          break;
        case 'shatter':
          this.emit(0, e.x + (r() - 0.5) * s, cy + (r() - 0.5) * h * 0.6, e.z + (r() - 0.5) * s, Math.cos(a) * sp2, up, Math.sin(a) * sp2, (0.1 + r() * 0.15) * s, 1.2 + r() * 0.5, i % 3 ? sp.color : sp.accent, gy);
          break;
        case 'smoke':
          if (i % 2) this.emit(3, e.x + (r() - 0.5) * s, cy, e.z + (r() - 0.5) * s, (r() - 0.5) * 0.6, 0.6 + r() * 0.8, (r() - 0.5) * 0.6, (0.25 + r() * 0.2) * s, 1.3 + r() * 0.4, '#1a1418', -1e9);
          else this.emit(2, e.x, cy, e.z, Math.cos(a) * sp2 * 0.6, up * 0.8, Math.sin(a) * sp2 * 0.6, 0.06 + r() * 0.05, 0.8 + r() * 0.5, sp.element < 8 ? sp.accent : '#ff5a2a', -1e9);
          break;
        case 'motes':
          this.emit(2, e.x + (r() - 0.5) * s * 0.8, cy + (r() - 0.5) * h * 0.5, e.z + (r() - 0.5) * s * 0.8, (r() - 0.5) * 0.8, 0.8 + r() * 1.5, (r() - 0.5) * 0.8, 0.05 + r() * 0.06, 0.9 + r() * 0.6, sp.spectral ? sp.color : sp.accent, -1e9);
          break;
        default:
          // dust: a few soft puffs kicked up where the body lands
          if (i < 6) this.emit(3, e.x + Math.cos(a) * 0.35 * s, gy + 0.1, e.z + Math.sin(a) * 0.35 * s, Math.cos(a) * 0.9, 0.25 + r() * 0.25, Math.sin(a) * 0.9, (0.09 + r() * 0.06) * s, 0.7 + r() * 0.25, '#c8bca4', -1e9);
      }
    }
  }

  private stepDebris(dt: number): number {
    const meshes = this.debrisMeshes;
    const counts = [0, 0, 0];
    let alive = 0;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      if (this.dLife[i] <= 0) continue;
      this.dLife[i] -= dt;
      if (this.dLife[i] <= 0) continue;
      alive++;
      const k = this.dKind[i];
      const o = i * 3;
      const puff = k === 3;
      if (!puff && k !== 2) this.dVel[o + 1] -= 14 * dt;
      else this.dVel[o + 1] -= (k === 2 ? 0.6 : -0.2) * dt;
      const damp = puff ? Math.exp(-dt * 2.5) : 1;
      this.dVel[o] *= damp;
      this.dVel[o + 2] *= damp;
      this.dPos[o] += this.dVel[o] * dt;
      this.dPos[o + 1] += this.dVel[o + 1] * dt;
      this.dPos[o + 2] += this.dVel[o + 2] * dt;
      if (this.dPos[o + 1] < this.dGround[i] + 0.03) {
        // land: jelly splats flat, chunks tumble to a stop
        this.dPos[o + 1] = this.dGround[i] + 0.03;
        this.dVel[o + 1] *= -0.25;
        this.dVel[o] *= 0.6;
        this.dVel[o + 2] *= 0.6;
      }
      const lifeK = this.dLife[i] / this.dMax[i];
      // puffs swell then shrink away; chunks shrink at the end
      const size = this.dSize[i] * (puff ? (0.6 + (1 - lifeK) * 1.6) * Math.min(1, lifeK * 2.5) : Math.min(1, lifeK * 3));
      const flat = k === 1 && this.dPos[o + 1] <= this.dGround[i] + 0.04 ? 0.35 : 1;
      const mi = k === 1 ? 1 : k === 2 ? 2 : 0;
      const mesh = meshes[mi];
      const n = counts[mi]++;
      _e.set(this.dPos[o] * 3, i, this.dPos[o + 2] * 3);
      _qy.setFromEuler(_e);
      _local.compose(_p.set(this.dPos[o], this.dPos[o + 1], this.dPos[o + 2]), _qy, _s.set(size, size * flat, size));
      mesh.setMatrixAt(n, _local);
      _col.setRGB(this.dCol[o], this.dCol[o + 1], this.dCol[o + 2]);
      mesh.setColorAt(n, _col);
      const fx = mesh.geometry.getAttribute('iFx') as THREE.InstancedBufferAttribute;
      (fx.array as Float32Array)[n * 4 + 2] = 0;
      (fx.array as Float32Array)[n * 4 + 3] = puff ? -1 : k === 2 ? this.debrisGlow : 0; // no hot edge on dust and smoke; motes glow softly (calm kills)
    }
    for (let mi = 0; mi < 3; mi++) {
      const mesh = meshes[mi];
      mesh.count = counts[mi];
      mesh.visible = counts[mi] > 0;
      if (counts[mi]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.geometry.getAttribute('iFx').needsUpdate = true;
      }
    }
    return alive;
  }
}

/** Joint local matrix: rest offset + pose offset, XYZ rotation, scale. */
function jointLocal(rest: readonly number[], pose: Float32Array, j: number, out: THREE.Matrix4): void {
  const o = j * POSE_STRIDE;
  _e.set(pose[o], pose[o + 1], pose[o + 2], 'XYZ');
  _q.setFromEuler(_e);
  out.compose(_p.set(rest[0] + pose[o + 3], rest[1] + pose[o + 4], rest[2] + pose[o + 5]), _q, _s.set(pose[o + 6], pose[o + 7], pose[o + 8]));
}

/** A name label (sprites always face the camera). */
function labelSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.font = '600 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(text, 128, 24, 250);
  g.fillStyle = color;
  g.fillText(text, 128, 24, 250);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.6, 0.3, 1);
  sp.renderOrder = 11;
  return sp;
}
