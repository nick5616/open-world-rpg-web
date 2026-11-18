// The town sundials (playtest 5, CR 054): a knee-high stone drum in each
// settlement's square with a round plate carved with the hours (VI to XVIII,
// at the angles the shadow really falls: sundial.ts) and a brass gnomon. The
// shadow on the plate is the gnomon projected along the renderer's sun
// direction every frame (a tapered dark blade, so it reads at any
// resolution; the sun's shadow map is not what draws it). Faint and gone in
// cloud and rain, absent at dusk and at night: nothing readable by moonlight.
// Built lazily for settlements near the camera; four small meshes each.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Towns } from '@lodestone/worldgen';
import { sunDirection } from '../../scene/SkyAndSun';
import { DAY_LENGTH_S } from '@lodestone/contracts';
import type { GroundQuery } from '../../sim/ground';
import { DIAL_R, GNOMON_H, discHitsBox, hourMarks, shadowOf, sundialSpot, type FlatBox, type Vec3 } from './sundial';

const ACTIVE_M = 260;
const PLATE_Y = 0.78;
const ROMAN = ['VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'I', 'II', 'III', 'IV', 'V', 'VI'];

const sunAtHour = (h: number): Vec3 => sunDirection((h / 24) * DAY_LENGTH_S);

let dialTex: THREE.CanvasTexture | null = null;

/** The plate's top: carved hour lines at the real shadow angles, numerals, half-hour ticks, rings. Null without a DOM. */
export function dialTexture(): THREE.CanvasTexture | null {
  if (dialTex) return dialTex;
  if (typeof document === 'undefined') return null;
  const N = 512;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  if (!g) return null;
  const R = N / 2;
  const grad = g.createRadialGradient(R, R, 10, R, R, R);
  grad.addColorStop(0, '#948f83');
  grad.addColorStop(1, '#7d786c');
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);
  // speckle, so it reads as stone
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${60 + (i * 37) % 90},${55 + (i * 53) % 80},${50 + (i * 29) % 70},0.08)`;
    g.fillRect((i * 97) % N, (i * 61) % N, 2, 2);
  }
  const marks = hourMarks(sunAtHour);
  const carve = '#26221d';
  const px = (phi: number, r: number) => [R + Math.cos(phi) * r * R, R - Math.sin(phi) * r * R] as const;
  g.strokeStyle = carve;
  g.lineCap = 'round';
  // rings
  g.lineWidth = 5;
  g.beginPath();
  g.arc(R, R, R * 0.97, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2.5;
  g.beginPath();
  g.arc(R, R, R * 0.64, 0, Math.PI * 2);
  g.stroke();
  // hour lines, half-hour ticks, numerals
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    g.lineWidth = 4.5;
    g.beginPath();
    g.moveTo(...px(m.phi, 0.64));
    g.lineTo(...px(m.phi, 0.95));
    g.stroke();
    if (i + 1 < marks.length) {
      const mid = (m.phi + marks[i + 1].phi) / 2;
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(...px(mid, 0.64));
      g.lineTo(...px(mid, 0.76));
      g.stroke();
    }
    g.save();
    const [tx, ty] = px(m.phi, 0.5);
    g.translate(tx, ty);
    g.rotate(Math.PI / 2 - m.phi);
    g.fillStyle = carve;
    g.font = '700 34px serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(ROMAN[i], 0, 0);
    g.restore();
  }
  // the unused half is smooth stone with a small sun carved in it
  g.fillStyle = carve;
  g.beginPath();
  g.arc(R, R + R * 0.45, 17, 0, Math.PI * 2);
  g.fill();
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(R + Math.cos(a) * 26, R + R * 0.45 + Math.sin(a) * 26);
    g.lineTo(R + Math.cos(a) * 37, R + R * 0.45 + Math.sin(a) * 37);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  dialTex = tex;
  return tex;
}

type G = THREE.BufferGeometry;
function colored(g: G, c: number): G {
  const col = new THREE.Color(c);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.toArray(a, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function stoneGeometry(): G {
  const parts: G[] = [];
  const cyl = (rt: number, rb: number, h: number, y: number, c: number, seg = 14) => {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    g.translate(0, y + h / 2, 0);
    parts.push(colored(g.toNonIndexed(), c));
  };
  cyl(0.62, 0.7, 0.14, 0, 0x8d877b); // plinth
  cyl(0.5, 0.58, 0.1, 0.14, 0x9a9488);
  cyl(0.3, 0.38, 0.4, 0.24, 0xa39d90); // shaft
  cyl(0.46, 0.34, 0.1, 0.64, 0x9a9488); // flare under the plate
  cyl(DIAL_R, DIAL_R, PLATE_Y - 0.74 + 0.0, 0.74, 0x8a857a, 32); // the plate's edge (its top is textured separately)
  const m = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  m.deleteAttribute('uv');
  return m;
}

function gnomonGeometry(): G {
  const parts: G[] = [];
  const rod = new THREE.CylinderGeometry(0.014, 0.024, GNOMON_H, 8);
  rod.translate(0, GNOMON_H / 2, 0);
  parts.push(colored(rod.toNonIndexed(), 0xb8893a));
  const ball = new THREE.SphereGeometry(0.03, 8, 6);
  ball.translate(0, GNOMON_H + 0.02, 0);
  parts.push(colored(ball.toNonIndexed(), 0xd2a24c));
  const base = new THREE.CylinderGeometry(0.06, 0.07, 0.04, 10);
  base.translate(0, 0.02, 0);
  parts.push(colored(base.toNonIndexed(), 0xb8893a));
  const m = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  m.deleteAttribute('uv');
  return m;
}

/** A unit shadow blade along +x: a thin base at the gnomon, narrowing to the tip at x = 1. */
function bladeGeometry(): G {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, -0.045, 0, 0, 0.045, 1, 0, 0.008, 1, 0, -0.008]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

interface Dial {
  group: THREE.Group;
  blade: THREE.Mesh;
  x: number;
  z: number;
  y: number;
  yAt: number;
}

export class TownSundials {
  readonly group = new THREE.Group();
  private readonly dials = new Map<number, Dial>();
  private readonly stone = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, vertexColors: true });
  private readonly brass = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.6, vertexColors: true });
  private readonly plate = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  private readonly shadowMat = new THREE.MeshBasicMaterial({ color: 0x1b1712, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
  private readonly stoneGeo = stoneGeometry();
  private readonly gnomonGeo = gnomonGeometry();
  private readonly capGeo = new THREE.CircleGeometry(DIAL_R, 40);
  private readonly bladeGeo = bladeGeometry();
  /** Debug and tests: the shadow of the nearest dial last frame. */
  readonly last = { lit: false, phi: 0, len: 0, opacity: 0, dials: 0 };

  constructor(
    private readonly towns: Towns,
    private readonly ground: GroundQuery & { floorAt?: (x: number, y: number, z: number) => number },
    private readonly collision: { candidates(x: number, z: number, m: number): number[] } | null,
    private readonly isDwarf: (settlement: number) => boolean,
  ) {
    this.group.name = 'town-sundials';
    this.capGeo.rotateX(-Math.PI / 2);
    this.shadowMat.userData.keep = true;
  }

  /** Is the disc at (x, z) clear of every building and town box? */
  private free = (x: number, z: number, r: number): boolean => {
    const t = this.towns;
    const b = t.boxes;
    if (this.collision) {
      for (const i of this.collision.candidates(x, z, r + 1)) {
        const o = i * 9;
        const box: FlatBox = { x: b.f[o], z: b.f[o + 1], c: b.f[o + 2], s: b.f[o + 3], hx: b.f[o + 4], hz: b.f[o + 5] };
        if (discHitsBox(x, z, r, box, 0.2)) return false;
      }
    }
    for (let k = 0; k < t.buildings.length; k++) {
      const bd = t.buildings[k];
      if (Math.abs(bd.x - x) > 40 || Math.abs(bd.z - z) > 40) continue;
      if (discHitsBox(x, z, r, { x: bd.x, z: bd.z, c: bd.c, s: bd.s, hx: bd.hx, hz: bd.hz }, 0.6)) return false;
    }
    return true;
  };

  /** Where settlement `si`'s sundial stands (null: none, e.g. a dwarven hall). */
  spotOf(si: number): { x: number; z: number } | null {
    const st = this.towns.settlements[si];
    if (!st || this.isDwarf(si) || st.y > this.ground.heightAt(st.x, st.z) + 60) return null;
    return sundialSpot(st.x, st.z, Number(st.id & 0xffffn), this.free);
  }

  private build(si: number): Dial | null {
    const spot = this.spotOf(si);
    if (!spot) return null;
    const g = new THREE.Group();
    g.name = `sundial-${si}`;
    const y = this.groundAt(spot.x, spot.z);
    g.position.set(spot.x, y, spot.z);
    const body = new THREE.Mesh(this.stoneGeo, this.stone);
    body.castShadow = true;
    body.receiveShadow = true;
    const cap = new THREE.Mesh(this.capGeo, this.plate);
    cap.position.y = PLATE_Y;
    cap.receiveShadow = true;
    const tex = dialTexture();
    if (tex) this.plate.map = tex;
    const gnomon = new THREE.Mesh(this.gnomonGeo, this.brass);
    gnomon.position.y = PLATE_Y;
    const blade = new THREE.Mesh(this.bladeGeo, this.shadowMat);
    blade.position.y = PLATE_Y + 0.004;
    blade.renderOrder = 3;
    blade.visible = false;
    g.add(body, cap, gnomon, blade);
    g.traverse((o) => {
      o.frustumCulled = true;
    });
    this.group.add(g);
    return { group: g, blade, x: spot.x, z: spot.z, y, yAt: performance.now() };
  }

  private groundAt(x: number, z: number): number {
    const h = this.ground.heightAt(x, z);
    return this.ground.floorAt ? this.ground.floorAt(x, h + 2, z) : h;
  }

  /**
   * Per frame. `sun` is the renderer's sun direction (skyLighting().sunDir);
   * `strength` 0..1 how clearly it shines (day factor times clear sky).
   */
  update(camera: THREE.Camera, sun: Vec3, strength: number): void {
    const cam = camera.position;
    const sh = shadowOf(sun);
    this.shadowMat.opacity = sh.lit ? 0.78 * strength : 0;
    let nearest = Infinity;
    for (const st of this.towns.settlements) {
      if (Math.hypot(st.x - cam.x, st.z - cam.z) - st.radius > ACTIVE_M) {
        const d = this.dials.get(st.index);
        if (d) d.group.visible = false;
        continue;
      }
      let d = this.dials.get(st.index);
      if (d === undefined) {
        d = this.build(st.index) ?? undefined;
        if (!d) {
          this.dials.set(st.index, null as unknown as Dial);
          continue;
        }
        this.dials.set(st.index, d);
      }
      if (!d) continue;
      d.group.visible = true;
      d.blade.visible = sh.lit && this.shadowMat.opacity > 0.01;
      if (sh.lit) {
        d.blade.scale.set(Math.max(0.02, sh.len), 1, 1);
        d.blade.rotation.y = -Math.atan2(sh.dz, sh.dx);
      }
      nearest = Math.min(nearest, Math.hypot(d.x - cam.x, d.z - cam.z));
    }
    this.last.lit = sh.lit;
    this.last.phi = sh.phi;
    this.last.len = sh.len;
    this.last.opacity = this.shadowMat.opacity;
    this.last.dials = [...this.dials.values()].filter(Boolean).length;
  }

  /** The nearest dial's centre (debug and evidence scripts). */
  nearest(x: number, z: number): { x: number; y: number; z: number; plateY: number } | null {
    let best: Dial | null = null;
    let bd = Infinity;
    for (const d of this.dials.values()) {
      if (!d) continue;
      const k = Math.hypot(d.x - x, d.z - z);
      if (k < bd) {
        bd = k;
        best = d;
      }
    }
    return best ? { x: best.x, y: best.y, z: best.z, plateY: best.y + PLATE_Y } : null;
  }

  dispose(): void {
    this.stoneGeo.dispose();
    this.gnomonGeo.dispose();
    this.capGeo.dispose();
    this.bladeGeo.dispose();
    this.stone.dispose();
    this.brass.dispose();
    this.plate.dispose();
    this.shadowMat.dispose();
    dialTex?.dispose();
    dialTex = null;
  }
}
