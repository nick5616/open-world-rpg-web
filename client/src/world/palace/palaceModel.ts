// CR 044: the sky palace's geometry, procedural and original. One local
// frame (x right, z toward the gate, y up from the floor, metres), merged
// into three vertex-coloured meshes:
//   full  - everything: the building from PALACE.boxes (the very boxes the
//           movement collides with), colonnades, domes, spires, banners,
//           the interior's carpets, sconces, dais and shaft rail;
//   hull  - the outside only (outer walls, towers, domes, spires, portico):
//           what you see from the ground and from other islands;
//   far   - a silhouette of a dozen solids for the horizon.
// Gold parts are over-bright vertex colours, so the glow material makes them
// shine; the marble is calm.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALACE } from '@lodestone/contracts';

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
export const MARBLE = C(0.8, 0.78, 0.73);
const MARBLE2 = C(0.74, 0.71, 0.66);
const CREAM = C(0.84, 0.77, 0.64);
const GOLD = C(0.95, 0.62, 0.14);
const GOLD_BRIGHT = C(1.6, 1.05, 0.3);
const DEEP = C(0.12, 0.2, 0.46);
const WINDOW = C(0.75, 1.0, 1.5);
const BANNER = C(0.96, 0.94, 0.88);
const CARPET = C(0.12, 0.2, 0.46);

class Builder {
  parts: THREE.BufferGeometry[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly e = new THREE.Euler();
  private readonly q = new THREE.Quaternion();

  put(g: THREE.BufferGeometry, color: THREE.Color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): void {
    const ng = g.index ? g.toNonIndexed() : g.clone();
    this.q.setFromEuler(this.e.set(rx, ry, rz));
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz));
    ng.applyMatrix4(this.m);
    const n = ng.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = color.r;
      col[i * 3 + 1] = color.g;
      col[i * 3 + 2] = color.b;
    }
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
    ng.deleteAttribute('uv');
    this.parts.push(ng);
  }
  /** An axis-aligned box from its extents. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: THREE.Color): void {
    this.put(UNIT_BOX, color, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 0, 0, 0, x1 - x0, y1 - y0, z1 - z0);
  }
  cyl(x: number, z: number, y0: number, y1: number, r0: number, r1: number, color: THREE.Color, seg = 14): void {
    this.put(new THREE.CylinderGeometry(r1, r0, y1 - y0, seg), color, x, (y0 + y1) / 2, z);
  }
  cone(x: number, z: number, y0: number, h: number, r: number, color: THREE.Color, seg = 12): void {
    this.put(new THREE.ConeGeometry(r, h, seg), color, x, y0 + h / 2, z);
  }
  dome(x: number, z: number, y0: number, r: number, color: THREE.Color, sy = 1): void {
    this.put(new THREE.SphereGeometry(r, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), color, x, y0, z, 0, 0, 0, 1, sy, 1);
  }
  ball(x: number, y: number, z: number, r: number, color: THREE.Color): void {
    this.put(new THREE.IcosahedronGeometry(r, 1), color, x, y, z);
  }
  torus(x: number, y: number, z: number, r: number, tube: number, color: THREE.Color, rx = Math.PI / 2, ry = 0, rz = 0): void {
    this.put(new THREE.TorusGeometry(r, tube, 6, 28), color, x, y, z, rx, ry, rz);
  }
  merge(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts)!;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

interface Box {
  kind: number;
  x: number;
  z: number;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
}

const boxes: Box[] = PALACE.boxes.map((r) => ({ kind: r[0], x: r[2], z: r[3], hx: r[4], hz: r[5], y0: r[6], y1: Math.max(r[7], r[8]) }));
const isColumn = (b: Box) => b.hx === 1 && b.hz === 1 && b.kind === 1;

/** The building itself: every collision box, columns round, walls with a gold cap, a window band on the outside. */
function building(b: Builder, interior: boolean): void {
  for (const o of boxes) {
    if (o.y0 < -2 && o.kind === 0 && o.hx > 30) continue; // the plinth is drawn below
    if (isColumn(o)) {
      b.cyl(o.x, o.z, o.y0, o.y1, 0.95, 0.85, MARBLE);
      b.cyl(o.x, o.z, o.y0, o.y0 + 0.5, 1.25, 1.25, GOLD, 12);
      b.cyl(o.x, o.z, o.y1 - 0.7, o.y1, 1.35, 1.0, GOLD, 12);
      continue;
    }
    if (!interior && o.y1 < 0.5 && o.kind !== 0) continue;
    const col = o.kind === 3 ? CREAM : o.kind === 0 ? MARBLE2 : o.kind === 2 ? MARBLE : MARBLE;
    b.box(o.x - o.hx, o.x + o.hx, o.y0, o.y1, o.z - o.hz, o.z + o.hz, col);
    // A deep-blue frieze with gold fillets round every tall wall (both faces).
    if (o.kind === 1 && o.y1 - Math.max(o.y0, 0) >= 9 && Math.min(o.hx, o.hz) <= 1.01) {
      const y = Math.max(o.y0, 0) + 5.2;
      b.box(o.x - o.hx - 0.06, o.x + o.hx + 0.06, y, y + 1.0, o.z - o.hz - 0.06, o.z + o.hz + 0.06, DEEP);
      b.box(o.x - o.hx - 0.1, o.x + o.hx + 0.1, y - 0.12, y, o.z - o.hz - 0.1, o.z + o.hz + 0.1, GOLD);
      b.box(o.x - o.hx - 0.1, o.x + o.hx + 0.1, y + 1.0, y + 1.12, o.z - o.hz - 0.1, o.z + o.hz + 0.1, GOLD);
    }
    // A gold capping line on the top of the walls (not the floors).
    if (o.kind === 1 || o.kind === 2) b.box(o.x - o.hx - 0.12, o.x + o.hx + 0.12, o.y1 - 0.25, o.y1 + 0.1, o.z - o.hz - 0.12, o.z + o.hz + 0.12, GOLD);
  }
  // The plinth and its gold trim.
  b.box(-34, 34, -9, 0, -46, 46, MARBLE2);
  b.box(-34.15, 34.15, -1.1, -0.7, -46.15, 46.15, GOLD);
  b.box(-34.15, 34.15, -3.2, -2.9, -46.15, 46.15, GOLD);
  for (let i = 0; i < 5; i++) b.box(-8, 8, -9, -0.4 * (i + 1), 46 + i * 1.5, 47.5 + i * 1.5, MARBLE);
}

/** The outside: windows, pilasters, the cornice, the portico pediment, towers, domes, spires. */
function ornament(b: Builder): void {
  // Tall windows down both long sides and the back; blue-white glass in gold frames.
  for (const sx of [-1, 1]) {
    for (let z = -34; z <= 34; z += 8) {
      if (Math.abs(z) < 0.1) continue;
      b.box(sx * 28.95 - (sx > 0 ? 0.05 : 0.15), sx * 28.95 + (sx > 0 ? 0.15 : 0.05), 4, 8.4, z - 1.1, z + 1.1, GOLD);
      b.box(sx * 29.05 - (sx > 0 ? 0.0 : 0.1), sx * 29.05 + (sx > 0 ? 0.1 : 0.0), 4.3, 8.1, z - 0.8, z + 0.8, WINDOW);
    }
    // Pilasters between them, gold-capped.
    for (let z = -38; z <= 38; z += 8) {
      b.box(sx * 29.1 - 0.7, sx * 29.1 + 0.7, 0, 12.2, z - 0.7, z + 0.7, MARBLE);
      b.box(sx * 29.1 - 0.9, sx * 29.1 + 0.9, 11.4, 12.4, z - 0.9, z + 0.9, GOLD);
    }
  }
  for (let x = -24; x <= 24; x += 8) {
    b.box(x - 1.1, x + 1.1, 4, 8.4, -41.1, -40.8, GOLD);
    b.box(x - 0.8, x + 0.8, 4.3, 8.1, -41.15, -40.9, WINDOW);
  }
  // The cornice.
  b.box(-29.6, 29.6, 11.6, 12.4, -41.6, 41.6, GOLD);
  // Portico: pediment over the front columns, a gold sun disc in it.
  b.put(new THREE.CylinderGeometry(1, 1, 49, 3), MARBLE, 0, 12.2, 45.2, 0, 0, Math.PI / 2, 1, 1, 1);
  b.box(-25, 25, 9, 10.4, 40.6, 46.4, GOLD);
  b.torus(0, 11.6, 46.4, 2.1, 0.22, GOLD_BRIGHT, 0, 0, 0);
  b.ball(0, 11.6, 46.5, 1.0, GOLD_BRIGHT);
  // Flat roofs of the wings at 12.4; corner towers with gold spires.
  b.box(-28.2, 28.2, 12.2, 12.5, -40.2, 40.2, CREAM);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = sx * 30.5;
      const z = sz * 42.5;
      b.cyl(x, z, -2, 42, 3.8, 3.4, MARBLE, 16);
      b.cyl(x, z, 22.5, 23.5, 4.3, 4.3, GOLD, 16);
      b.cyl(x, z, 32, 33.3, 4.3, 4.0, GOLD, 16);
      b.cyl(x, z, 41, 42.4, 4.2, 3.8, GOLD, 16);
      b.cone(x, z, 42, 28, 3.9, DEEP, 16);
      b.cone(x, z, 66, 8, 0.5, GOLD, 8);
      b.ball(x, 74.6, z, 0.9, GOLD_BRIGHT);
      for (let k = 0; k < 4; k++) b.box(x - 0.18 + (k % 2 ? 3.7 * 0 : 0), x + 0.18, 24 + k * 1.2, 26 + k * 1.2, z + 3.6, z + 3.75, WINDOW);
    }
  // The great dome over the atrium: a drum with columns, a gold dome, a lantern and a spire.
  const dz = PALACE.shaft.z;
  b.cyl(0, dz, 31, 38, 14.5, 14, MARBLE, 32);
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    b.cyl(Math.cos(a) * 14.4, dz + Math.sin(a) * 14.4, 31, 38, 0.55, 0.5, GOLD, 8);
  }
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    b.box(Math.cos(a) * 14.1 - 0.9, Math.cos(a) * 14.1 + 0.9, 33, 37, dz + Math.sin(a) * 14.1 - 0.9, dz + Math.sin(a) * 14.1 + 0.9, WINDOW);
  }
  b.cyl(0, dz, 37.6, 38.6, 15.2, 15.2, GOLD, 32);
  b.dome(0, dz, 38.5, 14.6, GOLD, 0.95);
  b.cyl(0, dz, 52, 58, 1.8, 2.4, MARBLE, 12);
  b.cyl(0, dz, 58, 59, 3.2, 3.2, GOLD, 12);
  b.cone(0, dz, 59, 40, 2.0, GOLD, 12);
  b.ball(0, 100.6, dz, 1.4, GOLD_BRIGHT);
  // The throne hall's dome and the vestibule's twin domes.
  b.cyl(0, -27, 28.5, 31, 12, 12, MARBLE, 28);
  b.dome(0, -27, 30.8, 11.5, GOLD, 0.9);
  b.cone(0, -27, 40.8, 9, 1.0, GOLD, 10);
  b.ball(0, 50, -27, 0.55, GOLD_BRIGHT);
  for (const sx of [-1, 1]) {
    b.cyl(sx * 21, 33, 10.5, 12.5, 8, 8, MARBLE, 20);
    b.dome(sx * 21, 33, 12.4, 7.4, DEEP, 0.8);
    b.cyl(sx * 21, 33, 12.2, 12.8, 7.7, 7.7, GOLD, 20);
    b.ball(sx * 21, 18.7, 33, 0.5, GOLD_BRIGHT);
  }
  // Slender minarets either side of the gate.
  for (const sx of [-1, 1]) {
    b.cyl(sx * 11, 41.5, 10, 24, 1.1, 0.9, MARBLE, 10);
    b.cone(sx * 11, 41.5, 24, 6, 1.2, GOLD, 10);
    b.torus(sx * 11, 20, 41.5, 1.3, 0.15, GOLD, Math.PI / 2, 0, 0);
  }
}

/** Banners (cloth hangs from a gold rod, a sun disc on each): the thin mesh the shader sways. */
export function buildBanners(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const spots: [number, number, number, number][] = [
    [-20, 44.9, 8.5, 0],
    [-8, 44.9, 8.5, 0],
    [8, 44.9, 8.5, 0],
    [20, 44.9, 8.5, 0],
    [-13.4, 28, 9, Math.PI / 2],
    [13.4, 28, 9, -Math.PI / 2],
    [-13.4, -6, 28, Math.PI / 2],
    [13.4, -6, 28, -Math.PI / 2],
    [0, -39.3, 24, Math.PI],
    [-6, -39.3, 24, Math.PI],
    [6, -39.3, 24, Math.PI],
  ];
  for (const [x, z, top, ry] of spots) {
    const h = top > 20 ? 14 : 6.2;
    const w = top > 20 ? 3.2 : 1.8;
    const g = new THREE.PlaneGeometry(w, h, 2, 6);
    g.rotateY(ry);
    g.translate(x, top - h / 2, z);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = g.attributes.position.getY(i);
      const edge = Math.abs(((y - (top - h)) / h) % 1) > 0.9 || y > top - 0.2;
      const c = edge ? GOLD : BANNER;
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    // Hang weight (0 at the rod, 1 at the hem) for the sway.
    const wgt = new Float32Array(n);
    for (let i = 0; i < n; i++) wgt[i] = Math.max(0, Math.min(1, (top - g.attributes.position.getY(i)) / h));
    g.setAttribute('aHang', new THREE.BufferAttribute(wgt, 1));
    parts.push(g.index ? g.toNonIndexed() : g);
    // The sun disc.
    const d = new THREE.CircleGeometry(w * 0.28, 16);
    d.rotateY(ry);
    d.translate(x + Math.sin(ry) * 0.02, top - h * 0.45, z + Math.cos(ry) * 0.02);
    const dn = d.attributes.position.count;
    const dc = new Float32Array(dn * 3);
    for (let i = 0; i < dn; i++) dc.set([GOLD_BRIGHT.r, GOLD_BRIGHT.g, GOLD_BRIGHT.b], i * 3);
    d.setAttribute('color', new THREE.BufferAttribute(dc, 3));
    d.setAttribute('aHang', new THREE.BufferAttribute(new Float32Array(dn).fill(0.45), 1));
    d.deleteAttribute('uv');
    parts.push(d.toNonIndexed());
  }
  for (const p of parts) if (!p.attributes.aHang) p.setAttribute('aHang', new THREE.BufferAttribute(new Float32Array(p.attributes.position.count), 1));
  return mergeGeometries(parts)!;
}

/** Inside: the carpet, sconces, chandeliers, the throne dais, the gallery's gold rail, the shaft's basin. */
function furnishings(b: Builder): void {
  // The long carpet from the gate to the atrium with gold edges and medallions.
  b.box(-2.4, 2.4, 0.02, 0.07, 3, 40, CARPET);
  b.box(-2.6, -2.4, 0.02, 0.1, 3, 40, GOLD);
  b.box(2.4, 2.6, 0.02, 0.1, 3, 40, GOLD);
  for (let z = 8; z <= 36; z += 7) b.torus(0, 0.09, z, 1.3, 0.12, GOLD, Math.PI / 2, 0, 0);
  // The atrium's floor: a gold ring round the shaft and a star.
  const cz = PALACE.shaft.z;
  b.torus(0, 0.06, cz, PALACE.shaft.r + 0.9, 0.2, GOLD, Math.PI / 2, 0, 0);
  b.cyl(0, cz, 0, 0.9, PALACE.shaft.r + 1.2, PALACE.shaft.r + 0.9, MARBLE, 28);
  // The gold rail on the gallery's inner edge.
  const ry = PALACE.ringY;
  const rail = (x0: number, x1: number, z0: number, z1: number) => {
    b.box(x0, x1, ry + 0.9, ry + 1.05, z0, z1, GOLD);
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 2));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      b.box(x0 + (x1 - x0) * f - 0.06, x0 + (x1 - x0) * f + 0.06, ry, ry + 0.95, z0 + (z1 - z0) * f - 0.06, z0 + (z1 - z0) * f + 0.06, GOLD);
    }
  };
  rail(-10, 10, -10.05, -9.95);
  rail(-10, 10, -0.05, 0.05);
  // Sconces: small golden lamps on the inner walls, and a chandelier ring in each hall.
  const lamp = (x: number, y: number, z: number) => {
    b.box(x - 0.14, x + 0.14, y - 0.2, y + 0.2, z - 0.14, z + 0.14, GOLD_BRIGHT);
    b.box(x - 0.2, x + 0.2, y - 0.3, y - 0.2, z - 0.2, z + 0.2, GOLD);
  };
  for (const z of [30, 22, 10, 0, -8]) {
    lamp(-12.7, 4, z);
    lamp(12.7, 4, z);
  }
  for (const [x, z] of [
    [0, 33],
    [0, 16],
    [-21, 16],
    [21, 16],
    [-21, 33],
    [21, 33],
    [-21, -5],
    [21, -5],
  ]) {
    b.cyl(x, z, 8.2, 10, 0.05, 0.05, GOLD, 4);
    b.torus(x, 8.2, z, 1.2, 0.1, GOLD_BRIGHT, Math.PI / 2, 0, 0);
    b.torus(x, 8.0, z, 0.6, 0.08, GOLD, Math.PI / 2, 0, 0);
  }
  for (const [x, y, z] of [
    [-12.5, ry + 4, -12],
    [12.5, ry + 4, -12],
    [-9, ry + 5, -38],
    [9, ry + 5, -38],
  ])
    lamp(x, y, z);
  // The throne dais, throne and the guardian's seal on the floor.
  const t = PALACE.arena;
  // The throne's backdrop: a deep-blue hanging with a gold sun, between two gold-edged pillars of light.
  b.box(-7, 7, ry + 1.2, ry + 13, -39.12, -38.9, DEEP);
  b.box(-7.3, -6.9, ry + 1.0, ry + 13.4, -39.2, -38.8, GOLD);
  b.box(6.9, 7.3, ry + 1.0, ry + 13.4, -39.2, -38.8, GOLD);
  b.box(-7.3, 7.3, ry + 13.0, ry + 13.4, -39.2, -38.8, GOLD);
  b.put(new THREE.CylinderGeometry(2.4, 2.4, 0.1, 24), GOLD_BRIGHT, 0, ry + 9, -38.8, Math.PI / 2, 0, 0);
  for (let k = 0; k < 16; k++) b.put(new THREE.ConeGeometry(0.28, 1.6, 4), GOLD_BRIGHT, Math.cos((k / 16) * 6.283) * 3.5, ry + 9 + Math.sin((k / 16) * 6.283) * 3.5, -38.8, Math.PI / 2, 0, (k / 16) * 6.283 + Math.PI / 2);
  // The atrium's tall windows (blue-white glass in gold frames) high on both long walls.
  for (const sx of [-1, 1])
    for (let z = -11; z <= 1; z += 6) {
      b.box(sx * 13 - 0.12, sx * 13 + 0.12, 17.7, 27.3, z - 1.4, z + 1.4, GOLD);
      b.box(sx * 13 - 0.2, sx * 13 + 0.2, 18, 27, z - 1.1, z + 1.1, WINDOW);
    }
  for (let i = 0; i < 3; i++) b.box(-6 + i * 0.8, 6 - i * 0.8, ry, ry + 0.3 * (i + 1), -39.2, -32.5 + i * 1.0, i % 2 ? MARBLE : MARBLE2);
  b.box(-1.6, 1.6, ry + 0.9, ry + 1.4, -38.8, -36.4, MARBLE);
  b.box(-1.6, 1.6, ry + 1.4, ry + 6.2, -38.9, -38.3, MARBLE);
  b.box(-2.1, 2.1, ry + 5.8, ry + 6.9, -39.0, -38.2, GOLD);
  for (const sx of [-1, 1]) {
    b.box(sx * 1.8 - 0.14, sx * 1.8 + 0.14, ry + 1.4, ry + 3.4, -38.8, -36.6, GOLD);
    b.put(new THREE.ConeGeometry(0.4, 3.4, 4), GOLD_BRIGHT, sx * 2.6, ry + 4.4, -38.5, 0, 0, sx * -0.35);
  }
  b.torus(t.x, ry + 0.06, t.z, t.r * 0.7, 0.18, GOLD, Math.PI / 2, 0, 0);
  b.torus(t.x, ry + 0.06, t.z, t.r * 0.45, 0.12, GOLD, Math.PI / 2, 0, 0);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    b.box(t.x + Math.cos(a) * t.r * 0.45 - 0.08, t.x + Math.cos(a) * t.r * 0.7 + 0.08, ry + 0.02, ry + 0.1, t.z + Math.sin(a) * t.r * 0.45 - 0.08, t.z + Math.sin(a) * t.r * 0.7 + 0.08, GOLD);
  }
}

/** The shaft's visible wind: a tall translucent cylinder (the material scrolls streaks up it). */
export function buildShaft(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(PALACE.shaft.r * 0.9, PALACE.shaft.r * 0.9, PALACE.shaft.top + 2, 20, 8, true);
  g.translate(PALACE.shaft.x, (PALACE.shaft.top + 2) / 2 - 0.5, PALACE.shaft.z);
  return g;
}

/** Floating rings round the keep (three tilted gold rings and a scatter of orbs): one object, rotated slowly. */
export function buildRings(): THREE.BufferGeometry {
  const b = new Builder();
  const cz = 0;
  b.torus(0, 70, cz, 34, 1.1, GOLD, Math.PI / 2 + 0.25, 0, 0.1);
  b.torus(0, 80, cz, 26, 0.9, GOLD_BRIGHT, Math.PI / 2 - 0.3, 0.6, 0);
  b.torus(0, 60, cz, 44, 1.4, GOLD, Math.PI / 2 + 0.1, 1.9, 0.2);
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2;
    const r = 30 + (k % 3) * 4;
    b.ball(Math.cos(a) * (r + 6), 68 + Math.sin(a * 3) * 6, cz + Math.sin(a) * (r + 6), 1.0 + (k % 2) * 0.6, k % 2 ? GOLD_BRIGHT : MARBLE);
  }
  return b.merge();
}

/** The silhouette for the horizon: the body, the towers, the great dome, the rings. */
function silhouette(b: Builder): void {
  b.box(-29, 29, -9, 12.4, -41, 41, MARBLE);
  b.box(-34, 34, -9, -0.5, -46, 46, MARBLE2);
  const dz = PALACE.shaft.z;
  b.cyl(0, dz, 12, 38, 15, 14.5, MARBLE, 16);
  b.dome(0, dz, 38, 14.6, GOLD, 0.95);
  b.cone(0, dz, 52.5, 48, 2.2, GOLD, 8);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      b.cyl(sx * 30.5, sz * 42.5, -2, 42, 3.8, 3.5, MARBLE, 8);
      b.cone(sx * 30.5, sz * 42.5, 42, 28, 3.9, DEEP, 8);
    }
  b.cyl(0, -27, 12, 31, 12, 12, MARBLE, 12);
  b.dome(0, -27, 30.8, 11.5, GOLD, 0.9);
}

export interface PalaceGeometries {
  full: THREE.BufferGeometry;
  hull: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
}

export function buildPalaceGeometries(): PalaceGeometries {
  const full = new Builder();
  building(full, true);
  ornament(full);
  furnishings(full);
  const hull = new Builder();
  building(hull, false);
  ornament(hull);
  const far = new Builder();
  silhouette(far);
  return { full: full.merge(), hull: hull.merge(), far: far.merge() };
}

/** The gate's two leaves (animated: hinged at x = +-4). Local origin = the hinge, the leaf extends toward the centre. */
export function buildDoorLeaf(): THREE.BufferGeometry {
  const b = new Builder();
  b.box(0, 4, 0, 6.5, -0.35, 0.35, MARBLE);
  b.box(0.15, 3.85, 0.2, 6.3, -0.4, 0.4, GOLD);
  b.box(0.45, 3.55, 0.5, 6.0, -0.45, 0.45, CREAM);
  b.torus(3.1, 3.2, 0.5, 0.45, 0.07, GOLD_BRIGHT, 0, 0, 0);
  b.box(0.1, 3.9, 6.3, 6.5, -0.45, 0.45, GOLD);
  const g = b.merge();
  return g;
}

/** A ward: the pedestal (static) and its glowing emblem (separate geometry, the emblem is tinted by state). */
export function buildWardPedestal(): THREE.BufferGeometry {
  const b = new Builder();
  b.cyl(0, 0, 0, 0.5, 1.0, 0.9, MARBLE, 10);
  b.cyl(0, 0, 0.5, 1.5, 0.45, 0.5, MARBLE2, 10);
  b.cyl(0, 0, 1.5, 1.7, 0.7, 0.7, GOLD, 10);
  return b.merge();
}

export function buildWardEmblem(index: number): THREE.BufferGeometry {
  const b = new Builder();
  if (index === 0) {
    // The sun: a disc with rays.
    b.put(new THREE.CylinderGeometry(0.7, 0.7, 0.12, 18), GOLD, 0, 0, 0, Math.PI / 2, 0, 0);
    for (let k = 0; k < 12; k++) b.put(new THREE.ConeGeometry(0.12, 0.55, 4), GOLD, Math.cos((k / 12) * 6.283) * 1.0, Math.sin((k / 12) * 6.283) * 1.0, 0, 0, 0, (k / 12) * 6.283 - Math.PI / 2);
  } else if (index === 1) {
    // The moon: a ring and a crescent bite.
    b.torus(0, 0, 0, 0.7, 0.2, WINDOW, 0, 0, 0);
    b.put(new THREE.SphereGeometry(0.42, 12, 8), WINDOW, 0.15, 0, 0);
  } else {
    // The wind: a ring of hanging chimes.
    b.torus(0, 0.5, 0, 0.9, 0.06, GOLD, Math.PI / 2, 0, 0);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      b.cyl(Math.cos(a) * 0.9, Math.sin(a) * 0.9, -0.5 - (k % 3) * 0.2, 0.5, 0.05, 0.07, WINDOW, 6);
    }
    b.ball(0, -0.4, 0, 0.18, GOLD);
  }
  return b.merge();
}

export function buildChest(): THREE.BufferGeometry {
  const b = new Builder();
  b.box(-1, 1, 0, 0.9, -0.6, 0.6, DEEP);
  b.box(-1.05, 1.05, 0.9, 1.15, -0.65, 0.65, GOLD);
  b.put(new THREE.CylinderGeometry(0.65, 0.65, 2.1, 12, 1, false, 0, Math.PI), GOLD, 0, 1.0, 0, 0, 0, Math.PI / 2);
  b.box(-0.12, 0.12, 0.5, 1.0, -0.7, -0.6, GOLD_BRIGHT);
  b.box(-1.05, -0.9, 0, 1.0, -0.65, 0.65, GOLD);
  b.box(0.9, 1.05, 0, 1.0, -0.65, 0.65, GOLD);
  return b.merge();
}
