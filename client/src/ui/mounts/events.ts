// Playtest 2 mounts (CR 027): the wire. Events 1140-1143 in, Interact 110
// out (contracts/events.md); the zone is server/zone/internal/game/mounts.go.

import type { Event as ZoneEvent } from '@lodestone/contracts';

export const STEED_INTERACT = 110;
export const STEED_ACT = { summon: 1, mount: 2, dismount: 3, name: 4, colour: 5, dismiss: 6, sync: 7, dev: 9 } as const;
export const STEED_EV = { sync: 1140, state: 1141, refused: 1142, thrown: 1143 } as const;
export const PHASE = { gone: 0, arriving: 1, standing: 2, ridden: 3, bolting: 4 } as const;
/** Player typeId bit 14: riding (contracts/events.md "Player entities"). */
export const TYPE_RIDING = 1 << 14;
export const ridingOf = (typeId: number): boolean => (typeId & TYPE_RIDING) !== 0;

/** The colour choices (Interact 110/5 arg = index): body, mane/glow. */
export const STEED_COLOURS: { name: string; body: number; glow: number }[] = [
  { name: 'Moonmist', body: 0x9fc6ff, glow: 0xdff0ff },
  { name: 'Ember', body: 0xffb35c, glow: 0xffe2a8 },
  { name: 'Verdant', body: 0x7fe0a0, glow: 0xd8ffe4 },
  { name: 'Dusk', body: 0xb59bff, glow: 0xeadfff },
  { name: 'Frost', body: 0xe8f4ff, glow: 0xffffff },
  { name: 'Shade', body: 0x3f6f8a, glow: 0x9be7ff },
];

export const REFUSAL: Record<number, string> = {
  1: "That didn't work.",
  2: 'You have no steed. General stores sell a Spirit Whistle (40 gold).',
  3: 'Your steed is still spooked.',
  4: "Your steed can't reach you underground.",
  5: 'Get closer to your steed.',
  6: 'Not now: stand on solid ground first.',
  7: 'Your steed is not here. Whistle for it first (5).',
  8: 'You are down.',
  9: 'A name of 1-16 letters, digits, spaces, apostrophes or dashes.',
  10: 'You are already riding.',
};

export const THROWN: Record<number, string> = {
  0: '',
  1: 'The blow knocked you out of the saddle!',
  2: 'Your steed shied from the demon and bolted!',
  3: 'A hard landing threw you off.',
  4: 'Your steed balked at the deep water.',
  5: '',
  6: 'Your steed stays behind.',
};

export interface SteedSync {
  owned: boolean;
  name: string;
  colour: number;
  kind: number;
  whistle: boolean;
  phase: number;
  x: number;
  z: number;
  coolMs: number;
  colours: number;
  count: number;
  arriveMs: number;
}

/** One player's steed (Event 1141), with the client time it arrived. */
export interface SteedView {
  owner: number;
  phase: number;
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
  /** Arriving / bolting: performance.now() when it ends. */
  until: number;
  /** When this state arrived (performance.now()). */
  at: number;
  colour: number;
  name: string;
  kind: number;
  ver: number;
}

function json<T>(e: ZoneEvent): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(e.data)) as T;
  } catch {
    return null;
  }
}

export function decodeSync(e: ZoneEvent): SteedSync | null {
  return json<SteedSync>(e);
}

export function decodeState(e: ZoneEvent, now: number): SteedView | null {
  const j = json<{ p: number; x: number; y: number; z: number; fx?: number; fz?: number; ms?: number; c: number; n: string; k: number }>(e);
  if (!j) return null;
  return { owner: e.entityId, phase: j.p, x: j.x, y: j.y, z: j.z, fx: j.fx ?? j.x, fz: j.fz ?? j.z, until: now + (j.ms ?? 0), at: now, colour: j.c, name: j.n, kind: j.k, ver: e.targetId };
}

/** Where a steed is drawn at `now` (arriving: along its gallop in; bolting: running off) and its heading (yaw, -Z forward). */
export function steedPose(v: SteedView, now: number): { x: number; z: number; yaw: number; speed: number; alpha: number } {
  if (v.phase === PHASE.arriving || v.phase === PHASE.bolting) {
    const dur = Math.max(1, v.until - v.at);
    const t = Math.min(1, Math.max(0, (now - v.at) / dur));
    const dx = v.phase === PHASE.arriving ? v.x - v.fx : v.fx - v.x;
    const dz = v.phase === PHASE.arriving ? v.z - v.fz : v.fz - v.z;
    const d = Math.hypot(dx, dz);
    const sx = v.phase === PHASE.arriving ? v.fx : v.x;
    const sz = v.phase === PHASE.arriving ? v.fz : v.z;
    // Gallop in fast, slow down at the end (ease out); bolting: speed up and fade.
    const e = v.phase === PHASE.arriving ? 1 - (1 - t) * (1 - t) : t * t;
    const speed = d < 0.5 ? 0 : v.phase === PHASE.arriving ? (2 * (1 - t) * d) / (dur / 1000) : (2 * t * d) / (dur / 1000);
    const yaw = d < 0.5 ? 0 : Math.atan2(-dx, -dz);
    const alpha = v.phase === PHASE.arriving ? (d < 0.5 ? t : Math.min(1, t * 4)) : 1 - t;
    return { x: sx + dx * e, z: sz + dz * e, yaw, speed, alpha };
  }
  return { x: v.x, z: v.z, yaw: 0, speed: 0, alpha: 1 };
}

/** A name as Interact 110/4 chunks (4 ASCII bytes per arg, a 0 byte ends it). */
export function nameChunks(text: string): number[] {
  const b = [...text.slice(0, 16)].map((c) => c.charCodeAt(0) & 0x7f);
  b.push(0);
  const out: number[] = [];
  for (let i = 0; i < b.length && out.length < 4; i += 4) out.push((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) * 0x1000000));
  return out;
}
