// Layer tile meshes (CR 038), built in the generation workers: a layer
// tile's two surfaces (Underground/Depths: floor and ceiling; sky: island top
// and bottom) as one indexed mesh with vertex colours and a baked glow, plus
// its water (lakes, rivers) or lava as a second mesh.
//
// What the lattice rules say is solid or open decides which triangles exist
// (worldgen/README.md "Vertical world"): a floor or ceiling triangle is drawn
// when any corner is open air; an island triangle when any corner is inside
// the island (top above bottom). Where the two surfaces meet (a chamber wall
// against its roof, an island's rim) their lattice values are equal, so the
// mesh closes without seams.
//
// The glow is the look of the place: rock near a light-casting crystal, a
// glowing lake, a lava river or a cenote's daylight is tinted by it per
// vertex, so a 400 m cavern reads as lit by its crystals at any distance
// with a handful of real lights near the player.

import { DECO, DECO_LIGHT, LAYER_DEPTHS, LAYER_SKY, NO_WATER, OPEN_C, TILE_S, type LayerTile, type VerticalWorld } from '@lodestone/worldgen';

export interface LayerMeshData {
  layer: number;
  lod: number;
  cx: number;
  cz: number;
  /** Surface mesh: 2 * S * S vertices (floor/top grid, then ceiling/bottom grid). */
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** rgb = baked glow (linear, unclamped), a = daylight weight (cenote shafts). */
  glow: Float32Array;
  index: Uint32Array;
  /** Water or lava: S * S vertices at the water surface, depth in wDepth. */
  wPositions: Float32Array;
  wDepth: Float32Array;
  wIndex: Uint32Array;
  /** [minX, minY, minZ, maxX, maxY, maxZ] of the surface vertices in use. */
  bounds: number[];
}

export function layerMeshTransferables(m: LayerMeshData): ArrayBuffer[] {
  return [m.positions.buffer, m.normals.buffer, m.colors.buffer, m.glow.buffer, m.index.buffer, m.wPositions.buffer, m.wDepth.buffer, m.wIndex.buffer] as ArrayBuffer[];
}

/** Light colours by tint (0..7 elements, 8 turquoise, 9 white). Linear. */
export const TINT_RGB: [number, number, number][] = [
  [1.0, 0.42, 0.12], // fire
  [0.35, 0.72, 1.0], // ice
  [0.85, 0.85, 0.35], // lightning
  [0.4, 1.0, 0.5], // earth (green)
  [0.6, 0.95, 0.85], // wind
  [1.0, 0.88, 0.55], // light
  [0.55, 0.25, 0.9], // dark
  [0.7, 0.38, 1.0], // void
  [0.2, 0.92, 0.88], // turquoise
  [0.9, 0.95, 1.0], // white
];

/** Island grass by island kind (grove, meadow, crag, town, palace, ruin): the sky is lush whatever lies below. */
const ISLAND_GRASS: [number, number, number][] = [
  [0.1, 0.25, 0.06],
  [0.2, 0.36, 0.08],
  [0.2, 0.26, 0.12],
  [0.17, 0.32, 0.08],
  [0.16, 0.34, 0.1],
  [0.2, 0.28, 0.1],
];

/** Cheap hash noise in [0, 1) on world coordinates (stable across tiles and LODs). */
function hn(x: number, z: number): number {
  let h = Math.imul((Math.floor(x) | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.floor(z) | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}
/** Smooth value noise, period `p` m. */
function vn(x: number, z: number, p: number): number {
  const u = x / p;
  const v = z / p;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const su = fu * fu * (3 - 2 * fu);
  const sv = fv * fv * (3 - 2 * fv);
  const a = hn(i * 17.1, j * 31.7);
  const b = hn((i + 1) * 17.1, j * 31.7);
  const c = hn(i * 17.1, (j + 1) * 31.7);
  const d = hn((i + 1) * 17.1, (j + 1) * 31.7);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

interface Emitter {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  range: number;
}

/** Chamber palette (rock, flat-floor tint) by chamber kind. */
const CHAMBER_ROCK: { rock: [number, number, number]; floor: [number, number, number] }[] = [
  { rock: [0.07, 0.075, 0.095], floor: [0.1, 0.1, 0.13] }, // crystal: blue-black stone
  { rock: [0.11, 0.11, 0.105], floor: [0.16, 0.16, 0.145] }, // cenote: grey limestone
  { rock: [0.085, 0.09, 0.095], floor: [0.06, 0.1, 0.065] }, // river: wet rock, moss
  { rock: [0.06, 0.052, 0.05], floor: [0.05, 0.085, 0.055] }, // fungal: dark earth, moss
  { rock: [0.045, 0.032, 0.03], floor: [0.07, 0.045, 0.035] }, // inferno: basalt
  { rock: [0.055, 0.05, 0.047], floor: [0.15, 0.14, 0.135] }, // ashen: ash plains
];

export function buildLayerMesh(t: LayerTile, v: VerticalWorld): LayerMeshData {
  const S = TILE_S;
  const N = S * S;
  const step = t.step;
  const x0 = t.cx * 64;
  const z0 = t.cz * 64;
  const span = step * (S - 1);
  const sky = t.layer === LAYER_SKY;
  const deep = t.layer === LAYER_DEPTHS;
  const positions = new Float32Array(N * 2 * 3);
  const normals = new Float32Array(N * 2 * 3);
  const colors = new Float32Array(N * 2 * 3);
  const glow = new Float32Array(N * 2 * 4);
  const A = t.a;
  const B = t.b;
  const W = t.w;
  const at = (arr: Float32Array, i: number, j: number) => arr[Math.max(0, Math.min(S - 1, j)) * S + Math.max(0, Math.min(S - 1, i))];
  const solid = (k: number) => (sky ? A[k] - B[k] > 0.01 : B[k] - A[k] > 0.01);

  // Nearby features for colour and glow.
  const pad = 60;
  const inBox = (x: number, z: number, m = pad) => x > x0 - m && x < x0 + span + m && z > z0 - m && z < z0 + span + m;
  const chambers = v.chambers.filter((c) => c.layer === t.layer && inBox(c.x, c.z, c.reach + pad));
  const emitters: Emitter[] = [];
  if (!sky) {
    const coarse = t.lod >= 2;
    for (const d of v.decos) {
      if (d.layer !== t.layer || !inBox(d.x, d.z)) continue;
      const light = (d.flags & DECO_LIGHT) !== 0;
      const crystal = d.kind === DECO.crystal || d.kind === DECO.spire || d.kind === DECO.mushroom;
      if (!light && (!crystal || coarse)) continue;
      const [r, g, b] = TINT_RGB[d.tint] ?? TINT_RGB[9];
      const k = light ? 1.25 : 0.32;
      const hang = d.kind === DECO.stalactite ? -1 : 1;
      emitters.push({ x: d.x, y: d.y + hang * Math.min(d.size, 8) * 0.5, z: d.z, r: r * k, g: g * k, b: b * k, range: light ? 28 + d.size * 3 : 9 + d.size * 2.2 });
    }
  }
  const shafts = sky ? [] : v.shafts.filter((s) => inBox(s.x, s.z, s.r * 4));
  const gates = !sky && !deep ? v.gateOpenings.filter((o) => inBox(o.x, o.z, o.rMask + step)) : [];

  // Chamber lookup per vertex (ellipse coordinate e).
  const chamberAt = (x: number, z: number): { c: (typeof chambers)[number]; e: number } | null => {
    let best: { c: (typeof chambers)[number]; e: number } | null = null;
    for (const c of chambers) {
      const dx = x - c.x;
      const dz = z - c.z;
      const u = dx * c.c + dz * c.s;
      const w = -dx * c.s + dz * c.c;
      const e = Math.sqrt((u / c.rx) ** 2 + (w / c.rz) ** 2);
      if (e < 1.25 && (!best || e < best.e)) best = { c, e };
    }
    return best;
  };

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let g = 0; g < 2; g++) {
    const H = g === 0 ? A : B;
    const down = g === 1; // ceiling / island bottom faces down
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const k = j * S + i;
        const x = x0 + i * step;
        const z = z0 + j * step;
        let y = H[k];
        if (!sky && down && y >= OPEN_C / 2) y = A[k] + 8; // open sky (never drawn)
        const o = (g * N + k) * 3;
        positions[o] = x;
        positions[o + 1] = y;
        positions[o + 2] = z;
        const hx = (at(H, i + 1, j) - at(H, i - 1, j)) / (2 * step);
        const hz = (at(H, i, j + 1) - at(H, i, j - 1)) / (2 * step);
        let nx = -hx;
        let ny = 1;
        let nz = -hz;
        if (down) {
          nx = hx;
          ny = -1;
          nz = hz;
        }
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        normals[o] = nx;
        normals[o + 1] = ny;
        normals[o + 2] = nz;
        const flat = Math.abs(ny); // 1 flat .. 0 vertical
        const n1 = vn(x, z, 7) * 0.6 + vn(x, z, 23) * 0.4;
        const n2 = hn(x * 3.1, z * 2.7);
        let r: number;
        let gg: number;
        let b: number;
        if (sky) {
          const isl = v.islands.find((s) => (x - s.x) ** 2 + (z - s.z) ** 2 < (s.reach + 6) ** 2);
          if (!down) {
            const grass = ISLAND_GRASS[isl?.kind ?? 0] ?? ISLAND_GRASS[0];
            const thick = A[k] - B[k];
            const dirt = Math.max(1 - Math.min(1, (flat - 0.55) / 0.3), thick < 6 ? 0.85 : 0);
            const v1 = 0.7 + 0.6 * n1;
            // Patches of brighter young grass and dry tufts.
            const patch = vn(x, z, 11);
            r = (grass[0] * v1 + 0.08 * Math.max(0, patch - 0.6)) * (1 - dirt) + 0.27 * dirt;
            gg = (grass[1] * v1 + 0.1 * Math.max(0, patch - 0.6)) * (1 - dirt) + 0.2 * dirt;
            b = (grass[2] * v1) * (1 - dirt) + 0.13 * dirt;
            if (n2 > 0.97 && dirt < 0.3 && step <= 2) {
              // A few wildflowers.
              const fc = [[0.55, 0.5, 0.18], [0.5, 0.25, 0.32], [0.36, 0.36, 0.55]][Math.floor(n2 * 1000) % 3];
              r = (r + fc[0]) * 0.5;
              gg = (gg + fc[1]) * 0.5;
              b = (b + fc[2]) * 0.5;
            }
            if (isl && (isl.kind === 2 || isl.kind === 5)) {
              // Crags and ruins: more bare stone.
              const st = Math.max(0, n1 - 0.45) * 1.6;
              r = r * (1 - st) + 0.42 * st;
              gg = gg * (1 - st) + 0.41 * st;
              b = b * (1 - st) + 0.38 * st;
            }
          } else {
            const top = isl ? isl.top : A[k];
            const depth = Math.max(0, Math.min(1, (top - y) / ((isl?.thick ?? 60) + 10)));
            const earth = [0.27, 0.19, 0.12];
            const stone = [0.3, 0.29, 0.28];
            const m = Math.min(1, depth * 1.6);
            const shade = 0.85 + 0.3 * n1 - 0.35 * depth;
            r = (earth[0] * (1 - m) + stone[0] * m) * shade;
            gg = (earth[1] * (1 - m) + stone[1] * m) * shade;
            b = (earth[2] * (1 - m) + stone[2] * m) * shade;
            if (n2 > 0.86 && depth < 0.5) {
              r *= 0.8;
              gg *= 1.15; // moss and roots
            }
          }
        } else {
          const ch = chamberAt(x, z);
          const pal = CHAMBER_ROCK[ch ? ch.c.kind : deep ? 4 : 2] ?? CHAMBER_ROCK[0];
          const flatW = down ? 0 : Math.max(0, (flat - 0.75) / 0.25);
          const v1 = 0.7 + 0.6 * n1;
          r = (pal.rock[0] * (1 - flatW) + pal.floor[0] * flatW) * v1;
          gg = (pal.rock[1] * (1 - flatW) + pal.floor[1] * flatW) * v1;
          b = (pal.rock[2] * (1 - flatW) + pal.floor[2] * flatW) * v1;
          if (down) {
            r *= 0.8;
            gg *= 0.8;
            b *= 0.85;
          }
          // Strata bands on walls.
          if (flat < 0.6) {
            const band = 0.85 + 0.25 * Math.sin(y * 0.9 + n1 * 3);
            r *= band;
            gg *= band;
            b *= band;
          }
        }
        colors[o] = r;
        colors[o + 1] = gg;
        colors[o + 2] = b;
        // Glow.
        let lr = 0;
        let lg = 0;
        let lb = 0;
        let sun = 0;
        if (!sky) {
          for (const e of emitters) {
            const dx = e.x - x;
            const dy = e.y - y;
            const dz = e.z - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            const rr = e.range * 2.6;
            if (d2 > rr * rr) continue;
            const d = Math.sqrt(d2) || 1;
            const lam = 0.3 + 0.7 * Math.max(0, (nx * dx + ny * dy + nz * dz) / d);
            const fall = (1 / (1 + d2 / (e.range * e.range))) * (1 - d / rr);
            lr += e.r * fall * lam;
            lg += e.g * fall * lam;
            lb += e.b * fall * lam;
          }
          // Glowing water: the lake lights the rock around it and the roof over it.
          const ch = chamberAt(x, z);
          if (ch && ch.c.lake > NO_WATER / 2) {
            const h = y - ch.c.lake;
            const near = ch.e < ch.c.lakeE + 0.35 ? 1 : Math.max(0, 1 - (ch.e - ch.c.lakeE - 0.35) * 3);
            const k2 = down ? 0.22 * Math.exp(-Math.max(0, h) / 45) : 0.75 * Math.exp(-Math.max(0, h) / 10);
            const col = deep ? [1.0, 0.36, 0.08] : [0.16, 0.82, 0.78];
            const kk = near * k2 * (deep ? 1.8 : 1);
            if (h > -2) {
              lr += col[0] * kk;
              lg += col[1] * kk;
              lb += col[2] * kk;
            }
          }
          // Rivers and lava rivers.
          const wv = W[k];
          if (wv > NO_WATER / 2 && !ch) {
            const h = y - wv;
            if (h > -2 && h < 25) {
              const col = deep ? [1.0, 0.4, 0.1] : [0.15, 0.7, 0.68];
              const kk = (down ? 0.35 : 0.6) * Math.exp(-Math.max(0, h) / (down ? 14 : 6)) * (deep ? 1.8 : 1);
              lr += col[0] * kk;
              lg += col[1] * kk;
              lb += col[2] * kk;
            }
          }
          for (const s of shafts) {
            const d = Math.hypot(x - s.x, z - s.z);
            const reach = s.r * 3.2;
            if (d < reach) sun += (1 - d / reach) ** (down ? 3 : 2) * (down ? 0.2 : 1);
          }
        }
        const go = (g * N + k) * 4;
        glow[go] = lr;
        glow[go + 1] = lg;
        glow[go + 2] = lb;
        glow[go + 3] = Math.min(1.5, sun);
      }
    }
  }

  // Triangles: each 1-step cell, split along the (i+1, j) - (i, j+1) diagonal like the collision mesh.
  const idx: number[] = [];
  for (let g = 0; g < 2; g++) {
    const base = g * N;
    for (let j = 0; j < S - 1; j++) {
      for (let i = 0; i < S - 1; i++) {
        const a = j * S + i;
        const b = a + 1;
        const c = a + S;
        const d = c + 1;
        for (let tri = 0; tri < 2; tri++) {
          const q = tri === 0 ? [a, b, c] : [d, c, b];
          if (!solid(q[0]) && !solid(q[1]) && !solid(q[2])) continue;
          if (!sky && g === 1 && (B[q[0]] >= OPEN_C / 2 || B[q[1]] >= OPEN_C / 2 || B[q[2]] >= OPEN_C / 2)) continue;
          if (gates.length && g === 0) {
            // A Depths gate's hole in the Underground floor (the collision mask rule at this tile's spacing).
            const cxw = x0 + i * step;
            const czw = z0 + j * step;
            const ccx = tri === 0 ? cxw + step / 3 : cxw + (2 * step) / 3;
            const ccz = tri === 0 ? czw + step / 3 : czw + (2 * step) / 3;
            if (gates.some((o) => (ccx - o.x) ** 2 + (ccz - o.z) ** 2 < o.rMask * o.rMask)) continue;
          }
          // Up-facing surfaces wind counter-clockwise seen from above; the down-facing ones the other way.
          if (g === 0) idx.push(base + q[0], base + q[2], base + q[1]);
          else idx.push(base + q[0], base + q[1], base + q[2]);
          for (const vi of q) {
            const o = (base + vi) * 3;
            const px = positions[o];
            const py = positions[o + 1];
            const pz = positions[o + 2];
            if (px < minX) minX = px;
            if (py < minY) minY = py;
            if (pz < minZ) minZ = pz;
            if (px > maxX) maxX = px;
            if (py > maxY) maxY = py;
            if (pz > maxZ) maxZ = pz;
          }
        }
      }
    }
  }

  // Water / lava.
  const wPositions = new Float32Array(sky ? 0 : N * 3);
  const wDepth = new Float32Array(sky ? 0 : N);
  const widx: number[] = [];
  if (!sky && t.flags & 2) {
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const k = j * S + i;
        wPositions[k * 3] = x0 + i * step;
        wPositions[k * 3 + 1] = W[k] > NO_WATER / 2 ? W[k] : A[k] - 1;
        wPositions[k * 3 + 2] = z0 + j * step;
        wDepth[k] = W[k] > NO_WATER / 2 ? W[k] - A[k] : -1;
      }
    }
    for (let j = 0; j < S - 1; j++) {
      for (let i = 0; i < S - 1; i++) {
        const a = j * S + i;
        const b = a + 1;
        const c = a + S;
        const d = c + 1;
        for (const q of [
          [a, b, c],
          [d, c, b],
        ]) {
          if (wDepth[q[0]] <= 0.05 && wDepth[q[1]] <= 0.05 && wDepth[q[2]] <= 0.05) continue;
          if (W[q[0]] <= NO_WATER / 2 || W[q[1]] <= NO_WATER / 2 || W[q[2]] <= NO_WATER / 2) continue;
          widx.push(q[0], q[2], q[1]);
        }
      }
    }
  }
  return {
    layer: t.layer,
    lod: t.lod,
    cx: t.cx,
    cz: t.cz,
    positions,
    normals,
    colors,
    glow,
    index: new Uint32Array(idx),
    wPositions,
    wDepth,
    wIndex: new Uint32Array(widx),
    bounds: Number.isFinite(minX) ? [minX, minY, minZ, maxX, maxY, maxZ] : [x0, 0, z0, x0 + span, 0, z0 + span],
  };
}
