// Townsfolk (WP20, spec 5 "NPCs live in towns"): low-poly villagers drawn
// with a handful of InstancedMeshes (one per body part: legs, torso, arms,
// head, hair, hat, helmet, apron, spear), so every NPC in view costs the
// same ~9 draw calls. Role and appearance come from the snapshot (typeId =
// role | variant << 8, level = merchant kind, contracts/events.md); walk
// cycles from the interpolated speed; names and roles float over heads
// within 15 m (DOM labels, like the cave HUD).
//
// Online the zone moves them (schedules: out by day, indoors at night) and
// they arrive as remote entities of kind npc (drawnRemotes.views, filled by
// RemotePlayers each frame). Offline (solo) every NPC stands at its work
// spot from the towns buffer, so solo screenshots show the townsfolk.
//
// Yaw: the renderer works in worldgen's convention (radians from +x toward
// +z, forward = (cos, sin)), so a model facing +x is turned by -yaw. Online
// NPCs arrive with the camera-convention yaw every EntityRecord carries
// (forward = (-sin, -cos), like players); fromWireYaw converts it (the map
// is its own inverse). Offline NPCs read the towns buffer's worldgen yaw.
const fromWireYaw = (y: number) => Math.atan2(-Math.cos(y), -Math.sin(y));

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EntityKind } from '@lodestone/contracts';
import type { Towns } from '@lodestone/worldgen';
import { drawnRemotes, netRuntime } from '../../net/netStore';
import type { GroundQuery } from '../../sim/ground';
import { NPC_ROLE_LABEL } from './townEvents';
import { emoteOf } from '../../ui/emotes/store';

/** CR 028: townsfolk applaud a song with the cheer emote (Event 1090 id 3 on the NPC; value 0 cheer, 1 clap). */
const EMOTE_CHEER = 3;
const CHEER_S = 2.4;

/** How an NPC's arms applaud at t s into a cheer (null: not applauding). Pure: forward raise (about the side axis) and inward swing (about the facing axis). */
export function applaudArms(value: number, t: number, side: number): { fwd: number; inward: number } | null {
  if (t < 0 || t > CHEER_S) return null;
  const env = Math.min(1, t / 0.2) * Math.min(1, (CHEER_S - t) / 0.3);
  if (value === 1) return { fwd: 1.25 * env, inward: side * (0.22 + 0.16 * Math.abs(Math.sin(t * 13))) * env };
  return { fwd: (2.75 + 0.22 * Math.sin(t * 8 + (side > 0 ? 0 : 1.2))) * env, inward: side * 0.12 * env };
}

export const NPC_ROLE = { villager: 0, merchant: 1, blacksmith: 2, innkeeper: 3, bounty: 4, farmer: 5, guard: 6 } as const;
const MAX = 96;
const DRAW_M = 140;
export const LABEL_M = 15;

export interface NpcView {
  /** Entity id online; -1 - record index offline. */
  key: number;
  entityId: number | null;
  /** Towns-buffer record (-1 when an online entity matched none). */
  index: number;
  name: string;
  role: number;
  variant: number;
  merchant: number;
  settlement: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
}

const SKIN = [0xf0c8a0, 0xd9a47c, 0xa8714a, 0x6e4a32].map((c) => new THREE.Color(c));
const HAIR = [0x2b1d14, 0x5a3a20, 0x8a6a3a, 0xc9b28a, 0x1a1a1a, 0x7a2e1a, 0x9a9a9a, 0x4a3020].map((c) => new THREE.Color(c));
const VILLAGER = [0x7a8f5a, 0x8a5a4a, 0x5a6a8a, 0xa08a5a, 0x6a5a7a, 0x9a7a5a, 0x5a7a7a, 0xb0a080].map((c) => new THREE.Color(c));
const ROLE_SHIRT: Record<number, number[]> = {
  1: [0x6a3a8a, 0x2a7a7a, 0x9a3a3a, 0x3a5a9a],
  2: [0x4a4a4e, 0x55504a],
  3: [0xe8e0d0, 0xd8d0c0],
  4: [0x7a2a24, 0x5a2a3a],
  5: [0xb09a6a, 0x9a8a5a],
  6: [0x8a9098, 0x7a8088],
};
/** Eyes, brows and mouth (immersion pass). */
const FACE = new THREE.Color(0x2a1c14);
/** Dwarven beard and hair colours: red, black, grey, chestnut, white, sandy. */
const DWARF_BEARD = [0x8a3a1a, 0x1c1612, 0x8c8a86, 0x5a3820, 0xd8d4cc, 0xb08a4a].map((c) => new THREE.Color(c));
const TROUSERS = [0x4a3a2a, 0x3a3a44, 0x5a4a34, 0x2e2a26].map((c) => new THREE.Color(c));

function part(geo: THREE.BufferGeometry, name: string, shadow: boolean): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }), MAX);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  m.count = 0;
  m.name = `npc-${name}`;
  m.castShadow = shadow;
  m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cyl = (rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number) => new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z);
const merge = (gs: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(gs.map((x) => x.toNonIndexed()), false)!;
  gs.forEach((x) => x.dispose());
  return g;
};

export class NpcRenderer {
  readonly group = new THREE.Group();
  readonly views: NpcView[] = [];
  private readonly legs = part(box(0.15, 0.85, 0.17, 0, -0.425, 0), 'legs', true);
  private readonly torso = part(merge([box(0.27, 0.62, 0.42, 0, 1.15, 0), box(0.2, 0.08, 0.2, 0, 1.49, 0)]), 'torso', true);
  private readonly arms = part(box(0.11, 0.62, 0.12, 0, -0.29, 0), 'arms', false);
  private readonly head = part(merge([box(0.24, 0.27, 0.22, 0, 1.66, 0), box(0.05, 0.06, 0.05, 0.13, 1.64, 0)]), 'head', false);
  // Playtest 2 immersion pass: townsfolk had blank box faces. Eyes, brows and a mouth on the
  // head's front (+x), one more instanced draw for every NPC in view.
  private readonly face = part(
    merge([
      box(0.02, 0.036, 0.034, 0.121, 1.695, 0.052),
      box(0.02, 0.036, 0.034, 0.121, 1.695, -0.052),
      box(0.016, 0.014, 0.056, 0.123, 1.738, 0.054),
      box(0.016, 0.014, 0.056, 0.123, 1.738, -0.054),
      box(0.016, 0.012, 0.062, 0.122, 1.592, 0),
    ]),
    'face',
    false,
  );
  private readonly hair = part(merge([box(0.27, 0.07, 0.25, -0.01, 1.81, 0), box(0.06, 0.22, 0.25, -0.12, 1.7, 0)]), 'hair', false);
  private readonly hat = part(merge([cyl(0.33, 0.33, 0.03, 12, 0, 1.79, 0), cyl(0.14, 0.16, 0.16, 8, 0, 1.87, 0)]), 'hat', false);
  private readonly helmet = part(merge([cyl(0.15, 0.16, 0.14, 8, 0, 1.77, 0), cyl(0.0, 0.15, 0.12, 8, 0, 1.9, 0), box(0.04, 0.12, 0.04, 0.15, 1.69, 0)]), 'helmet', false);
  private readonly apron = part(box(0.03, 0.72, 0.32, 0.15, 1.02, 0), 'apron', false);
  // CR 043: dwarves (townsfolk of the Underground halls) wear a big beard: a bib over the chest and a braided point.
  private readonly beard = part(merge([box(0.1, 0.34, 0.26, 0.135, 1.5, 0), box(0.08, 0.2, 0.16, 0.14, 1.28, 0), box(0.07, 0.07, 0.05, 0.14, 1.15, 0.03), box(0.07, 0.07, 0.05, 0.14, 1.15, -0.03), box(0.09, 0.08, 0.3, 0.12, 1.62, 0)]), 'beard', false);
  private readonly spear = part(merge([cyl(0.025, 0.025, 2.3, 5, 0, 1.05, 0), cyl(0.0, 0.06, 0.25, 4, 0, 2.32, 0)]), 'spear', true);
  private readonly phase = new Map<number, number>();
  private readonly offlineY = new Map<number, number>();
  private readonly labels: HTMLDivElement[] = [];
  private labelRoot: HTMLDivElement | null = null;

  constructor(
    private readonly towns: Towns,
    private readonly ground: GroundQuery & { floorAt?: (x: number, y: number, z: number) => number },
    private readonly isDwarf: (settlement: number) => boolean = () => false,
  ) {
    this.group.name = 'townsfolk';
    this.group.add(this.legs, this.torso, this.arms, this.head, this.face, this.hair, this.hat, this.helmet, this.apron, this.beard, this.spear);
  }

  /** Online when a zone session is playing (NPC entities come from it). */
  private online(): boolean {
    const s = netRuntime.session;
    return !!s && s.phase === 'playing';
  }

  private gather(cam: THREE.Vector3): void {
    const out = this.views;
    out.length = 0;
    if (this.online()) {
      const frame = netRuntime.session?.latestFrame;
      const typeOf = new Map<number, number>();
      if (frame) for (const e of frame.ents) if (e.kind === EntityKind.npc) typeOf.set(e.id, e.typeId);
      for (const v of drawnRemotes.views) {
        if (v.kind !== EntityKind.npc) continue;
        if (Math.hypot(v.x - cam.x, v.z - cam.z) > DRAW_M) continue;
        const rec = this.match(v.name, v.x, v.z);
        const tid = typeOf.get(v.id);
        const role = tid !== undefined ? tid & 0xff : rec ? this.towns.npcs[rec].role : 0;
        const variant = tid !== undefined ? (tid >> 8) & 0xff : rec ? this.towns.npcs[rec].variant : 0;
        out.push({ key: v.id, entityId: v.id, index: rec ?? -1, name: v.name, role, variant, merchant: v.level, settlement: rec !== null ? this.towns.npcs[rec].settlement : -1, x: v.x, y: v.y, z: v.z, yaw: fromWireYaw(v.yaw), speed: v.speed });
        if (out.length >= MAX) break;
      }
      return;
    }
    for (const n of this.towns.npcs) {
      if (Math.hypot(n.workX - cam.x, n.workZ - cam.z) > DRAW_M) continue;
      let y = this.offlineY.get(n.index);
      if (y === undefined) {
        const g = this.ground.heightAt(n.workX, n.workZ);
        y = this.ground.floorAt ? this.ground.floorAt(n.workX, g + 2.0, n.workZ) : g;
        this.offlineY.set(n.index, y);
      }
      out.push({ key: -1 - n.index, entityId: null, index: n.index, name: n.name, role: n.role, variant: n.variant, merchant: n.merchant, settlement: n.settlement, x: n.workX, y, z: n.workZ, yaw: n.workYaw, speed: 0 });
      if (out.length >= MAX) break;
    }
  }

  private readonly nameIdx = new Map<string, number[]>();
  /** Towns-buffer record of an online NPC: same name, nearest home/work spot. */
  private match(name: string, x: number, z: number): number | null {
    if (!this.nameIdx.size) for (const n of this.towns.npcs) this.nameIdx.set(n.name, [...(this.nameIdx.get(n.name) ?? []), n.index]);
    const l = this.nameIdx.get(name);
    if (!l) return null;
    let best = l[0];
    let bd = Infinity;
    for (const i of l) {
      const n = this.towns.npcs[i];
      const d = Math.min(Math.hypot(n.workX - x, n.workZ - z), Math.hypot(n.homeX - x, n.homeZ - z));
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  update(camera: THREE.Camera, dt: number, t: number): void {
    const cam = camera.position;
    this.gather(cam);
    const m = new THREE.Matrix4();
    const base = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const tmp = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const c = new THREE.Color();
    let nl = 0;
    let na = 0;
    let nHat = 0;
    let nHelm = 0;
    let nApron = 0;
    let nSpear = 0;
    let nHair = 0;
    let nBeard = 0;
    const dwarfScale = new THREE.Vector3(1.1, 0.8, 1.25);
    const nowMs = performance.now();
    const xAxis = new THREE.Vector3(1, 0, 0);
    this.views.forEach((v, i) => {
      const em = v.entityId !== null ? emoteOf(v.entityId) : undefined;
      const cheerT = em && em.id === EMOTE_CHEER ? (nowMs - em.at) / 1000 : -1;
      // Walk cycle: phase advances with speed; idle sway otherwise.
      const ph = (this.phase.get(v.key) ?? (v.key * 1.37) % 6.28) + dt * Math.min(v.speed, 4) * 4.2;
      this.phase.set(v.key, ph);
      const walk = Math.min(1, v.speed / 1.2);
      const swing = Math.sin(ph) * 0.6 * walk;
      const sway = (1 - walk) * Math.sin(t * 1.3 + v.key) * 0.06;
      q.setFromAxisAngle(up, -v.yaw);
      const dwarf = v.settlement >= 0 && this.isDwarf(v.settlement);
      // Dwarves: a head shorter and a lot stockier (the model faces +x: x thickness, y height, z width).
      base.compose(new THREE.Vector3(v.x, v.y + Math.abs(Math.sin(ph)) * 0.04 * walk, v.z), q, dwarf ? dwarfScale : one);
      const role = v.role;
      const shirtList = ROLE_SHIRT[role];
      const shirt = shirtList ? new THREE.Color(shirtList[(v.variant >> 2) % shirtList.length]) : VILLAGER[(v.variant >> 2) & 7];
      const trousers = TROUSERS[(v.variant >> 5) & 3];
      // Torso, head.
      this.torso.setMatrixAt(i, base);
      this.torso.setColorAt(i, shirt);
      this.head.setMatrixAt(i, base);
      this.head.setColorAt(i, SKIN[v.variant & 3]);
      this.face.setMatrixAt(i, base);
      this.face.setColorAt(i, FACE);
      // Legs and arms swing about the hip / shoulder (local z axis: the model faces +x).
      for (const side of [-1, 1]) {
        tmp.makeRotationAxis(zAxis, side * swing);
        m.copy(base).multiply(new THREE.Matrix4().makeTranslation(0, 0.85, side * 0.1)).multiply(tmp);
        this.legs.setMatrixAt(nl, m);
        this.legs.setColorAt(nl++, trousers);
        const guardRight = role === NPC_ROLE.guard && side > 0;
        const clap = applaudArms(em?.value ?? 0, cheerT, side);
        tmp.makeRotationAxis(zAxis, clap ? clap.fwd : guardRight ? 0.5 : -side * swing * 0.8 + sway * side);
        m.copy(base).multiply(new THREE.Matrix4().makeTranslation(0, 1.43, side * 0.27));
        if (clap) m.multiply(new THREE.Matrix4().makeRotationAxis(xAxis, clap.inward));
        m.multiply(tmp);
        this.arms.setMatrixAt(na, m);
        this.arms.setColorAt(na++, role === NPC_ROLE.blacksmith ? SKIN[v.variant & 3] : shirt);
      }
      if (dwarf) {
        this.beard.setMatrixAt(nBeard, base);
        this.beard.setColorAt(nBeard++, DWARF_BEARD[(v.variant >> 3) % DWARF_BEARD.length]);
      }
      // Headgear by role (smiths and every other miner wear a helmet under the beard); hair otherwise.
      if (dwarf && (role === NPC_ROLE.blacksmith || role === NPC_ROLE.villager) && (role === NPC_ROLE.blacksmith || (v.variant & 1) === 0)) {
        this.helmet.setMatrixAt(nHelm, base);
        this.helmet.setColorAt(nHelm++, c.set(role === NPC_ROLE.blacksmith ? 0x6a5a4a : 0x8a7a50));
        this.hair.setMatrixAt(nHair, base);
        this.hair.setColorAt(nHair++, DWARF_BEARD[(v.variant >> 3) % DWARF_BEARD.length]);
      } else if (role === NPC_ROLE.guard) {
        this.helmet.setMatrixAt(nHelm, base);
        this.helmet.setColorAt(nHelm++, c.set(0x9aa0a8));
        m.copy(base).multiply(new THREE.Matrix4().makeTranslation(0.3, 0, 0.36));
        this.spear.setMatrixAt(nSpear, m);
        this.spear.setColorAt(nSpear++, c.set(0x6a5038));
      } else if (role === NPC_ROLE.farmer || role === NPC_ROLE.bounty || role === NPC_ROLE.merchant) {
        // Merchants wear the hat squashed into a soft cap (same mesh, scaled about the head top).
        const s = role === NPC_ROLE.merchant ? new THREE.Vector3(0.62, 0.7, 0.62) : one;
        m.copy(base).multiply(new THREE.Matrix4().compose(new THREE.Vector3(0, role === NPC_ROLE.merchant ? 0.55 : 0, 0), new THREE.Quaternion(), s));
        this.hat.setMatrixAt(nHat, m);
        this.hat.setColorAt(nHat++, c.set(role === NPC_ROLE.farmer ? 0xd8c070 : role === NPC_ROLE.bounty ? 0x3a2a20 : shirt.getHex()));
        this.hair.setMatrixAt(nHair, base);
        this.hair.setColorAt(nHair++, HAIR[(v.variant >> 5) & 7]);
      } else {
        this.hair.setMatrixAt(nHair, base);
        this.hair.setColorAt(nHair++, HAIR[((v.variant >> 3) ^ v.variant) & 7]);
      }
      if (role === NPC_ROLE.blacksmith || role === NPC_ROLE.innkeeper) {
        this.apron.setMatrixAt(nApron, base);
        this.apron.setColorAt(nApron++, c.set(role === NPC_ROLE.blacksmith ? 0x5a3a24 : 0xf2eee4));
      }
    });
    const n = this.views.length;
    const set = (mesh: THREE.InstancedMesh, k: number) => {
      mesh.count = k;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    set(this.torso, n);
    set(this.head, n);
    set(this.face, n);
    set(this.legs, nl);
    set(this.arms, na);
    set(this.hat, nHat);
    set(this.helmet, nHelm);
    set(this.apron, nApron);
    set(this.spear, nSpear);
    set(this.beard, nBeard);
    set(this.hair, nHair);
    this.updateLabels(camera);
  }

  private updateLabels(camera: THREE.Camera): void {
    if (!this.labelRoot) {
      this.labelRoot = document.createElement('div');
      this.labelRoot.dataset.testid = 'npc-labels';
      Object.assign(this.labelRoot.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '15' });
      document.body.appendChild(this.labelRoot);
    }
    const cam = camera.position;
    const near = this.views
      .map((v) => ({ v, d: Math.hypot(v.x - cam.x, v.y + 1.7 - cam.y, v.z - cam.z) }))
      .filter((e) => e.d < LABEL_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, 10);
    const p = new THREE.Vector3();
    const w = window.innerWidth;
    const h = window.innerHeight;
    let k = 0;
    for (const { v, d } of near) {
      p.set(v.x, v.y + 2.15, v.z).project(camera);
      if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) continue;
      let el = this.labels[k];
      if (!el) {
        el = document.createElement('div');
        Object.assign(el.style, { position: 'absolute', transform: 'translate(-50%, -100%)', color: '#f4efe2', font: '600 12px system-ui, sans-serif', textShadow: '0 1px 2px #000, 0 0 4px #000', textAlign: 'center', whiteSpace: 'nowrap' });
        this.labels.push(el);
        this.labelRoot.appendChild(el);
      }
      const role = NPC_ROLE_LABEL[v.role] ?? 'villager';
      const text = `${v.name}\n${role}`;
      if (el.dataset.text !== text) {
        el.dataset.text = text;
        el.innerHTML = `${escapeHtml(v.name)}<div style="font-weight:400;font-size:11px;opacity:.8">${role}</div>`;
      }
      el.style.left = `${((p.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - p.y) / 2) * h}px`;
      el.style.opacity = String(Math.max(0, Math.min(1, (LABEL_M - d) / 3)));
      el.style.display = '';
      k++;
    }
    for (let i = k; i < this.labels.length; i++) this.labels[i].style.display = 'none';
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.InstancedMesh;
      if (mesh.isInstancedMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
      }
    });
    this.labelRoot?.remove();
  }
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
