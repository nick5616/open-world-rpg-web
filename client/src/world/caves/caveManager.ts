// CaveManager (WP09, spec 7 and 12): the underground in the browser.
//
// - Streaming: only while the player is underground or within 200 m of a
//   mouth, cave cells within ~96 m are built in the generation workers
//   (cave_build, same wasm as the zone) and shared with collision through
//   CaveCellStore. Cells outside every cave system's bounds are never asked
//   for (most of the volume is solid rock).
// - Meshes: one plain three.js mesh per cell straight from the buffer
//   (positions, i8 normals + depth band, u16 indices); nothing is
//   recomputed on the main thread.
// - Light: near-black ambient underground (WorldScene dims sun, sky and fog
//   by `underground`), emissive gems and glowing fungi, and a fixed pool of
//   point lights (min(8, tier maxLights), never added or removed, so
//   material programs never recompile: wizard-wars LightPool's rule) that
//   borrow the colors of the nearest glowing things, plus the player's own
//   lantern glow.
// - Sound: a reverb bus sized by the radius of the chamber you are in.
// - Mining: aim at a vein within reach and press E (or click): online the
//   zone decides everything (Interact -> Events + WorldEdits); in solo the
//   same edits are applied locally so the carve and pickup can be seen.
// - Rock arches over every mouth and a rim of boulders around sinkholes hide
//   the seam between the heightfield and the volume.

import * as THREE from 'three';
import {
  CAVE_CELL_H,
  CAVE_CELL_W,
  caveCellKey,
  caveCellValid,
  caveSystemAt,
  encodeCaveEdits,
  parseCaveCell,
  veinMaterialName,
  type CaveGraph,
  type CaveVein,
} from '@lodestone/worldgen';
import type { WorldRuntime } from '../core/runtime';
import type { ResultMsg } from '../core/protocol';
import { localPlayer } from '../../state/live';
import { netRuntime } from '../../net/netStore';
import type { CaveGround } from './caveGround';
import type { CaveCellStore, StoredCell } from './caveStore';
import { CaveAudio } from './caveAudio';
import { installCaveDebug } from './caveDebug';
import {
  ELEMENT_GLOW,
  GEM_COLORS,
  ORE_LOOKS,
  archRockMaterial,
  boulderGeometry,
  caveRockMaterial,
  crystalGeometry,
  fungusMaterial,
  gemMaterial,
  mushroomGeometry,
  nuggetGeometry,
  oreMaterial,
  rupeeGeometry,
} from './caveVisuals';

/** Stream cells within this of the player (spec 7: ~96 m). */
export const CAVE_RENDER_M = 96;
/** Start streaming this far from a mouth (lod-0/1 terrain holes are visible ~140 m out). */
export const CAVE_ACTIVATE_M = 200;
const REACH_M = 4.5;
const SWING_MS = 300;
const MAX_INFLIGHT = 6;
const GEM_INSTANCES = 768;
const ORE_INSTANCES = 1024;
const FUNGUS_INSTANCES = 2048;

interface MeshEntry {
  mesh: THREE.Mesh;
  version: number;
}

interface Emitter {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  intensity: number;
  distance: number;
}

interface LocalPickup {
  id: number;
  mesh: THREE.Mesh;
  item: string;
  qty: number;
  t: number;
  /** online: server entity id (null = solo, local). */
  serverId: number | null;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** "gem:ruby:cut" -> "ruby (cut)", "ore:iron" -> "iron ore" (item ids until WP14 defines items). */
export function itemLabel(item: string): string {
  const [kind, name, cut] = item.split(':');
  return kind === 'gem' ? `${name}${cut ? ` (${cut})` : ''}` : `${name} ore`;
}

/** Deterministic per-vein random for cluster layout. */
function rng(seed: bigint): () => number {
  let s = Number(seed & 0xffffffffn) >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export class CaveManager {
  readonly group = new THREE.Group();
  /** 0 on the surface .. 1 deep underground (eased); WorldScene dims sky light by it. */
  underground = 0;
  chamberRadius = 8;
  readonly audio = new CaveAudio();
  readonly stats = { cells: 0, meshes: 0, requested: 0, built: 0, buildMs: 0, maxBuildMs: 0, syncBuilds: 0, lights: 0, veins: 0 };

  private readonly graph: CaveGraph;
  private readonly store: CaveCellStore;
  private readonly ground: CaveGround;
  private readonly rock = caveRockMaterial();
  private readonly meshes = new Map<number, MeshEntry>();
  private readonly inflight = new Map<number, string>();
  private readonly gemMeshes: THREE.InstancedMesh[];
  private readonly oreMeshes: THREE.InstancedMesh[];
  private readonly fungi: THREE.InstancedMesh;
  private readonly lights: THREE.PointLight[] = [];
  private emitters: Emitter[] = [];
  private visualsDirty = true;
  private activeVeins: CaveVein[] = [];
  private target: CaveVein | null = null;
  private lastSwing = 0;
  private localHp = new Map<bigint, number>();
  private serverHp = new Map<bigint, [number, number]>();
  private pickups: LocalPickup[] = [];
  private nextPickupId = 1;
  private hud: HTMLDivElement | null = null;
  private toastEl: HTMLDivElement | null = null;
  private toasts: { text: string; until: number }[] = [];
  private hookedSession: unknown = null;
  private sparks: { mesh: THREE.Points; t: number }[] = [];
  private nextAudio = 0;
  private active = false;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code === 'KeyE' && !e.repeat) this.swing();
  };
  private readonly onMouse = (e: MouseEvent) => {
    if (e.button === 0 && document.pointerLockElement) this.swing();
    this.audio.unlock();
  };

  constructor(
    private readonly runtime: WorldRuntime,
    lightCount: number,
  ) {
    if (!runtime.caveGraph || !runtime.caveStore) throw new Error('no caves in this runtime');
    this.graph = runtime.caveGraph;
    this.store = runtime.caveStore;
    // runtime.ground may wrap the caves (WP20 towns on top): use the cave ground itself.
    this.ground = runtime.caveGround as CaveGround;
    this.group.name = 'caves';
    this.store.onCell = (s) => this.onCell(s);

    const crystal = crystalGeometry();
    this.gemMeshes = GEM_COLORS.map((_, i) => {
      const m = new THREE.InstancedMesh(crystal, gemMaterial(i), GEM_INSTANCES);
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
    this.oreMeshes = ORE_LOOKS.map((_, i) => {
      const m = new THREE.InstancedMesh(nuggetGeometry(i + 3), oreMaterial(i), ORE_INSTANCES);
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
    this.fungi = new THREE.InstancedMesh(mushroomGeometry(), fungusMaterial(), FUNGUS_INSTANCES);
    this.fungi.count = 0;
    this.fungi.frustumCulled = false;
    this.fungi.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FUNGUS_INSTANCES * 3), 3);
    this.group.add(this.fungi);
    for (let i = 0; i < Math.max(1, Math.min(8, lightCount)); i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }
    this.group.add(this.buildArches());
    // Compile the spark program during the load veil, not on the first swing.
    const warm = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)), this.sparkMat);
    warm.frustumCulled = false;
    this.group.add(warm);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('mousedown', this.onMouse);
    installCaveDebug(this, this.graph);
  }

  /** Materials that should receive the sun's cascaded shadows (arches outside). */
  sunMaterials(): THREE.Material[] {
    return [this.archMat];
  }
  private archMat = archRockMaterial();
  private readonly pickupGem = rupeeGeometry(0.18, 0.32);
  private readonly pickupOre = nuggetGeometry(7);

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('mousedown', this.onMouse);
    for (const e of this.meshes.values()) e.mesh.geometry.dispose();
    this.meshes.clear();
    this.hud?.remove();
    this.toastEl?.remove();
    this.store.onCell = null;
  }

  // ---- streaming

  private nearestOpening(x: number, z: number): number {
    let best = Infinity;
    for (const o of this.graph.openings) best = Math.min(best, Math.hypot(x - o.x, z - o.z));
    return best;
  }

  private cellInSystems(cx: number, cy: number, cz: number): boolean {
    const x0 = cx * CAVE_CELL_W - 2, y0 = cy * CAVE_CELL_H - 2, z0 = cz * CAVE_CELL_W - 2;
    const x1 = x0 + CAVE_CELL_W + 2, y1 = y0 + CAVE_CELL_H + 2, z1 = z0 + CAVE_CELL_W + 2;
    for (const s of this.graph.systems) {
      const b = s.bbox;
      if (b[0] <= x1 && b[3] >= x0 && b[1] <= y1 && b[4] >= y0 && b[2] <= z1 && b[5] >= z0) return true;
    }
    return false;
  }

  private request(cx: number, cy: number, cz: number, prio: number): void {
    const k = caveCellKey(cx, cy, cz);
    if (this.inflight.has(k) || this.inflight.size >= MAX_INFLIGHT) return;
    const sig = this.store.editSig(cx, cy, cz);
    this.inflight.set(k, sig);
    this.stats.requested++;
    const edits = encodeCaveEdits(this.store.editsFor(cx, cy, cz));
    this.runtime.pool
      .submit(`cave:${k}`, { type: 'cave', cx, cy, cz, edits }, prio)
      .then((r: ResultMsg | null) => {
        this.inflight.delete(k);
        if (!r || r.type !== 'cave') return;
        this.stats.built++;
        this.stats.buildMs += r.genMs;
        this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, r.genMs);
        // An edit landed while this was in flight: build again with it.
        if (sig !== this.store.editSig(cx, cy, cz)) return;
        this.store.put(parseCaveCell(r.bytes));
      })
      .catch(() => this.inflight.delete(k));
  }

  private onCell(s: StoredCell): void {
    const e = this.meshes.get(s.key);
    if (e && e.version !== s.version) {
      this.disposeMesh(s.key);
    }
    this.visualsDirty = true;
  }

  private disposeMesh(k: number): void {
    const e = this.meshes.get(k);
    if (!e) return;
    this.group.remove(e.mesh);
    e.mesh.geometry.dispose();
    this.meshes.delete(k);
    this.visualsDirty = true;
  }

  private ensureMesh(s: StoredCell): void {
    if (this.meshes.has(s.key) || s.cell.triangleCount === 0) return;
    const c = s.cell;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    const ib = new THREE.InterleavedBuffer(c.normals, 4);
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 0, true));
    g.setAttribute('aBand', new THREE.InterleavedBufferAttribute(ib, 1, 3, true));
    g.setIndex(new THREE.BufferAttribute(c.indices, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.rock);
    mesh.name = `cave ${c.cx},${c.cy},${c.cz}`;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.meshes.set(s.key, { mesh, version: s.version });
    this.visualsDirty = true;
  }

  private stream(px: number, py: number, pz: number): void {
    const R = CAVE_RENDER_M;
    const cx0 = Math.floor((px - R) / CAVE_CELL_W), cx1 = Math.floor((px + R) / CAVE_CELL_W);
    const cz0 = Math.floor((pz - R) / CAVE_CELL_W), cz1 = Math.floor((pz + R) / CAVE_CELL_W);
    const cy0 = Math.floor((py - 48) / CAVE_CELL_H), cy1 = Math.floor((py + 40) / CAVE_CELL_H);
    const want = new Set<number>();
    const missing: [number, number, number, number][] = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          if (!caveCellValid(cx, cy, cz) || !this.cellInSystems(cx, cy, cz)) continue;
          const dx = Math.max(0, Math.abs(px - (cx + 0.5) * CAVE_CELL_W) - CAVE_CELL_W / 2);
          const dz = Math.max(0, Math.abs(pz - (cz + 0.5) * CAVE_CELL_W) - CAVE_CELL_W / 2);
          const d = Math.hypot(dx, dz);
          if (d > R) continue;
          const k = caveCellKey(cx, cy, cz);
          want.add(k);
          const s = this.store.cells.get(k);
          if (s) {
            s.lastUsed = Number.MAX_SAFE_INTEGER - 1; // keep while wanted
            this.ensureMesh(s);
          } else missing.push([d + Math.abs(py - (cy + 0.5) * CAVE_CELL_H) * 0.5, cx, cy, cz]);
        }
      }
    }
    missing.sort((a, b) => a[0] - b[0]);
    for (const [d, cx, cy, cz] of missing) this.request(cx, cy, cz, d * 0.4);
    for (const k of [...this.meshes.keys()]) if (!want.has(k)) this.disposeMesh(k);
    for (const s of this.store.cells.values()) if (!want.has(s.key) && s.lastUsed > 1e15) s.lastUsed = 0;
  }

  // ---- instanced visuals (veins, fungi) and light emitters

  private rebuildVisuals(): void {
    this.visualsDirty = false;
    const gemCount = new Array(this.gemMeshes.length).fill(0);
    const oreCount = new Array(this.oreMeshes.length).fill(0);
    let fc = 0;
    const emitters: Emitter[] = [];
    this.activeVeins = [];
    const col = new THREE.Color();
    for (const k of this.meshes.keys()) {
      const s = this.store.cells.get(k);
      if (!s) continue;
      for (const v of s.cell.veins) {
        if (v.flags & 2) continue; // mined
        this.activeVeins.push(v);
        const r = rng(v.id);
        const n = tmpV.set(v.nx, v.ny, v.nz).normalize().clone();
        const gem = v.kind === 'gem';
        const target = gem ? this.gemMeshes[v.material] : this.oreMeshes[v.material];
        const counts = gem ? gemCount : oreCount;
        if (!target) continue;
        for (let i = 0; i < v.size; i++) {
          if (counts[v.material] >= (gem ? GEM_INSTANCES : ORE_INSTANCES)) break;
          // Scatter around the vein point on the wall plane, lean out along the normal.
          const t1 = new THREE.Vector3().crossVectors(n, Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
          const t2 = new THREE.Vector3().crossVectors(n, t1);
          const a = r() * Math.PI * 2;
          const rad = (i === 0 ? 0 : 0.18 + r() * 0.32) * (gem ? 1 : 1.2);
          const p = new THREE.Vector3(v.x, v.y, v.z).addScaledVector(t1, Math.cos(a) * rad).addScaledVector(t2, Math.sin(a) * rad).addScaledVector(n, gem ? -0.05 : -0.08);
          const dir = n.clone().addScaledVector(t1, (r() - 0.5) * 0.9).addScaledVector(t2, (r() - 0.5) * 0.9).normalize();
          tmpQ.setFromUnitVectors(UP, dir);
          const sc = (gem ? 0.7 + r() * 0.8 : 0.8 + r() * 0.9) * (i === 0 ? 1.3 : 1);
          tmpS.set(sc, gem ? sc * (0.8 + r() * 0.6) : sc, sc);
          tmpM.compose(p, tmpQ, tmpS);
          target.setMatrixAt(counts[v.material]++, tmpM);
        }
        if (gem) {
          emitters.push({ x: v.x + v.nx * 0.6, y: v.y + v.ny * 0.6, z: v.z + v.nz * 0.6, color: new THREE.Color(GEM_COLORS[v.material][1]), intensity: 10, distance: 10 });
        } else if (ORE_LOOKS[v.material].glow > 0.4) {
          emitters.push({ x: v.x + v.nx * 0.6, y: v.y + v.ny * 0.6, z: v.z + v.nz * 0.6, color: new THREE.Color(ORE_LOOKS[v.material].emissive), intensity: 9, distance: 8 });
        }
      }
      for (const d of s.cell.decos) {
        if (d.kind === 2) continue; // stalagmites: rock, drawn by the mesh's noise
        const r = rng(BigInt(Math.floor(d.x * 131 + d.z * 7919)));
        const color = col.set(ELEMENT_GLOW[d.variant] ?? ELEMENT_GLOW[0]);
        const n = d.kind === 0 ? 3 + Math.floor(r() * 5) : 2 + Math.floor(r() * 3);
        for (let i = 0; i < n && fc < FUNGUS_INSTANCES; i++) {
          const a = r() * Math.PI * 2;
          const rad = i === 0 ? 0 : 0.15 + r() * 0.45;
          const sc = ((d.scale / 255) * 0.9 + 0.45) * (0.7 + r() * 0.6) * (d.kind === 1 ? 1.5 : 1);
          tmpQ.setFromAxisAngle(UP, r() * 6.28);
          tmpS.set(sc, sc * (d.kind === 1 ? 2.2 : 1), sc);
          tmpM.compose(new THREE.Vector3(d.x + Math.cos(a) * rad, d.y, d.z + Math.sin(a) * rad), tmpQ, tmpS);
          this.fungi.setMatrixAt(fc, tmpM);
          this.fungi.setColorAt(fc, color);
          fc++;
        }
        emitters.push({ x: d.x, y: d.y + 0.4, z: d.z, color: color.clone(), intensity: 5, distance: 7 });
      }
    }
    this.gemMeshes.forEach((m, i) => {
      m.count = gemCount[i];
      m.instanceMatrix.needsUpdate = true;
    });
    this.oreMeshes.forEach((m, i) => {
      m.count = oreCount[i];
      m.instanceMatrix.needsUpdate = true;
    });
    this.fungi.count = fc;
    this.fungi.instanceMatrix.needsUpdate = true;
    if (this.fungi.instanceColor) this.fungi.instanceColor.needsUpdate = true;
    this.emitters = emitters;
    this.stats.veins = this.activeVeins.length;
  }

  private updateLights(cam: THREE.Vector3, forward: THREE.Vector3): void {
    // Light 0: the player's lantern glow underground (staff glow, spec 7).
    const lantern = this.lights[0];
    // A wisp floating ahead and above the eye. At the hands it blew the
    // first-person arms out to white while walls 4 m away stayed dark
    // (inverse square); out here the arms are ~1.7 m from it and the walls
    // ahead 2-4 m, and the light grazes the rock so its facets read.
    lantern.position.copy(cam).addScaledVector(forward, 1.6).add(tmpV.set(0, 0.8, 0));
    lantern.color.set(0xffd9a8);
    lantern.distance = 26;
    lantern.intensity = 18 * this.underground;
    const near = this.emitters
      .map((e) => ({ e, d: (e.x - cam.x) ** 2 + (e.y - cam.y) ** 2 + (e.z - cam.z) ** 2 }))
      .filter((x) => x.d < 32 * 32)
      .sort((a, b) => a.d - b.d);
    let used = 1;
    for (let i = 1; i < this.lights.length; i++) {
      const l = this.lights[i];
      const n = near[i - 1];
      if (!n) {
        l.intensity = 0;
        continue;
      }
      l.position.set(n.e.x, n.e.y, n.e.z);
      l.color.copy(n.e.color);
      l.distance = n.e.distance;
      // Fade lights in by distance so reassignments don't pop.
      l.intensity = n.e.intensity * Math.min(1, (32 * 32 - n.d) / (12 * 12)) * Math.max(0.35, this.underground);
      used++;
    }
    this.stats.lights = used;
  }

  // ---- arches over mouths, rims around sinkholes

  private buildArches(): THREE.InstancedMesh {
    const rocks: THREE.Matrix4[] = [];
    const wg = this.runtime.wg;
    const atlas = this.runtime.atlas;
    const hAt = (x: number, z: number) => wg.collisionHeight(atlas, x, z);
    for (const o of this.graph.openings) {
      const rand = rng(BigInt(Math.floor(o.x * 1000 + o.z)));
      if (o.kind === 'mouth') {
        const yaw = (o.yaw / 65536) * Math.PI * 2;
        const out = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
        const side = new THREE.Vector3(-out.z, 0, out.x);
        const sys = this.graph.systems[o.system];
        const t = this.graph.tunnels[sys.firstTunnel];
        const ra = t.r + 1.6;
        // The arch stands where the ramp meets the hillside: the outer edge of the hole.
        const cx = o.x + out.x * o.rMask * 0.35;
        const cz = o.z + out.z * o.rMask * 0.35;
        const base = Math.min(hAt(cx + side.x * ra, cz + side.z * ra), hAt(cx - side.x * ra, cz - side.z * ra)) - 0.6;
        const k = 11;
        for (let i = 0; i < k; i++) {
          const th = (i / (k - 1)) * Math.PI;
          const sc = (i === 0 || i === k - 1 ? 1.6 : 1.1) + rand() * 0.5;
          const p = new THREE.Vector3(cx, base, cz).addScaledVector(side, Math.cos(th) * ra).add(tmpV.set(0, Math.sin(th) * ra * 1.15 + 0.3, 0));
          rocks.push(new THREE.Matrix4().compose(p, tmpQ.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)), tmpS.set(sc, sc, sc)));
        }
        // Rim: boulders around the hole, leaving the downhill side (the path in) open.
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2 + rand() * 0.2;
          const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
          if (dir.dot(out) > 0.55) continue;
          const rr = o.rMask + 0.6 + rand() * 1.2;
          const x = o.x + dir.x * rr, z = o.z + dir.z * rr;
          const sc = 0.6 + rand() * 0.9;
          rocks.push(new THREE.Matrix4().compose(new THREE.Vector3(x, hAt(x, z) - sc * 0.3, z), tmpQ.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)), tmpS.set(sc, sc * 0.8, sc)));
        }
      } else {
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2 + rand() * 0.2;
          const rr = o.rMask + 0.4 + rand() * 0.8;
          const x = o.x + Math.cos(a) * rr, z = o.z + Math.sin(a) * rr;
          const sc = 0.7 + rand() * 1.0;
          rocks.push(new THREE.Matrix4().compose(new THREE.Vector3(x, hAt(x, z) - sc * 0.35, z), tmpQ.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)), tmpS.set(sc, sc * 0.75, sc)));
        }
      }
    }
    const m = new THREE.InstancedMesh(boulderGeometry(), this.archMat, rocks.length);
    rocks.forEach((r, i) => m.setMatrixAt(i, r));
    m.instanceMatrix.needsUpdate = true;
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'cave arches';
    m.computeBoundingSphere();
    return m;
  }

  // ---- mining

  private findTarget(cam: THREE.Vector3, forward: THREE.Vector3): CaveVein | null {
    let best: CaveVein | null = null;
    let bestCos = Math.cos((14 * Math.PI) / 180);
    for (const v of this.activeVeins) {
      const dx = v.x - cam.x, dy = v.y - cam.y, dz = v.z - cam.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > REACH_M || d < 1e-3) continue;
      const c = (dx * forward.x + dy * forward.y + dz * forward.z) / d;
      if (c > bestCos) {
        bestCos = c;
        best = v;
      }
    }
    return best;
  }

  private swing(): void {
    this.audio.unlock();
    const v = this.target;
    const now = performance.now();
    if (!v || now - this.lastSwing < SWING_MS) return;
    this.lastSwing = now;
    this.audio.hit(v.kind === 'gem');
    this.spark(v);
    const session = netRuntime.session;
    if (session && session.phase === 'playing') {
      session.sendInteract(40, v.id, 1, 0); // Interact targetKind 40 = vein (contracts/events.md)
      return;
    }
    // Solo: the same rules locally (pickaxe 25 per swing, carve on break).
    const hp = (this.localHp.get(v.id) ?? v.hp) - 25;
    this.localHp.set(v.id, hp);
    if (hp <= 0) this.breakLocal(v);
  }

  private breakLocal(v: CaveVein): void {
    this.localHp.delete(v.id);
    this.audio.crumble();
    this.store.setEdit({ veinId: v.id, x: v.x, y: v.y, z: v.z, r: 1.5 });
    const item = v.kind === 'gem' ? `gem:${veinMaterialName(v)}:rough` : `ore:${veinMaterialName(v)}`;
    const qty = v.kind === 'gem' ? 1 : 1 + Math.floor(v.size / 3);
    this.spawnPickup(v.x + v.nx * 0.7, v.y + v.ny * 0.7 + 0.2, v.z + v.nz * 0.7, item, qty, null);
    this.toast(`${veinMaterialName(v)} ${v.kind === 'gem' ? 'cluster' : 'vein'} broken`);
  }

  /** One-instance InstancedMesh: same shader program as the vein clusters (a plain Mesh would compile a non-instanced variant mid-game). */
  private single(g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[]): THREE.Mesh {
    const im = new THREE.InstancedMesh(g, m, 1);
    im.setMatrixAt(0, new THREE.Matrix4());
    im.frustumCulled = false;
    return im;
  }

  private spawnPickup(x: number, y: number, z: number, item: string, qty: number, serverId: number | null): void {
    const [kind, name] = item.split(':');
    let mesh: THREE.Mesh;
    if (kind === 'gem') {
      const gi = ['ruby', 'sapphire', 'topaz', 'emerald', 'aquamarine', 'sunstone', 'onyx', 'amethyst', 'opal', 'moonstone'].indexOf(name);
      // Reuse the instanced meshes' materials: a fresh physical material
      // compiled a new program on every break (a 180 ms hitch).
      mesh = this.single(this.pickupGem, this.gemMeshes[Math.max(0, gi)].material);
    } else {
      const oi = ['copper', 'iron', 'silver', 'sunsteel', 'starmetal', 'voidglass'].indexOf(name);
      mesh = this.single(this.pickupOre, this.oreMeshes[Math.max(0, oi)].material);
    }
    mesh.position.set(x, y, z);
    mesh.name = `pickup ${item}`;
    this.group.add(mesh);
    this.pickups.push({ id: this.nextPickupId++, mesh, item, qty, t: 0, serverId });
  }

  private readonly sparkMat = new THREE.PointsMaterial({ size: 0.06, transparent: true, opacity: 1, depthWrite: false });

  private spark(v: CaveVein): void {
    const n = 24;
    const pos = new Float32Array(n * 3);
    const vel: number[] = [];
    for (let i = 0; i < n; i++) {
      pos.set([v.x + v.nx * 0.15, v.y + v.ny * 0.15, v.z + v.nz * 0.15], i * 3);
      vel.push(v.nx * 2 + (Math.random() - 0.5) * 3, v.ny * 2 + Math.random() * 2, v.nz * 2 + (Math.random() - 0.5) * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.userData.vel = vel;
    const color = v.kind === 'gem' ? GEM_COLORS[v.material][1] : '#ffcf8a';
    const mat = this.sparkMat.clone(); // same program, own color/opacity
    mat.color.set(color);
    const pts = new THREE.Points(g, mat);
    this.group.add(pts);
    this.sparks.push({ mesh: pts, t: 0 });
  }

  /** Online: hook the zone session's WorldEdits and mining events (once per session). */
  private hookSession(): void {
    const s = netRuntime.session;
    if (!s || s === this.hookedSession) return;
    this.hookedSession = s;
    s.onWorldEdits = (m) => {
      const now = s.clock.serverNow();
      for (const e of m.edits) {
        if (e.kind !== 1 || e.params.length < 16) continue; // vein_mined
        const dv = new DataView(e.params.buffer, e.params.byteOffset, 16);
        const edit = { veinId: e.targetId, x: dv.getFloat32(0, true), y: dv.getFloat32(4, true), z: dv.getFloat32(8, true), r: dv.getFloat32(12, true) };
        if (e.expiresAt !== 0 && e.expiresAt <= now + 50) this.store.removeEdit(e.targetId);
        else this.store.setEdit(edit);
      }
      this.visualsDirty = true;
    };
    s.eventListeners.add((ev) => {
      const vein = ev.data.length >= 8 ? new DataView(ev.data.buffer, ev.data.byteOffset, 8).getBigUint64(0, true) : 0n;
      switch (ev.kind) {
        case 701: {
          const max = ev.data.length >= 10 ? new DataView(ev.data.buffer, ev.data.byteOffset, 10).getUint16(8, true) : 0;
          this.serverHp.set(vein, [ev.value, max]);
          break;
        }
        case 702:
          this.audio.crumble();
          this.serverHp.delete(vein);
          this.toast('Vein broken');
          break;
        case 704:
          this.audio.chime();
          this.toast(`+${ev.value} ${itemLabel(new TextDecoder().decode(ev.data))}`);
          break;
        case 706:
          if (ev.value === 1) this.toast('Too far to reach');
          else if (ev.value === 2) this.toast('Already mined');
          break;
      }
    });
  }

  private toast(text: string): void {
    this.toasts.push({ text, until: performance.now() + 2500 });
  }

  private updateHud(): void {
    if (!this.hud) {
      this.hud = document.createElement('div');
      this.hud.dataset.testid = 'cave-hud';
      Object.assign(this.hud.style, { position: 'fixed', left: '50%', top: '58%', transform: 'translateX(-50%)', color: '#f1ecdf', font: '13px system-ui, sans-serif', textShadow: '0 1px 2px #000', pointerEvents: 'none', zIndex: '20', textAlign: 'center' });
      document.body.appendChild(this.hud);
      this.toastEl = document.createElement('div');
      Object.assign(this.toastEl.style, { position: 'fixed', left: '50%', top: '22%', transform: 'translateX(-50%)', color: '#ffe9b0', font: '600 15px system-ui, sans-serif', textShadow: '0 1px 3px #000', pointerEvents: 'none', zIndex: '20', textAlign: 'center' });
      document.body.appendChild(this.toastEl);
    }
    const v = this.target;
    if (v) {
      const hp = this.serverHp.get(v.id) ?? [this.localHp.get(v.id) ?? v.hp, v.hp];
      const pct = Math.max(0, Math.min(1, hp[0] / Math.max(1, hp[1] || v.hp)));
      this.hud.innerHTML = `<div><b>[E]</b> mine ${veinMaterialName(v)}${v.kind === 'gem' ? '' : ' ore'}</div><div style="margin:4px auto 0;width:120px;height:4px;background:#0008"><div style="width:${Math.round(pct * 100)}%;height:4px;background:#e8c46a"></div></div>`;
    } else this.hud.textContent = '';
    const now = performance.now();
    this.toasts = this.toasts.filter((t) => t.until > now);
    if (this.toastEl) this.toastEl.textContent = this.toasts.map((t) => t.text).join('  ·  ');
  }

  private updatePickups(dt: number, cam: THREE.Vector3): void {
    // Online pickups come from snapshots (personal: only ours are sent).
    const s = netRuntime.session;
    if (s && s.phase === 'playing' && s.latestFrame) {
      const seen = new Set<number>();
      for (const e of s.latestFrame.ents) {
        if (e.kind !== 4) continue; // EntityKind.pickup
        if (!e.name.startsWith('ore:') && !e.name.startsWith('gem:')) continue; // WP14: other items are drawn by ui/inventory/LootLayer
        seen.add(e.id);
        if (!this.pickups.some((p) => p.serverId === e.id)) this.spawnPickup(e.x / 100, e.y / 100, e.z / 100, e.name, e.level, e.id);
      }
      for (const p of this.pickups) if (p.serverId !== null && !seen.has(p.serverId)) p.t = -1; // taken: fly to the player
    }
    for (const p of this.pickups) {
      p.t += dt;
      p.mesh.rotation.y += dt * 2;
      const feet = localPlayer.pos;
      const d = Math.hypot(p.mesh.position.x - feet.x, p.mesh.position.y - (feet.y + 1), p.mesh.position.z - feet.z);
      const solo = p.serverId === null;
      if ((solo && (d < 2.5 || p.t > 1.2)) || p.t < 0 || p.t > 1e6) {
        // Fly to the player and vanish (the grant): local in solo, the zone's take online.
        p.mesh.position.lerp(tmpV.set(cam.x, cam.y - 0.4, cam.z), Math.min(1, dt * 8));
        p.mesh.scale.multiplyScalar(1 - Math.min(0.9, dt * 3));
        if (p.mesh.scale.x < 0.15) {
          if (solo) {
            this.audio.chime();
            this.toast(`+${p.qty} ${itemLabel(p.item)}`);
          }
          p.t = 2e6;
        }
      } else {
        p.mesh.position.y += Math.sin(p.t * 3) * dt * 0.15;
      }
    }
    for (const p of this.pickups.filter((x) => x.t >= 2e6)) this.group.remove(p.mesh); // shared geometry and material
    this.pickups = this.pickups.filter((x) => x.t < 2e6);
    for (const sp of this.sparks) {
      sp.t += dt;
      const pos = sp.mesh.geometry.attributes.position as THREE.BufferAttribute;
      const vel = sp.mesh.geometry.userData.vel as number[];
      for (let i = 0; i < pos.count; i++) {
        vel[i * 3 + 1] -= 9.8 * dt;
        pos.setXYZ(i, pos.getX(i) + vel[i * 3] * dt, pos.getY(i) + vel[i * 3 + 1] * dt, pos.getZ(i) + vel[i * 3 + 2] * dt);
      }
      pos.needsUpdate = true;
      (sp.mesh.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - sp.t / 0.5);
    }
    for (const sp of this.sparks.filter((x) => x.t > 0.5)) {
      this.group.remove(sp.mesh);
      sp.mesh.geometry.dispose();
    }
    this.sparks = this.sparks.filter((x) => x.t <= 0.5);
  }

  // ---- per frame

  update(camera: THREE.Camera, dt: number, now: number): void {
    this.store.tick();
    this.hookSession();
    const feet = localPlayer.pos;
    const cam = camera.position;
    const forward = tmpV.set(0, 0, -1).applyQuaternion(camera.quaternion).clone();
    const h = this.ground.heightAt(feet.x, feet.z);
    const inCave = this.ground.inCave(feet.x, feet.y, feet.z);
    const nearMouth = this.nearestOpening(feet.x, feet.z);
    const target = inCave ? Math.min(1, Math.max(0.25, (h - feet.y + 1.5) / 9)) : 0;
    this.underground += (target - this.underground) * Math.min(1, dt * 1.6);
    this.active = inCave || nearMouth < CAVE_ACTIVATE_M;
    if (this.active) this.stream(feet.x, feet.y, feet.z);
    else if (this.meshes.size) for (const k of [...this.meshes.keys()]) this.disposeMesh(k);
    if (this.visualsDirty) this.rebuildVisuals();
    this.updateLights(cam, forward);
    this.target = this.underground > 0.05 || nearMouth < 30 ? this.findTarget(cam, forward) : null;
    this.updatePickups(dt, cam);
    this.updateHud();
    if (now > this.nextAudio) {
      this.nextAudio = now + 400;
      const si = inCave ? caveSystemAt(this.graph, feet.x, feet.y + 1, feet.z) : -1;
      if (si >= 0) {
        const s = this.graph.systems[si];
        let best = Infinity;
        let r = 4;
        for (let k = 0; k < s.chamberCount; k++) {
          const c = this.graph.chambers[s.firstChamber + k];
          const d = Math.hypot(c.x - feet.x, c.floor - feet.y, c.z - feet.z) - c.rx;
          if (d < best) {
            best = d;
            r = d < 2 ? c.rx : 3.5; // in a chamber: its radius; in a tunnel: tight
          }
        }
        this.chamberRadius = r;
        this.audio.setChamberRadius(r);
      }
    }
    this.audio.setUnderground(this.underground, now);
    this.stats.cells = this.store.cells.size;
    this.stats.meshes = this.meshes.size;
    this.stats.syncBuilds = this.store.syncBuilds;
  }

  /** Debug/headless: the graph, and where the deepest chamber of a system is. */
  debugInfo(): { systems: number; underground: number; chamberRadius: number; stats: CaveManager['stats']; target: string | null } {
    return { systems: this.graph.systems.length, underground: this.underground, chamberRadius: this.chamberRadius, stats: this.stats, target: this.target ? `${veinMaterialName(this.target)} ${this.target.id.toString(16)}` : null };
  }

  /** Debug/headless: mine the targeted vein (solo: local; online: Interact). */
  debugSwing(): void {
    this.lastSwing = 0;
    this.swing();
  }
}
