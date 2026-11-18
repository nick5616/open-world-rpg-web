// Playtest 5 (CR 055): a marked place reaches the wisp, the compass and the map with its name.

import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { guide, guideTo, markedGoal, MARK_GUIDE_MS } from '../../world/guide/guideStore';
import { decodePins, EV, pinName } from './events';
import { markedLine, onPlaceEvent } from './placeMarks';

const enc = new TextEncoder();
const ev = (kind: number, label: string, x: number, z: number): ZoneEvent => ({ type: 'Event', kind, entityId: 1, targetId: 0, value: 0, x, y: 0, z, data: enc.encode(label) }) as ZoneEvent;

describe('marked places', () => {
  it('the conversation and journal events both remember the place for the wisp', () => {
    guide.marked = null;
    onPlaceEvent(ev(EV.dialogMark, 'Stables, Kudrogair', 166400, 240000));
    expect(markedGoal()).toMatchObject({ x: 1664, z: 2400, label: 'Stables, Kudrogair' });
    guide.marked = null;
    onPlaceEvent(ev(EV.placeMarked, 'Smith, Draedmore', 100050, 99950));
    expect(markedGoal()).toMatchObject({ x: 1000.5, z: 999.5, label: 'Smith, Draedmore' });
    onPlaceEvent(ev(EV.progress, 'x', 1, 1)); // not ours
    expect(markedGoal()?.label).toBe('Smith, Draedmore');
  });

  it('the key leads there for two minutes, then the quest comes first again', () => {
    guide.marked = { x: 1, z: 2, label: 'a', at: 1000 };
    expect(markedGoal(1000 + MARK_GUIDE_MS - 1)).not.toBeNull();
    expect(markedGoal(1000 + MARK_GUIDE_MS + 1)).toBeNull();
  });

  it('"Guide me" asks the wisp for exactly that place', () => {
    guide.go = false;
    guideTo(10, 20, 'Inn, Draedmore');
    expect(guide.go).toBe(true);
    expect(guide.target).toEqual({ x: 10, z: 20, label: 'Inn, Draedmore' });
  });

  it('says how to be guided, with the key from the bindings', () => {
    expect(markedLine('Stables, Kudrogair', ['.'])).toBe('Marked: Stables, Kudrogair. Press . and a wisp leads you there.');
    expect(markedLine('Inn', [])).toBe('Marked: Inn.');
  });

  it('a personal pin shows its label, a party pin its owner, a hand-dropped pin "Your pin"', () => {
    expect(pinName({ party: false, owner: '', label: 'Stables, Kudrogair' })).toBe('Stables, Kudrogair');
    expect(pinName({ party: false, owner: '', label: '' })).toBe('Your pin');
    expect(pinName({ party: true, owner: 'Ari', label: '' })).toBe('Party pin (Ari)');
  });

  it('decodes a labelled personal pin from the wire', () => {
    const label = enc.encode('Stables, Kudrogair');
    const b = new Uint8Array(2 + 13 + label.length);
    const dv = new DataView(b.buffer);
    b[0] = 1;
    b[1] = 1;
    b[2] = 0; // personal
    b[3] = 2; // slot
    b[4] = 4; // colour
    dv.setInt32(5, 166400, true);
    dv.setInt32(9, 240000, true);
    dv.setUint16(13, label.length, true);
    b.set(label, 15);
    expect(decodePins(b)).toEqual([{ party: false, slot: 2, color: 4, x: 1664, z: 2400, owner: '', label: 'Stables, Kudrogair' }]);
  });
});
