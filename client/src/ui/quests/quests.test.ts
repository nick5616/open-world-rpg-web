import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { compassWord, decodeQuestLog, QEV, whereText } from './events';
import { offerMarkers, reduceQuestEvent, trackedQuest, useQuests, type QuestState } from './store';

const enc = new TextEncoder();
const ev = (kind: number, data: unknown, extra: Partial<ZoneEvent> = {}): ZoneEvent =>
  ({ kind, entityId: 0, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: enc.encode(JSON.stringify(data)), ...extra }) as ZoneEvent;

const base = (): QuestState => ({ ...useQuests.getState(), log: { tracked: 0, quests: [] }, offer: null, preview: null, notes: [], journalOpen: false, actions: null, stats: { logs: 0, steps: 0, completed: 0, offers: 0 } });

// The zone's JSON (server/zone/internal/quests/wire.go).
const ward = {
  id: 0x57415244,
  key: 'story:ward',
  kind: 1,
  title: 'Ward against the night',
  giver: 'Selina, blacksmith of Draedmore',
  step: 1,
  steps: [{ text: 'Talk to Selina', done: true }, { text: 'Mine 4 sunsteel ore', done: false }],
  text: 'Mine 4 sunsteel ore',
  note: 'Sunsteel glints where daylight reaches...',
  progress: 2,
  need: 4,
  markers: [{ x: 1465, z: 2530, r: 20, label: 'Sunsteel ore' }, { x: 1450, z: 2500, label: 'Cave mouth' }],
  gold: 30,
  xp: 200,
};

describe('quest store', () => {
  it('takes the whole log from 950 and tracks', () => {
    const p = reduceQuestEvent(base(), ev(QEV.log, { v: 1, tracked: ward.id, quests: [ward] }), 0)!;
    expect(p.log!.quests).toHaveLength(1);
    expect(p.log!.quests[0].markers[0].r).toBe(20);
    expect(trackedQuest({ log: p.log! })!.title).toBe('Ward against the night');
    // Unknown tracked id falls back to the first quest.
    expect(trackedQuest({ log: { tracked: 9, quests: p.log!.quests } })!.id).toBe(ward.id);
  });

  it('stores offers with every step marker and dedupes the preview', () => {
    const offer = { ...ward, step: 0, stepMarkers: [[{ x: 1, z: 2, label: 'Smith' }], ward.markers, [{ x: 1, z: 2, label: 'Smith' }]] };
    const p = reduceQuestEvent(base(), ev(QEV.offer, offer, { entityId: 77, targetId: ward.id }), 5)!;
    expect(p.offer!.npc).toBe(77);
    const ms = offerMarkers(p.offer!.quest);
    expect(ms.map((m) => m.label)).toEqual(['1. Smith', '2. Sunsteel ore', '2. Cave mouth']);
  });

  it('notes steps, completions and refusals; started clears a matching offer', () => {
    let s = base();
    s = { ...s, ...reduceQuestEvent(s, ev(QEV.offer, ward, { targetId: ward.id }), 0)! };
    s = { ...s, ...reduceQuestEvent(s, ev(QEV.started, { title: 'Ward against the night', text: 'Talk' }, { targetId: ward.id }), 1)! };
    expect(s.offer).toBeNull();
    s = { ...s, ...reduceQuestEvent(s, ev(QEV.step, { title: 'Ward', done: 'Talk', next: 'Mine' }, { targetId: ward.id, value: 1 }), 2)! };
    s = { ...s, ...reduceQuestEvent(s, ev(QEV.completed, { title: 'Ward', gold: 30, xp: 200 }, { targetId: ward.id, value: 30 }), 3)! };
    expect(s.notes.map((n) => n.kind)).toEqual(['started', 'step', 'done']);
    expect(s.notes[2].text).toBe('+30 gold · +200 XP');
    expect(s.stats.completed).toBe(1);
    s = { ...s, ...reduceQuestEvent(s, ev(QEV.refused, null, { value: 2 }), 4)! };
    expect(s.notes.at(-1)!.text).toMatch(/bounty board/);
    expect(reduceQuestEvent(s, ev(800, {}), 5)).toBeNull();
  });

  it('survives bad JSON', () => {
    expect(decodeQuestLog(enc.encode('nope')).quests).toEqual([]);
  });
});

describe('quest wording', () => {
  it('matches the zone compass (north is -z)', () => {
    expect(compassWord(0, 0, 0, -10)).toBe('north');
    expect(compassWord(0, 0, 10, -10)).toBe('north-east');
    expect(compassWord(0, 0, -10, 10)).toBe('south-west');
    expect(whereText(0, 0, { x: 300, z: -300, label: '' })).toBe('420 m north-east');
    expect(whereText(0, 0, { x: 5, z: 0, label: '' })).toBe('here');
    expect(whereText(0, 0, { x: 0, z: 1500, label: '' })).toBe('1.5 km south');
  });
});
