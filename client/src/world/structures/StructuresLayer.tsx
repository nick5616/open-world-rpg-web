// Towers and waypoint stones in the scene (WP12). WP20 will build richer
// structures; these are deliberately simple but should read well from far
// away, because a tower on a peak is the thing you walk toward (spec 5:
// placed by visibility).
//
//  - Towers: the exact collision profile (structures/towers.ts) turned on a
//    lathe, so what you see is what you climb, in procedural dressed stone,
//    with decorative merlons, a flagstone top and a floating lodestone
//    crystal that glows amber while locked and bright cyan once you've
//    climbed it (with a faint light pillar visible across the region).
//    All towers are ONE merged mesh: one draw call however many are in view
//    (spec 12 draw-call budget).
//  - Waypoint stones: a tapered monolith with a rune that lights up when the
//    stone is activated. Instanced: two draw calls for every stone.
//
// Merlons are visual only: the overlay top is flat (a heightfield can't
// have a parapet you stand behind), so walking through one is possible.

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldRuntime } from '../core/runtime';
import { towerBottom } from './towers';
import type { RadialStructure } from './overlay';
import { hasBit } from '../../ui/map/events';
import { useExploration } from '../../ui/map/store';
import { setMapWorld } from '../../ui/map/world';

const STONE_REF_R = 6; // radius the brick texture is laid out for (m)
const BRICK_W = 1.2;
const BRICK_H = 0.6;

/** Procedural dressed-stone texture: offset courses of slightly varied blocks with dark mortar. */
function stoneTexture(): THREE.CanvasTexture {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4a4740';
  g.fillRect(0, 0, n, n);
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const rows = 8;
  const cols = 4;
  const bh = n / rows;
  const bw = n / cols;
  for (let r = 0; r < rows; r++) {
    for (let k = -1; k < cols; k++) {
      const x = k * bw + (r % 2 ? bw / 2 : 0);
      const l = 118 + rnd() * 40;
      const warm = rnd() * 10;
      g.fillStyle = `rgb(${l + warm},${l + warm * 0.6},${l - 6})`;
      g.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
      // Weathering speckle.
      for (let i = 0; i < 40; i++) {
        const d = rnd() * 30 - 15;
        g.fillStyle = `rgba(${d > 0 ? 255 : 0},${d > 0 ? 255 : 0},${d > 0 ? 255 : 0},${Math.abs(d) / 160})`;
        g.fillRect(x + 2 + rnd() * (bw - 6), r * bh + 2 + rnd() * (bh - 6), 2 + rnd() * 3, 2 + rnd() * 3);
      }
      // A soft top highlight and bottom shade per block.
      const grad = g.createLinearGradient(0, r * bh, 0, (r + 1) * bh);
      grad.addColorStop(0, 'rgba(255,255,255,0.10)');
      grad.addColorStop(1, 'rgba(0,0,0,0.18)');
      g.fillStyle = grad;
      g.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** One tower's geometry in world space: lathe of the collision profile + top disc + merlons. */
export function towerGeometry(t: RadialStructure): THREE.BufferGeometry {
  const bottom = towerBottom(t);
  // Profile from the bottom of the lower wall up to the top rim (y relative to topY).
  const pts = [new THREE.Vector2(t.maxR, bottom - t.topY)];
  for (let i = t.r.length - 1; i >= 0; i--) pts.push(new THREE.Vector2(t.r[i], -t.drop[i]));
  const segs = 40;
  const lathe = new THREE.LatheGeometry(pts, segs);
  // Bricks: u along the circumference at a reference radius, v by height.
  const uv = lathe.getAttribute('uv') as THREE.BufferAttribute;
  const pos = lathe.getAttribute('position') as THREE.BufferAttribute;
  // Whole texture repeats around the circumference, or the courses break at the seam.
  const circ = Math.round((2 * Math.PI * STONE_REF_R) / BRICK_W / 4); // texture holds 4 bricks across
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, pos.getY(i) / (BRICK_H * 8));
  const flat = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
  const parts: THREE.BufferGeometry[] = [flat(lathe)];
  // Flagstone top.
  const top = new THREE.CircleGeometry(t.r[0], segs);
  top.rotateX(-Math.PI / 2);
  const tuv = top.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < tuv.count; i++) tuv.setXY(i, tuv.getX(i) * 3, tuv.getY(i) * 3);
  parts.push(flat(top));
  // Merlons around the rim.
  const merlons = 12;
  for (let i = 0; i < merlons; i++) {
    const a = (i / merlons) * Math.PI * 2;
    const m = new THREE.BoxGeometry(0.55, 0.9, 1.2);
    m.translate(0, 0.45, 0);
    m.rotateY(-a);
    m.translate(Math.cos(a) * (t.r[0] - 0.3), 0, Math.sin(a) * (t.r[0] - 0.3));
    parts.push(flat(m));
  }
  for (const p of parts) {
    for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') p.deleteAttribute(name);
  }
  const merged = mergeGeometries(parts, false)!;
  merged.translate(t.cx, t.topY, t.cz);
  for (const p of parts) p.dispose();
  lathe.dispose();
  top.dispose();
  return merged;
}

function runeTexture(): THREE.CanvasTexture {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, n, n);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 7;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(64, 64, 40, 0, Math.PI * 2);
  g.moveTo(64, 18);
  g.lineTo(64, 110);
  g.moveTo(34, 50);
  g.lineTo(94, 78);
  g.moveTo(94, 50);
  g.lineTo(34, 78);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const LOCKED = new THREE.Color('#d08a2c');
const UNLOCKED = new THREE.Color('#5ff2ff');
const STONE_DIM = new THREE.Color('#3a4a55');

export function StructuresLayer({ runtime }: { runtime: WorldRuntime }) {
  const towers = runtime.towers;
  const waypoints = useMemo(() => runtime.data.sites.filter((s) => s.category === 'poi' && s.kind === 'waypoint'), [runtime]);

  // The map draws this world.
  useEffect(() => {
    setMapWorld(runtime.data, towers.towers.map((shape, i) => ({ site: towers.sites[i].index, shape })), runtime.vertical);
    return () => setMapWorld(null);
  }, [runtime, towers]);

  const built = useMemo(() => {
    const group = new THREE.Group();
    group.name = 'wp12-structures';
    const stone = stoneTexture();
    const wallMat = new THREE.MeshStandardMaterial({ map: stone, bumpMap: stone, bumpScale: 0.6, roughness: 0.92, metalness: 0, color: '#d8d2c4' });
    const geos = towers.towers.map((t) => towerGeometry(t));
    let towerMesh: THREE.Mesh | null = null;
    if (geos.length) {
      const g = mergeGeometries(geos, false)!;
      geos.forEach((x) => x.dispose());
      g.computeBoundingSphere();
      towerMesh = new THREE.Mesh(g, wallMat);
      towerMesh.castShadow = true;
      towerMesh.receiveShadow = true;
      towerMesh.name = 'towers';
      group.add(towerMesh);
    }
    // Lodestone crystals (instanced, colour per instance).
    const crystalGeo = new THREE.OctahedronGeometry(0.9, 0);
    crystalGeo.scale(1, 1.7, 1);
    const crystalMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 1.6, roughness: 0.25, metalness: 0.1, toneMapped: false });
    const crystals = new THREE.InstancedMesh(crystalGeo, crystalMat, Math.max(1, towers.towers.length));
    crystals.count = towers.towers.length;
    crystals.name = 'tower-crystals';
    // Light pillars over unlocked towers (additive, unlit, no depth write).
    const beamGeo = new THREE.CylinderGeometry(0.35, 1.2, 160, 12, 1, true);
    beamGeo.translate(0, 80, 0);
    const beamMat = new THREE.MeshBasicMaterial({ color: UNLOCKED, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const beams = new THREE.InstancedMesh(beamGeo, beamMat, Math.max(1, towers.towers.length));
    beams.count = 0;
    beams.name = 'tower-beams';
    beams.frustumCulled = false;
    group.add(crystals, beams);

    // Waypoint stones + runes.
    const ground = runtime.ground;
    const stoneGeo = new THREE.CylinderGeometry(0.32, 0.5, 2.6, 4, 1);
    stoneGeo.rotateY(Math.PI / 4);
    stoneGeo.translate(0, 1.15, 0);
    const wpStoneMat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.85, color: '#9aa3a8' });
    const stones = new THREE.InstancedMesh(stoneGeo, wpStoneMat, Math.max(1, waypoints.length));
    stones.count = waypoints.length;
    stones.castShadow = true;
    stones.name = 'waypoint-stones';
    const runeGeo = new THREE.PlaneGeometry(0.55, 0.55);
    runeGeo.translate(0, 1.5, 0.34);
    const runeMat = new THREE.MeshBasicMaterial({ map: runeTexture(), transparent: true, depthWrite: false, toneMapped: false, color: '#ffffff' });
    const runes = new THREE.InstancedMesh(runeGeo, runeMat, Math.max(1, waypoints.length));
    runes.count = waypoints.length;
    runes.name = 'waypoint-runes';
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    waypoints.forEach((s, i) => {
      // Face along the site yaw (the side fast travel arrives on); our rune
      // plane faces +z, and site yaw 0 means +x.
      q.setFromAxisAngle(up, Math.PI / 2 - s.yaw);
      m.compose(new THREE.Vector3(s.x, ground.heightAt(s.x, s.z) - 0.15, s.z), q, new THREE.Vector3(1, 1, 1));
      stones.setMatrixAt(i, m);
      runes.setMatrixAt(i, m);
    });
    group.add(stones, runes);
    return { group, crystals, beams, runes, towerMesh, dispose: () => {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
      });
      [wallMat, crystalMat, beamMat, wpStoneMat, runeMat].forEach((x) => x.dispose());
      stone.dispose();
      runeMat.map?.dispose();
    } };
  }, [runtime, towers, waypoints]);

  useEffect(() => () => built.dispose(), [built]);

  // Unlock state -> colours (only when progress changes).
  useEffect(() => {
    const apply = (towersBits: Uint8Array, waypointBits: Uint8Array) => {
      const c = new THREE.Color();
      let nb = 0;
      const m = new THREE.Matrix4();
      towers.towers.forEach((t, i) => {
        const on = hasBit(towersBits, towers.sites[i].index);
        built.crystals.setColorAt(i, c.copy(on ? UNLOCKED : LOCKED));
        if (on) {
          m.makeTranslation(t.cx, t.topY, t.cz);
          built.beams.setMatrixAt(nb++, m);
        }
      });
      built.beams.count = nb;
      built.beams.instanceMatrix.needsUpdate = true;
      if (built.crystals.instanceColor) built.crystals.instanceColor.needsUpdate = true;
      waypoints.forEach((s, i) => built.runes.setColorAt(i, c.copy(hasBit(waypointBits, s.index) ? UNLOCKED : STONE_DIM)));
      if (built.runes.instanceColor) built.runes.instanceColor.needsUpdate = true;
    };
    const p = useExploration.getState().progress;
    apply(p.towers, p.waypoints);
    return useExploration.subscribe((s, prev) => {
      if (s.progress !== prev.progress) apply(s.progress.towers, s.progress.waypoints);
    });
  }, [built, towers, waypoints]);

  // Crystals bob and turn slowly.
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    towers.towers.forEach((tw, i) => {
      p.set(tw.cx, tw.topY + 2.6 + Math.sin(t * 1.3 + i) * 0.25, tw.cz);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * 0.6 + i);
      built.crystals.setMatrixAt(i, m.compose(p, q, s));
    });
    built.crystals.instanceMatrix.needsUpdate = true;
  });

  return <primitive object={built.group} />;
}
