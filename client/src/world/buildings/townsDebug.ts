// window.__lodestoneTowns: debug handle for headless scripts (townBench.mjs)
// and the browser console. Debug builds only, like window.__lodestoneWorld.

import { BUILDING_ROLES, BUILDING_STYLES, NPC_ROLES, SETTLEMENT_SIZES, TOWN_STRUCTURE_KINDS } from '@lodestone/worldgen';
import { DEBUG } from '../../config';
import { useDebugStore } from '../../stores/debugStore';
import { frameInfo } from '../debug/worldDebug';
import { boxAt, BK } from './kit';
import type { TownsManager } from './townsManager';

export function installTownsDebug(m: TownsManager): () => void {
  if (!DEBUG || typeof window === 'undefined') return () => {};
  const t = m.towns;
  const sites = m.runtime.data.sites;
  const handle = {
    settlements: () =>
      t.settlements.map((s) => ({ index: s.index, name: sites[s.site]?.name ?? '', size: SETTLEMENT_SIZES[s.size], style: BUILDING_STYLES[s.style], walled: s.walled, x: s.x, y: s.y, z: s.z, radius: s.radius, square: s.square, buildings: s.buildingCount, npcs: s.npcCount })),
    /** The biggest town: size 2 with the most buildings (falls back to the biggest settlement). */
    largestTown: () => [...t.settlements].sort((a, b) => b.size - a.size || b.buildingCount - a.buildingCount)[0]?.index ?? -1,
    structures: () => t.structures.map((s) => ({ index: s.index, id: s.id.toString(), kind: TOWN_STRUCTURE_KINDS[s.kind], tier: s.tier, x: s.x, y: s.y, z: s.z, radius: s.radius, link: s.link, pieces: s.pieceCount })),
    buildings: (si: number) => {
      const s = t.settlements[si];
      return t.buildings.slice(s.buildingFirst, s.buildingFirst + s.buildingCount).map((b) => ({ index: b.index, role: BUILDING_ROLES[b.role], style: BUILDING_STYLES[b.style], x: b.x, z: b.z, floorY: b.floorY, hx: b.hx, hz: b.hz, c: b.c, s: b.s, floors: b.floors, doorU: b.doorU, doorW: b.doorW, frontX: b.frontX, frontZ: b.frontZ, flags: b.flags }));
    },
    /** Blocking boxes of a settlement (walls, town wall, gates, fences, props), [cx, cz, c, s, hx, hz] each: headless walkers plan around them. */
    solids: (si: number) => {
      const s = t.settlements[si];
      const out: number[][] = [];
      for (let i = s.boxFirst; i < s.boxFirst + s.boxCount; i++) {
        const b = boxAt(t, i);
        if (b.kind === BK.wall || b.kind === BK.townWall || b.kind === BK.gate || b.kind === BK.fence || b.kind === BK.townProp || b.kind === BK.railing || b.kind === BK.piece) out.push([b.cx, b.cz, b.c, b.s, b.hx, b.hz]);
      }
      return out;
    },
    npcs: (si: number) =>
      t.npcs.filter((n) => n.settlement === si).map((n) => ({ index: n.index, name: n.name, role: NPC_ROLES[n.role], x: n.workX, z: n.workZ, yaw: n.workYaw, workProp: n.workProp })),
    props: (si: number, kind: number) => {
      const s = t.settlements[si];
      return t.props.slice(s.propFirst, s.propFirst + s.propCount).filter((p) => p.kind === kind).map((p) => ({ index: p.index, id: p.id.toString(), x: p.x, y: p.y, z: p.z, yaw: p.yaw, building: p.building }));
    },
    bridges: () => t.bridges.map((b) => ({ index: b.index, ax: b.ax, az: b.az, bx: b.bx, bz: b.bz, deckY: b.deckY, waterY: b.waterY, style: b.style, width: b.width })),
    signs: () => t.signs.map((s, i) => ({ index: i, x: s.x, y: s.y, z: s.z, arms: s.arms })),
    /** Teleport the solo player (the debug teleport the world section uses). y omitted: onto the ground. */
    teleportTo: (index: number, opts: { kind?: 'settlement' | 'structure'; dx?: number; dz?: number; y?: number } = {}) => {
      const s = opts.kind === 'structure' ? t.structures[index] : t.settlements[index];
      if (!s) return null;
      const target = { x: s.x + (opts.dx ?? 0), z: s.z + (opts.dz ?? 0), ...(opts.y !== undefined ? { y: opts.y } : {}) };
      useDebugStore.getState().teleport(target);
      return target;
    },
    stats: () => ({ ...m.stats, frame: { ...frameInfo }, townTris: m.triangles() }),
    idle: () => m.idle(),
    target: () => {
      const c = m.hud.target;
      return c ? { kind: c.kind, name: c.name, role: c.role, entityId: c.entityId, stableId: c.stableId.toString() } : null;
    },
    /** Press E on the current target (solo: the offline panel; online: Interact). */
    interact: () => {
      if (m.hud.target) m.hud.act(m.hud.target);
      return m.hud.lastAction;
    },
    panel: () => m.hud.debugPanel(),
    closePanel: () => m.hud.close(),
    showBoxes: (v: boolean) => {
      m.showBoxes = v;
    },
    /** A settlement's streets (polylines x, y, z, ...). */
    streets: (si: number) => {
      const s = t.settlements[si];
      return t.roads.slice(s.roadFirst, s.roadFirst + s.roadCount).map((r) => ({ index: r.index, width: r.width, points: Array.from(r.points) }));
    },
    /** Hide/show the whole towns layer (draw-call comparisons with and without it). */
    setVisible: (v: boolean) => {
      m.group.visible = v;
    },
    /** Meshes of the towns layer in the scene (name, triangles, visible). */
    meshes: () => {
      const out: { name: string; tris: number; visible: boolean; type: string }[] = [];
      m.group.traverse((o) => {
        const mesh = o as unknown as { isMesh?: boolean; visible: boolean; name: string; type: string; geometry?: { index: { count: number } | null; attributes: { position: { count: number } } } };
        if (mesh.isMesh && mesh.geometry) out.push({ name: mesh.name, type: mesh.type, visible: mesh.visible, tris: (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3 });
      });
      return out;
    },
    /** Building doors: a settlement's doors (index, building, role, position, yaw, open now). */
    doors: (si: number) => {
      const ds = m.doorSync;
      if (!ds) return [];
      return ds.doors.doors.filter((d) => d.settlement === si).map((d) => ({ index: d.index, id: d.id.toString(), building: d.building, role: BUILDING_ROLES[t.buildings[d.building].role], x: d.x, y: d.y, z: d.z, yaw: d.yaw, width: d.width, thick: d.thick, open: ds.isOpen(d.index), visual: m.doorLeaves?.open[d.index] ?? 1 }));
    },
    /** E on door d (Interact 34 online, local offline). */
    toggleDoor: (d: number) => m.doorSync?.toggle(d),
    doorStats: () => (m.doorSync ? { ...m.doorSync.stats, active: m.doorSync.states.active, leaves: m.doorLeaves?.mesh.count ?? 0, online: m.doorSync.online } : null),
    visibleNpcs: () => m.npcs.views.map((v) => ({ name: v.name, role: v.role, x: v.x, y: v.y, z: v.z, entityId: v.entityId })),
  };
  (window as unknown as { __lodestoneTowns: typeof handle }).__lodestoneTowns = handle;
  return () => {
    delete (window as unknown as { __lodestoneTowns?: unknown }).__lodestoneTowns;
  };
}
