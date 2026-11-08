// Worldgen debug map: renders an atlas as a 2D map (biomes with hillshade,
// water, rivers, sites, region grid, 800 m coverage) and, on click, one
// detail chunk. For eyeballing only; nothing here ships.
import { BIOMES, SETTLEMENT_SIZES, loadWorldgen, type AtlasData, type AtlasHandle, type Site } from '../js/src/index';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const map = $<HTMLCanvasElement>('map');
const ctx = map.getContext('2d')!;
const SIZE = 1024;

const BIOME_RGB: [number, number, number][] = [
  [142, 181, 96], // meadow
  [58, 112, 62], // forest
  [140, 130, 104], // highlands
  [236, 240, 244], // snowpeak
  [196, 128, 74], // badlands
  [86, 120, 98], // wetland
];
const SITE_STYLE: Record<string, { color: string; shape: 'tri' | 'sq' | 'dia' | 'dot' | 'ring' | 'star' | 'x' }> = {
  tower: { color: '#ff3b3b', shape: 'tri' },
  settlement: { color: '#ffffff', shape: 'sq' },
  cave_mouth: { color: '#111111', shape: 'dot' },
  waypoint: { color: '#38d9ff', shape: 'ring' },
  landmark: { color: '#ffd23f', shape: 'star' },
  enemy_camp: { color: '#ff9f1c', shape: 'x' },
  ruin: { color: '#c9b79c', shape: 'dia' },
  watchtower: { color: '#e07a5f', shape: 'dia' },
  mineshaft: { color: '#8d6e63', shape: 'dia' },
  shrine: { color: '#f2e8cf', shape: 'dia' },
  bandit_camp: { color: '#ff6f59', shape: 'dia' },
  wizard_tower: { color: '#b388ff', shape: 'dia' },
  meteor_crater: { color: '#7c4dff', shape: 'dia' },
  sunken_temple: { color: '#4dd0e1', shape: 'dia' },
  demon_lair: { color: '#d50000', shape: 'dia' },
};

const wasm = await (await fetch('/pkg/worldgen.wasm')).arrayBuffer();
const wg = await loadWorldgen(wasm);
let atlas: AtlasHandle | null = null;
let data: AtlasData | null = null;
let base: ImageData | null = null;

function sample(g: Float32Array | Uint8Array, n: number, u: number, v: number): number {
  const i = Math.min(n - 2, Math.floor(u));
  const j = Math.min(n - 2, Math.floor(v));
  const fu = u - i;
  const fv = v - j;
  const a = g[j * n + i] + (g[j * n + i + 1] - g[j * n + i]) * fu;
  const b = g[(j + 1) * n + i] + (g[(j + 1) * n + i + 1] - g[(j + 1) * n + i]) * fu;
  return a + (b - a) * fv;
}

function renderBase(d: AtlasData, biomes: boolean, cover: boolean): ImageData {
  const img = ctx.createImageData(SIZE, SIZE);
  const n = d.gridN;
  const scale = (n - 1) / SIZE;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
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
        const bi = d.biome[k];
        let c = biomes ? BIOME_RGB[bi] : [150, 150, 150];
        const alt = Math.max(0, Math.min(1, (h - d.seaY) / 500));
        c = [c[0] * (1 - 0.2 * alt) + 255 * 0.2 * alt, c[1] * (1 - 0.2 * alt) + 255 * 0.2 * alt, c[2] * (1 - 0.2 * alt) + 255 * 0.2 * alt];
        r = c[0] * shade;
        g = c[1] * shade;
        b = c[2] * shade;
        if (cover && d.coverage[k] === 0 && (flags & 1) === 0) {
          r = 255;
          g = 0;
          b = 200;
        }
      }
      const o = (py * SIZE + px) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  return img;
}

function drawShape(x: number, y: number, s: Site) {
  const style = SITE_STYLE[s.kind] ?? { color: '#fff', shape: 'dot' };
  ctx.fillStyle = style.color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  switch (style.shape) {
    case 'tri':
      ctx.moveTo(x, y - 9);
      ctx.lineTo(x + 7, y + 6);
      ctx.lineTo(x - 7, y + 6);
      ctx.closePath();
      break;
    case 'sq': {
      const r = Math.max(4, (s.radius / 4096) * SIZE);
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    }
    case 'dia':
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.closePath();
      break;
    case 'ring':
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = '#003040';
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 ? 3 : 7;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.closePath();
      break;
    case 'x':
      ctx.moveTo(x - 5, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5);
      ctx.lineTo(x - 5, y + 5);
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 3;
      ctx.stroke();
      return;
    default:
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#ddd';
  }
  ctx.fill();
  ctx.stroke();
}

function draw() {
  if (!data || !base) return;
  const d = data;
  ctx.putImageData(base, 0, 0);
  const s = SIZE / d.worldSize;
  const n = d.gridN;
  if ($<HTMLInputElement>('l-rivers').checked) {
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
  }
  if ($<HTMLInputElement>('l-regions').checked) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    const step = SIZE / d.regionsPerEdge;
    for (let i = 1; i < d.regionsPerEdge; i++) {
      ctx.beginPath();
      ctx.moveTo(i * step, 0);
      ctx.lineTo(i * step, SIZE);
      ctx.moveTo(0, i * step);
      ctx.lineTo(SIZE, i * step);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'left';
    for (const r of d.regions) {
      const x = (r.index % d.regionsPerEdge) * step + 6;
      const y = Math.floor(r.index / d.regionsPerEdge) * step + 14;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const label = `${r.name} · ${r.element}/${r.element2} · d${r.danger.toFixed(2)}`;
      ctx.fillRect(x - 3, y - 11, ctx.measureText(label).width + 6, 15);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x, y);
    }
  }
  if ($<HTMLInputElement>('l-sites').checked) {
    const order = (st: Site) => (st.kind === 'tower' ? 3 : st.category === 'settlement' ? 2 : st.kind === 'waypoint' ? 0 : 1);
    for (const st of [...d.sites].sort((a, b) => order(a) - order(b))) drawShape(st.x * s, st.z * s, st);
    // Spawn marker.
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(d.spawn.x * s, d.spawn.z * s, 12, 0, Math.PI * 2);
    ctx.stroke();
  }
  if ($<HTMLInputElement>('l-labels').checked) {
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    for (const st of d.sites) {
      if (!(st.category === 'settlement' || st.kind === 'tower') || !st.name) continue;
      const x = st.x * s;
      const y = st.z * s + 18;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(st.name, x, y);
      ctx.fillStyle = st.kind === 'tower' ? '#ffb3b3' : '#fff';
      ctx.fillText(st.name, x, y);
    }
  }
}

function sidebar(d: AtlasData, atlasMs: number, bytes: number) {
  const counts = new Map<string, number>();
  for (const st of d.sites) {
    const key = st.category === 'settlement' ? `settlement (${SETTLEMENT_SIZES[st.size]})` : st.kind;
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
  $('world').innerHTML = `<h2>${d.spec.name}</h2>
    <table>
      <tr><td>seed</td><td class="n">${d.seed}</td></tr>
      <tr><td>grammar / palette</td><td class="n">${d.spec.nameGrammar} / ${d.spec.palette}</td></tr>
      <tr><td>atlas</td><td class="n">${(bytes / 1024).toFixed(0)} KiB, ${atlasMs.toFixed(0)} ms</td></tr>
      <tr><td>sea level / peak</td><td class="n">${d.seaY.toFixed(1)} m / ${d.maxHeight.toFixed(0)} m</td></tr>
      <tr><td>800 m POI coverage</td><td class="n">${(d.params[19] * 100).toFixed(1)}%</td></tr>
      <tr><td>sites</td><td class="n">${d.sites.length}</td></tr>
      ${[...counts].sort().map(([k, v]) => `<tr><td>&nbsp;&nbsp;${k}</td><td class="n">${v}</td></tr>`).join('')}
    </table>`;
  $('legend').innerHTML =
    BIOMES.map((b, i) => `<div><span class="sw" style="background:rgb(${BIOME_RGB[i].join(',')})"></span>${b} <span style="color:#9aa0a8">${((100 * landByBiome[i]) / land).toFixed(1)}%</span></div>`).join('') +
    `<div style="margin-top:6px">${Object.entries(SITE_STYLE).map(([k, v]) => `<span style="margin-right:8px;white-space:nowrap"><span class="sw" style="background:${v.color}"></span>${k}</span>`).join(' ')}</div>
     <div style="margin-top:4px;color:#9aa0a8">green ring = spawn; magenta (coverage layer) = walkable land that sees no POI within 800 m</div>`;
  $('regions').innerHTML = `<table>${d.regions
    .map((r) => `<tr><td>${r.index}</td><td>${r.name}<br><span style="color:#9aa0a8">${r.biome}, ${r.element}/${r.element2}, ${r.settlements} settl.</span></td><td class="n">${r.danger.toFixed(2)}</td></tr>`)
    .join('')}</table>`;
}

const MOSAIC = 5; // chunks per side in the detail view
const MAT_RGB = [[96, 150, 60], [120, 92, 64], [128, 128, 128], [245, 245, 250], [214, 196, 140], [80, 70, 50]];
const LAYER_RGB = ['#000', '#0b3d0b', '#5a5a5a', '#2f6f2f', '#c8e6a0'];

/** Layer of a scatter record: top byte of the packed id (ids are a bijective mix). */
function unmix(z: bigint): bigint {
  const M = (1n << 64n) - 1n;
  z ^= (z >> 31n) ^ (z >> 62n);
  z = (z * 0x319642b2d24d8ec3n) & M;
  z ^= (z >> 27n) ^ (z >> 54n);
  z = (z * 0x96de1b173f119089n) & M;
  z ^= (z >> 30n) ^ (z >> 60n);
  return z;
}

/** Detail view: MOSAIC x MOSAIC LOD-0 chunks around (cx, cz) at 1 px per meter. */
function showChunk(cx: number, cz: number) {
  if (!atlas || !data) return;
  const c0x = Math.max(0, Math.min(64 - MOSAIC, cx - 2));
  const c0z = Math.max(0, Math.min(64 - MOSAIC, cz - 2));
  const W = MOSAIC * 64;
  const cv = $<HTMLCanvasElement>('chunk');
  cv.width = cv.height = W;
  const cc = cv.getContext('2d')!;
  const img = cc.createImageData(W, W);
  const ms: number[] = [];
  const marks: { x: number; z: number; color: string; size: number }[] = [];
  const counts = [0, 0, 0, 0, 0];
  let containers = 0;
  let spawns = 0;
  for (let gz = 0; gz < MOSAIC; gz++) {
    for (let gx = 0; gx < MOSAIC; gx++) {
      const t0 = performance.now();
      const c = wg.buildChunk(atlas, c0x + gx, c0z + gz, 0);
      ms.push(performance.now() - t0);
      for (let j = 0; j < 64; j++) {
        for (let i = 0; i < 64; i++) {
          const k = j * 65 + i;
          const w = [c.splatA[k * 4], c.splatA[k * 4 + 1], c.splatA[k * 4 + 2], c.splatA[k * 4 + 3], c.splatB[k * 4], c.splatB[k * 4 + 1]];
          let r = 0, g = 0, b = 0;
          w.forEach((wt, m) => {
            r += (MAT_RGB[m][0] * wt) / 255;
            g += (MAT_RGB[m][1] * wt) / 255;
            b += (MAT_RGB[m][2] * wt) / 255;
          });
          const hx = c.heights[k + 1] - c.heights[k];
          const hz = c.heights[k + 65] - c.heights[k];
          const sh = Math.max(0.35, Math.min(1.6, 1 + (-hx - hz) * 0.35));
          const depth = c.water[k] - c.heights[k];
          const o = ((gz * 64 + j) * W + gx * 64 + i) * 4;
          if (depth > 0) {
            const d = Math.min(1, depth / 4);
            img.data[o] = 60 - 30 * d;
            img.data[o + 1] = 130 - 50 * d;
            img.data[o + 2] = 190 - 30 * d;
          } else {
            img.data[o] = r * sh;
            img.data[o + 1] = g * sh;
            img.data[o + 2] = b * sh;
          }
          img.data[o + 3] = 255;
        }
      }
      for (let i = 0; i < c.scatter.count; i++) {
        const layer = Number(unmix(c.scatter.id(i)) >> 56n);
        counts[layer]++;
        if (layer === 4) continue;
        marks.push({ x: c.scatter.x(i) - c0x * 64, z: c.scatter.z(i) - c0z * 64, color: LAYER_RGB[layer], size: layer === 1 ? 3 : 2 });
      }
      for (let i = 0; i < c.containers.count; i++) marks.push({ x: c.containers.x(i) - c0x * 64, z: c.containers.z(i) - c0z * 64, color: '#ffd23f', size: 6 });
      for (let i = 0; i < c.spawns.count; i++) marks.push({ x: c.spawns.x(i) - c0x * 64, z: c.spawns.z(i) - c0z * 64, color: '#ff3b3b', size: 6 });
      containers += c.containers.count;
      spawns += c.spawns.count;
    }
  }
  cc.putImageData(img, 0, 0);
  for (const m of marks) {
    cc.fillStyle = m.color;
    cc.fillRect(m.x - m.size / 2, m.z - m.size / 2, m.size, m.size);
  }
  // Highlight the selected window on the main map.
  draw();
  const s = SIZE / data.worldSize;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.strokeRect(c0x * 64 * s, c0z * 64 * s, W * s, W * s);
  ms.sort((p, q) => p - q);
  $('chunkinfo').innerHTML = `chunks (${c0x}..${c0x + MOSAIC - 1}, ${c0z}..${c0z + MOSAIC - 1}), main thread: median ${ms[ms.length >> 1].toFixed(2)} ms, max ${ms[ms.length - 1].toFixed(2)} ms<br>
    trees ${counts[1]}, rocks ${counts[2]}, bushes ${counts[3]}, grass tufts ${counts[4]} (not drawn), containers ${containers}, spawn anchors ${spawns}<br>
    <span style="color:#9aa0a8">dark green = trees, light green = bushes, grey = rocks, yellow = containers, red = spawn anchors</span>`;
}

function generate(seed: string) {
  atlas?.free();
  const t0 = performance.now();
  atlas = wg.buildAtlas(wg.specFromSeed(seed));
  const atlasMs = performance.now() - t0;
  data = atlas.data;
  base = renderBase(data, $<HTMLInputElement>('l-biome').checked, $<HTMLInputElement>('l-cover').checked);
  sidebar(data, atlasMs, atlas.byteLength);
  draw();
  $('status').textContent = `atlas hash ${atlas.hash.toString(16).padStart(16, '0')}`;
  showChunk(Math.floor(data.spawn.x / 64), Math.floor(data.spawn.z / 64));
  document.body.dataset.ready = '1';
}

$('go').onclick = () => generate($<HTMLInputElement>('seed').value);
$('rnd').onclick = () => {
  const s = String(Math.floor(Math.random() * 2 ** 32));
  $<HTMLInputElement>('seed').value = s;
  generate(s);
};
for (const id of ['l-rivers', 'l-sites', 'l-labels', 'l-regions']) $(id).onchange = draw;
for (const id of ['l-biome', 'l-cover']) {
  $(id).onchange = () => {
    if (data) base = renderBase(data, $<HTMLInputElement>('l-biome').checked, $<HTMLInputElement>('l-cover').checked);
    draw();
  };
}
map.onclick = (e) => {
  if (!data) return;
  const r = map.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * data.worldSize;
  const z = ((e.clientY - r.top) / r.height) * data.worldSize;
  showChunk(Math.floor(x / 64), Math.floor(z / 64));
};

const params = new URLSearchParams(location.search);
if (params.get('seed')) $<HTMLInputElement>('seed').value = params.get('seed')!;
if (params.get('cover')) $<HTMLInputElement>('l-cover').checked = true;
generate($<HTMLInputElement>('seed').value);
