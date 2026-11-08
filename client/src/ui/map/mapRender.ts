// The map's terrain picture: biomes with hillshade, sea and lakes, rivers,
// drawn once per world from the atlas into an offscreen canvas. Adapted from
// tools/creator/web/src/preview/render.ts (`base`, rivers), itself adapted
// from worldgen/debug/main.ts, with a paper-map grade so it reads as a map
// rather than a debug view. The map screen then copies only revealed
// regions out of it.

import type { AtlasData, Site } from '@lodestone/worldgen';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const BIOME_RGB: [number, number, number][] = [
  [150, 178, 104], // meadow
  [78, 120, 72], // forest
  [146, 136, 108], // highlands
  [232, 234, 236], // snowpeak
  [200, 140, 88], // badlands
  [98, 128, 104], // wetland
];

/** Paper tone the map is graded toward (and unrevealed regions are filled with). */
export const PAPER: [number, number, number] = [222, 208, 172];

function sample(g: Float32Array, n: number, u: number, v: number): number {
  const i = Math.min(n - 2, Math.floor(u));
  const j = Math.min(n - 2, Math.floor(v));
  const fu = u - i;
  const fv = v - j;
  const a = g[j * n + i] + (g[j * n + i + 1] - g[j * n + i]) * fu;
  const b = g[(j + 1) * n + i] + (g[(j + 1) * n + i + 1] - g[(j + 1) * n + i]) * fu;
  return a + (b - a) * fv;
}

/** Draw the whole world's terrain at size x size pixels (north = up = -z). */
export function renderTerrain(ctx: Ctx, d: AtlasData, size: number): void {
  const img = ctx.createImageData(size, size);
  const n = d.gridN;
  const scale = (n - 1) / size;
  const paper = 0.22; // how far every colour leans toward the paper tone
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px * scale;
      const v = py * scale;
      const h = sample(d.height, n, u, v);
      const hx = sample(d.height, n, Math.min(n - 1, u + 0.5), v) - sample(d.height, n, Math.max(0, u - 0.5), v);
      const hz = sample(d.height, n, u, Math.min(n - 1, v + 0.5)) - sample(d.height, n, u, Math.max(0, v - 0.5));
      // Light from the north-west, as on paper maps.
      const shade = Math.max(0.55, Math.min(1.3, 1 + (-hx - hz) * 0.018));
      const k = Math.round(v) * n + Math.round(u);
      const flags = d.nodeParams[k * 4 + 3];
      const water = sample(d.water, n, u, v);
      let r: number, g: number, b: number;
      if ((flags & 3) !== 0 || h < d.seaY) {
        const depth = Math.max(0, Math.min(1, (Math.max(water, d.seaY) - h) / 60));
        r = 92 - 40 * depth;
        g = 146 - 46 * depth;
        b = 172 - 30 * depth;
      } else {
        const c = BIOME_RGB[d.biome[k]];
        const alt = Math.max(0, Math.min(1, (h - d.seaY) / 500));
        r = (c[0] * (1 - 0.2 * alt) + 60 * alt) * shade;
        g = (c[1] * (1 - 0.2 * alt) + 60 * alt) * shade;
        b = (c[2] * (1 - 0.2 * alt) + 60 * alt) * shade;
        // Contour every 40 m: a faint darker line where the band changes.
        const band = Math.floor((h - d.seaY) / 40);
        const bandR = Math.floor((sample(d.height, n, Math.min(n - 1, u + scale), v) - d.seaY) / 40);
        const bandD = Math.floor((sample(d.height, n, u, Math.min(n - 1, v + scale)) - d.seaY) / 40);
        if (band !== bandR || band !== bandD) {
          r *= 0.86;
          g *= 0.86;
          b *= 0.86;
        }
      }
      const o = (py * size + px) * 4;
      img.data[o] = r + (PAPER[0] - r) * paper;
      img.data[o + 1] = g + (PAPER[1] - g) * paper;
      img.data[o + 2] = b + (PAPER[2] - b) * paper;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Rivers.
  const s = size / d.worldSize;
  ctx.strokeStyle = 'rgb(84,138,170)';
  ctx.lineCap = 'round';
  const D8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  for (let k = 0; k < n * n; k++) {
    const w = d.river[k];
    if (!w || d.flow[k] === 255) continue;
    const [dx, dz] = D8[d.flow[k]];
    const i = k % n;
    const j = Math.floor(k / n);
    ctx.lineWidth = Math.max(1, w * s * 1.6);
    ctx.beginPath();
    ctx.moveTo(i * d.macroRes * s, j * d.macroRes * s);
    ctx.lineTo((i + dx) * d.macroRes * s, (j + dz) * d.macroRes * s);
    ctx.stroke();
  }
}

/** Glyph per site kind for the map and its legend. */
export function siteGlyph(s: Site): { color: string; shape: 'tower' | 'waypoint' | 'town' | 'cave' | 'struct' | 'star' | 'camp' } {
  if (s.kind === 'tower') return { color: '#c0392b', shape: 'tower' };
  if (s.kind === 'waypoint') return { color: '#1fb5d6', shape: 'waypoint' };
  if (s.category === 'settlement') return { color: '#f4ecd8', shape: 'town' };
  if (s.kind === 'cave_mouth') return { color: '#2b2b2b', shape: 'cave' };
  if (s.kind === 'landmark') return { color: '#e0b030', shape: 'star' };
  if (s.kind === 'enemy_camp') return { color: '#d35400', shape: 'camp' };
  return { color: '#8e7cc3', shape: 'struct' };
}
