// The towns texture array (WP20, spec 5 "pieces share one texture atlas per
// style so a whole town draws in a handful of draw calls"): every building
// material of every style is one layer of ONE texture array, so a town is a
// single material and a single draw call. Layers repeat on their own (a
// sampler2DArray wraps per layer), so there are no atlas seams or mip bleed.
//
// Painted procedurally into RGBA pixels (pure TS, no canvas: it runs in the
// buildings worker, ~100 ms, off the main thread). All patterns tile: noise
// is periodic over the tile and shapes are drawn modulo the tile size.
// Alpha is the glow mask (1 = this texel may emit: window glass, flames,
// lantern glass); the material keeps the surface opaque.

export const TEX = {
  plaster: 0,
  timber: 1,
  stone: 2,
  adobe: 3,
  logs: 4,
  planks: 5,
  floor: 6,
  thatch: 7,
  clayTile: 8,
  shingle: 9,
  cobble: 10,
  dirt: 11,
  fieldstone: 12,
  window: 13,
  door: 14,
  slate: 15,
  rock: 16,
  mossStone: 17,
  cloth: 18,
  metal: 19,
  fire: 20,
  soil: 21,
  crops: 22,
  flagstone: 23,
  books: 24,
  rug: 25,
  paper: 26,
  glow: 27,
  plain: 28,
  wood: 29,
  water: 30,
  stripes: 31,
  reed: 32,
} as const;
export type TexName = keyof typeof TEX;
export const TEX_LAYERS = 33;
export const TEX_SIZE = 256;

/** Metres per repeat for planar-mapped layers (0 = explicit 0..1 uvs: one picture per face). */
export const TILE_M: Record<TexName, number> = {
  plaster: 2,
  timber: 3,
  stone: 2,
  adobe: 2.5,
  logs: 2,
  planks: 2,
  floor: 2,
  thatch: 2,
  clayTile: 2,
  shingle: 2,
  cobble: 2,
  dirt: 4,
  fieldstone: 2,
  window: 0,
  door: 0,
  slate: 2,
  rock: 3,
  mossStone: 2,
  cloth: 1.5,
  metal: 1,
  fire: 0,
  soil: 2,
  crops: 1.5,
  flagstone: 3,
  books: 1,
  rug: 0,
  paper: 0,
  glow: 1,
  plain: 1,
  wood: 1.5,
  water: 1,
  stripes: 1.2,
  reed: 2,
};

type RGB = [number, number, number];

/** Periodic value noise table (period p over the tile), smooth-interpolated, 0..1. */
function noiseTable(n: number, p: number, seed: number): Float32Array {
  const lat = new Float32Array(p * p);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < lat.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    lat[i] = s / 4294967296;
  }
  const out = new Float32Array(n * n);
  const k = p / n;
  for (let y = 0; y < n; y++) {
    const fy = y * k;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < n; x++) {
      const fx = x * k;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const a = lat[(y0 % p) * p + (x0 % p)];
      const b = lat[(y0 % p) * p + ((x0 + 1) % p)];
      const c = lat[((y0 + 1) % p) * p + (x0 % p)];
      const d = lat[((y0 + 1) % p) * p + ((x0 + 1) % p)];
      out[y * n + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
  }
  return out;
}

/** Periodic fbm (octaves of the table above). */
function fbm(n: number, base: number, oct: number, seed: number): Float32Array {
  const out = new Float32Array(n * n);
  let amp = 1;
  let tot = 0;
  for (let o = 0; o < oct; o++) {
    const t = noiseTable(n, base << o, seed + o * 977);
    for (let i = 0; i < out.length; i++) out[i] += t[i] * amp;
    tot += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

/** Periodic jittered-grid cells (Voronoi): per pixel the nearest/second distance and cell id. */
function cells(n: number, g: number, seed: number, jitter = 0.8): { d1: Float32Array; d2: Float32Array; id: Uint16Array } {
  const scale = n / TEX_SIZE; // distances come back in 256 px units whatever the real size
  const pts: [number, number][] = [];
  let s = seed >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const cs = n / g;
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) pts.push([(i + 0.5 + (r() - 0.5) * jitter) * cs, (j + 0.5 + (r() - 0.5) * jitter) * cs]);
  const d1 = new Float32Array(n * n);
  const d2 = new Float32Array(n * n);
  const id = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) {
    const cj = Math.floor(y / cs);
    for (let x = 0; x < n; x++) {
      const ci = Math.floor(x / cs);
      let a = 1e9;
      let b = 1e9;
      let best = 0;
      for (let dj = -2; dj <= 2; dj++)
        for (let di = -2; di <= 2; di++) {
          const ii = (ci + di + g) % g;
          const jj = (cj + dj + g) % g;
          const p = pts[jj * g + ii];
          // Wrap the point next to this pixel.
          const px = p[0] + Math.round((x - p[0]) / n) * n;
          const py = p[1] + Math.round((y - p[1]) / n) * n;
          const d = Math.hypot(px - x, py - y);
          if (d < a) {
            b = a;
            a = d;
            best = jj * g + ii;
          } else if (d < b) b = d;
        }
      d1[y * n + x] = a / scale;
      d2[y * n + x] = b / scale;
      id[y * n + x] = best;
    }
  }
  return { d1, d2, id };
}

const hash = (i: number, seed = 0) => {
  let h = Math.imul(i ^ (seed * 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const sstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Paint all layers: TEX_LAYERS x size x size RGBA8, layer-major (the layout
 * a DataArrayTexture takes).
 */
export function paintTownTextures(size = TEX_SIZE): Uint8Array {
  // Painters are written in 256 px units (n); `size` (256 or 512) only sets how finely they are sampled and
  // the noise tables' resolution: a 512 px array has the same pictures with finer grain and crisper joints.
  const N = size;
  const S = N / TEX_SIZE;
  const n = TEX_SIZE;
  const out = new Uint8Array(TEX_LAYERS * N * N * 4);
  const N1 = fbm(N, 8, 4, 11);
  const N2 = fbm(N, 16, 3, 23);
  const NF = fbm(N, 32, 2, 37); // fine grain
  const NG = fbm(N, 64, 2, 53); // finer still
  const cobble = cells(N, 8, 5);
  const field = cells(N, 6, 9, 0.9);
  const flag = cells(N, 4, 13, 0.7);
  const px = (L: number, fn: (x: number, y: number, i: number) => [number, number, number, number?]) => {
    const base = L * N * N * 4;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const c = fn(x / S, y / S, i);
        const o = base + i * 4;
        out[o] = clamp(c[0]);
        out[o + 1] = clamp(c[1]);
        out[o + 2] = clamp(c[2]);
        out[o + 3] = c[3] === undefined ? 0 : clamp(c[3]);
      }
  };
  // Shared pieces.
  const plaster = (i: number): RGB => {
    // Lime wash over lath: soft trowel mottling, a pitted grain, damp stains and hairline cracks.
    const k = 0.9 + 0.09 * N1[i] + 0.04 * (NF[i] - 0.5) + 0.04 * (NG[i] - 0.5);
    const stain = sstep(0.62, 0.82, N2[i]) * 0.07;
    const crack = Math.abs(N1[i] - 0.5) < 0.004 ? 0.12 : 0;
    const wash = mix([234, 224, 202], [222, 214, 196], sstep(0.35, 0.7, N2[i]));
    return shade(wash, k - stain - crack);
  };
  /** Wood grain along y (vertical boards) or x. */
  const grain = (x: number, y: number, i: number, base: RGB, along: 'x' | 'y', board: number): RGB => {
    const a = along === 'y' ? x : y;
    const b = along === 'y' ? y : x;
    const bi = Math.floor(a / board);
    const t = (a % board) / board;
    const g = Math.sin((b / n) * Math.PI * 2 * 3 + hash(bi) * 6 + NF[i] * 4) * 0.5 + 0.5;
    let k = 0.82 + 0.18 * hash(bi, 3) + 0.1 * (g - 0.5) + 0.08 * (N2[i] - 0.5);
    if (t < 0.05 || t > 0.95) k *= 0.45; // the gap between boards
    else {
      // a knot or two and nail heads at the board ends
      const kx = hash(bi, 11) * 0.5 + 0.25;
      const ky = hash(bi, 12) * n;
      const kd = Math.hypot((t - kx) * board, (((b - ky + n * 1.5) % n) - n / 2) * 0.5);
      if (hash(bi, 13) > 0.55 && kd < board * 0.12) k *= 0.62 + 0.3 * (kd / (board * 0.12));
      if ((b < 6 || b > n - 6) && Math.abs(t - 0.5) < 0.12 && ((b % n) < 3 || b > n - 4)) k *= 0.5;
    }
    return shade(base, k);
  };
  const blocks = (x: number, y: number, i: number, rows: number, cols: number, base: RGB, mortar: RGB, moss = 0): RGB => {
    const bh = n / rows;
    const r = Math.floor(y / bh);
    const bw = n / cols;
    const xo = (x + (r % 2 ? bw / 2 : 0)) % n;
    const c = Math.floor(xo / bw);
    const fx = (xo % bw) / bw;
    const fy = (y % bh) / bh;
    const edge = Math.min(fx * bw, (1 - fx) * bw, fy * bh, (1 - fy) * bh);
    if (edge < 2.2) return shade(mortar, 0.9 + 0.2 * NF[i]);
    const id = r * 31 + c;
    let col = shade(base, 0.82 + 0.22 * hash(id, 7) + 0.1 * (N2[i] - 0.5));
    col = mix(col, shade(col, 1.12), sstep(0.8, 0.2, fy) * 0.25); // top highlight
    if (edge < 5) col = shade(col, 0.85 + edge * 0.03);
    // chiselled faces: lit upper edge, shaded lower edge, tooling pits and a few chipped corners
    const ly = fy * bh;
    if (ly < 6 && edge > 2.2) col = shade(col, 1.0 + (6 - ly) * 0.018);
    if (bh - ly < 6) col = shade(col, 0.9 + (bh - ly) * 0.017);
    if (NG[i] < 0.3) col = shade(col, 0.9 + NG[i] * 0.3);
    if (hash(id, 21) > 0.9 && Math.min(fx * bw, ly) < 7 && fx < 0.2 && fy < 0.2) col = shade(col, 0.8);
    if (moss > 0) col = mix(col, [70, 96, 48], sstep(0.55, 0.75, N1[i] * 0.7 + (1 - fy) * 0.2 + N2[i] * 0.3) * moss);
    return col;
  };

  // 0 plaster
  px(TEX.plaster, (_x, _y, i) => plaster(i));
  // 1 timber framing: plaster panels framed by dark oak beams; one tile = 3 m
  // (a storey), beams at the floor line, a post every half tile and braces.
  px(TEX.timber, (x, y, i) => {
    const beam = n * (0.2 / 3);
    const half = n / 2;
    const fx = x % half;
    const yy = n - 1 - y; // v grows upward: beam at the floor line
    const onH = yy < beam || yy > n - beam * 0.6;
    const onV = fx < beam * 0.5 || fx > half - beam * 0.5;
    const diag = Math.abs(fx / half - yy / n) * half < beam * 0.45 && yy > beam && yy < n - beam;
    if (onH || onV || diag) {
      const k = 0.75 + 0.2 * NF[i] + 0.08 * Math.sin(x * 0.4 + N2[i] * 6);
      return shade([92, 62, 40], k);
    }
    return plaster(i);
  });
  // 2 dressed stone
  px(TEX.stone, (x, y, i) => blocks(x, y, i, 5, 3, [168, 160, 146], [88, 84, 78]));
  // 3 adobe: smooth sun-baked mud, faint cracks and straw flecks
  px(TEX.adobe, (_x, _y, i) => {
    let c = shade([205, 160, 112], 0.86 + 0.16 * N1[i] + 0.06 * (NF[i] - 0.5));
    if (Math.abs(N2[i] - 0.5) < 0.006) c = shade(c, 0.72);
    if (NF[i] > 0.82) c = mix(c, [226, 196, 130], 0.5);
    return c;
  });
  // 4 logs: horizontal logs, round shading, dark chinks
  px(TEX.logs, (x, y, i) => {
    const lh = n / 6;
    const r = Math.floor(y / lh);
    const t = (y % lh) / lh;
    const round = Math.sin(t * Math.PI);
    if (t < 0.06 || t > 0.94) return shade([60, 48, 36], 0.9 + 0.2 * NF[i]);
    const bark = 0.7 + 0.3 * Math.sin((x / n) * Math.PI * 2 * 9 + NF[i] * 5 + r * 1.7) * 0.5 + 0.3;
    return shade([124, 88, 58], (0.55 + 0.5 * round) * (0.85 + 0.15 * bark) * (0.9 + 0.2 * hash(r, 2)));
  });
  // 5 vertical planks (walls, doors' surround, sheds)
  px(TEX.planks, (x, y, i) => grain(x, y, i, [138, 102, 68], 'y', n / 10));
  // 6 floor planks (warm, horizontal)
  px(TEX.floor, (x, y, i) => {
    const c = grain(x, y, i, [156, 112, 72], 'x', n / 8);
    const row = Math.floor(y / (n / 8));
    const endX = (hash(row, 5) * n) | 0;
    return Math.abs(x - endX) < 1.2 ? shade(c, 0.5) : c;
  });
  // 7 thatch: straw strands running down the slope, layered courses
  px(TEX.thatch, (x, y, i) => {
    const course = (y % (n / 6)) / (n / 6);
    const strand = Math.sin(x * 1.7 + NF[i] * 9 + Math.floor(y / (n / 6)) * 2.3) * 0.5 + 0.5;
    const k = 0.62 + 0.25 * strand + 0.18 * N1[i] - 0.25 * sstep(0.75, 1, course);
    return shade([196, 160, 92], k);
  });
  // 8 clay tiles: rows of round-bottomed terracotta tiles
  px(TEX.clayTile, (x, y, i) => {
    const rh = n / 8;
    const r = Math.floor(y / rh);
    const tw = n / 8;
    const xo = (x + (r % 2 ? tw / 2 : 0)) % n;
    const tx = (xo % tw) / tw;
    const ty = (y % rh) / rh;
    const curve = Math.sin(tx * Math.PI);
    let k = 0.62 + 0.4 * curve + 0.08 * (N2[i] - 0.5);
    if (ty > 0.82 + 0.12 * (1 - curve)) k *= 0.55; // shadow under the next row
    const base = mix([176, 86, 56], [160, 98, 64], hash(r * 17 + Math.floor(xo / tw), 5));
    let c = shade(base, k * (0.88 + 0.24 * hash(r * 17 + Math.floor(xo / tw), 3)) * (0.96 + 0.08 * NG[i]));
    c = mix(c, [96, 112, 66], sstep(0.66, 0.84, N1[i] * 0.6 + N2[i] * 0.4) * 0.45 * (1 - curve * 0.5)); // lichen in the troughs
    return c;
  });
  // 9 wood shingles: rows of random-width grey-brown shingles
  px(TEX.shingle, (x, y, i) => {
    const rh = n / 10;
    const r = Math.floor(y / rh);
    const ty = (y % rh) / rh;
    let x0 = 0;
    let k = 1;
    let w = 0;
    let s = 0;
    while (x0 <= x) {
      w = n / 14 + hash(r * 97 + s, 4) * (n / 9);
      if (x < x0 + w) break;
      x0 += w;
      s++;
    }
    const fx = (x - x0) / w;
    if (fx < 0.05) k *= 0.5;
    if (ty > 0.85) k *= 0.6;
    k *= 0.75 + 0.3 * hash(r * 97 + s, 6) + 0.12 * (NF[i] - 0.5) + 0.08 * (NG[i] - 0.5);
    // weathered: some shingles silvered, damp moss creeping up from the lower rows
    const silver = hash(r * 97 + s, 8) > 0.7 ? 1.12 : 1;
    const c = shade(mix([118, 100, 84], [128, 122, 112], hash(r * 97 + s, 9) * 0.6), k * silver);
    return mix(c, [88, 104, 62], sstep(0.68, 0.86, N1[i]) * 0.35);
  });
  // 10 cobble: rounded stones, dark gaps
  px(TEX.cobble, (_x, _y, i) => {
    const e = cobble.d2[i] - cobble.d1[i];
    const base = mix([128, 122, 112], [150, 136, 112], hash(cobble.id[i], 2));
    if (e < 2.5) return shade([60, 56, 50], 0.9 + 0.2 * NF[i]);
    return shade(base, (0.78 + 0.25 * Math.min(1, e / 12)) * (0.92 + 0.12 * NF[i]));
  });
  // 11 dirt road: u along the road, v across it (0..1 = edge to edge):
  // ruts, pebbles, darker frayed edges.
  px(TEX.dirt, (x, y, i) => {
    const v = y / n;
    let c = shade([142, 112, 80], 0.86 + 0.16 * N1[i] + 0.06 * (NF[i] - 0.5));
    const rut = Math.exp(-(((v - 0.3) / 0.05) ** 2)) + Math.exp(-(((v - 0.7) / 0.05) ** 2));
    c = shade(c, 1 - 0.12 * rut);
    if (NF[i] > 0.86) c = mix(c, [176, 168, 150], 0.6);
    const edge = Math.min(v, 1 - v);
    c = shade(c, 0.8 + 0.2 * sstep(0.0, 0.12 + 0.05 * N2[(i * 7) % (N * N)], edge));
    return c;
  });
  // 12 fieldstone foundation: irregular rounded stones in mortar
  px(TEX.fieldstone, (_x, _y, i) => {
    const e = field.d2[i] - field.d1[i];
    if (e < 3) return shade([112, 106, 96], 0.9 + 0.2 * NF[i]);
    return shade(mix([156, 148, 134], [182, 168, 144], hash(field.id[i], 1)), (0.75 + 0.3 * Math.min(1, e / 16)) * (0.9 + 0.15 * N2[i]));
  });
  // 13 window: wooden frame and cross, glass panes (alpha = glow mask)
  px(TEX.window, (x, y, i) => {
    const fx = x / n;
    const fy = y / n;
    const fr = 0.1;
    const bar = 0.026;
    // two columns x three rows of leaded panes; frame and lead never emit, each pane glows a little differently
    const gx = (fx - fr) / (1 - 2 * fr);
    const gy = (fy - fr) / (1 - 2 * fr);
    const lead = Math.abs(gx * 2 - Math.round(gx * 2)) * 0.5 < bar * 0.8 || Math.abs(gy * 3 - Math.round(gy * 3)) / 3 < bar * 0.8;
    if (fx < fr || fx > 1 - fr || fy < fr || fy > 1 - fr || (lead && gx > 0 && gx < 1 && gy > 0 && gy < 1)) {
      const inner = Math.min(fx - fr, 1 - fr - fx, fy - fr, 1 - fr - fy);
      const bevel = fx < fr || fx > 1 - fr || fy < fr || fy > 1 - fr ? 1 : 0.6;
      return [...shade(bevel === 1 ? [104, 74, 48] : [70, 66, 62], (0.8 + 0.25 * NF[i]) * (inner > -0.02 && inner < 0.01 ? 0.7 : 1)), 0] as [number, number, number, number];
    }
    const pane = Math.floor(Math.max(0, Math.min(1.999, gx * 2))) + 2 * Math.floor(Math.max(0, Math.min(2.999, gy * 3)));
    const refl = sstep(0.0, 1.0, 1 - Math.abs(fx - fy - 0.1) * 3) * 0.3;
    const wob = 0.85 + 0.3 * hash(pane, 31);
    return [(72 + 70 * refl) * wob, (92 + 76 * refl) * wob, (118 + 84 * refl) * wob, 150 + 105 * hash(pane, 33) * (0.6 + 0.4 * (1 - Math.abs(gy - 0.5)))];
  });
  // 14 door: vertical planks with iron straps and a ring
  px(TEX.door, (x, y, i) => {
    let c = grain(x, y, i, [116, 80, 50], 'y', n / 6);
    const fy = y / n;
    if (Math.abs(fy - 0.22) < 0.025 || Math.abs(fy - 0.78) < 0.025) c = shade([52, 50, 48], 0.9 + 0.2 * NF[i]);
    const dx = x / n - 0.78;
    const dy = fy - 0.52;
    if (Math.abs(Math.hypot(dx, dy) - 0.045) < 0.012) c = [60, 58, 56];
    return c;
  });
  // 15 slate: dark blue-grey overlapping slates
  px(TEX.slate, (x, y, i) => {
    const rh = n / 9;
    const r = Math.floor(y / rh);
    const tw = n / 6;
    const xo = (x + (r % 2 ? tw / 2 : 0)) % n;
    const tx = (xo % tw) / tw;
    const ty = (y % rh) / rh;
    let k = 0.8 + 0.25 * hash(r * 13 + Math.floor(xo / tw), 8) + 0.1 * (NF[i] - 0.5);
    if (tx < 0.04 || ty > 0.88) k *= 0.55;
    return shade([82, 88, 98], k);
  });
  // 16 rough rock
  px(TEX.rock, (_x, _y, i) => shade([122, 116, 108], 0.65 + 0.45 * N1[i] + 0.2 * (NF[i] - 0.5)));
  // 17 mossy stone (ruins, temples)
  px(TEX.mossStone, (x, y, i) => blocks(x, y, i, 4, 2, [150, 146, 132], [70, 72, 62], 0.9));
  // 18 canvas cloth (tinted per use)
  px(TEX.cloth, (x, y, i) => {
    const weave = ((x + y) % 4 < 2 ? 1 : 0.94) * (0.9 + 0.1 * N1[i]);
    return shade([234, 226, 206], weave);
  });
  // 19 dark iron
  px(TEX.metal, (_x, _y, i) => shade([74, 74, 78], 0.8 + 0.3 * NF[i] + 0.1 * N2[i]));
  // 20 fire: flames rising from the bottom (u across, v up), glow mask in alpha
  px(TEX.fire, (x, y, i) => {
    const fx = x / n;
    const fy = 1 - y / n;
    const tongue = (Math.sin(fx * Math.PI * 6 + N2[i] * 5) * 0.5 + 0.5) * 0.35 + N1[i] * 0.4;
    const h = 1 - fy - tongue * 0.6;
    const core = sstep(0.0, 0.5, h);
    const c = mix([200, 40, 10], mix([255, 140, 30], [255, 236, 150], sstep(0.4, 0.9, h)), core);
    const a = sstep(-0.05, 0.25, h) * sstep(0.0, 0.12, Math.min(fx, 1 - fx));
    return [c[0], c[1], c[2], 255 * a];
  });
  // 21 tilled soil: furrows along u
  px(TEX.soil, (_x, y, i) => {
    const f = Math.sin((y / n) * Math.PI * 2 * 4) * 0.5 + 0.5;
    return shade([104, 76, 52], 0.65 + 0.35 * f + 0.1 * (NF[i] - 0.5));
  });
  // 22 crops: leafy stalks (tinted green or gold per field)
  px(TEX.crops, (x, y, i) => {
    const st = Math.sin(x * 0.9 + NF[i] * 4) * 0.5 + 0.5;
    const leaf = sstep(0.5, 0.9, N2[i] + st * 0.3);
    return shade(mix([190, 196, 120], [236, 226, 150], leaf), 0.6 + 0.4 * (1 - y / n) * 0.5 + 0.3 * st);
  });
  // 23 flagstones (plaza, structure paving)
  px(TEX.flagstone, (_x, _y, i) => {
    const e = flag.d2[i] - flag.d1[i];
    if (e < 3) return shade([92, 90, 80], 0.9 + 0.2 * NF[i]);
    return shade(mix([168, 160, 144], [184, 172, 150], hash(flag.id[i], 3)), (0.84 + 0.18 * Math.min(1, e / 20)) * (0.9 + 0.12 * N2[i]));
  });
  // 24 books: rows of coloured spines on shelf boards
  px(TEX.books, (x, y, i) => {
    const rh = n / 4;
    const r = Math.floor(y / rh);
    const ty = (y % rh) / rh;
    if (ty > 0.86) return shade([110, 78, 50], 0.8 + 0.2 * NF[i]);
    let x0 = 0;
    let s = 0;
    let w = 0;
    while (x0 <= x) {
      w = 6 + hash(r * 53 + s, 2) * 10;
      if (x < x0 + w) break;
      x0 += w;
      s++;
    }
    const top = 0.12 + hash(r * 53 + s, 9) * 0.25;
    if (ty < top) return shade([60, 44, 30], 0.7);
    const pal: RGB[] = [[120, 40, 34], [40, 70, 110], [50, 92, 52], [140, 110, 60], [90, 50, 90], [150, 130, 110]];
    const c = pal[Math.floor(hash(r * 53 + s, 5) * pal.length)];
    return shade(c, (x - x0 < 1 ? 0.6 : 1) * (0.85 + 0.15 * NF[i]));
  });
  // 25 rug: red field, patterned border (one picture per rug)
  px(TEX.rug, (x, y, i) => {
    const fx = x / n;
    const fy = y / n;
    const e = Math.min(fx, 1 - fx, fy, 1 - fy);
    let c: RGB = [140, 44, 38];
    if (e < 0.12) c = (Math.floor((fx + fy) * 24) % 2 ? [206, 168, 90] : [60, 40, 70]) as RGB;
    else if (e < 0.15) c = [220, 200, 150];
    else if (Math.abs(Math.abs(fx - 0.5) + Math.abs(fy - 0.5) - 0.2) < 0.03) c = [206, 168, 90];
    return shade(c, 0.85 + 0.15 * NF[i]);
  });
  // 26 notice board face: papers pinned on planks
  px(TEX.paper, (x, y, i) => {
    let c = grain(x, y, i, [120, 88, 58], 'x', n / 6);
    const notes = [
      [0.08, 0.1, 0.32, 0.38],
      [0.45, 0.06, 0.28, 0.3],
      [0.78, 0.14, 0.16, 0.26],
      [0.12, 0.56, 0.26, 0.34],
      [0.46, 0.46, 0.34, 0.4],
    ];
    const fx = x / n;
    const fy = y / n;
    for (const [nx, ny, w, h] of notes)
      if (fx > nx && fx < nx + w && fy > ny && fy < ny + h) {
        c = shade([232, 222, 190], 0.92 + 0.08 * NF[i]);
        const line = ((fy - ny) / h) * 9;
        if (line % 1 < 0.22 && line > 1.5 && (fx - nx) / w > 0.12 && (fx - nx) / w < 0.88) c = [90, 80, 70];
      }
    return c;
  });
  // 27 glow: plain white that emits (tinted per use: lantern glass, crystals)
  px(TEX.glow, (_x, _y, i) => [235 + 20 * NF[i], 235 + 20 * NF[i], 235 + 20 * NF[i], 255]);
  // 28 plain: white, tinted per use, never emits
  px(TEX.plain, (_x, _y, i) => shade([240, 240, 240], 0.94 + 0.06 * NF[i]));
  // 29 furniture wood
  px(TEX.wood, (x, y, i) => grain(x, y, i, [150, 108, 70], 'x', n / 3));
  // 30 water (quench tub, well)
  px(TEX.water, (_x, _y, i) => shade([46, 84, 96], 0.8 + 0.3 * N1[i]));
  // 31 awning stripes
  px(TEX.stripes, (x, _y, i) => {
    const s = Math.floor((x / n) * 6) % 2 === 0;
    return shade(s ? [190, 52, 44] : [236, 226, 200], 0.9 + 0.1 * N1[i]);
  });
  // 32 reed walls (stilt houses): woven reed mats
  px(TEX.reed, (x, y, i) => {
    const bw = n / 16;
    const by = Math.floor(y / bw);
    const bx = Math.floor(x / bw);
    const over = (bx + by) % 2 === 0;
    const t = over ? (x % bw) / bw : (y % bw) / bw;
    return shade([170, 150, 98], (0.7 + 0.3 * Math.sin(t * Math.PI)) * (0.88 + 0.16 * NF[i]));
  });
  return out;
}
