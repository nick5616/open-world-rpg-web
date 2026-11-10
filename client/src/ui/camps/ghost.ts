// The placement ghost (playtest 2 camps, CR 025): where the piece would go
// this frame and whether the zone would take it. CampLayer recomputes it
// every frame while placing (and draws it green or red); CampHud's click
// sends exactly this spot. The rules are placement.ts (a mirror of the
// zone's); the world comes from the loaded runtime (terrain, water,
// settlements, the towns collision boxes).

import { CAMPS } from '@lodestone/contracts';
import { localPlayer } from '../../state/live';
import { worldDebug } from '../../world/debug/worldDebug';
import { useInventory } from '../inventory/store';
import { checkPlacement, ghostSpot, overlaps, radius, type Footprint, type PlaceEnv, type Placed } from './placement';
import { useCamps } from './store';

const BOX_WALK = 1;
const BOX_SOLID = 2;

export interface Ghost {
  active: boolean;
  kind: number;
  rot: number;
  x: number;
  y: number;
  z: number;
  reason: number;
}

export const campGhost: Ghost = { active: false, kind: 0, rot: 0, x: 0, y: 0, z: 0, reason: 0 };

/** The world as the placement rules see it, from the loaded runtime (null before it loads). */
export function runtimeEnv(): PlaceEnv | null {
  const rt = worldDebug.runtime;
  if (!rt) return null;
  const g = rt.ground;
  const towns = rt.towns;
  const col = rt.townCollision;
  return {
    heightAt: (x, z) => g.heightAt(x, z),
    waterAt: (x, z) => (g.waterAt ? g.waterAt(x, z) : -Infinity),
    inTown: (x, z, m) => !!towns?.settlements.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + m),
    structure: (f: Footprint) => {
      if (!towns || !col) return false;
      const b = towns.boxes;
      const y = g.heightAt(f.x, f.z);
      for (const i of col.candidates(f.x, f.z, radius(f) + 1)) {
        if ((b.flags[i] & (BOX_WALK | BOX_SOLID)) === 0) continue;
        const o = i * 9;
        const top = Math.max(b.f[o + 7], b.f[o + 8]);
        if (top < y - 0.3 || b.f[o + 6] > y + 2.6) continue;
        if (overlaps(f, { x: b.f[o], z: b.f[o + 1], c: b.f[o + 2], s: b.f[o + 3], hx: b.f[o + 4], hz: b.f[o + 5] }, 0.1)) return true;
      }
      return false;
    },
  };
}

export function kitCount(kind: number): number {
  const kit = CAMPS.pieces[kind - 1]?.kit;
  let n = 0;
  for (const it of useInventory.getState().inv?.items ?? []) if (it.b === kit) n += it.q;
  return n;
}

/** Recompute the ghost from the placement mode, the player and the world. */
export function updateGhost(): Ghost {
  const s = useCamps.getState();
  const pl = s.placing;
  const env = runtimeEnv();
  if (!pl || !env) {
    campGhost.active = false;
    return campGhost;
  }
  const p = localPlayer.pos;
  const def = CAMPS.pieces[pl.kind - 1];
  const dist = Math.max(pl.dist, Math.hypot(def.w, def.d) / 2 + 1);
  const { x, z } = ghostSpot(p.x, p.z, localPlayer.yaw, dist);
  const near: Placed[] = Object.values(s.pieces)
    .filter((q) => q.mine || Math.hypot(q.x - x, q.z - z) < CAMPS.limits.campRadiusM * 2 + CAMPS.placement.otherCampM + 4)
    .map((q) => ({ id: q.id, kind: q.kind, rot: q.rot, x: q.x, z: q.z, mine: q.mine }));
  const r = checkPlacement({ kind: pl.kind, rot: pl.rot, x, z, feetX: p.x, feetY: p.y, feetZ: p.z, kits: kitCount(pl.kind) }, near, env);
  campGhost.active = true;
  campGhost.kind = pl.kind;
  campGhost.rot = pl.rot;
  campGhost.x = x;
  campGhost.z = z;
  campGhost.y = r.reason === 0 ? r.y : env.heightAt(x, z);
  campGhost.reason = r.reason;
  return campGhost;
}
