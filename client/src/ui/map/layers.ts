// CR 038: the map's layers. The map shows one layer at a time (Sky,
// Surface, Underground, Depths; "auto" follows where you are): the surface
// is the paper map; the sky lays the archipelagos over a pale veil; the
// Underground and the Depths darken the land and draw their chambers,
// passages, rivers and openings from the vertical descriptor, like a
// surveyor's cave map. Sites show on their own layer only.

import { CHAMBER_KINDS, LAYER_DEPTHS, LAYER_SKY, LAYER_UNDER, type Site, type VerticalWorld } from '@lodestone/worldgen';

export type MapLayer = 0 | 1 | 2 | 3;
export const MAP_LAYER_NAMES = ['Surface', 'Sky', 'Underground', 'Depths'] as const;
/** Button order on the map (top to bottom: up to down). */
export const MAP_LAYER_ORDER: MapLayer[] = [1, 0, 2, 3];

type Ctx = CanvasRenderingContext2D;

const CHAMBER_FILL: Record<(typeof CHAMBER_KINDS)[number], string> = {
  crystal: 'rgba(92,120,230,0.85)',
  cenote: 'rgba(48,214,196,0.85)',
  river: 'rgba(52,150,200,0.85)',
  fungal: 'rgba(90,200,120,0.8)',
  inferno: 'rgba(232,96,36,0.9)',
  ashen: 'rgba(150,138,128,0.85)',
  dwarf_camp: 'rgba(214,150,70,0.9)',
  stronghold: 'rgba(230,170,60,0.9)',
  lower_halls: 'rgba(160,80,60,0.9)',
};

/** The layer a site belongs to (sites from before genVersion 3 are surface sites). */
export function siteLayer(s: Site): number {
  return s.layer ?? 0;
}

/**
 * Draw the overlay of `layer` over the surface map: nothing for the surface,
 * the archipelagos for the sky, chambers and passages underground.
 */
export function drawLayerOverlay(ctx: Ctx, v: VerticalWorld | null, layer: MapLayer, sx: (x: number) => number, sy: (z: number) => number, k: number, w: number, h: number, nameOf: (site: number) => string | null): void {
  if (!v || layer === 0) return;
  if (layer === LAYER_SKY) {
    ctx.fillStyle = 'rgba(230,238,250,0.42)';
    ctx.fillRect(0, 0, w, h);
    // Cloud banks under each archipelago, then the islands.
    for (const a of v.archs) {
      const g = ctx.createRadialGradient(sx(a.x), sy(a.z), 0, sx(a.x), sy(a.z), (a.r + 120) * k);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx(a.x), sy(a.z), (a.r + 120) * k, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const isl of v.islands) {
      ctx.fillStyle = isl.kind === 3 ? '#9cc46f' : isl.kind === 4 ? '#e9dcb0' : isl.kind === 2 ? '#9a9a8c' : '#7fb35a';
      ctx.strokeStyle = 'rgba(70,50,30,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const l of isl.lobes) {
        ctx.moveTo(sx(isl.x + l[0]) + l[2] * k, sy(isl.z + l[1]));
        ctx.arc(sx(isl.x + l[0]), sy(isl.z + l[1]), Math.max(1.5, l[2] * k), 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
    }
    // Wind: columns and sky lifts.
    for (const u of v.updrafts) {
      ctx.strokeStyle = u.kind === 1 ? 'rgba(40,190,200,0.95)' : 'rgba(120,140,170,0.8)';
      ctx.lineWidth = u.kind === 1 ? 2.5 : 1.5;
      ctx.beginPath();
      const r = Math.max(3, u.r * k);
      ctx.arc(sx(u.x), sy(u.z), r, 0.3, Math.PI * 1.7);
      ctx.stroke();
    }
    for (const a of v.archs) {
      const n = nameOf(a.site);
      if (!n || k < 0.12) continue;
      ctx.font = 'italic 600 13px Georgia, serif';
      ctx.fillStyle = 'rgba(40,50,80,0.85)';
      ctx.textAlign = 'center';
      ctx.fillText(n, sx(a.x), sy(a.z - a.r - 30));
    }
    return;
  }
  // Underground / Depths: the land darkens, the caverns are drawn.
  ctx.fillStyle = layer === LAYER_DEPTHS ? 'rgba(24,8,6,0.86)' : 'rgba(8,12,22,0.84)';
  ctx.fillRect(0, 0, w, h);
  for (const c of v.corridors) {
    if (c.layer !== layer) continue;
    ctx.strokeStyle = c.lava ? 'rgba(240,110,40,0.9)' : c.water > 0 ? 'rgba(60,170,210,0.9)' : layer === LAYER_DEPTHS ? 'rgba(150,90,70,0.85)' : 'rgba(150,160,190,0.8)';
    ctx.lineWidth = Math.max(1.5, c.hw * 2 * k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < c.pts.length / 3; i++) {
      const x = sx(c.pts[i * 3]);
      const y = sy(c.pts[i * 3 + 2]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (const c of v.chambers) {
    if (c.layer !== layer) continue;
    ctx.save();
    ctx.translate(sx(c.x), sy(c.z));
    ctx.rotate(Math.atan2(c.s, c.c));
    ctx.fillStyle = CHAMBER_FILL[CHAMBER_KINDS[c.kind] ?? 'crystal'];
    ctx.strokeStyle = 'rgba(220,230,255,0.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(2, c.rx * 0.95 * k), Math.max(2, c.rz * 0.95 * k), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (c.lake > -9000 && c.lakeE > 0) {
      ctx.fillStyle = layer === LAYER_DEPTHS ? 'rgba(255,160,40,0.9)' : 'rgba(120,255,240,0.75)';
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.max(1, c.rx * c.lakeE * k), Math.max(1, c.rz * c.lakeE * k), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    const n = nameOf(c.site);
    if (n && k > 0.15) {
      ctx.font = 'italic 600 12px Georgia, serif';
      ctx.fillStyle = 'rgba(225,235,255,0.92)';
      ctx.textAlign = 'center';
      ctx.fillText(n, sx(c.x), sy(c.z) - Math.max(c.rx, c.rz) * k - 6);
    }
  }
  for (const o of v.openings) {
    if (!((layer === LAYER_UNDER && (o.into === LAYER_UNDER || o.into === LAYER_DEPTHS)) || (layer === LAYER_DEPTHS && o.into === LAYER_DEPTHS))) continue;
    ctx.strokeStyle = o.kind === 2 ? '#ff5a1f' : o.kind === 1 ? '#fff6c0' : '#5ff0ff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sx(o.x), sy(o.z), Math.max(4, o.rMask * k), 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Is this site shown on `layer`'s map? Openings to a layer show on the layers they join. */
export function siteOnLayer(s: Site, layer: MapLayer): boolean {
  const l = siteLayer(s);
  if (l === layer) return true;
  // A tunnel entrance is on the surface and the doorway to the Underground; a Depths gate likewise one layer down.
  if (s.kind === 'tunnel' && layer === LAYER_UNDER) return true;
  if (s.kind === 'depths_gate' && layer === LAYER_DEPTHS) return true;
  if (s.kind === 'sky_lift' && layer === LAYER_SKY) return true;
  return false;
}
