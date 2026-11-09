import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { friendHash, reduceTravelEvent, refusalText, TRAVEL_EV, type TravelState } from './travel';

const ev = (kind: number, value: number, data = ''): ZoneEvent => ({ type: 'Event', kind, entityId: 1, targetId: 0, value, x: 0, y: 0, z: 0, data: new TextEncoder().encode(data) }) as ZoneEvent;
const empty: TravelState = { channel: null, note: null, fadeAt: 0 };

describe('travel to a friend (playtest 2)', () => {
  it('hashes character ids like the zone (FNV-1a 64; friendtravel_test.go has the same vectors)', () => {
    expect(friendHash('')).toBe(0xcbf29ce484222325n);
    expect(friendHash('11111111-2222-3333-4444-555555555555')).toBe(0x5ff56bf05c1d58f9n);
  });
  it('tracks the channel, refusals and arrival', () => {
    const ch = reduceTravelEvent(empty, ev(TRAVEL_EV.channel, 3000, 'Bea'), 100)!;
    expect(ch.channel).toEqual({ name: 'Bea', at: 100, ms: 3000 });
    const moved = reduceTravelEvent({ ...empty, ...ch } as TravelState, ev(TRAVEL_EV.refused, 6, 'Bea'), 900)!;
    expect(moved.channel).toBeNull();
    expect(moved.note?.text).toBe('Travel cancelled: you moved');
    const busy = reduceTravelEvent(empty, ev(TRAVEL_EV.refused, 4, 'Bea'), 0)!;
    expect(busy.note?.text).toBe('Bea is in combat; try again in a moment');
    const done = reduceTravelEvent({ ...empty, ...ch } as TravelState, ev(TRAVEL_EV.arrived, 0, 'Bea'), 3100)!;
    expect(done).toMatchObject({ channel: null, fadeAt: 3100, note: { text: 'You travelled to Bea' } });
    expect(reduceTravelEvent(empty, ev(950, 0), 0)).toBeNull();
  });
  it('words every refusal', () => {
    for (let r = 1; r <= 10; r++) expect(refusalText(r, 'Bea')).not.toMatch(/refused \(/);
    expect(refusalText(1, '')).toBe("Your friend isn't online in this world");
  });
});
