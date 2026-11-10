// Playtest 2 emotes (CR 026): definitions from contracts/content.yaml
// `emotes` (generated CONTENT.emotes), the wire numbers (Interact 89,
// Events 1090-1091), the wheel's sector pick, the client-side twin of the
// zone's rate limit and the /emote command. Pure: unit-tested in
// emotes.test.ts.

import { CONTENT, type EmoteDef } from '@lodestone/contracts';

export const EMOTE_INTERACT = 89;
export const EMOTE_ACT = { play: 1, stop: 2 } as const;
export const EV_EMOTE = 1090;
export const EV_EMOTE_REFUSED = 1091;

export const EMOTE_REFUSAL: Record<number, string> = {
  1: 'Unknown emote',
  2: 'Slow down a little',
  3: 'Not now',
};

/** The wheel's emotes (not the zone's own fishing poses), in content.yaml order. */
export const WHEEL: readonly EmoteDef[] = CONTENT.emotes.list.filter((e) => !e.system);

export function emoteByKey(key: string): EmoteDef | null {
  const k = key.trim().toLowerCase();
  return WHEEL.find((e) => e.key === k || e.name.toLowerCase() === k) ?? WHEEL.find((e) => e.key.startsWith(k) && k.length >= 2) ?? null;
}

export function emoteById(id: number): EmoteDef | null {
  return CONTENT.emotes.list.find((e) => e.id === id) ?? null;
}

/**
 * The wheel sector under a mouse offset (pixels, y down) from the wheel's
 * centre: n sectors clockwise from the top, the first centred straight up;
 * -1 inside the dead zone.
 */
export function pickSector(dx: number, dy: number, n: number, deadzone = 28): number {
  if (n <= 0 || Math.hypot(dx, dy) < deadzone) return -1;
  // angle clockwise from up, 0..2pi
  let a = Math.atan2(dx, -dy);
  if (a < 0) a += Math.PI * 2;
  const step = (Math.PI * 2) / n;
  return Math.floor((a + step / 2) / step) % n;
}

/** Where sector i's label sits (unit circle, y down), for drawing. */
export function sectorCenter(i: number, n: number): { x: number; y: number } {
  const a = (i / n) * Math.PI * 2;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

/** Clamp the wheel's virtual cursor to a radius (pointer-lock deltas pile up). */
export function clampCursor(c: { x: number; y: number }, r: number): void {
  const d = Math.hypot(c.x, c.y);
  if (d > r) {
    c.x *= r / d;
    c.y *= r / d;
  }
}

/** A token bucket like the zone's (ratelimit.Bucket): `burst` at once, then one per `everyS`. */
export class TokenBucket {
  private tokens: number;
  private last = -1;
  constructor(
    readonly burst: number,
    readonly everyS: number,
  ) {
    this.tokens = burst;
  }
  take(nowMs: number): boolean {
    if (this.last >= 0) this.tokens = Math.min(this.burst, this.tokens + (nowMs - this.last) / 1000 / this.everyS);
    this.last = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export type EmoteCommand = { kind: 'play'; emote: EmoteDef } | { kind: 'list' } | { kind: 'stop' } | { kind: 'error'; message: string };

/** `/emote <name>` (also `/e`): play it; no name lists them; `stop` ends a loop. */
export function parseEmoteCommand(args: string): EmoteCommand {
  const a = args.trim();
  if (!a) return { kind: 'list' };
  if (a.toLowerCase() === 'stop') return { kind: 'stop' };
  const e = emoteByKey(a);
  return e ? { kind: 'play', emote: e } : { kind: 'error', message: `No emote "${a}". Try: ${WHEEL.map((x) => x.key).join(', ')}` };
}
