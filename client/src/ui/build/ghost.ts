// The build ghost, live (CR 041): where the piece in hand would go this
// frame, whether the rules take it and whether you can afford it. BuildLayer
// draws it every frame in build mode and BuildHud's click sends exactly this
// spot (Interact 90/1 with the height). The rules are rules.ts (a mirror of
// the zone's); the world is the loaded runtime; the aim is the view ray.

import { CAMPS } from '@lodestone/contracts';
import { localPlayer } from '../../state/live';
import { campRuntime } from '../camps/collide';
import { runtimeEnv } from '../camps/ghost';
import { BUILD_REFUSAL, type CampPiece } from '../camps/events';
import { useCamps } from '../camps/store';
import { useInventory } from '../inventory/store';
import { costLines, missing, missingText, type CostLine } from './defs';
import type { BP } from './geometry';
import { REFUSE, type BuildEnv } from './rules';
import { aimPiece, aimPoint, snap } from './snap';

export const EYE_M = 1.6;

export interface BuildGhost {
  active: boolean;
  kind: number;
  rot: number;
  /** cm */
  x: number;
  y: number;
  z: number;
  hasY: boolean;
  /** The rules' refusal (0 = the zone would take it, materials aside). */
  reason: number;
  lines: CostLine[];
  /** Missing materials (empty when you can afford it). */
  short: CostLine[];
  /** One line for the bar: why it is red, or nothing. */
  text: string;
  /** The piece under the crosshair (for deconstruct and repair), if any. */
  aim: CampPiece | null;
}

export const buildGhost: BuildGhost = { active: false, kind: 0, rot: 0, x: 0, y: 0, z: 0, hasY: false, reason: 0, lines: [], short: [], text: '', aim: null };

export const ME = '@me';

/** A store piece as the rules see it (owners by who is "you"). */
export function toBP(p: CampPiece): BP {
  return { id: p.id, kind: p.kind, rot: p.rot, x: p.xCm, y: p.yCm, z: p.zCm, state: p.state, owner: p.mine ? ME : `other:${p.owner}`, party: p.party ? 1 : 0, lock: p.shared ? 1 : 0 };
}

export function haveItem(item: string): number {
  let n = 0;
  for (const it of useInventory.getState().inv?.items ?? []) if (it.b === item) n += it.q;
  return n;
}

export function viewDir(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** The world as the build rules see it: terrain, water, towns (the zone adds sites and roads). */
export function buildEnv(): BuildEnv | null {
  const e = runtimeEnv();
  if (!e) return null;
  return { heightAt: e.heightAt, waterAt: e.waterAt, structure: e.structure, noBuild: (x, z) => (e.inTown(x, z, CAMPS.build.townMarginM) ? REFUSE.town : 0) };
}

let cacheKey = '';
let cachePieces: Record<number, CampPiece> | null = null;

/** Recompute the ghost from build mode, the player and the world. */
export function updateBuildGhost(): BuildGhost {
  const s = useCamps.getState();
  const b = s.building;
  const env = buildEnv();
  const d = viewDir(localPlayer.yaw, localPlayer.pitch);
  const eye = { x: localPlayer.pos.x, y: localPlayer.pos.y + EYE_M, z: localPlayer.pos.z };
  const near = Object.values(s.pieces)
    .filter((q) => Math.abs(q.x - eye.x) < 24 && Math.abs(q.z - eye.z) < 24)
    .map(toBP);
  if (!env) {
    buildGhost.active = false;
    return buildGhost;
  }
  // The piece under the crosshair, for X and F (also with nothing in hand).
  const aimed = aimPiece(eye, d, near);
  buildGhost.aim = aimed ? (s.pieces[aimed.id] ?? null) : null;
  if (!b) {
    buildGhost.active = false;
    return buildGhost;
  }
  const set = campRuntime.set;
  const hit = aimPoint(eye, d, env.heightAt, (x, z, y) => set.surfaceAt(x, z, y));
  const key = `${b.kind}:${b.rot}:${hit.x.toFixed(2)}:${hit.y.toFixed(2)}:${hit.z.toFixed(2)}:${near.length}`;
  if (key !== cacheKey || s.pieces !== cachePieces) {
    cacheKey = key;
    cachePieces = s.pieces;
    const r = snap({ kind: b.kind, rot: b.rot, px: hit.x, py: hit.y, pz: hit.z, feet: localPlayer.pos, owner: ME, party: 1, all: near, env });
    buildGhost.kind = r.kind;
    buildGhost.rot = r.rot;
    buildGhost.x = r.x;
    buildGhost.y = r.y;
    buildGhost.z = r.z;
    buildGhost.hasY = r.hasY;
    buildGhost.reason = r.reason;
  }
  buildGhost.active = true;
  buildGhost.lines = costLines(b.kind, haveItem);
  buildGhost.short = missing(buildGhost.lines);
  buildGhost.text = buildGhost.reason !== 0 ? (BUILD_REFUSAL[buildGhost.reason] ?? 'Not there') : buildGhost.short.length ? missingText(buildGhost.lines) : '';
  return buildGhost;
}

/** Is the ghost green: valid by the rules and affordable. */
export const ghostOk = (g: BuildGhost): boolean => g.active && g.reason === 0 && g.short.length === 0;
