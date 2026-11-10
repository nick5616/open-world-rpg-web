// WP12 client logic: Event payload decoding against the Go encoder's
// vectors, the exploration reducer, compass maths and map visibility.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import type { Site } from '@lodestone/worldgen';
import { decodePins, decodeProgress, emptyProgress, EV, hasBit, packPinPos } from './events';
import { reduceEvent, type ExplorationState } from './store';
import { bearing, headingOf, wrapAngle } from './Compass';
import { canFastTravel, siteVisibility } from './MapScreen';

const vectors = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../../server/zone/internal/explore/testdata/events_vectors.json', import.meta.url)), 'utf8')) as {
  Progress: { Hex: string; XP: number; Level: number; LastWaypoint: number; Revealed: number; Towers: number[]; Waypoints: number[]; Discoveries: number[] };
  Pins: { Hex: string; Pins: { Party: boolean; Slot: number; Color: number; XCm: number; ZCm: number; Owner: string }[] };
};
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

describe('event payloads (Go vectors)', () => {
  it('progress_sync decodes', () => {
    const p = decodeProgress(fromHex(vectors.Progress.Hex));
    expect(p.xp).toBe(BigInt(vectors.Progress.XP));
    expect(p.level).toBe(vectors.Progress.Level);
    expect(p.lastWaypoint).toBe(vectors.Progress.LastWaypoint);
    expect(p.revealed).toBe(vectors.Progress.Revealed);
    for (const i of vectors.Progress.Towers) expect(hasBit(p.towers, i)).toBe(true);
    for (const i of vectors.Progress.Discoveries) expect(hasBit(p.discoveries, i)).toBe(true);
    expect(hasBit(p.towers, 1)).toBe(false);
    expect(hasBit(p.towers, 9999)).toBe(false);
  });
  it('pins decode (incl. UTF-8 owner)', () => {
    const pins = decodePins(fromHex(vectors.Pins.Hex));
    expect(pins).toEqual(vectors.Pins.Pins.map((p) => ({ party: p.Party, slot: p.Slot, color: p.Color, x: p.XCm / 100, z: p.ZCm / 100, owner: p.Owner })));
    expect(() => decodePins(fromHex(vectors.Pins.Hex).slice(0, -1))).toThrow();
  });
  it('pin positions pack like the Go side', () => {
    expect(packPinPos(1234.56, 4095.99)).toBe(123456n | (409599n << 32n));
  });
});

const ev = (kind: number, extra: Partial<ZoneEvent> = {}): ZoneEvent => ({ type: 'Event', kind, entityId: 1, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: new Uint8Array(0), ...extra });
const base = (): ExplorationState => ({ progress: emptyProgress(), pins: [], partyId: 0, toasts: [], mapOpen: false, respawnName: '', stats: { events: 0, discoveries: 0, towers: 0, xpGained: 0, teleports: 0 }, actions: null });

describe('reducer', () => {
  it('discovery and tower toasts, stats', () => {
    let s = base();
    s = { ...s, ...reduceEvent(s, ev(EV.discovery, { value: 40, data: new TextEncoder().encode('Old Spire') }), 0)! };
    expect(s.toasts[0]).toMatchObject({ kind: 'discovery', title: 'Discovered: Old Spire', detail: '+40 XP' });
    s = { ...s, ...reduceEvent(s, ev(EV.towerUnlocked, { data: new TextEncoder().encode('Highmarch') }), 1)! };
    expect(s.toasts.map((t) => t.kind)).toEqual(['discovery', 'tower']);
    expect(s.stats).toMatchObject({ discoveries: 1, towers: 1, xpGained: 40, events: 2 });
    // Old toasts expire on the next push.
    s = { ...s, ...reduceEvent(s, ev(EV.levelUp, { value: 2 }), 10000)! };
    expect(s.toasts.map((t) => t.title)).toEqual(['Level 2']);
  });
  it('progress, pins and party replace state', () => {
    let s = base();
    s = { ...s, ...reduceEvent(s, ev(EV.progress, { data: fromHex(vectors.Progress.Hex) }), 0)! };
    expect(s.progress.level).toBe(vectors.Progress.Level);
    s = { ...s, ...reduceEvent(s, ev(EV.pins, { data: fromHex(vectors.Pins.Hex) }), 0)! };
    expect(s.pins).toHaveLength(2);
    s = { ...s, ...reduceEvent(s, ev(EV.party, { value: -5 }), 0)! };
    expect(s.partyId).toBe(0xfffffffb); // u32 party hash rides in the i32 value
    expect(reduceEvent(s, ev(777), 0)).toBeNull();
  });
});

describe('compass', () => {
  it('bearings are clockwise from north (-z)', () => {
    expect(bearing(0, 0, 0, -10)).toBeCloseTo(0);
    expect(bearing(0, 0, 10, 0)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(bearing(0, 0, 0, 10))).toBeCloseTo(Math.PI);
    expect(bearing(0, 0, -10, 0)).toBeCloseTo(-Math.PI / 2);
  });
  it('heading follows the movement convention (yaw 0 faces -z, forward = (-sin, -cos))', () => {
    for (const yaw of [0, 0.7, -1.2, 3]) {
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      expect(wrapAngle(bearing(0, 0, fx, fz) - headingOf(yaw))).toBeCloseTo(0, 9);
    }
  });
  it('wraps', () => {
    expect(wrapAngle(2.5 * Math.PI)).toBeCloseTo(Math.PI / 2);
    expect(wrapAngle(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2);
  });
});

describe('map visibility', () => {
  const site = (kind: string, index: number, region = 0): Site => ({ index, kind, category: kind === 'settlement' ? 'settlement' : 'poi', region } as unknown as Site);
  const bits = (...i: number[]) => {
    const b = new Uint8Array(4);
    for (const x of i) b[x >> 3] |= 1 << (x & 7);
    return b;
  };
  it('hidden in unrevealed regions until discovered; unlocked points travel', () => {
    const none = new Uint8Array(0);
    expect(siteVisibility(site('settlement', 3, 2), 0, none, none, none)).toBe('hidden');
    expect(siteVisibility(site('settlement', 3, 2), 1 << 2, none, none, none)).toBe('dim');
    expect(siteVisibility(site('settlement', 3, 2), 0, none, none, bits(3))).toBe('known');
    expect(siteVisibility(site('tower', 5, 1), 0, bits(5), none, bits(5))).toBe('unlocked');
    expect(canFastTravel(site('tower', 5), bits(5), none)).toBe(true);
    expect(canFastTravel(site('waypoint', 6), bits(5), none)).toBe(false);
    expect(canFastTravel(site('waypoint', 6), none, bits(6))).toBe(true);
    expect(canFastTravel(site('settlement', 5), bits(5), bits(5))).toBe(false);
  });
});
