// CR 044: the sky palaces in the scene. One group per palace placed on its
// island (the descriptor's PALACE decoration, turned by quarter turns like the
// collision): a full model near, the hull farther, a silhouette on the
// horizon; an aurora column and a halo so it can be found from far below;
// the great doors that swing open as you come, floating rings, banners that
// sway, the atrium's wind, three wards and the chest that follow the zone's
// state (Event 1704). Everything per frame is a handful of matrix and uniform
// writes.
import * as THREE from 'three';
import { PALACE } from '@lodestone/contracts';
import { glowMaterial } from '../vertical/decoMeshes';
import type { LightEmitter } from '../vertical/decoMeshes';
import { verticalUniforms } from '../vertical/verticalMaterials';
import { usePalace } from './palaceStore';
import { buildBanners, buildChest, buildDoorLeaf, buildPalaceGeometries, buildRings, buildShaft, buildWardEmblem, buildWardPedestal } from './palaceModel';
import { palaceWorld, type PalaceSite } from './palaceSites';

const FULL_M = 230;
const HULL_M = 1500;
const DOOR_OPEN_M = 60;

interface View {
  site: PalaceSite;
  group: THREE.Group;
  full: THREE.Group;
  hull: THREE.Mesh;
  far: THREE.Mesh;
  beacon: THREE.Group;
  rings: THREE.Mesh;
  leafL: THREE.Mesh;
  leafR: THREE.Mesh;
  open: number;
  emblems: THREE.Mesh[];
  beams: THREE.Mesh[];
  chest: THREE.Mesh;
  chestGlow: THREE.Mesh;
  gx: number;
  gy: number;
  gz: number;
}

function haloTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,238,190,1)');
  gr.addColorStop(0.25, 'rgba(255,214,130,0.45)');
  gr.addColorStop(1, 'rgba(255,200,100,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PalaceViews {
  readonly group = new THREE.Group();
  readonly sunMaterials: THREE.Material[] = [];
  private readonly views: View[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private time = 0;

  constructor(sites: PalaceSite[]) {
    if (!sites.length) return;
    const geos = buildPalaceGeometries();
    const bannerGeo = buildBanners();
    const ringsGeo = buildRings();
    const shaftGeo = buildShaft();
    const leafGeo = buildDoorLeaf();
    const pedestalGeo = buildWardPedestal();
    const emblemGeos = [0, 1, 2].map(buildWardEmblem);
    const chestGeo = buildChest();
    this.disposables.push(geos.full, geos.hull, geos.far, bannerGeo, ringsGeo, shaftGeo, leafGeo, pedestalGeo, chestGeo, ...emblemGeos);

    const stone = glowMaterial(0.1, { vertexColors: true, roughness: 0.55, metalness: 0.15, emissive: 0x2e2216 });
    const gild = glowMaterial(0.55, { vertexColors: true, roughness: 0.35, metalness: 0.3 });
    const farMat = glowMaterial(0.8, { vertexColors: true, roughness: 0.6 });
    this.sunMaterials.push(stone);
    const banner = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide, emissive: 0x2a2418 });
    banner.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = verticalUniforms.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aHang;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z += sin(uTime * 1.7 + position.x * 0.9 + position.y * 0.35) * 0.35 * aHang * aHang;\ntransformed.x += cos(uTime * 1.3 + position.y * 0.5) * 0.12 * aHang;');
    };
    banner.customProgramCacheKey = () => 'palace-banner';
    const shaftMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: verticalUniforms.uTime },
      vertexShader: 'varying vec2 vUv; varying float vY; void main(){ vUv = uv; vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'varying vec2 vUv; varying float vY; uniform float uTime; void main(){ float a = vUv.x * 12.0 + vY * 0.35 - uTime * 2.2; float s = smoothstep(0.55, 1.0, sin(a) * 0.5 + 0.5) * smoothstep(0.0, 0.2, vUv.y) * (1.0 - smoothstep(0.78, 1.0, vUv.y)); gl_FragColor = vec4(vec3(0.7, 0.9, 1.0) * s * 0.55, s * 0.45); }',
    });
    const beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      vertexShader: 'varying float vH; varying vec3 vN; void main(){ vH = uv.y; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vH; varying vec3 vN; void main(){ float rim = 0.45 + 0.55 * abs(vN.z); float a = pow(max(1.0 - vH, 0.0001), 1.4) * 0.5 * rim; gl_FragColor = vec4(1.0, 0.7, 0.2, a); }',
    });
    const halo = new THREE.SpriteMaterial({ map: haloTexture(), depthWrite: false, transparent: true, fog: false, opacity: 0.85, color: 0xffb040 });
    const wardBeamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: 'varying float vH; void main(){ vH = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vH; uniform vec3 uColor; void main(){ float a = (1.0 - vH) * 0.5; gl_FragColor = vec4(uColor * a, a); }',
      uniforms: { uColor: { value: new THREE.Color(1, 0.85, 0.4) } },
    });
    this.disposables.push(stone, gild, farMat, banner, shaftMat, beamMat, halo, wardBeamMat);
    const doorMat = glowMaterial(0.5, { vertexColors: true, roughness: 0.4, metalness: 0.3 });

    for (const s of sites) {
      const group = new THREE.Group();
      group.position.set(s.x, s.floor, s.z);
      group.rotation.y = (s.q * Math.PI) / 2;
      group.name = `palace-${s.index}`;
      const full = new THREE.Group();
      const body = new THREE.Mesh(geos.full, stone);
      body.castShadow = body.receiveShadow = true;
      full.add(body);
      full.add(new THREE.Mesh(bannerGeo, banner));
      const shaft = new THREE.Mesh(shaftGeo, shaftMat);
      shaft.renderOrder = 3;
      full.add(shaft);
      const hull = new THREE.Mesh(geos.hull, stone);
      hull.castShadow = true;
      const far = new THREE.Mesh(geos.far, farMat);
      const rings = new THREE.Mesh(ringsGeo, gild);
      rings.position.set(0, 0, PALACE.shaft.z);
      rings.name = 'rings';
      // The doors.
      const gz = 40;
      const leafL = new THREE.Mesh(leafGeo, doorMat);
      leafL.position.set(-4, 0, gz);
      const leafR = new THREE.Mesh(leafGeo, doorMat);
      leafR.position.set(4, 0, gz);
      leafR.scale.x = -1;
      // Wards and the chest.
      const emblems: THREE.Mesh[] = [];
      const beams: THREE.Mesh[] = [];
      PALACE.wards.forEach((w, i) => {
        const ped = new THREE.Mesh(pedestalGeo, stone);
        ped.position.set(w.x, w.y, w.z);
        full.add(ped);
        const em = new THREE.Mesh(emblemGeos[i], new THREE.MeshBasicMaterial({ vertexColors: true, color: 0x333344, fog: true }));
        em.position.set(w.x, w.y + 2.9, w.z);
        full.add(em);
        emblems.push(em);
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.9, 14, 8, 1, true), wardBeamMat);
        beam.position.set(w.x, w.y + 9, w.z);
        beam.visible = false;
        full.add(beam);
        beams.push(beam);
      });
      const chest = new THREE.Mesh(chestGeo, gild);
      chest.position.set(PALACE.chest.x, PALACE.chest.y + 0.05, PALACE.chest.z);
      full.add(chest);
      const chestGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo.map, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 })) as unknown as THREE.Mesh;
      chestGlow.position.set(PALACE.chest.x, PALACE.chest.y + 1.6, PALACE.chest.z);
      chestGlow.scale.set(7, 7, 1);
      full.add(chestGlow);
      full.add(leafL, leafR);
      // The beacon: an aurora column over the great dome and a halo, visible through the fog from far below.
      const beacon = new THREE.Group();
      const colG = new THREE.CylinderGeometry(5, 9, 560, 16, 1, true);
      colG.translate(0, 280, 0);
      this.disposables.push(colG);
      const col = new THREE.Mesh(colG, beamMat);
      col.position.set(0, 100, PALACE.shaft.z);
      col.frustumCulled = false;
      const hs = new THREE.Sprite(halo);
      hs.position.set(0, 60, PALACE.shaft.z);
      hs.scale.set(260, 260, 1);
      beacon.add(col, hs);
      group.add(full, hull, far, rings, beacon);
      this.group.add(group);
      const [gx, gzw] = palaceWorld(s, 0, gz + 1);
      this.views.push({ site: s, group, full, hull, far, beacon, rings, leafL, leafR, open: 0, emblems, beams, chest, chestGlow, gx, gy: s.floor, gz: gzw });
    }
  }

  /** Interior lamps for the cave light pool (the nearest few light the camera's surroundings). */
  emitters(): LightEmitter[] {
    const out: LightEmitter[] = [];
    const spots: [number, number, number, number][] = [
      [0, 7, 33, 26],
      [0, 7, 16, 30],
      [-21, 7, 14, 24],
      [21, 7, 14, 24],
      [0, 16, -5, 36],
      [0, PALACE.ringY + 9, -27, 34],
    ];
    for (const v of this.views) {
      for (const [lx, ly, lz, i] of spots) {
        const [x, z] = palaceWorld(v.site, lx, lz);
        out.push({ x, y: v.site.floor + ly, z, color: new THREE.Color(1.0, 0.8, 0.45), intensity: i, distance: 40, layer: 1 });
      }
    }
    return out;
  }

  /** Per frame: LODs by distance, the doors, rings, wards and chest. */
  update(camera: THREE.Camera, dt: number, feet: { x: number; y: number; z: number }): void {
    if (!this.views.length) return;
    this.time += dt;
    const st = usePalace.getState();
    const cam = camera.position;
    for (const v of this.views) {
      const s = v.site;
      const d = Math.hypot(cam.x - s.x, cam.y - (s.floor + 20), cam.z - s.z);
      const showFull = d < FULL_M;
      const showHull = !showFull && d < HULL_M;
      v.full.visible = showFull;
      v.hull.visible = showHull;
      v.far.visible = !showFull && !showHull;
      v.rings.visible = d < 2600;
      v.beacon.visible = d > 160;
      if (d > 2600) continue;
      v.rings.rotation.y += dt * 0.07;
      if (!showFull) {
        // The doors are part of the hull's wall when seen from afar (closed): nothing to do.
        v.leafL.visible = v.leafR.visible = false;
        continue;
      }
      v.leafL.visible = v.leafR.visible = true;
      // The doors swing open as you come (a smooth ease, 1.6 s).
      const dg = Math.hypot(feet.x - v.gx, feet.z - v.gz);
      const want = dg < DOOR_OPEN_M && Math.abs(feet.y - s.floor) < 40 ? 1 : 0;
      v.open += Math.max(-1, Math.min(1, (want - v.open) * 4)) * Math.min(dt, 0.1) * 0.6;
      v.open = Math.max(0, Math.min(1, v.open));
      const e = v.open * v.open * (3 - 2 * v.open);
      v.leafL.rotation.y = -e * 1.75;
      v.leafR.rotation.y = e * 1.75;
      // Wards and the chest follow the zone's state when it is this palace's.
      const mine = st.site === s.index;
      for (let i = 0; i < 3; i++) {
        const lit = mine && st.wards[i];
        const em = v.emblems[i];
        const mat = em.material as THREE.MeshBasicMaterial;
        const k = lit ? 1 : 0;
        mat.color.setRGB(0.2 + k * 1.4, 0.2 + k * 1.15, 0.28 + k * 0.7);
        em.rotation.y += dt * (lit ? 1.6 : 0.4);
        em.position.y = PALACE.wards[i].y + 2.9 + Math.sin(this.time * 1.6 + i * 2) * 0.12;
        v.beams[i].visible = lit;
      }
      const cleared = mine && st.phase === 3;
      (v.chestGlow.material as THREE.SpriteMaterial).opacity = cleared && !st.opened ? 0.6 + Math.sin(this.time * 2.4) * 0.15 : 0;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
