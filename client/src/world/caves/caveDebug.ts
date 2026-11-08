// window.__lodestoneCaves: debug handle for headless scripts (the cave walk
// and screenshot evidence) and the browser console. Debug builds only, like
// WP02's window.__lodestone.

import type { CaveGraph } from '@lodestone/worldgen';
import { caveRoute } from './autopilot';
import type { CaveManager } from './caveManager';

export const caveDebug: { manager: CaveManager | null; graph: CaveGraph | null } = { manager: null, graph: null };

export function installCaveDebug(m: CaveManager, graph: CaveGraph): void {
  caveDebug.manager = m;
  caveDebug.graph = graph;
  const handle = {
    info: () => m.debugInfo(),
    /** Every system: mouth opening, deepest chamber, depth reached. */
    systems: () =>
      graph.systems.map((s) => {
        const o = graph.openings[s.firstOpening];
        const d = graph.chambers[s.firstChamber + s.deepest];
        return { index: s.index, mouth: { x: o.x, y: o.y, z: o.z, yaw: o.yaw }, deepest: { x: d.x, y: d.floor, z: d.z, rx: d.rx }, maxDepth: s.maxDepth, chambers: s.chamberCount, veins: s.veinCount };
      }),
    /** The scripted route from in front of a mouth to the deepest chamber (waypoints, nav graph). */
    route: (si: number) => caveRoute(graph, si),
    /** Chambers of a system with their gem veins (screenshot spots). */
    chambers: (si: number) => {
      const s = graph.systems[si];
      const out = [];
      for (let k = 0; k < s.chamberCount; k++) {
        const c = graph.chambers[s.firstChamber + k];
        const gems = graph.veins.slice(s.firstVein, s.firstVein + s.veinCount).filter((v) => v.chamber === k && v.kind === 'gem').length;
        out.push({ k, x: c.x, y: c.floor, z: c.z, rx: c.rx, ry: c.ry, depth: c.depth, gems, flags: c.flags });
      }
      return out;
    },
    /** Veins of a system (x, y, z, normal, what it holds). */
    veins: (si: number) => {
      const s = graph.systems[si];
      return graph.veins.slice(s.firstVein, s.firstVein + s.veinCount).map((v) => ({ id: v.id.toString(), x: v.x, y: v.y, z: v.z, nx: v.nx, ny: v.ny, nz: v.nz, kind: v.kind, material: v.material, chamber: v.chamber, hp: v.hp }));
    },
    /** Swing at whatever is targeted (solo: local mining; online: Interact). */
    swing: () => m.debugSwing(),
  };
  (window as unknown as { __lodestoneCaves: typeof handle }).__lodestoneCaves = handle;
}
