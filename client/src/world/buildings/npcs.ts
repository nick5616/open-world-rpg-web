// Townsfolk (WP20, spec 5 "NPCs live in towns"; playtest 4 CR 050 "lively
// townsfolk"): low-poly villagers drawn with a handful of InstancedMeshes
// (legs, torso, head, and "gear" meshes that hold every variant of arms,
// face, headgear, dress and held props, see npcGear.ts), so every NPC in
// view costs the same 9 draw calls however differently they look. Role and
// appearance come from the snapshot (typeId = role | variant << 8, level =
// merchant kind, contracts/events.md); names and roles float over heads
// within 15 m (DOM labels, like the cave HUD) and whatever they say is drawn
// as a speech bubble over their head (npcBubbles.ts, fed by npcFocus).
//
// Lively (CR 050), all client-side from the snapshot, the clock and hashes of
// the NPC's id (no per-NPC server state): they work at their spot with a
// held tool (hammer, hoe, scythe, broom, mug, spear ...), breathe, blink and
// look around, turn their head to follow you within 6 m, greet you with a
// wave and a word (rate limited), face you and gesture while a dialog is open
// with them, stop to chat with idle neighbours (overheard conversations),
// hold a hand over their head in the rain, cower from monsters, cheer when
// you level up. Poses are pure (npcLife.ts); this file applies them.
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
import { EntityKind, type Event as ZoneEvent } from '@lodestone/contracts';
import { PROP_KINDS, type Towns } from '@lodestone/worldgen';
import { drawnRemotes, netRuntime } from '../../net/netStore';
import type { GroundQuery } from '../../sim/ground';
import { NPC_ROLE_LABEL } from './townEvents';
import { emoteOf } from '../../ui/emotes/store';
import { localPlayer, worldClock } from '../../state/live';
import { liveWeather } from '../../systems/weather/runtime';
import { useQualityStore } from '../../stores/qualityStore';
import { audioEngine } from '../../audio/engine';
import { EV_NPC_BARK, npcFocus } from './npcFocus';
import { BubbleLayer } from './npcBubbles';
import { noteSmith } from './smithLink';
import { CHEER_LINES, GUARD_THREAT, FEAR_LINES, RAIN_LINES, cryFor, greetingFor } from './npcLines';
import {
  GREET_M,
  GreetLimiter,
  H,
  LOOK_M,
  NPC_ROLE,
  PROP,
  blinking,
  buildOf,
  carryProp,
  chatLine,
  chatPairs,
  cowerPose,
  dressFor,
  easeTo,
  lerp,
  lookAround,
  lookAt,
  mouthOpen,
  newPose,
  rainPose,
  resetPose,
  smithState,
  talkPose,
  wavePose,
  workPose,
  wrapPi,
  type Build,
  type ChatCandidate,
  type Dress,
  type LookResult,
} from './npcLife';
import { F, NPC_MAX, buildArms, buildFace, buildHeadGear, buildProps, buildTorsoGear, boxG, type GearMesh } from './npcGear';

export { NPC_ROLE };

/** CR 028: townsfolk applaud a song with the cheer emote (Event 1090 id 3 on the NPC; value 0 cheer, 1 clap). */
const EMOTE_CHEER = 3;
const CHEER_S = 2.4;
const EV_LEVEL_UP = 604;
/** CR 050: the town bell (zone, dusk): x/z in cm, value = strokes. */
export const EV_TOWN_BELL = 1931;

/** How an NPC's arms applaud at t s into a cheer (null: not applauding). Pure: forward raise (about the side axis) and inward swing (about the facing axis). */
export function applaudArms(value: number, t: number, side: number): { fwd: number; inward: number } | null {
  if (t < 0 || t > CHEER_S) return null;
  const env = Math.min(1, t / 0.2) * Math.min(1, (CHEER_S - t) / 0.3);
  if (value === 1) return { fwd: 1.25 * env, inward: side * (0.22 + 0.16 * Math.abs(Math.sin(t * 13))) * env };
  return { fwd: (2.75 + 0.22 * Math.sin(t * 8 + (side > 0 ? 0 : 1.2))) * env, inward: side * 0.12 * env };
}

const MAX = NPC_MAX;
const DRAW_M = 140;
export const LABEL_M = 15;
/** Beyond this the fine animation (looking, gestures) is skipped. */
const LIVELY_M = 60;
const THREAT_M = 20;
const KIND_BENCH = PROP_KINDS.indexOf('bench');
const KIND_ANVIL = PROP_KINDS.indexOf('anvil');
const FOCUS_KINDS = new Set<number>(['anvil', 'stall', 'counter', 'crops', 'workbench', 'board', 'forge'].map((k) => PROP_KINDS.indexOf(k as never)));

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

const col = (list: number[]) => list.map((c) => new THREE.Color(c));
const SKIN = col([0xf0c8a0, 0xd9a47c, 0xa8714a, 0x6e4a32]);
const HAIR = col([0x2b1d14, 0x5a3a20, 0x8a6a3a, 0xc9b28a, 0x1a1a1a, 0x7a2e1a, 0x9a9a9a, 0x4a3020]);
const VILLAGER = col([0x7a8f5a, 0x8a5a4a, 0x5a6a8a, 0xa08a5a, 0x6a5a7a, 0x9a7a5a, 0x5a7a7a, 0xb0a080]);
const CLOTH2 = col([0x8a4a3a, 0x3a5a7a, 0x6a7a3a, 0x7a3a5a, 0x9a8a4a, 0x4a6a5a, 0x7a5a3a, 0x5a4a6a]);
const ACCENT = col([0xc8a040, 0xa03030, 0x2a5a9a, 0xe0d8c0, 0x3a7a4a, 0x7a2a6a, 0xd07030, 0x3a3a3a]);
const TABARD = col([0x2d4a7a, 0x7a2a24, 0x2a5a3a, 0x5a3a6a]);
const ROLE_SHIRT: Record<number, THREE.Color[]> = {
  1: col([0x6a3a8a, 0x2a7a7a, 0x9a3a3a, 0x3a5a9a]),
  2: col([0x4a4a4e, 0x55504a]),
  3: col([0xe8e0d0, 0xd8d0c0]),
  4: col([0x7a2a24, 0x5a2a3a]),
  5: col([0xb09a6a, 0x9a8a5a]),
  6: col([0x8a9098, 0x7a8088]),
};
/** Eyes, brows and mouth (immersion pass). */
const FACE = new THREE.Color(0x2a1c14);
/** Dwarven beard and hair colours: red, black, grey, chestnut, white, sandy. */
const DWARF_BEARD = col([0x8a3a1a, 0x1c1612, 0x8c8a86, 0x5a3820, 0xd8d4cc, 0xb08a4a]);
const TROUSERS = col([0x4a3a2a, 0x3a3a44, 0x5a4a34, 0x2e2a26]);
const WOOD = new THREE.Color(0x6a5038);
const IRON = new THREE.Color(0x70747a);
const STRAW = new THREE.Color(0xc8a860);
const STRAW_HAT = new THREE.Color(0xd8c070);
const DARK_HAT = new THREE.Color(0x3a2a20);
const HELM_IRON = new THREE.Color(0x9aa0a8);
const PLUME = new THREE.Color(0xa02a2a);
const LEATHER = new THREE.Color(0x5a3a24);
const LINEN = new THREE.Color(0xf2eee4);
const SACK = new THREE.Color(0x8a7a5a);
const PROP_C1: Record<number, THREE.Color> = { [PROP.broom]: STRAW, [PROP.basket]: STRAW, [PROP.mug]: IRON, [PROP.crate]: WOOD };

function part(geo: THREE.BufferGeometry, name: string, shadow: boolean): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }), MAX * 2);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2 * 3), 3);
  m.count = 0;
  m.name = `npc-${name}`;
  m.castShadow = shadow;
  m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}

const merge = (gs: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(gs.map((x) => x.toNonIndexed()), false)!;
  gs.forEach((x) => x.dispose());
  return g;
};

/** Everything the renderer remembers about one NPC between frames. */
interface Anim {
  ph: number;
  headYaw: number;
  torso: number;
  yawOff: number;
  track: number;
  near: boolean;
  waveAt: number;
  nodAt: number;
  nodUntil: number;
  nextCry: number;
  cryUntil: number;
  cheerAt: number;
  strikes: number;
  nextBark: number;
  build: Build;
  dress: Dress;
  stable: number;
  elder: boolean;
  dwarf: boolean;
  /** Sit spot (bench) found for this idle stretch: x, z, yaw; null none. */
  sit: { x: number; z: number; yaw: number } | null;
  sitCheckAt: number;
  sitW: number;
  /** Position at the last sit check (re-check when it moved). */
  sx: number;
  sz: number;
  crouchW: number;
  rainW: number;
  last: number;
}

interface Spark {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

export class NpcRenderer {
  readonly group = new THREE.Group();
  readonly views: NpcView[] = [];
  private readonly legs = part(boxG(0.15, 0.85, 0.17, 0, -0.425, 0), 'legs', true);
  private readonly torso = part(merge([boxG(0.27, 0.62, 0.42, 0, 1.15, 0), boxG(0.2, 0.08, 0.2, 0, 1.49, 0)]), 'torso', true);
  private readonly head = part(merge([boxG(0.24, 0.27, 0.22, 0, 1.66, 0), boxG(0.05, 0.06, 0.05, 0.13, 1.64, 0)]), 'head', false);
  private readonly arms: GearMesh = buildArms();
  private readonly face: GearMesh = buildFace();
  private readonly headgear: GearMesh = buildHeadGear();
  private readonly dress: GearMesh = buildTorsoGear();
  private readonly props: GearMesh = buildProps();
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly sparks: Spark[] = [];
  private readonly anim = new Map<number, Anim>();
  private readonly byKey = new Map<number, NpcView>();
  private readonly labels: HTMLDivElement[] = [];
  private labelRoot: HTMLDivElement | null = null;
  private readonly bubbles = new BubbleLayer();
  private readonly greet = new GreetLimiter();
  private readonly offlineY = new Map<number, number>();
  private readonly nameIdx = new Map<string, number[]>();
  private readonly propGrids = new Map<number, Map<number, number[]>>();
  private readonly chat = new Map<number, { partner: number; active: boolean; speaking: boolean }>();
  private readonly chatLast = new Map<number, number>();
  private chatAt = 0;
  private threats: { x: number; z: number }[] = [];
  private hooked: unknown = null;
  private readonly listener = (e: ZoneEvent) => this.onEvent(e);
  private levelCheer = { at: -1e9, x: 0, z: 0 };
  private lastDrawn = 0;
  /** Debug/bench: counts of what the last frame did. */
  readonly stats = { greeted: 0, chats: 0, bubbles: 0, props: 0, sparks: 0 };

  // Scratch (no per-frame allocation in the loop).
  private readonly mBase = new THREE.Matrix4();
  private readonly mUp = new THREE.Matrix4();
  private readonly mHead = new THREE.Matrix4();
  private readonly mArm = new THREE.Matrix4();
  private readonly mHand = new THREE.Matrix4();
  private readonly mLeg = new THREE.Matrix4();
  private readonly mT = new THREE.Matrix4();
  private readonly mR = new THREE.Matrix4();
  private readonly mS = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly look: LookResult = { head: 0, torso: 0, reach: false };
  private readonly pose = newPose();
  private readonly color = new THREE.Color();
  private readonly color2 = new THREE.Color();

  constructor(
    private readonly towns: Towns,
    private readonly ground: GroundQuery & { floorAt?: (x: number, y: number, z: number) => number },
    private readonly isDwarf: (settlement: number) => boolean = () => false,
  ) {
    this.group.name = 'townsfolk';
    const sg = boxG(0.03, 0.03, 0.03, 0, 0, 0);
    this.sparkMesh = new THREE.InstancedMesh(sg, new THREE.MeshBasicMaterial({ color: 0xffb04a }), 64);
    this.sparkMesh.count = 0;
    this.sparkMesh.name = 'npc-sparks';
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.visible = false;
    this.group.add(this.legs, this.torso, this.head, this.arms, this.face, this.headgear, this.dress, this.props, this.sparkMesh);
  }

  /** Online when a zone session is playing (NPC entities come from it). */
  private online(): boolean {
    const s = netRuntime.session;
    return !!s && s.phase === 'playing';
  }

  private gather(cam: THREE.Vector3): void {
    const out = this.views;
    out.length = 0;
    this.byKey.clear();
    this.threats.length = 0;
    if (this.online()) {
      const frame = netRuntime.session?.latestFrame;
      const typeOf = new Map<number, number>();
      if (frame) for (const e of frame.ents) if (e.kind === EntityKind.npc) typeOf.set(e.id, e.typeId);
      for (const v of drawnRemotes.views) {
        if ((v.kind === EntityKind.enemy || v.kind === EntityKind.demon) && this.threats.length < 12 && Math.hypot(v.x - cam.x, v.z - cam.z) < DRAW_M) this.threats.push({ x: v.x, z: v.z });
        if (v.kind !== EntityKind.npc) continue;
        if (Math.hypot(v.x - cam.x, v.z - cam.z) > DRAW_M) continue;
        if (out.length >= MAX) continue;
        const rec = this.match(v.name, v.x, v.z);
        const tid = typeOf.get(v.id);
        const role = tid !== undefined ? tid & 0xff : rec ? this.towns.npcs[rec].role : 0;
        const variant = tid !== undefined ? (tid >> 8) & 0xff : rec ? this.towns.npcs[rec].variant : 0;
        out.push({ key: v.id, entityId: v.id, index: rec ?? -1, name: v.name, role, variant, merchant: v.level, settlement: rec !== null ? this.towns.npcs[rec].settlement : -1, x: v.x, y: v.y, z: v.z, yaw: fromWireYaw(v.yaw), speed: v.speed });
      }
    } else {
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
    for (const v of out) this.byKey.set(v.key, v);
  }

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

  private stateOf(v: NpcView, nowMs: number): Anim {
    let a = this.anim.get(v.key);
    if (!a) {
      const stable = v.index >= 0 ? v.index : v.key;
      const dwarf = v.settlement >= 0 && this.isDwarf(v.settlement);
      const build = buildOf(v.role, v.variant, stable);
      a = {
        ph: (v.key * 1.37) % 6.28,
        headYaw: 0,
        torso: 0,
        yawOff: 0,
        track: 0,
        near: false,
        waveAt: -1e9,
        nodAt: nowMs + 3000 + (stable % 7) * 900,
        nodUntil: 0,
        nextCry: nowMs + 4000 + ((stable * 7919) % 16000),
        cryUntil: 0,
        cheerAt: -1e9,
        strikes: -1,
        nextBark: 0,
        build,
        dress: dressFor(v.role, v.variant, stable, dwarf, build.elder === 1),
        stable,
        elder: build.elder === 1,
        dwarf,
        sit: null,
        sitCheckAt: 0,
        sitW: 0,
        sx: 1e9,
        sz: 1e9,
        crouchW: 0,
        rainW: 0,
        last: nowMs,
      };
      this.anim.set(v.key, a);
      if (this.anim.size > 600) for (const [k, s] of this.anim) if (nowMs - s.last > 60_000) this.anim.delete(k);
    }
    a.last = nowMs;
    return a;
  }

  /** Nearest prop of the given kind within r m of (x, z), or null (towns props, bucketed in 8 m cells once per kind). */
  private propNear(kind: number, x: number, z: number, r: number): { x: number; y: number; z: number; yaw: number } | null {
    let grid = this.propGrids.get(kind);
    if (!grid) {
      grid = new Map();
      for (const p of this.towns.props) {
        if (p.kind !== kind) continue;
        const k = Math.floor(p.x / 8) * 100003 + Math.floor(p.z / 8);
        const l = grid.get(k);
        if (l) l.push(p.index);
        else grid.set(k, [p.index]);
      }
      this.propGrids.set(kind, grid);
    }
    const cx = Math.floor(x / 8);
    const cz = Math.floor(z / 8);
    let best: { x: number; y: number; z: number; yaw: number } | null = null;
    let bd = r;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const l = grid.get((cx + i) * 100003 + (cz + j));
        if (!l) continue;
        for (const pi of l) {
          const p = this.towns.props[pi];
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < bd) {
            bd = d;
            best = { x: p.x, y: p.y, z: p.z, yaw: p.yaw };
          }
        }
      }
    return best;
  }

  private hook(): void {
    const s = netRuntime.session;
    if (s && s !== this.hooked) {
      (this.hooked as { eventListeners: Set<(e: ZoneEvent) => void> } | null)?.eventListeners.delete(this.listener);
      s.eventListeners.add(this.listener);
      this.hooked = s;
    }
  }

  private onEvent(e: ZoneEvent): void {
    if (e.kind === EV_NPC_BARK) {
      const text = new TextDecoder().decode(e.data);
      if (text) npcFocus.say(e.entityId, text, e.value > 0 ? e.value : 0, e.targetId !== 0);
    } else if (e.kind === EV_TOWN_BELL) {
      const at = { x: e.x / 100, y: this.groundY(e.x / 100, e.z / 100) + 12, z: e.z / 100 };
      const n = Math.max(1, Math.min(6, e.value || 3));
      const eng = audioEngine();
      for (let i = 0; i < n; i++) eng?.play('town_bell', { at, volume: 0.9 - i * 0.04, delay: i * 1.9, rate: 1 - i * 0.004 });
    } else if (e.kind === EV_LEVEL_UP) {
      this.levelCheer = { at: performance.now(), x: localPlayer.pos.x, z: localPlayer.pos.z };
      let best: NpcView | null = null;
      let bd = 12;
      for (const v of this.views) {
        const d = Math.hypot(v.x - localPlayer.pos.x, v.z - localPlayer.pos.z);
        if (d < bd && v.speed < 0.3) {
          bd = d;
          best = v;
        }
      }
      if (best) npcFocus.say(best.key, CHEER_LINES[(best.key + e.value + 99) % CHEER_LINES.length], 0, true);
    }
  }

  private groundY(x: number, z: number): number {
    return this.ground.heightAt(x, z);
  }

  private setMatT(x: number, y: number, z: number): THREE.Matrix4 {
    return this.mT.makeTranslation(x, y, z);
  }

  update(camera: THREE.Camera, dt: number, t: number): void {
    const cam = camera.position;
    this.hook();
    this.gather(cam);
    const nowMs = performance.now();
    const unixS = Date.now() / 1000;
    const hour = (worldClock.timeOfDayS / 3600) * 24;
    const rain = liveWeather.mix.rain;
    const raining = rain > 0.4;
    const px = localPlayer.pos.x;
    const py = localPlayer.pos.y;
    const pz = localPlayer.pos.z;
    const quality = useQualityStore.getState().tier;
    const talkKey = npcFocus.talkingTo;

    this.refreshChats(nowMs, unixS, px, pz, talkKey);

    const { mBase, mUp, mHead, mArm, mHand, mLeg, mR, q, pos, scl, up, pose, look, color, color2 } = this;
    const nViews = this.views.length;
    let nl = 0;
    let na = 0;
    let nProps = 0;
    let greeted = 0;

    for (let i = 0; i < nViews; i++) {
      const v = this.views[i];
      const a = this.stateOf(v, nowMs);
      const b = a.build;
      const dw = a.dwarf;
      const role = v.role;
      const toPlayer = Math.hypot(v.x - px, v.z - pz);
      const dy = Math.abs(v.y - py);
      const near = toPlayer < LIVELY_M;
      const moving = v.speed > 0.25;
      const talking = talkKey === v.key;
      const em = v.entityId !== null ? emoteOf(v.entityId) : undefined;
      const cheerT = em && em.id === EMOTE_CHEER ? (nowMs - em.at) / 1000 : -1;
      const lc = this.levelCheer;
      const levelT = nowMs - lc.at < 2600 && Math.hypot(v.x - lc.x, v.z - lc.z) < 14 ? (nowMs - lc.at - (a.stable % 7) * 90) / 1000 : -1;
      const cheerNow = cheerT >= 0 ? cheerT : levelT;
      const cheerVal = cheerT >= 0 ? (em?.value ?? 0) : 0;
      const line = npcFocus.lineOf(v.key, nowMs);
      const walkAdj = raining ? 1.25 : 1;

      // ---- Pose -----------------------------------------------------------
      resetPose(pose);
      let yawTarget = 0;
      let yawW = 0;
      const chat = this.chat.get(v.key);
      if (moving && !talking) {
        pose.prop = carryProp(role, v.variant);
        if (pose.prop === PROP.basket) pose.rFwd = 0.4;
        else if (pose.prop === PROP.bucket) pose.rFwd = 0.1;
        else if (pose.prop === PROP.spear) pose.rFwd = 0.12;
      } else if (near || role === NPC_ROLE.blacksmith) {
        workPose(pose, role, t, a.stable, v.variant);
      }

      // Facing the work (anvil, stall, counter, field): the NPC's own spot.
      if (!moving && near && v.index >= 0) {
        const n = this.towns.npcs[v.index];
        const own = n.workProp >= 0 ? this.towns.props[n.workProp] : null;
        const wp = role === NPC_ROLE.blacksmith ? this.propNear(KIND_ANVIL, v.x, v.z, 3.5) : own && FOCUS_KINDS.has(own.kind) ? own : null;
        if (wp && Math.hypot(wp.x - v.x, wp.z - v.z) < 3.5 && Math.hypot(wp.x - v.x, wp.z - v.z) > 0.2) {
          yawTarget = Math.atan2(wp.z - v.z, wp.x - v.x) - v.yaw;
          yawW = 1;
        }
      }

      // Sitting on a bench (idle villagers near one).
      let sitX = 0;
      let sitZ = 0;
      if (!moving && near && role === NPC_ROLE.villager && (v.variant & 3) === 3) {
        if (nowMs > a.sitCheckAt || Math.hypot(v.x - a.sx, v.z - a.sz) > 0.6) {
          a.sit = this.propNear(KIND_BENCH, v.x, v.z, 1.2);
          a.sx = v.x;
          a.sz = v.z;
          a.sitCheckAt = nowMs + 2000;
        }
      } else if (moving) a.sit = null;
      a.sitW = easeTo(a.sitW, a.sit && !talking && !raining ? 1 : 0, dt, 5);
      if (a.sit && a.sitW > 0.02) {
        sitX = a.sit.x - v.x;
        sitZ = a.sit.z - v.z;
        const away = wrapPi(a.sit.yaw + Math.PI / 2 - v.yaw);
        const alt = wrapPi(a.sit.yaw - Math.PI / 2 - v.yaw);
        yawTarget = Math.abs(away) < Math.abs(alt) ? away : alt;
        yawW = 1;
      }

      // Rain: a hand over the head, hurried steps.
      a.rainW = easeTo(a.rainW, raining && near && !talking && role !== NPC_ROLE.guard && role !== NPC_ROLE.blacksmith ? 1 : 0, dt, 2);
      if (a.rainW > 0.5) {
        const keepProp = pose.prop;
        rainPose(pose, t, a.stable);
        if (keepProp === PROP.basket) pose.prop = PROP.basket;
        else pose.prop = -1;
        if (!line && nowMs > a.nextBark && toPlayer < 18 && h32m(a.stable, nowMs) % 5 === 0) {
          npcFocus.say(v.key, RAIN_LINES[h32m(a.stable, 3) % RAIN_LINES.length], 0, false, nowMs);
          a.nextBark = nowMs + 30_000;
        } else if (nowMs > a.nextBark) a.nextBark = nowMs + 9000;
      }

      // Monsters near: villagers cower, guards turn to face them.
      let threatX = 0;
      let threatZ = 0;
      let threat = false;
      if (this.threats.length && near) {
        let bd = THREAT_M * THREAT_M;
        for (const th of this.threats) {
          const d = (th.x - v.x) ** 2 + (th.z - v.z) ** 2;
          if (d < bd) {
            bd = d;
            threatX = th.x;
            threatZ = th.z;
            threat = true;
          }
        }
      }
      const cowers = threat && role !== NPC_ROLE.guard && !talking;
      a.crouchW = easeTo(a.crouchW, cowers ? 1 : 0, dt, 6);
      if (cowers) {
        cowerPose(pose, t, a.stable);
        if (!line && nowMs > a.nextBark && toPlayer < 24) {
          npcFocus.say(v.key, FEAR_LINES[h32m(a.stable, 5) % FEAR_LINES.length], 0, false, nowMs);
          a.nextBark = nowMs + 16_000;
        }
      } else if (threat && role === NPC_ROLE.guard) {
        yawTarget = Math.atan2(threatZ - v.z, threatX - v.x) - v.yaw;
        yawW = 1;
        pose.rFwd = 0.9;
        pose.bend = 0.1;
        if (!line && nowMs > a.nextBark && toPlayer < 26) {
          npcFocus.say(v.key, GUARD_THREAT[h32m(a.stable, 9) % GUARD_THREAT.length], 0, false, nowMs);
          a.nextBark = nowMs + 20_000;
        }
      }

      // Talking with the player (dialog open) or with a neighbour.
      let speakingNow = !!line;
      if (talking) {
        yawTarget = Math.atan2(pz - v.z, px - v.x) - v.yaw;
        yawW = 1;
        speakingNow = npcFocus.speaking || !!line;
        talkPose(pose, t, a.stable, speakingNow);
        pose.legs = 0;
      } else if (chat && chat.active && !threat && a.rainW < 0.5) {
        const partner = this.byKey.get(chat.partner);
        if (partner) {
          yawTarget = Math.atan2(partner.z - v.z, partner.x - v.x) - v.yaw;
          yawW = 1;
          speakingNow = chat.speaking || !!line;
          talkPose(pose, t, a.stable, chat.speaking);
        }
      }

      // Greeting the player: a wave and a word, rarely.
      const d3 = Math.hypot(toPlayer, dy * 0.5);
      if (near && !talking && !threat) {
        if (d3 < GREET_M && !a.near) {
          a.near = true;
          if (!moving && !line && !(chat && chat.active) && a.rainW < 0.9 && this.greet.tryGreet(v.key, nowMs)) {
            a.waveAt = nowMs;
            npcFocus.say(v.key, greetingFor(role, hour, raining, a.stable ^ ((nowMs / 1000) | 0)), 0, true, nowMs);
            greeted++;
          }
        } else if (d3 > GREET_M + 1.5) a.near = false;
      }
      wavePose(pose, (nowMs - a.waveAt) / 1000);

      // Market cries and calling out, now and then.
      if (near && !moving && !talking && !threat && !line && nowMs > a.nextCry && toPlayer < 22 && (role === NPC_ROLE.merchant || role === NPC_ROLE.blacksmith || role === NPC_ROLE.farmer || role === NPC_ROLE.innkeeper)) {
        npcFocus.say(v.key, cryFor(role, v.merchant, a.stable + ((nowMs / 4000) | 0)), 0, false, nowMs);
        a.nextCry = nowMs + 20_000 + (h32m(a.stable, (nowMs / 1000) | 0) % 24_000);
        a.cryUntil = nowMs + 1100;
        if (role === NPC_ROLE.merchant) a.waveAt = nowMs - 300; // an arm up while calling
      } else if (nowMs > a.nextCry) a.nextCry = nowMs + 5000;

      // Smith: sparks and a clang on every blow, in step with the arm.
      if (role === NPC_ROLE.blacksmith && !moving && near && !talking && !cowers && pose.prop === PROP.hammer) {
        const ss = smithState(t + (a.stable % 61) * 0.7);
        if (a.strikes < 0) a.strikes = ss.strikes;
        else if (ss.strikes !== a.strikes) {
          a.strikes = ss.strikes;
          this.strike(v, a, quality, toPlayer, nowMs);
        }
        if (toPlayer < 60) noteSmith(v.x, v.z, nowMs);
      }

      // Cheering (an applauded song, or your level-up).
      const clapOn = cheerNow >= 0 && cheerNow <= CHEER_S;

      // ---- Body yaw -------------------------------------------------------
      const wantYaw = yawW > 0 ? wrapPi(yawTarget) : 0;
      a.yawOff = easeTo(a.yawOff, wantYaw, dt, yawW > 0 ? 4 : 3);
      if (yawW === 0 && Math.abs(a.yawOff) < 0.003) a.yawOff = 0;
      const yaw = v.yaw + a.yawOff;

      // ---- Head and torso follow the player ---------------------------------
      const watch = near && !talking && !cowers && !(chat && chat.active) && toPlayer < LOOK_M && dy < 4 && a.sitW < 0.5;
      let lookHead = pose.headYaw;
      let lookTorso = 0;
      if (watch) {
        lookAt(yaw, v.x, v.z, px, pz, look);
        a.track = easeTo(a.track, look.reach ? 1 : 0, dt, 3);
        lookHead = lerp(pose.headYaw * (1 - a.track), look.head, a.track);
        lookTorso = look.torso * a.track;
      } else {
        a.track = easeTo(a.track, 0, dt, 2);
        if (talking) lookHead = 0;
        else if (threat && role === NPC_ROLE.guard) lookHead = 0;
        else if (pose.headYaw === 0 && near) lookHead = lookAround(t, a.stable) * (moving ? 0.35 : 0.8);
        else lookHead = pose.headYaw;
      }
      a.headYaw = easeTo(a.headYaw, lookHead, dt, 6);
      a.torso = easeTo(a.torso, lookTorso, dt, 4);
      // An occasional nod to someone it is watching.
      if (a.track > 0.8 && nowMs > a.nodAt) {
        a.nodUntil = nowMs + 700;
        a.nodAt = nowMs + 9000 + (h32m(a.stable, (nowMs / 1000) | 0) % 8000);
      }
      if (nowMs < a.nodUntil) pose.headPitch -= 0.3 * Math.sin(((a.nodUntil - nowMs) / 700) * Math.PI);

      // ---- Idle life -----------------------------------------------------
      const walk = talking || a.sitW > 0.3 ? 0 : Math.min(1, v.speed / 1.2);
      a.ph += dt * Math.min(v.speed, 4) * 4.2 * b.gait * walkAdj * (talking ? 0 : 1);
      const swing = Math.sin(a.ph) * 0.6 * walk * (a.elder ? 0.75 : 1) * pose.legs;
      const breath = Math.sin(t * 1.6 + a.stable) * 0.012;
      const shift = (1 - walk) * Math.sin(t * 0.45 + a.stable * 1.9) * 0.025;
      pose.bend += breath + (a.elder ? 0.16 : 0) + (a.dwarf ? 0.02 : 0);
      pose.twist += a.torso;
      pose.headYaw = a.headYaw;

      // ---- Transforms -----------------------------------------------------
      const sit = a.sitW;
      const crouch = a.crouchW;
      const drop = sit * 0.4 + crouch * 0.32;
      const bobY = Math.abs(Math.sin(a.ph)) * 0.04 * walk * b.h;
      pos.set(v.x + sitX * sit * 0.9, v.y + bobY - drop * b.h, v.z + sitZ * sit * 0.9);
      q.setFromAxisAngle(up, -yaw);
      scl.set((dw ? 1.1 : 1) * (0.55 + 0.45 * b.w), (dw ? 0.8 : 1) * b.h, (dw ? 1.25 : 1) * b.w);
      mBase.compose(pos, q, scl);
      // Weight shifting: lean the whole body a hair about the forward axis.
      if (shift !== 0) mBase.multiply(mR.makeRotationX(shift));

      // Upper body: lean at the hips, twist along the spine.
      mUp.copy(mBase).multiply(this.setMatT(0, 0.85, 0)).multiply(mR.makeRotationZ(pose.bend + crouch * 0.1)).multiply(mR.makeRotationY(-pose.twist)).multiply(this.setMatT(0, -0.85, 0));
      // Head about the neck.
      mHead.copy(mUp).multiply(this.setMatT(0, 1.55, 0)).multiply(mR.makeRotationY(-pose.headYaw)).multiply(mR.makeRotationZ(pose.headPitch)).multiply(mR.makeRotationX(pose.headRoll)).multiply(this.setMatT(0, -1.55, 0));

      const dress = a.dress;
      const cloth = role === NPC_ROLE.villager ? VILLAGER[(v.variant >> 2) & 7] : ROLE_SHIRT[role] ? ROLE_SHIRT[role][(v.variant >> 2) % ROLE_SHIRT[role].length] : VILLAGER[(v.variant >> 2) & 7];
      const trousers = TROUSERS[(v.variant >> 5) & 3];
      const skin = SKIN[dress.skin];

      this.torso.setMatrixAt(i, mUp);
      this.torso.setColorAt(i, cloth);
      this.head.setMatrixAt(i, mHead);
      this.head.setColorAt(i, skin);

      // Face: eyes open/shut, brows, mouth shut/flapping.
      const blink = blinking(t, a.stable);
      const talkMouth = (speakingNow || nowMs < a.cryUntil) && mouthOpen(t, a.stable);
      const faceMask = (1 << (blink ? F.eyeShut : F.eyeOpen)) | (1 << F.brow) | (1 << (talkMouth ? F.mouthOpen : F.mouth));
      this.face.put(i, mHead, faceMask, FACE, FACE, FACE);

      // Head gear.
      let hm = dress.head;
      let hat: THREE.Color = CLOTH2[dress.cloth];
      let hair: THREE.Color = HAIR[dress.hairCol];
      let accent: THREE.Color = ACCENT[dress.accent];
      if (a.dwarf) {
        hair = DWARF_BEARD[(v.variant >> 3) % DWARF_BEARD.length];
        if (role === NPC_ROLE.blacksmith || (role === NPC_ROLE.villager && (v.variant & 1) === 0)) {
          hm = (hm & ~((1 << H.hat) | (1 << H.cap) | (1 << H.flatCap) | (1 << H.hood) | (1 << H.scarf))) | (1 << H.helm) | (1 << H.short);
          hat = color.set(role === NPC_ROLE.blacksmith ? 0x6a5a4a : 0x8a7a50);
        }
      } else if (role === NPC_ROLE.guard) hat = HELM_IRON;
      if (role === NPC_ROLE.farmer && hm & (1 << H.hat)) hat = STRAW_HAT;
      else if (role === NPC_ROLE.bounty) hat = DARK_HAT;
      if (hm & (1 << H.helm)) accent = PLUME;
      this.headgear.put(i, mHead, hm, hair, hat, accent);

      // Dress.
      const apron = role === NPC_ROLE.blacksmith ? LEATHER : role === NPC_ROLE.innkeeper ? LINEN : SACK;
      const main = role === NPC_ROLE.guard ? TABARD[(v.settlement >= 0 ? v.settlement : 0) & 3] : apron;
      this.dress.put(i, mUp, dress.torso, main, CLOTH2[(dress.cloth + 3) & 7], ACCENT[dress.accent]);

      // Legs and arms swing about the hip / shoulder (local z axis: the model faces +x).
      const sitAng = sit * 1.35 + crouch * 0.7;
      for (const side of [-1, 1] as const) {
        mLeg.copy(mBase).multiply(this.setMatT(0, 0.85, side * 0.1)).multiply(mR.makeRotationZ(side * swing + sitAng));
        this.legs.setMatrixAt(nl, mLeg);
        this.legs.setColorAt(nl++, trousers);
        const clap = clapOn ? applaudArms(cheerVal, cheerNow, side) : null;
        const pFwd = side > 0 ? pose.rFwd : pose.lFwd;
        const pIn = side > 0 ? pose.rIn : pose.lIn;
        const holds = side > 0 && pose.prop >= 0 && (pose.prop === PROP.basket || pose.prop === PROP.bucket || pose.prop === PROP.spear);
        const swingArm = pFwd > 1.1 || holds || talking || chat?.active ? 0 : -side * swing * 0.8;
        const sway = (1 - walk) * Math.sin(t * 1.3 + v.key) * 0.06;
        const fwd = clap ? clap.fwd : pFwd + swingArm + sway * side;
        const inw = clap ? clap.inward : side * pIn;
        mArm.copy(mUp).multiply(this.setMatT(0, 1.43, side * 0.27)).multiply(mR.makeRotationX(clap ? inw : inw)).multiply(mR.makeRotationZ(fwd));
        this.arms.put(na, mArm, dress.arm, cloth, skin, ACCENT[dress.accent]);
        na++;
        if (side > 0 && pose.prop >= 0 && !clap) {
          mHand.copy(mArm).multiply(this.setMatT(0, -0.58, 0));
          const c1 = PROP_C1[pose.prop] ?? IRON;
          color2.copy(ACCENT[dress.accent]);
          this.props.put(nProps, mHand, 1 << pose.prop, WOOD, c1, color2);
          nProps++;
        }
      }
    }

    const n = nViews;
    const setPlain = (mesh: THREE.InstancedMesh, k: number) => {
      mesh.count = k;
      mesh.visible = k > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    setPlain(this.torso, n);
    setPlain(this.head, n);
    setPlain(this.legs, nl);
    this.face.finish(n);
    this.headgear.finish(n);
    this.dress.finish(n);
    this.arms.finish(na);
    this.props.finish(nProps);
    this.updateSparks(dt);
    this.stats.greeted += greeted;
    this.stats.props = nProps;
    this.stats.sparks = this.sparks.length;
    this.updateLabels(camera);
    this.bubbles.update(camera, (key) => this.byKey.get(key), nowMs);
    this.stats.bubbles = this.bubbles.shown.size;
    this.lastDrawn = nowMs;
  }

  /** A hammer blow: a clang through the audio engine and a few sparks off the anvil. */
  private strike(v: NpcView, a: Anim, quality: string, toPlayer: number, nowMs: number): void {
    let x = v.x + Math.cos(v.yaw + a.yawOff) * 0.7;
    let z = v.z + Math.sin(v.yaw + a.yawOff) * 0.7;
    let y = v.y + 0.95;
    const p = this.propNear(KIND_ANVIL, v.x, v.z, 3.5);
    if (p) {
      x = p.x;
      z = p.z;
      y = p.y + 0.9;
    }
    if (toPlayer < 45) audioEngine()?.play('forge_hammer', { at: { x, y, z }, volume: 0.32 });
    const k = quality === 'low' ? 4 : 9;
    for (let i = 0; i < k && this.sparks.length < 60; i++) {
      const r = Math.random();
      const ang = Math.random() * Math.PI * 2;
      this.sparks.push({ x, y, z, vx: Math.cos(ang) * (0.6 + r * 1.2), vy: 1.2 + Math.random() * 1.6, vz: Math.sin(ang) * (0.6 + r * 1.2), life: 0.35 + Math.random() * 0.3 });
    }
    void nowMs;
  }

  private updateSparks(dt: number): void {
    const sp = this.sparks;
    const m = this.mHand;
    let k = 0;
    for (let i = sp.length - 1; i >= 0; i--) {
      const s = sp[i];
      s.life -= dt;
      if (s.life <= 0) {
        sp.splice(i, 1);
        continue;
      }
      s.vy -= 7 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
    }
    for (const s of sp) {
      const sc = Math.min(1, s.life * 4);
      m.makeScale(sc, sc, sc).setPosition(s.x, s.y, s.z);
      this.sparkMesh.setMatrixAt(k++, m);
    }
    this.sparkMesh.count = k;
    this.sparkMesh.visible = k > 0;
    if (k) this.sparkMesh.instanceMatrix.needsUpdate = true;
  }

  /** Four times a second: pair up idle neighbours near the player and say each pair's current line. */
  private refreshChats(nowMs: number, unixS: number, px: number, pz: number, talkKey: number | null): void {
    if (nowMs - this.chatAt < 250) return;
    this.chatAt = nowMs;
    this.chat.clear();
    const cands: ChatCandidate[] = [];
    const idx: NpcView[] = [];
    for (const v of this.views) {
      if (v.key === talkKey || v.speed > 0.25) continue;
      if (Math.hypot(v.x - px, v.z - pz) > 30) continue;
      cands.push({ key: v.key, stable: v.index >= 0 ? v.index : v.key, x: v.x, z: v.z, speed: v.speed });
      idx.push(v);
    }
    if (cands.length < 2) return;
    const pairs = chatPairs(cands);
    let chats = 0;
    for (const [ia, ib] of pairs) {
      const A_ = cands[ia];
      const B_ = cands[ib];
      // Guards, smiths hammering and the like stay at their posts; the rest chat when neighbours.
      const va = idx[ia];
      const vb = idx[ib];
      if (va.role === NPC_ROLE.blacksmith || vb.role === NPC_ROLE.blacksmith) continue;
      const cl = chatLine(A_.stable, B_.stable, unixS);
      const active = !!cl && cl.age < 4.4;
      this.chat.set(A_.key, { partner: B_.key, active, speaking: !!cl && cl.speakerIsA && cl.age < 3.8 });
      this.chat.set(B_.key, { partner: A_.key, active, speaking: !!cl && !cl.speakerIsA && cl.age < 3.8 });
      if (!active) continue;
      chats++;
      const pk = A_.stable * 100003 + B_.stable;
      const tag = cl.convo * 100 + cl.index + Math.floor(unixS / 60) * 10000;
      if (this.chatLast.get(pk) !== tag) {
        this.chatLast.set(pk, tag);
        npcFocus.say(cl.speakerIsA ? A_.key : B_.key, cl.text, 4300, false, nowMs);
        if (this.chatLast.size > 200) this.chatLast.clear();
      }
    }
    this.stats.chats = chats;
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
      .filter((e) => e.d < LABEL_M && !this.bubbles.shown.has(e.v.key))
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

  /** Debug: a view's live anim state (tests, scripts). */
  debugAnim(key: number): { track: number; yawOff: number; sitW: number; crouchW: number; rainW: number } | null {
    const a = this.anim.get(key);
    return a ? { track: a.track, yawOff: a.yawOff, sitW: a.sitW, crouchW: a.crouchW, rainW: a.rainW } : null;
  }

  dispose(): void {
    (this.hooked as { eventListeners: Set<(e: ZoneEvent) => void> } | null)?.eventListeners.delete(this.listener);
    this.group.traverse((o) => {
      const mesh = o as THREE.InstancedMesh;
      if (mesh.isInstancedMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
      }
    });
    this.labelRoot?.remove();
    this.bubbles.dispose();
  }
}

/** Cheap deterministic per-NPC, per-moment number for picking lines. */
function h32m(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return (h ^ (h >>> 12)) >>> 0;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
