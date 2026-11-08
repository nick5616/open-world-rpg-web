// 2D atlas preview: biomes with hillshade, sea and lakes, rivers, region
// grid with names, sites (towers, settlements to scale, structures, cave
// mouths, waypoints, landmarks, camps) and the spawn. Adapted from
// worldgen/debug/main.ts (renderBase/drawShape/draw), drawing into any 2D
// context so it runs on an OffscreenCanvas inside the preview worker.
import { BIOMES, SETTLEMENT_SIZES, type AtlasData, type Site } from '@lodestone/worldgen';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export const BIOME_RGB: [number, number, number][] = [
  [142, 181, 96], // meadow
  [58, 112, 62], // forest
  [140, 130, 104], // highlands
  [236, 240, 244], // snowpeak
  [196, 128, 74], // badlands
  [86, 120, 98], // wetland
];

type Shape = 'tri' | 'sq' | 'dia' | 'dot' | 'ring' | 'star' | 'x';
export const SITE_STYLE: Record<string, { color: string; shape: Shape; label: string }> = {
  tower: { color: '#ff3b3b', shape: 'tri', label: 'tower' },
  settlement: { color: '#ffffff', shape: 'sq', label: 'settlement' },
  cave_mouth: { color: '#111111', shape: 'dot', label: 'cave mouth' },
  waypoint: { color: '#38d9ff', shape: 'ring', label: 'waypoint' },
  landmark: { color: '#ffd23f', shape: 'star', label: 'landmark' },
  enemy_camp: { color: '#ff9f1c', shape: 'x', label: 'enemy camp' },
  ruin: { color: '#c9b79c', shape: 'dia', label: 'structure' },
  watchtower: { color: '#e07a5f', shape: 'dia', label: 'structure' },
  mineshaft: { color: '#8d6e63', shape: 'dia', label: 'structure' },
  shrine: { color: '#f2e8cf', shape: 'dia', label: 'structure' },
  bandit_camp: { color: '#ff6f59', shape: 'dia', label: 'structure' },
  wizard_tower: { color: '#b388ff', shape: 'dia', label: 'structure' },
  meteor_crater: { color: '#7c4dff', shape: 'dia', label: 'structure' },
  sunken_temple: { color: '#4dd0e1', shape: 'dia', label: 'structure' },
  demon_lair: { color: '#d50000', shape: 'dia', label: 'structure' },
};

function sample(g: Float32Array, n: number, u: number, v: number): number {
  const i = Math.min(n - 2, Math.floor(u));
  const j = Math.min(n - 2, Math.floor(v));
  const fu = u - i;
  const fv = v - j;
  const a = g[j * n + i] + (g[j * n + i + 1] - g[j * n + i]) * fu;
  const b = g[(j + 1) * n + i] + (g[(j + 1) * n + i + 1] - g[(j + 1) * n + i]) * fu;
  return a + (b - a) * fv;
}

function base(ctx: Ctx, d: AtlasData, size: number) {
  const img = ctx.createImageData(size, size);
  const n = d.gridN;
  const scale = (n - 1) / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px * scale;
      const v = py * scale;
      const h = sample(d.height, n, u, v);
      const hx = sample(d.height, n, Math.min(n - 1, u + 0.5), v) - sample(d.height, n, Math.max(0, u - 0.5), v);
      const hz = sample(d.height, n, u, Math.min(n - 1, v + 0.5)) - sample(d.height, n, u, Math.max(0, v - 0.5));
      // Light from the north-west.
      const shade = Math.max(0.45, Math.min(1.35, 1 + (-hx - hz) * 0.02));
      const k = Math.round(v) * n + Math.round(u);
      const flags = d.nodeParams[k * 4 + 3];
      const water = sample(d.water, n, u, v);
      let r: number, g: number, b: number;
      if ((flags & 3) !== 0 || h < d.seaY) {
        const depth = Math.max(0, Math.min(1, (Math.max(water, d.seaY) - h) / 60));
        r = 40 - 25 * depth;
        g = 110 - 50 * depth;
        b = 170 - 40 * depth;
        if (flags & 2) {
          r += 10;
          g += 20;
        }
      } else {
        const c = BIOME_RGB[d.biome[k]];
        const alt = Math.max(0, Math.min(1, (h - d.seaY) / 500));
        r = (c[0] * (1 - 0.2 * alt) + 51 * alt) * shade;
        g = (c[1] * (1 - 0.2 * alt) + 51 * alt) * shade;
        b = (c[2] * (1 - 0.2 * alt) + 51 * alt) * shade;
      }
      const o = (py * size + px) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawShape(ctx: Ctx, x: number, y: number, s: Site, px: number) {
  const style = SITE_STYLE[s.kind] ?? { color: '#fff', shape: 'dot' as Shape };
  const k = px / 1024; // shapes were tuned for a 1024 px map
  ctx.fillStyle = style.color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  switch (style.shape) {
    case 'tri':
      ctx.moveTo(x, y - 9 * k);
      ctx.lineTo(x + 7 * k, y + 6 * k);
      ctx.lineTo(x - 7 * k, y + 6 * k);
      ctx.closePath();
      break;
    case 'sq': {
      const r = Math.max(3, (s.radius / 4096) * px);
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    }
    case 'dia':
      ctx.moveTo(x, y - 6 * k);
      ctx.lineTo(x + 6 * k, y);
      ctx.lineTo(x, y + 6 * k);
      ctx.lineTo(x - 6 * k, y);
      ctx.closePath();
      break;
    case 'ring':
      ctx.arc(x, y, 5 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = '#003040';
      ctx.arc(x, y, 2 * k, 0, Math.PI * 2);
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rr = (i % 2 ? 3 : 7) * k;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.closePath();
      break;
    case 'x':
      ctx.moveTo(x - 5 * k, y - 5 * k);
      ctx.lineTo(x + 5 * k, y + 5 * k);
      ctx.moveTo(x + 5 * k, y - 5 * k);
      ctx.lineTo(x - 5 * k, y + 5 * k);
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 3;
      ctx.stroke();
      return;
    default:
      ctx.arc(x, y, 4 * k, 0, Math.PI * 2);
      ctx.strokeStyle = '#ddd';
  }
  ctx.fill();
  ctx.stroke();
}

/** Draw the whole preview at size x size pixels. */
export function renderAtlas(ctx: Ctx, d: AtlasData, size: number) {
  base(ctx, d, size);
  const s = size / d.worldSize;
  const n = d.gridN;
  // Rivers.
  ctx.strokeStyle = '#3d8fd6';
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
  // Region grid and names.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  const step = size / d.regionsPerEdge;
  for (let i = 1; i < d.regionsPerEdge; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (const r of d.regions) {
    const x = (r.index % d.regionsPerEdge) * step + 5;
    const y = Math.floor(r.index / d.regionsPerEdge) * step + 14;
    const label = `${r.name} · ${r.element}`;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 3, y - 11, ctx.measureText(label).width + 6, 15);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x, y);
  }
  // Sites: waypoints under structures under settlements under towers.
  const order = (st: Site) => (st.kind === 'tower' ? 3 : st.category === 'settlement' ? 2 : st.kind === 'waypoint' ? 0 : 1);
  for (const st of [...d.sites].sort((a, b) => order(a) - order(b))) drawShape(ctx, st.x * s, st.z * s, st, size);
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(d.spawn.x * s, d.spawn.z * s, 10, 0, Math.PI * 2);
  ctx.stroke();
  // Settlement names (towns and villages only, to keep the small map legible).
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const st of d.sites) {
    if (st.category !== 'settlement' || st.size < 1 || !st.name) continue;
    const x = st.x * s;
    const y = st.z * s + 16;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(st.name, x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(st.name, x, y);
  }
}

export interface PreviewStats {
  name: string;
  seed: string;
  atlasHash: string;
  atlasMs: number;
  bytes: number;
  seaY: number;
  peak: number;
  landFraction: number;
  coverage800: number;
  biomes: { name: string; pct: number }[];
  sites: number;
  counts: [string, number][];
  regions: { name: string; biome: string; element: string; element2: string; danger: number; settlements: number }[];
}

/** Summary numbers for the side panel. */
export function atlasStats(d: AtlasData, atlasHash: bigint, atlasMs: number): PreviewStats {
  const counts = new Map<string, number>();
  for (const st of d.sites) {
    const key = st.category === 'settlement' ? SETTLEMENT_SIZES[st.size] : st.category === 'structure' ? `structure: ${st.kind.replace('_', ' ')}` : st.kind.replace('_', ' ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const landByBiome = new Array(6).fill(0);
  let land = 0;
  for (let k = 0; k < d.gridN * d.gridN; k++) {
    if ((d.nodeParams[k * 4 + 3] & 1) === 0) {
      landByBiome[d.biome[k]]++;
      land++;
    }
  }
  return {
    name: d.spec.name,
    seed: d.spec.seed,
    atlasHash: atlasHash.toString(16).padStart(16, '0'),
    atlasMs,
    bytes: d.byteLength,
    seaY: d.seaY,
    peak: d.maxHeight,
    landFraction: d.params[23],
    coverage800: d.params[19],
    biomes: BIOMES.map((b, i) => ({ name: b, pct: land ? (100 * landByBiome[i]) / land : 0 })),
    sites: d.sites.length,
    counts: [...counts].sort((a, b) => a[0].localeCompare(b[0])),
    regions: d.regions.map((r) => ({ name: r.name, biome: r.biome, element: r.element, element2: r.element2, danger: r.danger, settlements: r.settlements })),
  };
}
