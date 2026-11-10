// The 3D half of loot (WP14), mounted inside the world canvas by NetPlay:
//   - item pickups (snapshot entities of kind 4: name = item key, level =
//     qty, typeId = rarity) that are not ores or gems (WP09's caveManager
//     draws those) as small bobbing, turning shapes coloured by rarity; rare
//     and above get a vertical light beam, Bitchin' a colour-cycling one;
//   - loot containers from Event 406 (chest, buried cache, urn, crate);
//     opened ones are dimmed and the chest lid stands open.
// Imperative three.js in one useFrame with shared geometries and a handful of
// shared materials: a few objects in view, far inside the draw-call budget.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { netRuntime } from '../../net/netStore';
import { isHolo, itemDef, rarityColor } from './items';
import type { Container } from './events';
import { useInventory } from './store';

const geo = {
  blade: new THREE.BoxGeometry(0.07, 0.7, 0.025),
  armor: new THREE.BoxGeometry(0.38, 0.34, 0.14),
  flask: new THREE.CylinderGeometry(0.07, 0.1, 0.22, 10),
  coin: new THREE.CylinderGeometry(0.13, 0.13, 0.035, 16),
  flat: new THREE.BoxGeometry(0.28, 0.04, 0.22),
  gemish: new THREE.OctahedronGeometry(0.15, 0),
  beam: new THREE.CylinderGeometry(0.05, 0.09, 7, 10, 1, true).translate(0, 3.5, 0),
  chest: new THREE.BoxGeometry(0.9, 0.48, 0.56).translate(0, 0.24, 0),
  lid: new THREE.BoxGeometry(0.92, 0.16, 0.58).translate(0, 0.08, 0.29),
  crate: new THREE.BoxGeometry(0.7, 0.7, 0.7).translate(0, 0.35, 0),
  urn: new THREE.LatheGeometry([new THREE.Vector2(0.0, 0), new THREE.Vector2(0.18, 0), new THREE.Vector2(0.3, 0.2), new THREE.Vector2(0.28, 0.45), new THREE.Vector2(0.14, 0.62), new THREE.Vector2(0.17, 0.7)], 14),
  mound: new THREE.SphereGeometry(0.6, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.4, 1),
  marker: new THREE.BoxGeometry(0.08, 0.5, 0.08).translate(0, 0.25, 0),
};

function itemGeometry(key: string): THREE.BufferGeometry {
  const d = itemDef(key);
  switch (d?.kind) {
    case 'weapon':
      return geo.blade;
    case 'armor':
      return geo.armor;
    case 'consumable':
      return geo.flask;
    case 'currency':
      return geo.coin;
    case 'blueprint':
    case 'tome':
      return geo.flat;
    default:
      return geo.gemish;
  }
}

interface PickupView {
  group: THREE.Group;
  mesh: THREE.Mesh;
  rarity: number;
  t: number;
}

// ---- sparkles (Nicole: "dropped loot should sparkle") ----
// A few tiny four-point glints around each dropped item, twinkling one at a
// time (each its own phase and rate, short and soft: a glitter, never a
// flash), more and brighter with rarity, in the rarity's colour.
const SPARKLE_N = [3, 4, 5, 6, 7, 8, 8, 9];
const sparkleGeos = new Map<number, THREE.BufferGeometry>();
function sparkleGeometry(n: number): THREE.BufferGeometry {
  let g = sparkleGeos.get(n);
  if (g) return g;
  const pos = new Float32Array(n * 3);
  const ph = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + i * 1.7;
    const r = 0.18 + ((i * 0.618) % 1) * 0.22;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 0.3 + ((i * 0.381) % 1) * 0.45;
    pos[i * 3 + 2] = Math.sin(a) * r;
    ph[i * 2] = i * 2.399; // phase
    ph[i * 2 + 1] = 0.7 + ((i * 0.737) % 1) * 0.9; // rate
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 2));
  sparkleGeos.set(n, g);
  return g;
}
function sparkleMaterial(color: THREE.Color, size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: color }, uSize: { value: size } },
    vertexShader: `
      attribute vec2 aPhase;
      uniform float uTime;
      uniform float uSize;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float s = sin(uTime * aPhase.y * 3.0 + aPhase.x);
        float tw = pow(max(0.0, s), 4.0); // a short glint, then a soft rest
        vA = tw;
        gl_PointSize = uSize * (0.45 + 1.2 * tw) * (420.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vA;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float cross = max(1.0 - abs(p.x) * 7.0, 0.0) * (1.0 - abs(p.y)) + max(1.0 - abs(p.y) * 7.0, 0.0) * (1.0 - abs(p.x));
        float core = max(0.0, 1.0 - length(p) * 2.2);
        float a = clamp(cross + core, 0.0, 1.0) * (0.45 + 0.55 * vA);
        if (a < 0.02) discard;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.55 * core) * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const HOLO_HUES = 0.18; // hue turns per second
const tmpHolo = new THREE.Color();

function makeMaterials() {
  const item = Array.from({ length: 8 }, (_, r) => {
    const c = new THREE.Color(rarityColor(r));
    return new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: r >= 2 ? 0.55 : 0.25, roughness: 0.4, metalness: 0.3 });
  });
  const sparkle = Array.from({ length: 8 }, (_, r) => sparkleMaterial(new THREE.Color(rarityColor(r)), r >= 2 ? 0.2 : 0.16));
  const beam = Array.from({ length: 8 }, (_, r) => new THREE.MeshBasicMaterial({ color: new THREE.Color(rarityColor(r)), transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
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
  return { item, sparkle, beam, wood, lid, clay, crate, dirt, woodDim: dim(wood), lidDim: dim(lid), clayDim: dim(clay), crateDim: dim(crate), dirtDim: dim(dirt), trim: box('#c9a650') };
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

export function LootLayer() {
  const scene = useThree((s) => s.scene);
  const root = useMemo(() => new THREE.Group(), []);
  const mats = useMemo(makeMaterials, []);
  const pickups = useMemo(() => new Map<number, PickupView>(), []);
  const containers = useMemo(() => ({ list: null as Container[] | null, groups: new Map<string, THREE.Group>() }), []);

  useEffect(() => {
    root.name = 'loot';
    scene.add(root);
    return () => {
      scene.remove(root);
      root.clear();
      pickups.clear();
      containers.groups.clear();
      containers.list = null;
      for (const v of Object.values(mats)) {
        if (Array.isArray(v)) v.forEach((x) => x.dispose());
        else v.dispose();
      }
    };
  }, [scene, root, mats, pickups, containers]);

  useFrame((_, dt) => {
    const now = performance.now() / 1000;
    // Bitchin': cycle the hue of its item and beam materials.
    const holo = tmpHolo.setHSL((now * HOLO_HUES) % 1, 0.9, 0.62);
    for (let r = 0; r < 8; r++)
      if (isHolo(r)) {
        mats.item[r].color.copy(holo);
        mats.item[r].emissive.copy(holo);
        mats.beam[r].color.copy(holo);
        mats.sparkle[r].uniforms.uColor.value.copy(holo);
      }
    for (const m of mats.sparkle) m.uniforms.uTime.value = now;

    // Pickups from the latest snapshot.
    const s = netRuntime.session;
    const seen = new Set<number>();
    if (s && s.phase === 'playing' && s.latestFrame) {
      for (const e of s.latestFrame.ents) {
        if (e.kind !== 4 || e.name.startsWith('ore:') || e.name.startsWith('gem:')) continue;
        seen.add(e.id);
        let v = pickups.get(e.id);
        if (!v) {
          const r = Math.max(0, Math.min(7, e.typeId));
          const group = new THREE.Group();
          group.name = `pickup ${e.name}`;
          const mesh = new THREE.Mesh(itemGeometry(e.name), mats.item[r]);
          mesh.castShadow = true;
          mesh.rotation.order = 'YXZ';
          if (itemDef(e.name)?.kind === 'weapon') mesh.rotation.z = 0.5; // a tilted blade reads better than an upright stick
          group.add(mesh);
          const glints = new THREE.Points(sparkleGeometry(SPARKLE_N[r]), mats.sparkle[r]);
          glints.frustumCulled = false;
          glints.renderOrder = 3;
          group.add(glints);
          if (r >= 2) {
            const beam = new THREE.Mesh(geo.beam, mats.beam[r]);
            beam.renderOrder = 2;
            group.add(beam);
          }
          root.add(group);
          v = { group, mesh, rarity: r, t: (e.id % 100) / 10 };
          pickups.set(e.id, v);
        }
        v.group.position.set(e.x / 100, e.y / 100, e.z / 100);
      }
    }
    for (const [id, v] of pickups) {
      if (!seen.has(id)) {
        root.remove(v.group);
        pickups.delete(id);
        continue;
      }
      v.t += dt;
      v.mesh.position.y = 0.45 + Math.sin(v.t * 2.2) * 0.08;
      v.mesh.rotation.y += dt * 1.6;
    }

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
