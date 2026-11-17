// WorldEditManager (CR 040): breaking and reshaping the generated world.
//
// Key 8 cycles the work tool (chop and break, dig, fill); with one up the left
// mouse button swings it (hold to repeat). Online the zone decides everything
// (Interact 42 harvest, 43 earthworks -> Events 1800-1807, WorldEdits kind
// object_destroyed, TerrainEdits message 73); in solo the same rules run
// locally (harvestDefs.ts, planner.ts). What this file owns on screen:
//
//   - targeting: the object under the crosshair (a reach capsule per tree,
//     rock and bush) or the ground point a shovel would strike (a ray march
//     over the edited ground), with a ring on the ground and a hit bar;
//   - the removal mask: felled objects are hidden in the scatter renderer by
//     id (ScatterManager.hide / unhide), nothing else touches it;
//   - the fall: a felled tree tips over on the same mesh and material it was
//     drawn with (no new shader), thuds, scatters leaves and chips and sinks
//     away; rocks shatter into chunks; bushes burst into leaves;
//   - debris: one pooled instanced mesh of small chunks for chips, stone and
//     soil, so a dig stays a draw call;
//   - the terrain: TerrainEdits go to the overlay every ground query reads
//     (WorldGround.edits); TerrainManager rebuilds the touched tiles.
//
// Nothing here adds or removes a three.js light, and the debris, ring and
// felling meshes are created once (the ring and debris sit in the scene from
// the start so the shader warm-up sees their programs).

import * as THREE from 'three';
import type { Event as ZoneEvent, WorldEdits, TerrainEdits } from '@lodestone/contracts';
import type { WorldRuntime } from '../core/runtime';
import type { ScatterManager } from '../scatter/scatterManager';
import type { TerrainManager } from '../terrain/terrainManager';
import type { ZoneSession } from '../../net/zoneSession';
import { netRuntime } from '../../net/netStore';
import { localActions, localPlayer, view } from '../../state/live';
import { emitSound } from '../../audio/bridge';
import { isCaptureClick } from '../../input/useMouseLook';
import { heldBlocked, onHeldRelease } from '../../input/held';
import { notGameKey } from '../../input/useKeyboard';
import { useInventory } from '../../ui/inventory/store';
import { countOf } from '../../ui/inventory/items';
import { cycleWorkTool, workTool, type WorkMode } from './toolState';
import { harvestDef, ITEM_NAMES, maxHp, rollDrops, scaleFactor, LAYER_ROCK, LAYER_TREE, type HarvestDef } from './harvestDefs';
import { BRUSH_R, costFor, itemsFor, planSwing, type PlanWorld } from './planner';
import { MAX_DELTA, STEP_M } from './overlay';

const SWING_MS = 250;
const REACH_M = 6;
const HARVEST_REACH_M = 4.8;
const DEBRIS_MAX = 384;
const TREE_FALL_S = 1.35;
const UP = new THREE.Vector3(0, 1, 0);

const u64 = (d: Uint8Array): bigint => new DataView(d.buffer, d.byteOffset, 8).getBigUint64(0, true);

interface Target {
  kind: 'object' | 'ground';
  x: number;
  y: number;
  z: number;
  /** object: its record */
  id?: bigint;
  layer?: number;
  objKind?: number;
  scale?: number;
  yaw?: number;
  def?: HarvestDef;
  radius: number;
}

interface Falling {
  mesh: THREE.InstancedMesh;
  base: THREE.Vector3;
  yaw: number;
  w: number;
  h: number;
  dir: number;
  t: number;
  duration: number;
  thudded: boolean;
  layer: number;
}

const TOOL_LABEL: Record<WorkMode, string> = { off: '', harvest: 'Chop and break', dig: 'Dig', fill: 'Fill' };
const TOOL_ITEM: Record<WorkMode, string> = { off: '', harvest: 'Axe, pickaxe', dig: 'Shovel', fill: 'Shovel' };

export class WorldEditManager {
  readonly group = new THREE.Group();
  private readonly ground: WorldRuntime['terrainGround'];
  private readonly overlay: WorldRuntime['terrainGround']['edits'];
  private hookedSession: ZoneSession | null = null;
  private held = false;
  private nextSwing = 0;
  private target: Target | null = null;
  private hp = new Map<bigint, { pct: number; at: number }>();
  private soloHp = new Map<bigint, number>();
  private soloRemoved = new Map<bigint, number>();
  private soloAcc = 0;
  private soloDirt = 0;
  private toasts: { text: string; until: number }[] = [];
  private hud: HTMLDivElement | null = null;
  private toastEl: HTMLDivElement | null = null;
  private lastHud = '';
  private falling: Falling[] = [];
  // debris pool
  private readonly debris: THREE.InstancedMesh;
  private readonly dPos = new Float32Array(DEBRIS_MAX * 3);
  private readonly dVel = new Float32Array(DEBRIS_MAX * 3);
  private readonly dLife = new Float32Array(DEBRIS_MAX);
  private readonly dSize = new Float32Array(DEBRIS_MAX);
  private readonly dSpin = new Float32Array(DEBRIS_MAX);
  private readonly dColor = new Float32Array(DEBRIS_MAX * 3);
  private dCount = 0;
  // targeting ring
  private readonly ring: THREE.LineLoop;
  private readonly ringPos: THREE.BufferAttribute;
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();
  private disposed = false;
  private detach: Array<() => void> = [];

  constructor(
    private readonly runtime: WorldRuntime,
    private readonly scatter: ScatterManager,
    terrain: TerrainManager,
  ) {
    this.group.name = 'world edits';
    this.ground = runtime.terrainGround;
    this.overlay = this.ground.edits;
    terrain.setEdits(this.overlay);

    // Debris: small tumbling chunks, one instanced draw.
    const g = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    this.debris = new THREE.InstancedMesh(g, m, DEBRIS_MAX);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DEBRIS_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.debris.count = 0;
    this.debris.frustumCulled = false;
    this.debris.name = 'work debris';
    this.group.add(this.debris);

    // The targeting ring (a unit circle scaled to the brush or the object).
    const N = 48;
    const rp = new Float32Array(N * 3);
    this.ringPos = new THREE.BufferAttribute(rp, 3).setUsage(THREE.DynamicDrawUsage);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', this.ringPos);
    this.ring = new THREE.LineLoop(rg, new THREE.LineBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.85, depthWrite: false }));
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.ring.name = 'work ring';
    this.group.add(this.ring);

    if (typeof window !== 'undefined') {
      const onDown = (e: MouseEvent) => {
        if (e.button !== 0 || workTool.mode === 'off') return;
        if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
        if (isCaptureClick() || heldBlocked()) return;
        this.held = true;
        this.nextSwing = 0;
      };
      const onUp = (e: MouseEvent) => {
        if (e.button === 0) this.held = false;
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.code !== 'Digit8' || e.repeat || notGameKey(e) || heldBlocked()) return;
        const mode = cycleWorkTool();
        this.held = false;
        this.toast(mode === 'off' ? 'Tools away' : `${TOOL_LABEL[mode]} (${TOOL_ITEM[mode]})`);
      };
      window.addEventListener('mousedown', onDown);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('keydown', onKey);
      const off = onHeldRelease(() => {
        this.held = false;
      });
      this.detach.push(() => {
        window.removeEventListener('mousedown', onDown);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('keydown', onKey);
        off();
      });
    }
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
      (window as unknown as { __lodestoneEdits?: unknown }).__lodestoneEdits = this.debugHandle();
    }
  }

  // ---- session hooks

  private online(): boolean {
    return !!netRuntime.session && netRuntime.session.phase === 'playing';
  }

  private hookSession(): void {
    const s = netRuntime.session;
    if (!s || s === this.hookedSession) return;
    this.hookedSession = s;
    s.worldEditListeners.add((m) => this.onWorldEdits(s, m));
    s.terrainEditListeners.add((m) => this.onTerrainEdits(m));
    s.eventListeners.add((ev) => this.onEvent(s, ev));
  }

  private onWorldEdits(s: ZoneSession, m: WorldEdits): void {
    const now = s.clock.serverNow();
    for (const e of m.edits) {
      if (e.kind !== 4) continue; // object_destroyed
      if (e.expiresAt !== 0 && e.expiresAt <= now + 50) this.scatter.unhide(e.targetId);
      else this.scatter.hide(e.targetId);
    }
  }

  private onTerrainEdits(m: TerrainEdits): void {
    this.overlay.applyWire(m.cx, m.cz, m.data);
  }

  private onEvent(s: ZoneSession, ev: ZoneEvent): void {
    if (ev.kind < 1800 || ev.kind > 1819) return;
    const self = s.welcome?.entityId ?? -1;
    const x = ev.x / 100;
    const y = ev.y / 100;
    const z = ev.z / 100;
    switch (ev.kind) {
      case 1800: // an object took our hit
        if (ev.data.length >= 8) this.hp.set(u64(ev.data), { pct: ev.value, at: performance.now() });
        break;
      case 1801: {
        // someone else's hit: chips and the sound
        const layer = ev.data.length >= 9 ? ev.data[8] : LAYER_TREE;
        this.hitFx(layer, x, y, z);
        break;
      }
      case 1802: {
        const id = ev.data.length >= 8 ? u64(ev.data) : 0n;
        const scale = ev.data[8] ?? 128;
        const yaw = ((ev.data[9] ?? 0) / 256) * Math.PI * 2;
        const dir = ((ev.data[10] ?? 0) / 256) * Math.PI * 2;
        this.scatter.hide(id);
        this.felled(ev.value >> 8, ev.value & 255, x, y, z, scale, yaw, dir);
        break;
      }
      case 1803: {
        const reason = ev.value;
        if (reason === 1) this.toast('Too far to reach');
        else if (reason === 3) this.toast(`You need ${ev.data.length > 8 ? toolName(new TextDecoder().decode(ev.data.subarray(8))) : 'a tool'}`);
        else if (reason === 5) this.toast('Already gone');
        else if (reason === 6) this.toast('Too much of the world has been cleared');
        break;
      }
      case 1805:
        if (ev.entityId !== self) this.dirtFx(x, y, z, ev.targetId === 2 ? 'fill' : 'dig');
        break;
      case 1806: {
        const msg: Record<number, string> = { 1: 'Too far to reach', 2: 'You need a shovel', 3: 'The ground here is protected', 5: ev.targetId === 2 ? 'Nothing to fill here' : 'It will not go any deeper here', 6: 'You have no dirt or stone to fill with', 7: 'Too much of the world has been reshaped', 8: 'Nothing to dig there', 9: 'That would shift too much earth at once' };
        if (msg[ev.value]) this.toast(msg[ev.value]);
        break;
      }
      case 1807:
        this.toast(`+${ev.value} Dirt${ev.targetId ? `, +${ev.targetId} Stone` : ''}`);
        break;
    }
  }

  // ---- per frame

  update(camera: THREE.Camera, dt: number, nowMs: number): void {
    if (this.disposed) return;
    this.hookSession();
    this.updateSoloRegrow(nowMs);
    const mode = workTool.mode;
    if (mode === 'off') {
      this.target = null;
      this.ring.visible = false;
      this.held = false;
    } else {
      this.target = this.aim(camera, mode);
      this.updateRing(mode);
      if (this.held && nowMs >= this.nextSwing && !heldBlocked()) {
        this.nextSwing = nowMs + SWING_MS;
        this.swing(mode, nowMs);
      }
    }
    this.updateDebris(dt);
    this.updateFalling(dt);
    this.updateHud(mode, nowMs);
  }

  private eye(camera: THREE.Camera): THREE.Vector3 {
    return view.third ? this.tmpV.set(view.eye.x, view.eye.y, view.eye.z) : this.tmpV.copy(camera.position);
  }

  /** What the crosshair is on, for the current tool. */
  private aim(camera: THREE.Camera, mode: WorkMode): Target | null {
    const o = this.eye(camera).clone();
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    if (mode === 'harvest') return this.pickObject(o, d);
    // Ground: march the ray over the (edited) ground, refine by bisection.
    let prevT = 0.3;
    const reach = REACH_M + 1;
    for (let t = 0.6; t <= reach; t += 0.3) {
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      const y = o.y + d.y * t;
      if (y <= this.ground.heightAt(x, z)) {
        let a = prevT;
        let b = t;
        for (let i = 0; i < 8; i++) {
          const m = (a + b) / 2;
          if (o.y + d.y * m <= this.ground.heightAt(o.x + d.x * m, o.z + d.z * m)) b = m;
          else a = m;
        }
        const px = o.x + d.x * b;
        const pz = o.z + d.z * b;
        const py = this.ground.heightAt(px, pz);
        if (Math.hypot(px - o.x, py - o.y, pz - o.z) > REACH_M) return null;
        return { kind: 'ground', x: px, y: py, z: pz, radius: BRUSH_R };
      }
      prevT = t;
    }
    return null;
  }

  private pickObject(o: THREE.Vector3, d: THREE.Vector3): Target | null {
    let best: Target | null = null;
    let bestT = Infinity;
    this.scatter.forEachObject(o.x, o.z, 9, (r) => {
      const def = harvestDef(r.layer, r.kind);
      if (!def) return;
      const sf = scaleFactor(r.scale);
      const top = r.y + def.height * sf;
      // Closest approach of the ray to the object's vertical axis segment.
      const w0x = o.x - r.x;
      const w0y = o.y - r.y;
      const w0z = o.z - r.z;
      const b = d.y; // d . (0,1,0)
      const dd = 1;
      const e = w0y; // (0,1,0) . w0
      const dRay = d.x * w0x + d.y * w0y + d.z * w0z;
      const den = dd - b * b;
      let tRay = den > 1e-6 ? (b * e - dRay) / den : 0; // along the ray
      tRay = Math.max(0, Math.min(REACH_M + 1.5, tRay));
      let s = e + b * tRay; // along the axis (m above r.y)
      s = Math.max(0, Math.min(top - r.y, s));
      tRay = Math.max(0, Math.min(REACH_M + 1.5, d.x * (r.x - o.x) + d.y * (r.y + s - o.y) + d.z * (r.z - o.z)));
      const px = o.x + d.x * tRay - r.x;
      const py = o.y + d.y * tRay - (r.y + s);
      const pz = o.z + d.z * tRay - r.z;
      const dist = Math.hypot(px, py, pz);
      const rad = def.radius * sf + (r.layer === LAYER_TREE ? 0.25 : 0.2);
      if (dist > rad) return;
      // Within the zone's reach: the eye to the axis segment.
      const cy = Math.max(r.y, Math.min(top, o.y));
      if (Math.hypot(o.x - r.x, o.y - cy, o.z - r.z) > HARVEST_REACH_M + def.radius * sf) return;
      if (tRay < bestT) {
        bestT = tRay;
        best = { kind: 'object', x: r.x, y: r.y, z: r.z, id: r.id, layer: r.layer, objKind: r.kind, scale: r.scale, yaw: r.yaw, def, radius: def.radius * sf + 0.35 };
      }
    });
    return best;
  }

  private updateRing(mode: WorkMode): void {
    const t = this.target;
    if (!t) {
      this.ring.visible = false;
      return;
    }
    this.ring.visible = true;
    const mat = this.ring.material as THREE.LineBasicMaterial;
    mat.color.set(mode === 'fill' ? 0x9be88a : mode === 'dig' ? 0xffc27a : 0xffe9a8);
    const n = this.ringPos.count;
    const r = t.radius;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = t.x + Math.cos(a) * r;
      const z = t.z + Math.sin(a) * r;
      this.ringPos.setXYZ(i, x, this.ground.heightAt(x, z) + 0.12, z);
    }
    this.ringPos.needsUpdate = true;
  }

  // ---- swinging

  private swing(mode: WorkMode, nowMs: number): void {
    localActions.mineSwings++; // your own third-person avatar swings the pick too
    if (this.target) this.strike(this.target, mode, nowMs); // else a swing at the air
  }

  private strike(t: Target, mode: WorkMode, nowMs: number): void {
    if (t.kind === 'object') {
      this.hitFx(t.layer!, t.x, t.y + (t.def?.height ?? 1) * 0.4, t.z);
      if (this.online()) netRuntime.session!.sendInteract(42, t.id!, 1, 0);
      else this.soloHarvest(t, nowMs);
    } else {
      this.dirtFx(t.x, t.y, t.z, mode === 'fill' ? 'fill' : 'dig');
      const packed = BigInt(Math.round(t.x * 100)) | (BigInt(Math.round(t.z * 100)) << 32n);
      if (this.online()) netRuntime.session!.sendInteract(43, packed, mode === 'fill' ? 2 : 1, 0);
      else this.soloEarth(t, mode === 'fill' ? 'fill' : 'dig');
    }
  }

  // ---- solo authority (the same rules the zone runs)

  private soloHarvest(t: Target, nowMs: number): void {
    const def = t.def!;
    const id = t.id!;
    const hp = (this.soloHp.get(id) ?? maxHp(def, t.scale!)) - def.damage;
    if (hp > 0) {
      this.soloHp.set(id, hp);
      this.hp.set(id, { pct: Math.ceil((hp / maxHp(def, t.scale!)) * 100), at: performance.now() });
      return;
    }
    this.soloHp.delete(id);
    this.hp.delete(id);
    this.scatter.hide(id);
    const dir = Math.atan2(t.z - localPlayer.pos.z, t.x - localPlayer.pos.x);
    this.felled(t.layer!, t.objKind!, t.x, t.y, t.z, t.scale!, t.yaw!, dir);
    this.soloRemoved.set(id, nowMs + (def.regrowS[0] + (def.regrowS[1] - def.regrowS[0]) * Math.random()) * 1000);
    let s = (Number(id & 0xffffffffn) >>> 0) || 1;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const got = rollDrops(def, t.scale!, rnd);
    this.toast(got.map((g) => `+${g.qty} ${ITEM_NAMES[g.item] ?? g.item}`).join('  '));
  }

  private updateSoloRegrow(nowMs: number): void {
    if (!this.soloRemoved.size) return;
    for (const [id, at] of this.soloRemoved) {
      if (nowMs >= at) {
        this.soloRemoved.delete(id);
        this.scatter.unhide(id);
      }
    }
  }

  private soloWorld(): PlanWorld {
    const towns = this.runtime.towns?.settlements ?? [];
    const g = this.ground;
    return {
      base: (x, z) => g.baseAt(x, z),
      water: (x, z) => g.waterAt(x, z),
      delta: (x, z) => this.overlay.delta(x, z),
      allowed: (x, z) => {
        if (x < 8 || z < 8 || x > 4088 || z > 4088) return false;
        for (const s of towns) if (Math.hypot(x - s.x, z - s.z) < Math.max(s.radius, s.wallRadius) + 12) return false;
        return true;
      },
    };
  }

  private soloEarth(t: Target, op: 'dig' | 'fill'): void {
    const { plan, reason } = planSwing(this.soloWorld(), op, t.x, t.z);
    if (!plan) {
      this.toast(reason === 'forbidden' ? 'The ground here is protected' : reason === 'big' ? 'That would shift too much earth at once' : op === 'fill' ? 'Nothing to fill here' : 'It will not go any deeper here');
      return;
    }
    const by = new Map<number, { cx: number; cz: number; es: { i: number; d: number }[] }>();
    for (const c of plan.changes) {
      const cx = c.x >> 6;
      const cz = c.z >> 6;
      const k = cz * 64 + cx;
      let b = by.get(k);
      if (!b) by.set(k, (b = { cx, cz, es: [] }));
      b.es.push({ i: (c.z & 63) * 64 + (c.x & 63), d: c.d });
    }
    for (const b of by.values()) this.overlay.setEntries(b.cx, b.cz, b.es);
    if (op === 'dig') {
      const { items, rest } = itemsFor(plan.lowered, this.soloAcc);
      this.soloAcc = rest;
      this.soloDirt += items;
      if (this.soloDirt >= 6) {
        this.toast(`+${this.soloDirt} Dirt`);
        this.soloDirt = 0;
      }
    } else void costFor(plan.raised); // solo has no bag: filling is free
  }

  // ---- effects

  private hitFx(layer: number, x: number, y: number, z: number): void {
    const at = { x, y, z };
    if (layer === LAYER_ROCK) {
      emitSound('mine_hit', { at, gem: false });
      this.burst(x, y, z, 7, [0.55, 0.55, 0.58], 3.2, 2.5, 0.07);
    } else if (layer === LAYER_TREE) {
      emitSound('work_chop', { at });
      this.burst(x, y, z, 7, [0.55, 0.38, 0.2], 3, 2.8, 0.06);
    } else {
      emitSound('work_chop', { at });
      this.burst(x, y, z, 6, [0.3, 0.55, 0.2], 2.6, 2.2, 0.06);
    }
  }

  private dirtFx(x: number, y: number, z: number, op: 'dig' | 'fill'): void {
    emitSound(op === 'fill' ? 'work_fill' : 'work_dig', { at: { x, y, z } });
    const sample = this.ground.heightAt(x, z);
    void sample;
    // soil clods thrown up (a dig) or sprinkled down (a fill), a little dust
    this.burst(x, y + 0.1, z, op === 'dig' ? 16 : 12, [0.38, 0.27, 0.17], op === 'dig' ? 3.4 : 1.8, op === 'dig' ? 3.6 : 1.2, 0.09);
    this.burst(x, y + 0.1, z, 6, [0.62, 0.55, 0.45], 1.2, 1.6, 0.14, 0.7);
  }

  /** A fallen object: the tree tips over, a rock or bush bursts. */
  private felled(layer: number, kind: number, x: number, y: number, z: number, scale: number, yaw: number, dir: number): void {
    if (Math.hypot(x - localPlayer.pos.x, z - localPlayer.pos.z) > 170) return;
    const at = { x, y, z };
    if (layer === LAYER_TREE) {
      const prop = this.scatter.propOf(layer, kind);
      if (!prop) return;
      const sf = scaleFactor(scale);
      const mesh = new THREE.InstancedMesh(prop.geometry, prop.material, 1);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([prop.tint.r, prop.tint.g, prop.tint.b]), 3);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'felled tree';
      this.group.add(mesh);
      const h = prop.h * sf;
      this.falling.push({ mesh, base: new THREE.Vector3(x, y, z), yaw, w: prop.w * sf, h, dir, t: 0, duration: TREE_FALL_S * Math.sqrt(Math.max(0.5, h / 8)), thudded: false, layer });
      this.setFallMatrix(this.falling[this.falling.length - 1], 0, 1);
      emitSound('work_tree_fall', { at });
      this.burst(x, y + 1, z, 10, [0.45, 0.62, 0.25], 2.4, 1.5, 0.12); // leaves shaken loose
    } else if (layer === LAYER_ROCK) {
      emitSound('work_rock_break', { at });
      this.burst(x, y + 0.5, z, 26, [0.52, 0.52, 0.55], 4.4, 4.2, 0.12);
      this.burst(x, y + 0.3, z, 8, [0.7, 0.66, 0.6], 1.6, 1.8, 0.2, 0.8);
    } else {
      emitSound('work_chop', { at });
      this.burst(x, y + 0.5, z, 14, [0.32, 0.56, 0.22], 3, 2.6, 0.1);
    }
  }

  private setFallMatrix(f: Falling, theta: number, sink: number): void {
    // Tips toward `dir` about the base: rotation about up x fall direction, after the object's own yaw.
    const fx = Math.cos(f.dir);
    const fz = Math.sin(f.dir);
    this.tmpV.set(fz, 0, -fx);
    this.tmpQ.setFromAxisAngle(this.tmpV, theta);
    this.tmpQ2.setFromAxisAngle(UP, f.yaw);
    this.tmpQ.multiply(this.tmpQ2);
    this.tmpS.set(f.w * sink, f.h * sink, f.w * sink);
    this.tmpV.copy(f.base);
    this.tmpV.y -= (1 - sink) * f.h * 0.5;
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
    f.mesh.setMatrixAt(0, this.tmpM);
    f.mesh.instanceMatrix.needsUpdate = true;
  }

  private updateFalling(dt: number): void {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.duration);
      const theta = (Math.PI / 2) * k * k;
      if (k >= 1 && !f.thudded) {
        f.thudded = true;
        const tip = f.h * 0.9;
        const x = f.base.x + Math.cos(f.dir) * tip;
        const z = f.base.z + Math.sin(f.dir) * tip;
        const y = this.ground.heightAt(x, z);
        emitSound('work_tree_thud', { at: { x, y, z } });
        this.burst(x, y + 0.3, z, 14, [0.5, 0.42, 0.3], 2.6, 1.6, 0.18, 0.8); // dust
        this.burst(x, y + 0.6, z, 12, [0.4, 0.6, 0.22], 3, 2, 0.12);
      }
      const rest = f.t - f.duration;
      const sink = rest > 2 ? Math.max(0, 1 - (rest - 2) / 1.6) : 1;
      this.setFallMatrix(f, theta, sink);
      if (sink <= 0.02) {
        this.group.remove(f.mesh);
        f.mesh.dispose();
        this.falling.splice(i, 1);
      }
    }
  }

  /** A burst of debris: n chunks of a colour thrown out and up, falling with gravity. */
  private burst(x: number, y: number, z: number, n: number, color: [number, number, number], speed: number, up: number, size: number, life = 1): void {
    for (let i = 0; i < n; i++) {
      const k = this.dCount < DEBRIS_MAX ? this.dCount++ : Math.floor(Math.random() * DEBRIS_MAX);
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.dPos[k * 3] = x + (Math.random() - 0.5) * 0.3;
      this.dPos[k * 3 + 1] = y + Math.random() * 0.2;
      this.dPos[k * 3 + 2] = z + (Math.random() - 0.5) * 0.3;
      this.dVel[k * 3] = Math.cos(a) * s;
      this.dVel[k * 3 + 1] = up * (0.4 + Math.random() * 0.6);
      this.dVel[k * 3 + 2] = Math.sin(a) * s;
      this.dLife[k] = (0.7 + Math.random() * 0.5) * life;
      this.dSize[k] = size * (0.6 + Math.random() * 0.8);
      this.dSpin[k] = Math.random() * 6;
      const v = 0.85 + Math.random() * 0.3;
      this.dColor[k * 3] = color[0] * v;
      this.dColor[k * 3 + 1] = color[1] * v;
      this.dColor[k * 3 + 2] = color[2] * v;
    }
  }

  private updateDebris(dt: number): void {
    if (!this.dCount) return;
    const d = Math.min(dt, 0.05);
    let live = 0;
    for (let k = 0; k < this.dCount; k++) {
      if (this.dLife[k] <= 0) continue;
      this.dLife[k] -= d;
      this.dVel[k * 3 + 1] -= 11 * d;
      const px = (this.dPos[k * 3] += this.dVel[k * 3] * d);
      let py = (this.dPos[k * 3 + 1] += this.dVel[k * 3 + 1] * d);
      const pz = (this.dPos[k * 3 + 2] += this.dVel[k * 3 + 2] * d);
      const gy = this.ground.heightAt(px, pz) + 0.03;
      if (py < gy) {
        py = this.dPos[k * 3 + 1] = gy;
        this.dVel[k * 3] *= 0.4;
        this.dVel[k * 3 + 1] = 0;
        this.dVel[k * 3 + 2] *= 0.4;
      }
      const fade = Math.min(1, this.dLife[k] * 2.5);
      if (fade <= 0) continue;
      const sc = this.dSize[k] * fade;
      this.dSpin[k] += d * 6;
      this.tmpQ.setFromAxisAngle(this.tmpV.set(0.6, 0.8, 0.3).normalize(), this.dSpin[k]);
      this.tmpV.set(px, py, pz);
      this.tmpS.set(sc, sc * 0.8, sc);
      this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
      this.debris.setMatrixAt(live, this.tmpM);
      this.tmpC.setRGB(this.dColor[k * 3], this.dColor[k * 3 + 1], this.dColor[k * 3 + 2]);
      this.debris.setColorAt(live, this.tmpC);
      live++;
    }
    this.debris.count = live;
    this.debris.instanceMatrix.needsUpdate = true;
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
    if (live === 0) this.dCount = 0;
  }

  // ---- HUD

  private toast(text: string): void {
    if (!text) return;
    this.toasts.push({ text, until: performance.now() + 2200 });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  private updateHud(mode: WorkMode, nowMs: number): void {
    if (typeof document === 'undefined') return;
    if (!this.hud) {
      this.hud = document.createElement('div');
      this.hud.dataset.testid = 'work-hud';
      Object.assign(this.hud.style, { position: 'fixed', left: '50%', top: '61%', transform: 'translateX(-50%)', color: '#f1ecdf', font: '13px system-ui, sans-serif', textShadow: '0 1px 2px #000', pointerEvents: 'none', zIndex: '20', textAlign: 'center' });
      document.body.appendChild(this.hud);
      this.toastEl = document.createElement('div');
      this.toastEl.dataset.testid = 'work-toast';
      Object.assign(this.toastEl.style, { position: 'fixed', left: '50%', top: '26%', transform: 'translateX(-50%)', color: '#ffe9b0', font: '600 15px system-ui, sans-serif', textShadow: '0 1px 3px #000', pointerEvents: 'none', zIndex: '20', textAlign: 'center' });
      document.body.appendChild(this.toastEl);
    }
    let html = '';
    if (mode !== 'off') {
      const items = useInventory.getState().inv?.items;
      const dirt = items ? countOf(items, 'earth:dirt') + countOf(items, 'stone:stone') : null;
      const t = this.target;
      let line = `<b>[8]</b> ${TOOL_LABEL[mode]}`;
      if (mode !== 'harvest' && dirt !== null) line += ` &middot; ${dirt} dirt and stone`;
      if (mode === 'harvest' && t?.kind === 'object') {
        const nm = t.layer === LAYER_TREE ? 'tree' : t.layer === LAYER_ROCK ? 'rock' : 'bush';
        const hp = this.hp.get(t.id!);
        const pct = hp && nowMs - hp.at < 6000 ? hp.pct : 100;
        line += ` &middot; ${nm}<div style="margin:4px auto 0;width:120px;height:4px;background:#0008"><div style="width:${pct}%;height:4px;background:#d9a066"></div></div>`;
      } else if (mode === 'harvest') line += ' &middot; aim at a tree, rock or bush';
      else if (t?.kind === 'ground') {
        const dl = Math.round(this.overlay.delta(Math.round(t.x), Math.round(t.z)) * STEP_M * 10) / 10;
        line += ` &middot; ${dl > 0 ? '+' : ''}${dl} m (limit &plusmn;${MAX_DELTA * STEP_M} m)`;
      }
      html = line;
    }
    if (html !== this.lastHud) {
      this.hud.innerHTML = html;
      this.lastHud = html;
    }
    this.toasts = this.toasts.filter((t) => t.until > nowMs);
    if (this.toastEl) this.toastEl.textContent = this.toasts.map((t) => t.text).join('   ');
  }

  // ---- debug / tests

  private debugHandle() {
    return {
      overlay: this.overlay,
      mode: () => workTool.mode,
      target: () => this.target,
      removed: () => this.soloRemoved.size,
      debris: () => this.debris.count,
      falling: () => this.falling.length,
      /** Scripted swing at the current target (headless runs). */
      swing: () => this.swing(workTool.mode, performance.now()),
      /** Scripted strike: dig or fill at a world point (the real Interact online, the local rules in solo). */
      digAt: (x: number, z: number, op: 'dig' | 'fill' = 'dig') => {
        this.strike({ kind: 'ground', x, y: this.ground.heightAt(x, z), z, radius: BRUSH_R }, op, performance.now());
      },
      /** The live trees, rocks and bushes near a point. */
      objects: (x: number, z: number, r: number) => {
        const out: { id: string; layer: number; kind: number; x: number; y: number; z: number }[] = [];
        this.scatter.forEachObject(x, z, r, (o) => out.push({ id: String(o.id), layer: o.layer, kind: o.kind, x: o.x, y: o.y, z: o.z }));
        return out;
      },
      /** One scripted swing at an object by id (the real Interact online). */
      harvest: (id: string) => {
        let t: Target | null = null;
        this.scatter.forEachObject(localPlayer.pos.x, localPlayer.pos.z, 12, (r) => {
          const def = harvestDef(r.layer, r.kind);
          if (def && String(r.id) === id) t = { kind: 'object', x: r.x, y: r.y, z: r.z, id: r.id, layer: r.layer, objKind: r.kind, scale: r.scale, yaw: r.yaw, def, radius: 1 };
        });
        if (t) this.strike(t, 'harvest', performance.now());
        return !!t;
      },
      setMode: (m: WorkMode) => {
        workTool.mode = m;
      },
      /** Scripted chop of the nearest tree to (x, z) (solo). */
      chopNear: (x: number, z: number, layer = LAYER_TREE) => {
        let best: Target | null = null;
        let bd = Infinity;
        this.scatter.forEachObject(x, z, 30, (r) => {
          const def = harvestDef(r.layer, r.kind);
          const d = Math.hypot(r.x - x, r.z - z);
          if (def && r.layer === layer && d < bd) {
            bd = d;
            best = { kind: 'object', x: r.x, y: r.y, z: r.z, id: r.id, layer: r.layer, objKind: r.kind, scale: r.scale, yaw: r.yaw, def, radius: 1 };
          }
        });
        const t = best as Target | null;
        if (!t) return null;
        for (let i = 0; i < 40 && !this.soloRemoved.has(t.id!); i++) this.soloHarvest(t, performance.now());
        return { x: t.x, y: t.y, z: t.z, id: String(t.id) };
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const f of this.falling) {
      this.group.remove(f.mesh);
      f.mesh.dispose();
    }
    this.falling = [];
    for (const d of this.detach) d();
    this.detach = [];
    this.hud?.remove();
    this.toastEl?.remove();
    this.debris.geometry.dispose();
    (this.debris.material as THREE.Material).dispose();
    this.debris.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
  }
}

const toolName = (key: string): string => (key === 'tool:axe' ? 'an axe' : key === 'tool:pickaxe' ? 'a pickaxe' : key === 'tool:shovel' ? 'a shovel' : 'a tool');
