// window.__lodestoneDiegetic (debug builds): what the diegetic layers decided,
// for headless scripts (world/guide/dev/diegetic-shots.ts) and the console.

import type { Signpost } from './signposts/placement';
import type { RoadGraph, Route, WispState } from './guide/route';

export const diegeticDebug = {
  posts: [] as Signpost[],
  graph: null as RoadGraph | null,
  wisp: null as { active: boolean; route: Route | null; w: WispState | null } | null,
  /** The wisp's head in the world, and how many Points are visible. */
  head: { x: 0, y: 0, z: 0, visible: false },
  landmarks: null as Record<string, number> | null,
  /** Heights at the posts (exit posts sample the terrain). */
  foot: [] as number[],
};

export function installDiegeticDebug(): () => void {
  const handle = {
    posts: () => diegeticDebug.posts.map((p, i) => ({ id: p.id, kind: p.kind, x: p.x, z: p.z, y: diegeticDebug.foot[i], boards: p.boards.map((b) => `${b.name} ${Math.round(b.dist)} m`) })),
    wisp: () => {
      const d = diegeticDebug.wisp;
      return d && { active: d.active, usesRoad: d.route?.usesRoad ?? null, length: d.route?.length ?? null, s: d.w?.s ?? null, ps: d.w?.ps ?? null, alpha: d.w?.alpha ?? null, mode: d.w?.mode ?? null, waiting: d.w?.waiting ?? null };
    },
    head: () => ({ ...diegeticDebug.head }),
    landmarks: () => diegeticDebug.landmarks,
    roadNodes: () => diegeticDebug.graph?.count ?? 0,
  };
  (window as unknown as { __lodestoneDiegetic: typeof handle }).__lodestoneDiegetic = handle;
  return () => {
    delete (window as unknown as { __lodestoneDiegetic?: unknown }).__lodestoneDiegetic;
  };
}
