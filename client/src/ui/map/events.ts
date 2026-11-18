// WP12 wire glue: Event kinds 600-699 and the Interact registry
// (contracts/events.md), plus decoders for the two binary payloads. TS twin
// of server/zone/internal/explore/progress.go (EncodeProgress, EncodePins,
// PackPinPos); events.test.ts replays the Go-generated vectors.

export const EV = {
  notice: 1,
  teleport: 2,
  towerUnlocked: 600,
  waypoint: 601,
  discovery: 602,
  progress: 603,
  levelUp: 604,
  pins: 605,
  fastTravelDenied: 606,
  party: 607,
  respawnPoint: 608,
  /** CR 055: the pins a conversation (1913) or the journal's Info tab (1980) placed: x / z in cm, data = the label. */
  dialogMark: 1913,
  placeMarked: 1980,
  placeRefused: 1981,
} as const;

export const INTERACT = {
  site: 10,
  pin: 11,
  fastTravel: 1,
  pinSet: 1,
  pinClear: 2,
  partyPinSet: 3,
  partyPinClear: 4,
  /** CR 055: mark a town service (Info tab). */
  placePin: 185,
  placeService: 1,
} as const;

export const TRAVEL_DENIED: Record<number, string> = { 1: 'Not a fast-travel point', 2: 'Not unlocked yet', 3: 'Too soon: wait a moment' };

export const MAX_PERSONAL_PINS = 10;

export interface Progress {
  xp: bigint;
  level: number;
  /** Atlas site index of the last waypoint touched (the respawn point), -1 none. */
  lastWaypoint: number;
  /** Bitmask of revealed regions (bit r = region r). */
  revealed: number;
  towers: Uint8Array;
  waypoints: Uint8Array;
  discoveries: Uint8Array;
}

export const emptyProgress = (): Progress => ({ xp: 0n, level: 1, lastWaypoint: -1, revealed: 0, towers: new Uint8Array(0), waypoints: new Uint8Array(0), discoveries: new Uint8Array(0) });

/** Bit i of a site bitset (LSB first, like the Go Bitset). */
export function hasBit(b: Uint8Array, i: number): boolean {
  return i >= 0 && i >> 3 < b.length && (b[i >> 3] & (1 << (i & 7))) !== 0;
}

/** progress_sync (603) payload. */
export function decodeProgress(data: Uint8Array): Progress {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 19 || data[0] !== 1) throw new Error('bad progress payload');
  let o = 19;
  const sets: Uint8Array[] = [];
  for (let i = 0; i < 3; i++) {
    if (o + 2 > data.length) throw new Error('progress payload truncated');
    const n = dv.getUint16(o, true);
    o += 2;
    if (o + n > data.length) throw new Error('progress payload truncated');
    sets.push(data.slice(o, o + n));
    o += n;
  }
  return { xp: dv.getBigUint64(1, true), level: dv.getUint16(9, true), lastWaypoint: dv.getInt32(11, true), revealed: dv.getUint32(15, true), towers: sets[0], waypoints: sets[1], discoveries: sets[2] };
}

export interface Pin {
  party: boolean;
  slot: number;
  color: number;
  /** Meters (wire is cm). */
  x: number;
  z: number;
  /** Party pins: who placed it. For a personal pin the wire carries its label here (CR 055). */
  owner: string;
  /** CR 055: what a personal pin is ("Stables, Kudrogair"); '' for one dropped by hand and for party pins. */
  label: string;
}

/** What to call a pin: its label, "Party pin (name)" or "Your pin". */
export function pinName(p: Pick<Pin, 'party' | 'owner' | 'label'>): string {
  if (p.party) return `Party pin (${p.owner})`;
  return p.label || 'Your pin';
}

/** pins (605) payload: the full list to show, replacing the previous one. */
export function decodePins(data: Uint8Array): Pin[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 2 || data[0] !== 1) throw new Error('bad pins payload');
  const n = data[1];
  const td = new TextDecoder();
  const out: Pin[] = [];
  let o = 2;
  for (let i = 0; i < n; i++) {
    if (o + 13 > data.length) throw new Error('pins payload truncated');
    const len = dv.getUint16(o + 11, true);
    if (o + 13 + len > data.length) throw new Error('pins payload truncated');
    out.push({ party: (data[o] & 1) !== 0, slot: data[o + 1], color: data[o + 2], x: dv.getInt32(o + 3, true) / 100, z: dv.getInt32(o + 7, true) / 100, owner: td.decode(data.subarray(o + 13, o + 13 + len)), label: '' });
    const last = out[out.length - 1];
    if (!last.party) {
      last.label = last.owner;
      last.owner = '';
    }
    o += 13 + len;
  }
  return out;
}

/** Interact targetId for a pin: x cm low 32 bits, z cm high 32 bits. */
export function packPinPos(x: number, z: number): bigint {
  const xc = BigInt(Math.max(0, Math.round(x * 100)) >>> 0);
  const zc = BigInt(Math.max(0, Math.round(z * 100)) >>> 0);
  return xc | (zc << 32n);
}

/** Pin colors (index on the wire). */
export const PIN_COLORS = ['#ff5a5f', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ffffff'];
