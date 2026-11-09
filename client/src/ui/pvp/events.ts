// Playtest 2 PvP and duels (CR 018): Event kinds 990-997, Interact 70 and
// the payload decoders. Mirrors server/zone/internal/game/pvp.go, duel.go
// and contracts/events.md.

import type { Event as ZoneEvent } from '@lodestone/contracts';

export const PEV = {
  state: 990,
  refused: 991,
  hit: 992,
  kill: 993,
  challenge: 994,
  duelState: 995,
  duelEnded: 996,
  duelOutside: 997,
} as const;

export const INTERACT_PVP = 70;
export const PVP_ACT = { flag: 1, challenge: 2, answer: 3, yield: 4 } as const;

/** Player typeId bits (bits 0-11 are the weapon look). */
export const TYPE_PVP_FLAG = 1 << 12;
export const TYPE_DUELING = 1 << 13;

/** Event 990 value bits. */
export const STATE_FLAGGED = 1;
export const STATE_TURNING = 2;
export const STATE_SAFE = 4;

export const DUEL_PHASE = { waiting: 1, countdown: 2, fighting: 3 } as const;

/** Event 996 reasons. */
export const DUEL_END = { defeated: 1, outside: 2, left: 3, timeUp: 4, yielded: 5, declined: 6, expired: 7, cancelled: 8 } as const;

/** HitResult refusal codes that concern PvP (contracts/events.md). */
export const REFUSE_NOT_HOSTILE = 1;
export const REFUSE_SAFE_ZONE = 16;
export const REFUSE_SAME_PARTY = 17;

const td = new TextDecoder();

export interface PvpStateEv {
  flagged: boolean;
  turningOff: boolean;
  /** ms until a waiting turn-off applies. */
  offInMs: number;
  safe: boolean;
  safeName: string;
}

export function decodeState(ev: ZoneEvent): PvpStateEv {
  return {
    flagged: (ev.value & STATE_FLAGGED) !== 0,
    turningOff: (ev.value & STATE_TURNING) !== 0,
    offInMs: ev.targetId,
    safe: (ev.value & STATE_SAFE) !== 0,
    safeName: td.decode(ev.data),
  };
}

export interface DuelStateEv {
  duelId: number;
  opponentId: number;
  opponentName: string;
  phase: number;
  center: { x: number; y: number; z: number };
  radius: number;
  /** ms until this phase ends. */
  phaseMs: number;
}

/** Event 995: u16 ring radius cm | u32 ms until the phase ends | UTF-8 opponent name. */
export function decodeDuelState(ev: ZoneEvent): DuelStateEv | null {
  const d = ev.data;
  if (d.length < 6) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    duelId: ev.targetId,
    opponentId: ev.entityId,
    opponentName: td.decode(d.subarray(6)),
    phase: ev.value,
    center: { x: ev.x / 100, y: ev.y / 100, z: ev.z / 100 },
    radius: v.getUint16(0, true) / 100,
    phaseMs: v.getUint32(2, true),
  };
}

/** What a 991 refusal says to the player. */
export function refusalText(reason: number, msLeft = 0): string {
  switch (reason) {
    case 1:
      return 'You fought too recently to change your PvP flag.';
    case 2:
      return `Wait ${Math.max(1, Math.ceil(msLeft / 1000))} s before changing your PvP flag again.`;
    case 3:
      return 'Your PvP flag is already set that way.';
    case 4:
      return 'That player is not here.';
    case 5:
      return 'Duels are between party members. Flag for PvP to fight anyone else.';
    case 6:
      return 'Too far away to duel: come closer.';
    case 7:
      return 'Already in a duel or a challenge.';
    case 8:
      return 'No duel to answer.';
    case 9:
      return 'Not while someone is down.';
    default:
      return 'Not allowed.';
  }
}

/** A HitResult refusal on a player, as a message (null: say nothing). */
export function hitRefusalText(reason: number): string | null {
  switch (reason) {
    case REFUSE_SAFE_ZONE:
      return 'Safe zone: no PvP here.';
    case REFUSE_SAME_PARTY:
      return 'A party member: challenge them to a duel instead.';
    case REFUSE_NOT_HOSTILE:
      return 'Both players must be flagged for PvP.';
  }
  return null;
}

export interface KillEv {
  killerId: number;
  victimId: number;
  killer: string;
  victim: string;
}

export function decodeKill(ev: ZoneEvent): KillEv {
  let killer = '';
  let victim = '';
  try {
    const j = JSON.parse(td.decode(ev.data)) as { killer?: string; victim?: string };
    killer = j.killer ?? '';
    victim = j.victim ?? '';
  } catch {
    /* a malformed payload still names the ids */
  }
  return { killerId: ev.entityId, victimId: ev.targetId, killer, victim };
}

export const textOf = (ev: ZoneEvent) => td.decode(ev.data);
