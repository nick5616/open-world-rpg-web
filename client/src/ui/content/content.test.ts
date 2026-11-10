import { describe, expect, it, beforeEach } from 'vitest';
import { CONTENT, type Event as ZoneEvent } from '@lodestone/contracts';
import { CEV, EVENT_PHASE, decodePlaces, eventStatus } from './events';
import { codexEntries, emptySync, nearestEvent, reduceContentEvent, resetContent, useContent, applyContentEvent, type ContentState } from './store';
import { playerTitles, titleOf } from './titles';
import { findContentTarget } from './ContentHud';
import { weaknesses } from './JournalTabs';
import { rewardText } from '../quests/QuestHud';

const enc = new TextEncoder();
const ev = (kind: number, data: unknown, extra: Partial<ZoneEvent> = {}): ZoneEvent =>
  ({ kind, entityId: 1, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: data instanceof Uint8Array ? data : enc.encode(typeof data === 'string' ? data : JSON.stringify(data)), ...extra }) as ZoneEvent;

function state(): ContentState {
  return { ...useContent.getState(), sync: emptySync(), tablets: {}, patches: {}, events: {}, vaults: {}, reading: null, notes: [] };
}

/** Event 1007 bytes as the zone writes them (content.go sendPlaces). */
function placesBytes(ax: number, az: number, tablets: [number, number, number, number, number, number][], patches: [number, number, number, number, number, number][]): Uint8Array {
  const b = new Uint8Array(7 + tablets.length * 16 + 2 + patches.length * 21);
  const dv = new DataView(b.buffer);
  b[0] = 1;
  dv.setUint16(1, ax, true);
  dv.setUint16(3, az, true);
  dv.setUint16(5, tablets.length, true);
  let o = 7;
  for (const [site, id, x, y, z, read] of tablets) {
    dv.setUint16(o, site, true);
    b[o + 2] = id;
    dv.setInt32(o + 3, x * 100, true);
    dv.setInt32(o + 7, y * 100, true);
    dv.setInt32(o + 11, z * 100, true);
    b[o + 15] = read;
    o += 16;
  }
  dv.setUint16(o, patches.length, true);
  o += 2;
  for (const [id, herb, x, y, z, left] of patches) {
    dv.setUint32(o, id, true);
    b[o + 4] = herb;
    dv.setInt32(o + 5, x * 100, true);
    dv.setInt32(o + 9, y * 100, true);
    dv.setInt32(o + 13, z * 100, true);
    dv.setUint32(o + 17, left, true);
    o += 21;
  }
  return b;
}

describe('content events', () => {
  beforeEach(() => resetContent());

  it('decodes the places of an area', () => {
    const p = decodePlaces(placesBytes(3, 4, [[17, 5, 800.5, 40, 1030.25, 0]], [[99, 2, 801, 41, 1031, 0], [100, 3, 805, 41, 1035, 60000]]), 1000);
    expect(p).not.toBeNull();
    expect(p!.ax).toBe(3);
    expect(p!.tablets[0]).toEqual({ site: 17, id: 5, x: 800.5, y: 40, z: 1030.25, read: false });
    expect(p!.patches[0].readyAt).toBe(0);
    expect(p!.patches[1].readyAt).toBe(61000);
  });

  it('keeps the sync, codex, feats, renown and titles', () => {
    let s = state();
    s = { ...s, ...reduceContentEvent(s, ev(CEV.sync, { kills: { slime: 3 }, feats: ['first_steps'], tablets: [2], title: '', stats: {}, rep: [], vaults: [], progress: {} }), 0) };
    expect(s.sync.kills.slime).toBe(3);
    s = { ...s, ...reduceContentEvent(s, ev(CEV.codex, 'wolf'), 10) };
    expect(s.sync.kills.wolf).toBe(1);
    expect(s.notes.at(-1)?.text).toBe('Mossjaw Wolf');
    s = { ...s, ...reduceContentEvent(s, ev(CEV.feat, { key: 'slimebane', name: 'Slimebane', desc: 'Defeat 100 slimes', title: 'Slimebane', gold: 40, xp: 200 }), 20) };
    expect(s.sync.feats).toContain('slimebane');
    expect(s.sync.title).toBe('slimebane');
    expect(s.notes.at(-1)?.text).toContain('title "Slimebane"');
    s = { ...s, ...reduceContentEvent(s, ev(CEV.rep, { town: 'Draedmore', rep: 25, gain: 12, tier: 1, tierName: 'Known', up: true }, { targetId: 9 }), 30) };
    expect(s.sync.rep).toEqual([{ town: 9, name: 'Draedmore', rep: 25, tier: 1 }]);
    expect(s.notes.at(-1)?.title).toBe('Draedmore: Known!');
    reduceContentEvent(s, ev(CEV.title, 'the Duelist', { entityId: 42 }), 40);
    expect(titleOf(42)).toBe('the Duelist');
    reduceContentEvent(s, ev(CEV.title, '', { entityId: 42 }), 41);
    expect(playerTitles.has(42)).toBe(false);
  });

  it('opens a tablet and marks it read', () => {
    let s = state();
    s = { ...s, ...reduceContentEvent(s, ev(CEV.places, placesBytes(0, 0, [[17, 5, 1, 0, 1, 0]], [])), 0) };
    s = { ...s, ...reduceContentEvent(s, ev(CEV.tablet, { site: 17, id: 5, title: 'Of the Watch', text: 'There were a thousand fires', new: true, place: 'Old Tower' }), 1) };
    expect(s.reading?.title).toBe('Of the Watch');
    expect(s.tablets[17].read).toBe(true);
    expect(s.sync.tablets).toEqual([5]);
  });

  it('follows a world event from announcement to victory', () => {
    let s = state();
    const data = { id: 7, kind: 'caravan', name: 'Caravan Ambush', text: 'Bandits!', endsInMs: 300000, progress: 100, x: 100, y: 10, z: 50, r: 26, wave: 1, waves: 3, hp: 100 };
    s = { ...s, ...reduceContentEvent(s, ev(CEV.worldEvent, data, { targetId: 7, value: EVENT_PHASE.active }), 0) };
    expect(s.events[7].phase).toBe(EVENT_PHASE.active);
    expect(s.notes.at(-1)?.title).toBe('Caravan Ambush');
    expect(eventStatus(s.events[7], 0)).toBe('Caravan 100% · wave 1/3 · 5:00');
    s = { ...s, ...reduceContentEvent(s, ev(CEV.worldEvent, { ...data, hp: 60, progress: 60 }, { targetId: 7, value: EVENT_PHASE.updated }), 1000) };
    expect(s.events[7].hp).toBe(60);
    expect(s.events[7].phase).toBe(EVENT_PHASE.active);
    expect(nearestEvent(s, 0, 0)?.id).toBe(7);
    s = { ...s, ...reduceContentEvent(s, ev(CEV.worldEvent, { ...data, text: 'The caravan rolls on.' }, { targetId: 7, value: EVENT_PHASE.won }), 2000) };
    expect(s.events[7].phase).toBe(EVENT_PHASE.won);
    expect(s.notes.at(-1)?.title).toBe('Caravan Ambush: won');
  });

  it('finds what E would do next to you', () => {
    applyContentEvent(ev(CEV.places, placesBytes(0, 0, [[17, 5, 10, 0, 10, 0]], [[99, 2, 30, 0, 30, 0]])), 0);
    applyContentEvent(ev(CEV.vault, { site: 5, name: 'The Undervault', puzzle: 'levers', title: 'The Three Levers', hint: 'Sun...', keeper: -1, x: 60, z: 60, r: 20, parts: [{ id: 1, kind: 'lever', label: 'Lever of sun', x: 60, y: 0, z: 61, on: false, glyph: 0 }, { id: 101, kind: 'chest', label: 'Vault chest', x: 58, y: 0, z: 60, on: false, glyph: 0 }] }, { targetId: 5, value: 0 }), 0);
    const s = useContent.getState();
    expect(findContentTarget(s, 10.5, 0, 10.5, 0)).toMatchObject({ kind: 'tablet', id: 17 });
    expect(findContentTarget(s, 30.5, 0, 30.5, 0)?.label).toBe(`[E] Gather ${CONTENT.forage.herbs[1].name}`);
    expect(findContentTarget(s, 60, 0, 61.5, 0)).toMatchObject({ kind: 'vault', site: 5, part: 1, label: '[E] Pull the lever of the sun' });
    expect(findContentTarget(s, 58, 0, 60.5, 0)).toMatchObject({ kind: 'hint' }); // the chest is sealed until the keeper falls
    expect(findContentTarget(s, 200, 0, 200, 0)).toBeNull();
    // A picked patch hides until it regrows.
    applyContentEvent(ev(CEV.picked, 'herb:emberroot', { targetId: 99, value: 60000 }), 0);
    expect(findContentTarget(useContent.getState(), 30.5, 0, 30.5, 10)).toBeNull();
  });

  it('describes the codex, weaknesses and rewards', () => {
    const entries = codexEntries({ ...emptySync(), kills: { slime: 2 } });
    expect(entries.length).toBe(CONTENT.codex.length);
    expect(entries.find((e) => e.key === 'slime')).toMatchObject({ unlocked: true, kills: 2 });
    expect(weaknesses(0).weakTo).toContain('wind'); // wind snuffs fire
    expect(weaknesses(1).weakTo).toContain('fire');
    expect(weaknesses(8).weakTo).toEqual([]);
    expect(rewardText({ gold: 20, xp: 80, rep: 12, repTown: 'Draedmore', rollItems: 1, items: [{ item: 'herb:frostcap', qty: 2 }] })).toBe('20 gold · 80 XP · 2 x Frostcap · a piece of gear · +12 renown with Draedmore');
  });
});
