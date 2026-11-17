// Signposts you can read (CR 052). The towns buffer already stands a post at
// every road fork (roads.ts) with blank boards; this layer
//   - writes the destination and distance on each of their arms, and
//   - stands exit posts (ours: post + stacked boards, one small mesh per
//     town, built the first time you come within EXIT_SHOW_M and hidden past
//     it) where each town road leaves the town,
// all placed client side from data the client has (placement.ts).
// Lettering is a small pool of canvas textures (LOD): only the posts within
// READ_M of the camera get one, a few slots per quality tier; each slot is
// one mesh of up to six quads (3 boards x 2 faces) and one draw call.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldRuntime } from '../core/runtime';
import { useQualityStore } from '../../stores/qualityStore';
import { distanceLabel, placeSignposts, type Signpost } from './placement';
import { layoutBoards, PLANK_HT, ROW_PX, TEX_H, TEX_W, type BoardLayout } from './boards';

/** Reading distance and the pool size by tier. */
export const READ_M = 38;
export const SLOTS_BY_TIER: Record<string, number> = { low: 3, medium: 5, high: 8, ultra: 8 };
/** Exit posts show within this range of the camera (their town's centre). */
const EXIT_SHOW_M = 650;
const EXIT_DROP_M = 900;

const WOOD_POST: [number, number, number] = [0.4, 0.3, 0.2];
const WOOD_PLANK: [number, number, number] = [0.62, 0.5, 0.34];

/** Plain data for placeSignposts from the towns buffer and the atlas' sites. */
export function placementInputOf(runtime: WorldRuntime) {
  const t = runtime.towns!;
  return {
    settlements: t.settlements.map((s) => ({ index: s.index, site: s.site, x: s.x, z: s.z, radius: s.radius })),
    roads: t.roads.map((r) => ({ index: r.index, from: r.from, to: r.to, cls: r.cls, width: r.width, points: r.points })),
    forks: t.signs.map((s) => ({ id: s.id.toString(), x: s.x, y: s.y, z: s.z, arms: s.arms })),
    sites: runtime.data.sites.map((s) => ({ index: s.index, category: s.category, kind: s.kind, name: s.name, x: s.x, z: s.z, layer: s.layer })),
  };
}

// ── The lettering ─────────────────────────────────────────────────────────

function drawRow(ctx: CanvasRenderingContext2D, row: number, name: string, dist: string, arrow: number): void {
  const y0 = row * ROW_PX;
  const g = ctx.createLinearGradient(0, y0, 0, y0 + ROW_PX);
  g.addColorStop(0, '#c4a173');
  g.addColorStop(0.5, '#b08d5f');
  g.addColorStop(1, '#9d7b50');
  ctx.fillStyle = g;
  ctx.fillRect(0, y0, TEX_W, ROW_PX);
  // grain
  ctx.strokeStyle = 'rgba(70,45,20,0.16)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    const yy = y0 + 8 + i * 11 + ((row * 7 + i * 3) % 5);
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.bezierCurveTo(TEX_W * 0.3, yy - 2, TEX_W * 0.6, yy + 3, TEX_W, yy);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(50,30,12,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(3, y0 + 3, TEX_W - 6, ROW_PX - 6);
  // arrow (as the reader of this face sees it)
  const cx = 44;
  const cy = y0 + ROW_PX / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(arrow);
  ctx.fillStyle = '#2a190b';
  ctx.beginPath();
  ctx.moveTo(0, -26);
  ctx.lineTo(17, -3);
  ctx.lineTo(6, -3);
  ctx.lineTo(6, 24);
  ctx.lineTo(-6, 24);
  ctx.lineTo(-6, -3);
  ctx.lineTo(-17, -3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // words: carved, dark with a light lip
  const distW = 118;
  let size = 40;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const room = TEX_W - 82 - distW - 14;
  for (; size > 22; size -= 2) {
    ctx.font = `700 ${size}px Georgia, 'Times New Roman', serif`;
    if (ctx.measureText(name).width <= room) break;
  }
  const ty = cy + 2;
  ctx.fillStyle = 'rgba(255,236,200,0.35)';
  ctx.fillText(name, 83, ty + 1.5);
  ctx.fillStyle = '#2a190b';
  ctx.fillText(name, 82, ty);
  ctx.font = "700 34px Georgia, 'Times New Roman', serif";
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,236,200,0.35)';
  ctx.fillText(dist, TEX_W - 15, ty + 1.5);
  ctx.fillStyle = '#2a190b';
  ctx.fillText(dist, TEX_W - 16, ty);
}

export function renderLabels(ctx: CanvasRenderingContext2D, p: Signpost, layout: BoardLayout[]): void {
  ctx.clearRect(0, 0, TEX_W, TEX_H);
  for (const b of layout) {
    const sb = p.boards[b.board];
    for (const f of b.faces) drawRow(ctx, f.row, sb.name, distanceLabel(sb.dist), f.arrow);
  }
}

// ── Slot meshes ───────────────────────────────────────────────────────────

interface Slot {
  mesh: THREE.Mesh;
  tex: THREE.CanvasTexture;
  ctx: CanvasRenderingContext2D;
  geo: THREE.BufferGeometry;
  post: number; // index in posts, -1 free
  mat: THREE.MeshLambertMaterial;
}

function makeSlot(): Slot {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(24 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(24 * 2), 2).setUsage(THREE.DynamicDrawUsage));
  const idx: number[] = [];
  for (let q = 0; q < 6; q++) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
  geo.setIndex(idx);
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.name = 'signpost-labels';
  return { mesh, tex, ctx, geo, post: -1, mat };
}

function fillSlot(s: Slot, p: Signpost, footY: number): void {
  const layout = layoutBoards(p, footY);
  renderLabels(s.ctx, p, layout);
  s.tex.needsUpdate = true;
  const pos = s.geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = s.geo.getAttribute('normal') as THREE.BufferAttribute;
  const uv = s.geo.getAttribute('uv') as THREE.BufferAttribute;
  let q = 0;
  for (const b of layout) {
    for (const f of b.faces) {
      const v1 = 1 - ((f.row + 1) * ROW_PX) / TEX_H;
      const v0 = 1 - (f.row * ROW_PX) / TEX_H;
      const us = [0, 1, 1, 0];
      const vs = [v1, v1, v0, v0];
      for (let k = 0; k < 4; k++) {
        const i = q * 4 + k;
        pos.setXYZ(i, f.c[k][0], f.c[k][1], f.c[k][2]);
        nor.setXYZ(i, f.nx, 0, f.nz);
        uv.setXY(i, us[k], vs[k]);
      }
      q++;
    }
  }
  s.geo.setDrawRange(0, q * 6);
  pos.needsUpdate = nor.needsUpdate = uv.needsUpdate = true;
  s.mesh.visible = q > 0;
}

// ── Exit posts ────────────────────────────────────────────────────────────

class Soup {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** An axis-aligned-in-its-own-frame box: centre, axis (x, z) of its length, half sizes (length, height, thickness). */
  box(cx: number, cy: number, cz: number, ax: number, az: number, hl: number, hh: number, ht: number, color: [number, number, number]): void {
    // local axes: l = (ax, 0, az), u = up, n = (-az, 0, ax)
    const l: [number, number, number] = [ax, 0, az];
    const n: [number, number, number] = [-az, 0, ax];
    const u: [number, number, number] = [0, 1, 0];
    const faces: { nrm: [number, number, number]; a: [number, number, number]; b: [number, number, number]; ha: number; hb: number; hn: number }[] = [
      { nrm: n, a: l, b: u, ha: hl, hb: hh, hn: ht },
      { nrm: [-n[0], 0, -n[2]], a: [-l[0], 0, -l[2]], b: u, ha: hl, hb: hh, hn: ht },
      { nrm: l, a: [-n[0], 0, -n[2]], b: u, ha: ht, hb: hh, hn: hl },
      { nrm: [-l[0], 0, -l[2]], a: n, b: u, ha: ht, hb: hh, hn: hl },
      { nrm: u, a: n, b: l, ha: ht, hb: hl, hn: hh },
      { nrm: [0, -1, 0], a: l, b: n, ha: hl, hb: ht, hn: hh },
    ];
    for (const f of faces) {
      const base = this.pos.length / 3;
      const mx = cx + f.nrm[0] * f.hn;
      const my = cy + f.nrm[1] * f.hn;
      const mz = cz + f.nrm[2] * f.hn;
      for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        this.pos.push(mx + f.a[0] * f.ha * sa + f.b[0] * f.hb * sb, my + f.a[1] * f.ha * sa + f.b[1] * f.hb * sb, mz + f.a[2] * f.ha * sa + f.b[2] * f.hb * sb);
        this.nor.push(...f.nrm);
        this.col.push(...color);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

/** Geometry of one exit post: the post, a cap and a plank per board (both sides lettered by the slot mesh when near). */
export function exitPostSoup(soup: Soup, p: Signpost, footY: number): void {
  soup.box(p.x, footY + 1.5, p.z, 1, 0, 0.09, 1.6, 0.09, WOOD_POST);
  soup.box(p.x, footY + 3.18, p.z, 1, 0, 0.14, 0.04, 0.14, WOOD_POST);
  for (const b of layoutBoards(p, footY)) soup.box(b.cx, b.cy, b.cz, b.ax, b.az, b.hl, b.hh, PLANK_HT, WOOD_PLANK);
  // a few stones at the foot
  soup.box(p.x + 0.3, footY + 0.12, p.z + 0.2, 1, 0, 0.22, 0.14, 0.18, [0.55, 0.53, 0.5]);
  soup.box(p.x - 0.28, footY + 0.08, p.z - 0.2, 0.7, 0.7, 0.18, 0.1, 0.16, [0.5, 0.48, 0.45]);
}

export function SignpostLayer({ runtime }: { runtime: WorldRuntime }) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const posts = useMemo<Signpost[]>(() => {
    if (!runtime.towns) return [];
    try {
      return placeSignposts(placementInputOf(runtime));
    } catch (err) {
      console.warn('[signposts] placement failed', err);
      return [];
    }
  }, [runtime]);
  const world = useMemo(() => {
    const root = new THREE.Group();
    root.name = 'signposts';
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const slots: Slot[] = [];
    const foot = posts.map((p) => (p.kind === 'fork' ? p.y : runtime.terrainGround.heightAt(p.x, p.z)));
    const byTown = new Map<number, number[]>();
    posts.forEach((p, i) => {
      if (p.kind !== 'exit') return;
      const l = byTown.get(p.settlement);
      if (l) l.push(i);
      else byTown.set(p.settlement, [i]);
    });
    const towns = new Map<number, THREE.Mesh | null>();
    return { root, mat, slots, foot, byTown, towns, acc: 0, near: [] as number[] };
  }, [posts, runtime]);

  useEffect(() => {
    scene.add(world.root);
    return () => {
      scene.remove(world.root);
      for (const m of world.towns.values()) m?.geometry.dispose();
      for (const s of world.slots) {
        s.tex.dispose();
        s.geo.dispose();
        s.mat.dispose();
      }
      world.mat.dispose();
    };
  }, [scene, world]);

  useFrame((_, dt) => {
    if (!posts.length) return;
    world.acc += dt;
    if (world.acc < 0.35) return;
    world.acc = 0;
    const cx = camera.position.x;
    const cz = camera.position.z;
    const towns = runtime.towns!.settlements;
    // Exit post meshes: built lazily per town, hidden past EXIT_DROP_M.
    for (const [ti, list] of world.byTown) {
      const s = towns[ti];
      const d = Math.hypot(s.x - cx, s.z - cz);
      let m = world.towns.get(ti);
      if (m === undefined && d < EXIT_SHOW_M) {
        const soup = new Soup();
        for (const pi of list) exitPostSoup(soup, posts[pi], world.foot[pi]);
        m = new THREE.Mesh(soup.geometry(), world.mat);
        m.castShadow = m.receiveShadow = true;
        m.name = `signposts ${ti}`;
        world.root.add(m);
        world.towns.set(ti, m);
      }
      if (m) m.visible = d < EXIT_DROP_M;
    }
    // Lettering slots: the nearest posts within reading range.
    const tier = useQualityStore.getState().tier;
    const want = SLOTS_BY_TIER[tier] ?? 5;
    const near: { i: number; d: number }[] = [];
    posts.forEach((p, i) => {
      const d = Math.hypot(p.x - cx, p.z - cz);
      if (d > READ_M) return;
      // An exit post is only there once its town's mesh is.
      if (p.kind === 'exit' && !world.towns.get(p.settlement)?.visible) return;
      near.push({ i, d });
    });
    near.sort((a, b) => a.d - b.d || a.i - b.i);
    const chosen = near.slice(0, want).map((n) => n.i);
    while (world.slots.length < chosen.length && world.slots.length < want) {
      const s = makeSlot();
      world.slots.push(s);
      world.root.add(s.mesh);
    }
    // Keep posts that already hold a slot, give free slots to the rest (one canvas render per tick).
    const held = new Set<number>();
    for (const s of world.slots) {
      if (s.post >= 0 && chosen.includes(s.post)) held.add(s.post);
      else if (s.post >= 0) {
        s.post = -1;
        s.mesh.visible = false;
      }
    }
    let filled = 0;
    for (const pi of chosen) {
      if (held.has(pi) || filled >= 2) continue;
      const s = world.slots.find((x) => x.post < 0);
      if (!s) break;
      s.post = pi;
      fillSlot(s, posts[pi], world.foot[pi]);
      filled++;
    }
  });

  return null;
}
