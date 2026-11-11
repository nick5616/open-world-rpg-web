// The 3D half of loot (WP14; playtest 2 ground loot), mounted inside the
// world canvas by NetPlay:
//   - item pickups: snapshot entities of kind 4 (name = item key, level =
//     qty, typeId = rarity; the server's y is the ground + 0.3), the same for
//     every client that sees them (shared server state; rolled loot is only
//     sent to its owner). Each is its real model (ground/models.ts: the
//     weapon, the armor piece, or a small prop), lying on the ground at a
//     slight angle (common, uncommon) or floating in its beam, slowly turning
//     (rare and better); a light beam streaming down from the sky into it, a
//     splash ring and falling motes (ground/beam.ts, uncommon and better);
//     a few twinkling sparkles (every drop); and its hum (ground/hum.ts,
//     through the audio engine's positional loop pool). Ores and gems keep
//     WP09's caveManager models; this layer adds their light and hum.
//     A drop that appears near you just now (its id is newer than anything
//     seen before) pops out of the corpse or chest in a short arc, its beam
//     striking down from the sky as it lands; one taken near you flies to you.
//   - loot containers from Event 406 (chest, buried cache, urn, crate);
//     opened ones are dimmed and the chest lid stands open.
// Imperative three.js in one useFrame with shared geometries and materials
// (weapon + armor materials, 8 beam/mote/splash materials per quality tier).

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { netRuntime } from '../../net/netStore';
import { localPlayer } from '../../state/live';
import { loopSources } from '../../audio/bridge';
import { useQualityStore, type QualityTier } from '../../stores/qualityStore';
import { liveWeather } from '../../systems/weather/runtime';
import { weaponMaterial } from '../../combat/weapons/material';
import { armorMaterial } from '../../combat/armor/material';
import { isHolo, rarityColor } from './items';
import type { Container } from './events';
import { useInventory } from './store';
import { beamGeometry, beamParams, disposeBeamMaterials, makeBeamMaterials, moteGeometry, ringGeometry, SPARKLE_N, sparkleGeometry, sparkleMaterial, tickBeamMaterials, type BeamMaterials } from './ground/beam';
import { dropGeometry, dropModelOf, type DropModel } from './ground/models';
import { humEmitters, type HumDrop } from './ground/hum';

const geo = {
  chest: new THREE.BoxGeometry(0.9, 0.48, 0.56).translate(0, 0.24, 0),
  lid: new THREE.BoxGeometry(0.92, 0.16, 0.58).translate(0, 0.08, 0.29),
  crate: new THREE.BoxGeometry(0.7, 0.7, 0.7).translate(0, 0.35, 0),
  urn: new THREE.LatheGeometry([new THREE.Vector2(0.0, 0), new THREE.Vector2(0.18, 0), new THREE.Vector2(0.3, 0.2), new THREE.Vector2(0.28, 0.45), new THREE.Vector2(0.14, 0.62), new THREE.Vector2(0.17, 0.7)], 14),
  mound: new THREE.SphereGeometry(0.6, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.4, 1),
  marker: new THREE.BoxGeometry(0.08, 0.5, 0.08).translate(0, 0.25, 0),
};

/** The server puts a drop 0.3 m above the ground (loot_ground.go groundSpot). */
const DROP_LIFT = 0.3;
/** A new drop's pop-out arc and its beam's strike (s). */
const ARC_S = 0.55;
const STRIKE_S = 0.45;
/** A drop taken within this of you flies to you (m). */
const FLY_M = 4;
const FLY_S = 0.28;
/** Props are small: drawn a little larger so they read on the ground. */
const PROP_SCALE = 1.3;
/** Beyond these the model / sparkles / motes are not drawn (m; the beam carries on). */
const MODEL_M = 75;
const SPARKLE_M = 40;
const MOTES_M = 130;

interface PickupView {
  id: number;
  key: string;
  rarity: number;
  group: THREE.Group;
  /** Turns (hover) or holds the tilt (lie). */
  pivot: THREE.Group;
  model: THREE.Object3D | null;
  beam: THREE.Mesh | null;
  motes: THREE.Points | null;
  ring: THREE.Mesh | null;
  glints: THREE.Points;
  dm: DropModel;
  /** Where it rests (ground point). */
  rest: THREE.Vector3;
  /** Hover centre height above the ground (m). */
  hoverY: number;
  t: number;
  /** Arc: from (s since start, -1 none). */
  arc: number;
  from: THREE.Vector3;
  /** Beam strike progress (s since landing, -1 done). */
  strike: number;
  /** Taken: flying to the player (s, -1 no). */
  fly: number;
}

const HOLO_HUES = 0.18; // hue turns per second
const tmpHolo = new THREE.Color();
const tmpV = new THREE.Vector3();
const tmpBox = new THREE.Box3();

function makeMaterials() {
  const sparkle = Array.from({ length: 8 }, (_, r) => sparkleMaterial(new THREE.Color(rarityColor(r)), r >= 2 ? 0.2 : 0.16));
  const box = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
  const wood = box('#7a5230');
  const lid = box('#8d6238');
  const clay = box('#b0643c');
  const crate = box('#a68352');
  const dirt = box('#5b4632');
  const dim = (m: THREE.MeshStandardMaterial) => {
    const c = m.clone();
    c.color.multiplyScalar(0.45);
    return c;
  };
  return { sparkle, wood, lid, clay, crate, dirt, woodDim: dim(wood), lidDim: dim(lid), clayDim: dim(clay), crateDim: dim(crate), dirtDim: dim(dirt), trim: box('#c9a650') };
}

type Mats = ReturnType<typeof makeMaterials>;

function makeContainer(c: Container, m: Mats): THREE.Group {
  const g = new THREE.Group();
  g.position.set(c.x, c.y, c.z);
  g.rotation.y = Number(c.id % 628n) / 100;
  g.name = `container ${c.id}`;
  const o = c.opened;
  switch (c.kind) {
    case 0: {
      g.add(new THREE.Mesh(geo.chest, o ? m.woodDim : m.wood));
      const lid = new THREE.Mesh(geo.lid, o ? m.lidDim : m.lid);
      lid.position.set(0, 0.48, -0.29);
      if (o) lid.rotation.x = -1.9;
      g.add(lid);
      break;
    }
    case 1: {
      g.add(new THREE.Mesh(geo.mound, o ? m.dirtDim : m.dirt));
      if (!o) {
        const mk = new THREE.Mesh(geo.marker, m.wood);
        mk.position.set(0.2, 0.15, 0.1);
        mk.rotation.z = 0.25;
        g.add(mk);
      }
      break;
    }
    case 2:
      g.add(new THREE.Mesh(geo.urn, o ? m.clayDim : m.clay));
      break;
    default:
      g.add(new THREE.Mesh(geo.crate, o ? m.crateDim : m.crate));
  }
  g.traverse((x) => {
    (x as THREE.Mesh).castShadow = true;
  });
  return g;
}

/** Stable per-drop jitter in [0, 1). */
function jitter(id: number, k: number): number {
  const x = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The model of a drop, posed in `pivot`: lying flat at a slight angle, or
 * upright for hovering (swords and spears point down). Returns the hover
 * centre height above the ground.
 */
function poseModel(v: PickupView, qty: number): number {
  const { dm, pivot, id } = v;
  const g = dropGeometry(v.key, v.rarity, qty);
  if (!g) return 0.5;
  const mat = dm.kind === 'armor' || dm.holo ? armorMaterial() : weaponMaterial();
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true;
  mesh.name = `drop-model ${v.key}`;
  const lay = new THREE.Group();
  lay.add(mesh);
  pivot.add(lay);
  v.model = lay;
  const bb = g.boundingBox ?? tmpBox.setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);
  const c = bb.getCenter(new THREE.Vector3());
  const size = bb.getSize(new THREE.Vector3());
  const hover = dm.pose === 'hover';
  pivot.rotation.y = jitter(id, 1) * Math.PI * 2;
  if (dm.kind === 'prop') {
    lay.scale.setScalar(PROP_SCALE);
    if (hover) {
      mesh.position.set(-c.x, -c.y, -c.z); // centred to turn about its middle
      return 0.45 + size.y * PROP_SCALE * 0.5;
    }
    pivot.rotation.z = (jitter(id, 2) - 0.5) * 0.12;
    return 0;
  }
  mesh.position.set(-c.x, -c.y, -c.z);
  if (dm.kind === 'weapon') {
    if (hover) {
      // Upright in the beam; blades point down into the ground's light.
      if (dm.shape === 'sword' || dm.shape === 'spear') lay.rotation.x = Math.PI;
      return 0.3 + size.y * 0.5;
    }
    // Flat on the ground, flats up (+Z -> +Y), a little tilted.
    lay.rotation.x = -Math.PI / 2;
    pivot.rotation.z = (jitter(id, 2) - 0.5) * 0.18;
    pivot.position.y = size.z * 0.5 + 0.01;
    return 0;
  }
  // armor
  if (hover) return 0.35 + size.y * 0.5;
  if (dm.shape === 'head') {
    pivot.position.y = size.y * 0.5;
    pivot.rotation.z = (jitter(id, 2) - 0.5) * 0.3;
    return 0;
  }
  lay.rotation.x = Math.PI / 2; // on its back, its front to the sky
  pivot.position.y = size.z * 0.5 + 0.01;
  pivot.rotation.z = (jitter(id, 2) - 0.5) * 0.1;
  return 0;
}

export function LootLayer() {
  const scene = useThree((s) => s.scene);
  const root = useMemo(() => new THREE.Group(), []);
  const mats = useMemo(makeMaterials, []);
  const pickups = useMemo(() => new Map<number, PickupView>(), []);
  const containers = useMemo(() => ({ list: null as Container[] | null, groups: new Map<string, THREE.Group>() }), []);
  const st = useMemo(() => ({ tier: '' as QualityTier | '', beams: null as BeamMaterials | null, maxId: 0, session: null as unknown, humDrops: [] as HumDrop[] }), []);

  useEffect(() => {
    root.name = 'loot';
    scene.add(root);
    const hums = (x: number, z: number) => humEmitters(st.humDrops, x, z);
    loopSources.add(hums);
    return () => {
      loopSources.delete(hums);
      scene.remove(root);
      root.clear();
      pickups.clear();
      containers.groups.clear();
      containers.list = null;
      if (st.beams) disposeBeamMaterials(st.beams);
      st.beams = null;
      st.tier = '';
      for (const v of Object.values(mats)) {
        if (Array.isArray(v)) v.forEach((x) => x.dispose());
        else v.dispose();
      }
    };
  }, [scene, root, mats, pickups, containers, st]);

  useFrame((state, dtRaw) => {
    const dt = Math.min(0.1, dtRaw);
    const now = performance.now() / 1000;
    // Quality tier: beam materials per tier (Low: no motes, one noise octave).
    const tier = useQualityStore.getState().tier;
    if (tier !== st.tier || !st.beams) {
      if (st.beams) disposeBeamMaterials(st.beams);
      st.beams = makeBeamMaterials(tier);
      st.tier = tier;
      for (const v of pickups.values()) root.remove(v.group);
      pickups.clear(); // rebuilt below with the new materials
    }
    const beams = st.beams;
    tickBeamMaterials(beams, now);
    // Bitchin': cycle the sparkles' hue (its beam shaders cycle their own).
    const holo = tmpHolo.setHSL((now * HOLO_HUES) % 1, 0.9, 0.62);
    for (let r = 0; r < 8; r++) if (isHolo(r)) mats.sparkle[r].uniforms.uColor.value.copy(holo);
    for (const m of mats.sparkle) m.uniforms.uTime.value = now;
    const wind = liveWeather.mix.wind ?? 0;
    for (const m of beams.beam) m.uniforms.uSway.value = 0.25 + wind * 1.1 + m.uniforms.uHeight.value * 0.015;

    // Pickups from the latest snapshot.
    const s = netRuntime.session;
    const seen = new Set<number>();
    const me = localPlayer.pos;
    if (s !== st.session) {
      st.session = s;
      st.maxId = Number.MAX_SAFE_INTEGER; // the first frame of a session: nothing in it is "new"
    }
    let frameMax = 0;
    const fresh: PickupView[] = [];
    if (s && s.phase === 'playing' && s.latestFrame) {
      for (const e of s.latestFrame.ents) {
        if (e.id > frameMax) frameMax = e.id;
        if (e.kind !== 4) continue;
        seen.add(e.id);
        let v = pickups.get(e.id);
        const ex = e.x / 100;
        const ez = e.z / 100;
        if (!v) {
          const r = Math.max(0, Math.min(7, e.typeId));
          const dm = dropModelOf(e.name, r);
          const cave = dm.kind === 'cave';
          const group = new THREE.Group();
          group.name = `pickup ${e.name}`;
          const pivot = new THREE.Group();
          group.add(pivot);
          const p = beamParams(r, tier);
          v = { id: e.id, key: e.name, rarity: r, group, pivot, model: null, beam: null, motes: null, ring: null, glints: null!, dm, rest: new THREE.Vector3(), hoverY: 0, t: jitter(e.id, 3) * 10, arc: -1, from: new THREE.Vector3(), strike: -1, fly: -1 };
          if (!cave) v.hoverY = poseModel(v, e.level);
          const glints = new THREE.Points(sparkleGeometry(SPARKLE_N[r]), mats.sparkle[r]);
          glints.frustumCulled = false;
          glints.renderOrder = 3;
          const msz = v.model ? new THREE.Box3().setFromObject(v.model).getSize(tmpV).length() : 0.5;
          glints.scale.setScalar(Math.max(1, msz / 0.7));
          if (v.dm.pose === 'hover') glints.position.y = Math.max(0, v.hoverY - 0.5);
          group.add(glints);
          v.glints = glints;
          if (p.visible) {
            const beam = new THREE.Mesh(beamGeometry(), beams.beam[r]);
            beam.renderOrder = 2;
            beam.name = 'loot-beam';
            group.add(beam);
            v.beam = beam;
            if (!cave) {
              const ring = new THREE.Mesh(ringGeometry(), beams.ring[r]);
              ring.scale.set(p.ring * 2, 1, p.ring * 2);
              ring.position.y = 0.04;
              ring.renderOrder = 1;
              group.add(ring);
              v.ring = ring;
            }
            if (p.motes > 0) {
              const motes = new THREE.Points(moteGeometry(p.motes), beams.motes[r]);
              motes.renderOrder = 3;
              group.add(motes);
              v.motes = motes;
            }
          }
          root.add(group);
          pickups.set(e.id, v);
          if (e.id > st.maxId && Math.hypot(ex - me.x, ez - me.z) < 45) fresh.push(v);
        }
        v.rest.set(ex, e.y / 100 - (v.dm.kind === 'cave' ? 0 : DROP_LIFT), ez);
        if (v.arc < 0 && v.fly < 0) v.group.position.copy(v.rest);
      }
    }
    if (frameMax > 0) st.maxId = st.maxId === Number.MAX_SAFE_INTEGER ? frameMax : Math.max(st.maxId, frameMax);
    // New drops pop out of where they came from: the centre of the batch
    // (the corpse), or the container they surround.
    if (fresh.length) {
      const c = new THREE.Vector3();
      for (const v of fresh) c.add(v.rest);
      c.divideScalar(fresh.length);
      let best = 3.5;
      for (const k of useInventory.getState().containers) {
        const d = Math.hypot(k.x - c.x, k.z - c.z);
        if (d < best) {
          best = d;
          c.set(k.x, k.y, k.z);
        }
      }
      for (const v of fresh) {
        v.from.copy(c);
        v.from.y += 0.4;
        v.arc = jitter(v.id, 4) * -0.12; // a ragged burst, not a single pop
        v.group.position.copy(v.from);
        if (v.beam) {
          v.strike = 0;
          v.beam.visible = false;
        }
      }
    }

    const cam = state.camera.position;
    const humDrops: HumDrop[] = [];
    for (const [id, v] of pickups) {
      if (!seen.has(id) && v.fly < 0) {
        // Gone: taken near you -> fly to you; else just vanish.
        if (v.group.position.distanceTo(tmpV.set(me.x, me.y + 0.9, me.z)) < FLY_M && v.model) {
          v.fly = 0;
          for (const o of [v.beam, v.motes, v.ring, v.glints]) if (o) o.visible = false;
        } else {
          root.remove(v.group);
          pickups.delete(id);
          continue;
        }
      }
      v.t += dt;
      if (v.fly >= 0) {
        v.fly += dt;
        const k = Math.min(1, v.fly / FLY_S);
        v.group.position.lerp(tmpV.set(me.x, me.y + 1.1, me.z), Math.min(1, dt * 14));
        v.group.scale.setScalar(Math.max(0.05, 1 - k));
        if (k >= 1) {
          root.remove(v.group);
          pickups.delete(id);
        }
        continue;
      }
      if (v.arc !== -1) {
        // The pop-out arc (a negative start is a small delay: a ragged burst).
        v.arc += dt;
        const k = Math.max(0, Math.min(1, v.arc / ARC_S));
        if (k >= 1) {
          v.arc = -1;
          v.group.position.copy(v.rest);
          v.pivot.rotation.x = 0;
        } else {
          v.group.position.lerpVectors(v.from, v.rest, k);
          v.group.position.y += Math.sin(Math.PI * k) * (1.1 + jitter(v.id, 5) * 0.4);
          v.pivot.rotation.x = (1 - k) * 6.0;
        }
      }
      if (v.strike >= 0 && v.arc === -1 && v.beam) {
        v.strike += dt;
        const k = Math.min(1, v.strike / STRIKE_S);
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        v.beam.visible = true;
        v.beam.scale.y = Math.max(0.02, e);
        v.beam.position.y = beamParams(v.rarity).height * (1 - e);
        if (v.ring) v.ring.scale.setScalar(beamParams(v.rarity).ring * 2 * (0.3 + 0.7 * e));
        if (k >= 1) {
          v.strike = -1;
          v.beam.scale.y = 1;
          v.beam.position.y = 0;
        }
      }
      // Distance culling of the small parts (the beam has its own fade).
      const d = v.group.position.distanceTo(cam);
      if (v.model) v.model.visible = d < MODEL_M;
      v.glints.visible = d < SPARKLE_M && v.fly < 0;
      if (v.motes) v.motes.visible = d < MOTES_M && v.strike < 0;
      if (v.dm.pose === 'hover' && v.model && v.arc === -1) {
        v.pivot.position.y = v.hoverY + Math.sin(v.t * 1.6) * 0.06;
        v.pivot.rotation.y += dt * 0.7;
      }
      if (v.arc === -1) humDrops.push({ id, key: v.key, rarity: v.rarity, x: v.rest.x, y: v.rest.y, z: v.rest.z });
    }
    st.humDrops = humDrops;

    // Containers (Event 406 list; rebuilt when the list changes).
    const list = useInventory.getState().containers;
    if (list !== containers.list) {
      containers.list = list;
      const want = new Map(list.map((c) => [`${c.id}:${c.opened ? 1 : 0}`, c]));
      for (const [k, g] of containers.groups)
        if (!want.has(k)) {
          root.remove(g);
          containers.groups.delete(k);
        }
      for (const [k, c] of want)
        if (!containers.groups.has(k)) {
          const g = makeContainer(c, mats);
          root.add(g);
          containers.groups.set(k, g);
        }
    }
  });

  return null;
}
