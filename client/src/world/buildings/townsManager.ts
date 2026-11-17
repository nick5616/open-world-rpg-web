// TownsManager (WP20): the towns layer in the scene, a plain three.js
// manager driven from TownsLayer's useFrame (spec 12: no React component per
// building).
//
//  - Streaming: settlements within ~1.5 km of the camera and structures
//    within ~1 km are assembled in the buildings worker on demand (nearest
//    first, two in flight) and dropped again past a hysteresis margin. The
//    road network (roads, plazas, paving, bridges, signposts, road lanterns)
//    arrives once, per 1 km cell, when the worker is ready.
//  - Draw calls: a settlement is ONE shell mesh (every building, wall, roof,
//    window, door, stall, field, town wall and outdoor prop) plus ONE
//    interior mesh shown within ~80 m; a structure is one mesh; a road cell
//    is one decal mesh and one furniture mesh. All share one material over
//    one texture array (townMaterial.ts).
//  - Uploads are time-sliced (one new mesh per frame) so traversal never
//    hitches; the worker transfers its buffers, nothing is copied here.
//  - Light: windows glow by night and fires always (per-vertex emissive);
//    a fixed pool of PointLights (never added or removed, so no material
//    recompiles) borrows the nearest emitters at night, with a flicker.
//  - Scatter: trees, rocks and tufts standing in buildings, plazas, fields
//    and roads are hidden by stable id (the worker finds them).
//  - NPCs and the interaction HUD live in npcs.ts / townHud.ts; this picks
//    the target each frame.
//  - Doors (doors.ts, doorsMesh.ts): Events 970-972 into the door states the
//    movement ground reads, the swinging leaves (one instanced draw) and the
//    "[E] Open door" / "[E] Close door" targets.

import * as THREE from 'three';
import { DAY_LENGTH_S } from '@lodestone/contracts';
import { liveStyle } from '../style/styles';
import type { Towns } from '@lodestone/worldgen';
import type { WorldRuntime } from '../core/runtime';
import { worldClock } from '../../state/live';
import { makeSkyLighting, skyLighting } from '../sky/atmosphere';
import { worldDebug } from '../debug/worldDebug';
import { boxAt, BK } from './kit';
import { geometryOf, makeTownMaterials, townTexture, type TownMaterials } from './townMaterial';
import { NpcRenderer } from './npcs';
import { TownHud } from './townHud';
import { pickTarget, type Candidate } from './interact';
import { PK } from './props';
import { SK } from './structures';
import type { BuildingsIn, BuildingsOut } from './protocol';
import { netRuntime } from '../../net/netStore';
import { localPlayer, view } from '../../state/live';
import { DoorSync } from './doors';
import { DoorRenderer } from './doorsMesh';
import { ChimneySmoke } from './chimneySmoke';
import { liveWeather } from '../../systems/weather/runtime';

export const SETTLEMENT_LOAD_M = 1500;
export const SETTLEMENT_DROP_M = 1800;
export const STRUCTURE_LOAD_M = 1000;
export const STRUCTURE_DROP_M = 1200;
export const INTERIOR_M = 80;
const LIGHT_PICK_M = 45;
const MAX_INFLIGHT = 2;

interface Built {
  meshes: THREE.Mesh[];
  interior: THREE.Mesh | null;
  lights: Float32Array;
  /** Chimney tops (settlements; playtest 2 immersion pass). */
  smoke?: Float32Array;
  ms: number;
}

export class TownsManager {
  readonly group = new THREE.Group();
  /** Playtest 2 immersion pass: chimney smoke over the loaded settlements. */
  readonly smoke = new ChimneySmoke();
  readonly towns: Towns;
  readonly npcs: NpcRenderer;
  readonly hud: TownHud;
  /** Building doors: wire sync and leaves (null without doors). */
  readonly doorSync: DoorSync | null = null;
  doorLeaves: DoorRenderer | null = null;
  private lastSettle = 0;
  readonly stats = { ready: false, readyMs: 0, worker: { towns: 0, textures: 0, roads: 0 }, settlements: 0, structures: 0, cells: 0, uploads: 0, maxUploadMs: 0, maxBuildMs: 0, hiddenScatter: 0, lights: 0, tris: 0, inFlight: 0 };
  private readonly worker: Worker;
  private mats: TownMaterials | null = null;
  private readonly settlements = new Map<number, Built>();
  private readonly structures = new Map<number, Built>();
  private readonly cells = new Map<string, Built>();
  private readonly inflight = new Map<string, number>();
  private readonly uploads: (() => void)[] = [];
  private readonly pool: THREE.PointLight[] = [];
  private readonly sky = makeSkyLighting();
  private readonly statics: Candidate[] = [];
  private nextId = 1;
  /** Builds the worker is working on (requests, not yet answered). */
  private atWorker = 0;
  private readonly failed = new Set<string>();
  private night = 0;
  private lastLightPick = 0;
  private lastClear = new THREE.Vector3(1e9, 0, 1e9);
  private clearBusy = false;
  private pendingHides: bigint[] = [];
  private debugLines: THREE.LineSegments | null = null;
  private readonly t0 = performance.now();
  private disposed = false;
  showBoxes = false;

  constructor(
    readonly runtime: WorldRuntime,
    lightCount: number,
  ) {
    if (!runtime.towns) throw new Error('no towns in this runtime');
    this.towns = runtime.towns;
    this.group.name = 'towns';
    this.npcs = new NpcRenderer(this.towns, runtime.ground as never, (si) => runtime.data.sites[this.towns.settlements[si]?.site]?.layer === 2);
    this.group.add(this.npcs.group);
    this.group.add(this.smoke.mesh);
    this.hud = new TownHud();
    if (runtime.doors && runtime.doorStates) {
      const sync = new DoorSync(runtime.doors, runtime.doorStates);
      sync.localSeq = () => localPlayer.seq;
      sync.onRefused = (text) => this.hud.toast(text);
      this.hud.doorAct = (d) => sync.toggle(d);
      this.doorSync = sync;
    }
    for (let i = 0; i < lightCount; i++) {
      const l = new THREE.PointLight(0xffb070, 0, 14, 2);
      l.castShadow = false;
      this.pool.push(l);
      this.group.add(l);
    }
    this.collectStatics();
    this.worker = new Worker(new URL('./buildings.worker.ts', import.meta.url), { type: 'module', name: 'buildings' });
    this.worker.onmessage = (e: MessageEvent<BuildingsOut>) => this.onMessage(e.data);
    this.worker.onerror = (e) => console.warn('[towns] worker error', e.message);
    const atlas = runtime.atlas.bytes();
    this.post({ type: 'init', atlas, wasmUrl: runtime.wasmUrl }, [atlas.buffer]);
  }

  private post(m: BuildingsIn, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  /** Interaction points that never move: boards, forges, anvils, mineshaft winches, signposts. */
  private collectStatics(): void {
    const t = this.towns;
    for (const p of t.props) {
      let kind: Candidate['kind'] | null = null;
      let stableId = p.id;
      let index = -1;
      let y = p.y + 1.2;
      if (p.kind === PK.board) {
        kind = 'board';
        y = p.y + 1.45;
      } else if (p.kind === PK.forge) kind = 'forge';
      else if (p.kind === PK.anvil) {
        kind = 'anvil';
        y = p.y + 0.8;
      } else if (p.kind === PK.workbench && p.variant === 9 && p.structure >= 0) {
        const st = t.structures[p.structure];
        if (st && st.kind === SK.mineshaft) {
          kind = 'shaft';
          stableId = st.id;
          index = st.link;
          y = p.y + 1.05;
        }
      }
      if (kind) this.statics.push({ kind, x: p.x, y, z: p.z, entityId: null, stableId, index, name: '', role: -1, merchant: 255, settlement: p.settlement });
    }
    const sites = this.runtime.data.sites;
    t.signs.forEach((sg, i) => {
      const arms = sg.arms
        .filter((a) => a.settlement >= 0)
        .map((a) => {
          const s = t.settlements[a.settlement];
          const name = sites[s.site]?.name || `settlement ${a.settlement}`;
          const km = Math.hypot(s.x - sg.x, s.z - sg.z) / 1000;
          return `${name} ${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`}`;
        });
      this.statics.push({ kind: 'sign', x: sg.x, y: sg.y + 2.2, z: sg.z, entityId: null, stableId: sg.id, index: i, name: `Signpost: ${arms.join('  ·  ')}`, role: -1, merchant: 255, settlement: -1 });
    });
  }

  private onMessage(m: BuildingsOut): void {
    if (this.disposed) return;
    switch (m.type) {
      case 'ready': {
        this.mats = makeTownMaterials(townTexture(m.textures, m.size, m.layers));
        if (this.runtime.doors) {
          this.doorLeaves = new DoorRenderer(this.runtime.doors, this.mats.solid);
          this.group.add(this.doorLeaves.mesh);
        }
        this.stats.ready = true;
        this.stats.readyMs = performance.now() - this.t0;
        this.stats.worker = m.ms;
        for (const c of m.cells) {
          this.uploads.push(() => {
            const meshes: THREE.Mesh[] = [];
            if (c.decal.indexCount) {
              const d = new THREE.Mesh(geometryOf(c.decal), this.mats!.decal);
              d.receiveShadow = true;
              d.name = `roads ${c.key}`;
              d.renderOrder = -1;
              meshes.push(d);
            }
            if (c.furniture.indexCount) {
              const f = new THREE.Mesh(geometryOf(c.furniture), this.mats!.solid);
              f.castShadow = f.receiveShadow = true;
              f.name = `road-furniture ${c.key}`;
              meshes.push(f);
            }
            meshes.forEach((x) => this.group.add(x));
            this.cells.set(c.key, { meshes, interior: null, lights: c.lights, ms: 0 });
          });
        }
        break;
      }
      case 'settlement':
      case 'structure': {
        const key = `${m.type}:${m.index}`;
        this.atWorker--;
        if (this.inflight.get(key) !== m.id) return; // cancelled meanwhile
        // Still "requested" until the upload runs (else the next frame asks again).
        this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, m.ms);
        this.uploads.push(() => {
          if (this.inflight.get(key) !== m.id || !this.mats) return; // dropped while queued
          this.inflight.delete(key);
          const shell = new THREE.Mesh(geometryOf(m.mesh.shell), this.mats.solid);
          shell.castShadow = shell.receiveShadow = true;
          shell.name = `${m.type} ${m.index}`;
          this.group.add(shell);
          let interior: THREE.Mesh | null = null;
          if (m.type === 'settlement' && m.mesh.interior.indexCount) {
            interior = new THREE.Mesh(geometryOf(m.mesh.interior), this.mats.solid);
            interior.receiveShadow = true;
            interior.name = `interior ${m.index}`;
            interior.visible = false;
            this.group.add(interior);
          }
          (m.type === 'settlement' ? this.settlements : this.structures).set(m.index, { meshes: [shell], interior, lights: m.mesh.lights, smoke: m.type === 'settlement' ? m.mesh.smoke : undefined, ms: m.ms });
        });
        break;
      }
      case 'clear': {
        this.clearBusy = false;
        for (const id of m.ids) this.pendingHides.push(id);
        if (m.more) this.lastClear.set(1e9, 0, 1e9); // keep going next tick
        break;
      }
      case 'error':
        if (m.id) {
          // A failed build: free its slot; it is not retried (the warning says why).
          this.atWorker--;
          for (const [k, id] of this.inflight) if (id === m.id) this.failed.add(k);
        }
        console.warn('[towns] worker:', m.message);
        break;
    }
  }

  private drop(map: Map<number, Built>, i: number): void {
    const b = map.get(i);
    if (!b) return;
    for (const m of [...b.meshes, ...(b.interior ? [b.interior] : [])]) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    map.delete(i);
  }

  /** Forget a request; a worker answer still to come no longer counts against the limit. */
  private cancel(key: string): void {
    this.inflight.delete(key);
  }

  private stream(cam: THREE.Vector3): void {
    const t = this.towns;
    // Settlements.
    const want: [number, string, number][] = [];
    t.settlements.forEach((s, i) => {
      const d = Math.hypot(s.x - cam.x, s.z - cam.z) - s.radius;
      if (d > SETTLEMENT_DROP_M) {
        this.drop(this.settlements, i);
        this.cancel(`settlement:${i}`);
      } else if (d < SETTLEMENT_LOAD_M && !this.settlements.has(i) && !this.inflight.has(`settlement:${i}`) && !this.failed.has(`settlement:${i}`)) want.push([d, 'settlement', i]);
      const b = this.settlements.get(i);
      if (b?.interior) b.interior.visible = d < INTERIOR_M;
    });
    t.structures.forEach((s, i) => {
      const d = Math.hypot(s.x - cam.x, s.z - cam.z) - s.radius;
      if (d > STRUCTURE_DROP_M) {
        this.drop(this.structures, i);
        this.cancel(`structure:${i}`);
      } else if (d < STRUCTURE_LOAD_M && !this.structures.has(i) && !this.inflight.has(`structure:${i}`) && !this.failed.has(`structure:${i}`)) want.push([d, 'structure', i]);
    });
    want.sort((a, b) => a[0] - b[0]);
    for (const [, type, index] of want) {
      if (this.atWorker >= MAX_INFLIGHT) break;
      this.atWorker++;
      const id = this.nextId++;
      this.inflight.set(`${type}:${index}`, id);
      this.post({ type: type as 'settlement' | 'structure', id, index });
    }
  }

  private updateLights(cam: THREE.Vector3, now: number): void {
    if (!this.pool.length) return;
    const on = this.night > 0.05;
    if (on && now - this.lastLightPick > 250) {
      this.lastLightPick = now;
      const best: { d: number; l: Float32Array; o: number }[] = [];
      const scan = (l: Float32Array) => {
        for (let o = 0; o < l.length; o += 7) {
          const d = Math.hypot(l[o] - cam.x, l[o + 1] - cam.y, l[o + 2] - cam.z);
          if (d < LIGHT_PICK_M) best.push({ d, l, o });
        }
      };
      for (const b of this.settlements.values()) scan(b.lights);
      for (const b of this.structures.values()) scan(b.lights);
      for (const b of this.cells.values()) scan(b.lights);
      best.sort((a, b) => a.d - b.d);
      this.pool.forEach((p, i) => {
        const e = best[i];
        p.userData.on = !!e;
        if (!e) return;
        p.position.set(e.l[e.o], e.l[e.o + 1], e.l[e.o + 2]);
        p.color.setRGB(e.l[e.o + 3], e.l[e.o + 4], e.l[e.o + 5]);
        p.distance = e.l[e.o + 6];
        p.userData.seed = e.o;
      });
    }
    let n = 0;
    for (const p of this.pool) {
      if (!on || !p.userData.on) {
        p.intensity = 0;
        continue;
      }
      const s = p.userData.seed as number;
      const flicker = 0.88 + 0.05 * Math.sin(now * 0.0024 + s) + 0.03 * Math.sin(now * 0.0039 + s * 1.7); // a gentle sway, no strobe
      p.intensity = 9 * this.night * flicker * liveStyle.torch; // playtest 2 styles: warmer nights
      n++;
    }
    this.stats.lights = n;
  }

  /** Per frame (TownsLayer useFrame, before the world renders). */
  update(camera: THREE.Camera, dt: number): void {
    const now = performance.now();
    const cam = camera.position;
    const L = skyLighting(worldClock.timeOfDayS, this.sky);
    const target = 1 - THREE.MathUtils.smoothstep(L.day, 0.15, 0.7);
    this.night += (target - this.night) * Math.min(1, dt * 2);
    if (this.mats) {
      this.mats.uniforms.uNight.value = this.night;
      this.mats.uniforms.uTownTime.value = (this.mats.uniforms.uTownTime.value + dt) % 1000; // flames (wrapped: float precision)
    }
    this.stream(cam);
    // Time-sliced uploads: one new mesh per frame (its GPU upload happens in
    // this frame's render, so one at a time keeps the frame flat).
    const t0 = performance.now();
    if (this.uploads.length) {
      this.uploads.shift()!();
      this.stats.uploads++;
    }
    this.stats.maxUploadMs = Math.max(this.stats.maxUploadMs, performance.now() - t0);
    // Scatter to hide near the camera.
    if (this.stats.ready && !this.clearBusy && Math.hypot(cam.x - this.lastClear.x, cam.z - this.lastClear.z) > 48) {
      this.lastClear.copy(cam);
      this.clearBusy = true;
      this.post({ type: 'clear', x: cam.x, z: cam.z, radius: 420, max: 24 });
    }
    const sc = worldDebug.scatter;
    if (sc && this.pendingHides.length) {
      for (const id of this.pendingHides) sc.hide(id);
      this.stats.hiddenScatter += this.pendingHides.length;
      this.pendingHides = [];
    }
    this.updateLights(cam, now);
    // Playtest 2 immersion pass: smoke from the chimneys (busiest at breakfast and supper).
    this.smoke.update(camera, dt, (worldClock.timeOfDayS / DAY_LENGTH_S) * 24, L.day, Math.min(1, liveWeather.mix.rain), 0, this.smokeList);
    this.npcs.update(camera, dt, (now - this.t0) / 1000);
    // Interaction target.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const cands: Candidate[] = [];
    for (const c of this.statics) if (Math.abs(c.x - cam.x) < 8 && Math.abs(c.z - cam.z) < 8) cands.push(c);
    for (const v of this.npcs.views) {
      if (Math.abs(v.x - cam.x) > 6 || Math.abs(v.z - cam.z) > 6) continue;
      cands.push({ kind: 'npc', x: v.x, y: v.y + 1.25, z: v.z, entityId: v.entityId, stableId: v.index >= 0 ? this.towns.npcs[v.index].id : 0n, index: v.index, name: v.name, role: v.role, merchant: v.merchant, settlement: v.settlement });
    }
    const ds = this.doorSync;
    if (ds) {
      ds.follow(netRuntime.session);
      if (now - this.lastSettle > 500) {
        this.lastSettle = now;
        if (ds.states.active) ds.states.settle(localPlayer.seq);
      }
      if (this.doorLeaves) {
        this.doorLeaves.update(cam, dt, (d) => ds.isOpen(d), 6);
        for (const d of this.doorLeaves.near) {
          const door = ds.doors.doors[d];
          cands.push({ kind: 'door', x: door.x, y: door.y + 1.2, z: door.z, entityId: null, stableId: door.id, index: d, name: '', role: ds.isOpen(d) ? 1 : 0, merchant: 255, settlement: door.settlement });
        }
      }
    }
    this.hud.update(pickTarget(view.third ? view.eye : cam, fwd, cands)); // playtest 2: reach from the eye in third person
    this.stats.settlements = this.settlements.size;
    this.stats.structures = this.structures.size;
    this.stats.cells = this.cells.size;
    this.stats.inFlight = this.inflight.size;
    if (this.showBoxes !== !!this.debugLines) this.toggleBoxes(cam);
  }

  /** Debug: wireframes of the collision boxes within 150 m (to check geometry against collision). */
  private toggleBoxes(cam: THREE.Vector3): void {
    if (this.debugLines) {
      this.group.remove(this.debugLines);
      this.debugLines.geometry.dispose();
      (this.debugLines.material as THREE.Material).dispose();
      this.debugLines = null;
      return;
    }
    const t = this.towns;
    const pts: number[] = [];
    for (let i = 0; i < t.boxes.count; i++) {
      const b = boxAt(t, i);
      if (Math.hypot(b.cx - cam.x, b.cz - cam.z) > 150 || b.kind === BK.furniture) continue;
      const c: [number, number, number][] = [];
      for (const [u, v] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const x = b.cx + u * b.hx * b.c - v * b.hz * b.s;
        const z = b.cz + u * b.hx * b.s + v * b.hz * b.c;
        c.push([x, z, u < 0 ? b.y1 : b.y2]);
      }
      for (let k = 0; k < 4; k++) {
        const a = c[k];
        const d = c[(k + 1) % 4];
        pts.push(a[0], b.y0, a[1], d[0], b.y0, d[1], a[0], a[2], a[1], d[0], d[2], d[1], a[0], b.y0, a[1], a[0], a[2], a[1]);
      }
    }
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.debugLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff3366, depthTest: false, transparent: true, opacity: 0.8 }));
    this.debugLines.renderOrder = 999;
    this.debugLines.frustumCulled = false;
    this.group.add(this.debugLines);
  }

  /** Triangles in the towns layer meshes currently in the scene. */
  triangles(): number {
    let n = 0;
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && m.geometry.index && !(m as THREE.InstancedMesh).isInstancedMesh) n += m.geometry.index.count / 3;
    });
    return n;
  }

  /** Every queued build and upload done (benchmarks wait on this). */
  idle(): boolean {
    return this.stats.ready && this.atWorker === 0 && this.inflight.size === this.failed.size && this.uploads.length === 0;
  }

  /** The chimney tops of every loaded settlement (the smoke picks the nearest; asked 4x a second). */
  private readonly smokeList = () => this.smokeSources();
  private *smokeSources(): Iterable<Float32Array> {
    for (const b of this.settlements.values()) if (b.smoke && b.smoke.length) yield b.smoke;
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    for (const i of [...this.settlements.keys()]) this.drop(this.settlements, i);
    for (const i of [...this.structures.keys()]) this.drop(this.structures, i);
    for (const b of this.cells.values()) for (const m of b.meshes) m.geometry.dispose();
    this.cells.clear();
    this.npcs.dispose();
    this.smoke.dispose();
    this.hud.dispose();
    this.doorSync?.follow(null);
    this.doorLeaves?.dispose();
    this.mats?.dispose();
    if (this.debugLines) this.debugLines.geometry.dispose();
  }
}
