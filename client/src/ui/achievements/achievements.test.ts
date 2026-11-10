// CR 031 achievements: the view model, the content reducer for Events
// 1000 / 1002 / 1240 / 1241, and the toast queue.

import { beforeEach, describe, expect, it } from 'vitest';
import { CONTENT, type Event as ZoneEvent } from '@lodestone/contracts';
import { CEV } from '../content/events';
import { emptySync, reduceContentEvent, resetContent, useContent, type ContentState } from '../content/store';
import { MASK, achList, achView, catSummaries, earnedTitles, matchesSearch, points, recentEarned, roman, titleText, type AchSync } from './model';
import { AEV, MAX_QUEUED, TOAST_MS, emptyQueue, enqueueToast, moreCount, rewardLines, tickToasts, toastFromEvent, type AchToast } from './toasts';
import { pushAchievementEvent, resetAchievements, useAchievements } from './store';

const enc = new TextEncoder();
const ev = (kind: number, data: unknown, extra: Partial<ZoneEvent> = {}): ZoneEvent =>
  ({ type: 'Event', kind, entityId: 1, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: typeof data === 'string' ? enc.encode(data) : enc.encode(JSON.stringify(data)), ...extra }) as ZoneEvent;
const def = (key: string) => CONTENT.achievements.find((a) => a.key === key)!;
const sync = (p: Partial<AchSync> = {}): AchSync => ({ feats: [], earned: {}, progress: {}, title: '', ...p });

describe('the achievements table', () => {
  it('has the requested one, gold, hidden, with a title and a hint', () => {
    const t = def('tony_stark');
    expect(t.name).toBe('Tony Stark built this in a cave with scraps');
    expect(CONTENT.achievementTiers[t.tier].key).toBe('gold');
    expect(t.hidden).toBe(true);
    expect(t.title).toBeTruthy();
    expect(t.hint).toBeTruthy();
    expect(CONTENT.achievementCats[t.cat].key).toBe('secrets');
  });

  it('keeps the CR 023 feats (keys unchanged) and chains have I, II, III steps', () => {
    for (const k of ['first_steps', 'slimebane', 'skyreader', 'bard', 'fireside_tales', 'green_thumb']) expect(def(k), k).toBeTruthy();
    const towers = CONTENT.achievements.filter((a) => a.chain === 'towers').sort((a, b) => a.step - b.step);
    expect(towers.map((a) => a.step)).toEqual([1, 2, 3]);
    expect(towers.map((a) => a.n)).toEqual([...towers.map((a) => a.n)].sort((a, b) => a - b));
    expect([1, 2, 3].map(roman)).toEqual(['I', 'II', 'III']);
  });
});

describe('the view model', () => {
  it('clamps progress and fills earned ones', () => {
    const s = sync({ progress: { slimebane: 250, squelch: 4 }, feats: ['first_steps'] });
    expect(achView(def('slimebane'), s).progress).toBe(100);
    expect(achView(def('slimebane'), s).pct).toBe(1);
    expect(achView(def('squelch'), s).pct).toBeCloseTo(0.4);
    expect(achView(def('first_steps'), s).progress).toBe(def('first_steps').n);
    expect(achView(def('getting_the_hang'), sync({ progress: { getting_the_hang: -5 } })).progress).toBe(0);
  });

  it('masks hidden achievements until earned, and search only finds them as "???"', () => {
    const masked = achView(def('tony_stark'), sync());
    expect(masked.masked).toBe(true);
    expect(masked.name).toBe(MASK);
    expect(masked.desc).toBe(def('tony_stark').hint);
    expect(matchesSearch(masked, 'tony')).toBe(false);
    expect(matchesSearch(masked, 'magma')).toBe(false);
    expect(matchesSearch(masked, '???')).toBe(true);
    const earned = achView(def('tony_stark'), sync({ feats: ['tony_stark'], earned: { tony_stark: 99 } }));
    expect(earned.masked).toBe(false);
    expect(earned.name).toBe('Tony Stark built this in a cave with scraps');
    expect(matchesSearch(earned, 'TONY')).toBe(true);
    expect(matchesSearch(earned, 'ironclad')).toBe(true); // its title
  });

  it('filters by category, earned / unearned / hidden', () => {
    const s = sync({ feats: ['first_steps', 'skyreader'] });
    const combat = CONTENT.achievementCats.findIndex((c) => c.key === 'combat');
    const rows = achList(s, { cat: combat, collapseChains: false });
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((v) => v.def.cat === combat)).toBe(true);
    expect(achList(s, { filter: 'earned' }).map((v) => v.def.key).sort()).toEqual(['first_steps', 'skyreader']);
    expect(achList(s, { filter: 'unearned', collapseChains: false }).length).toBe(CONTENT.achievements.length - 2);
    const hidden = achList(s, { filter: 'hidden' });
    expect(hidden.length).toBe(CONTENT.achievements.filter((a) => a.hidden).length);
    expect(hidden.every((v) => v.masked)).toBe(true);
  });

  it('collapses a chain to its earned steps and the next one (not while searching)', () => {
    const keys = (s: AchSync, search = '') => achList(s, { search }).filter((v) => v.def.chain === 'towers').map((v) => v.def.key);
    expect(keys(sync())).toEqual(['skyreader']);
    expect(keys(sync({ feats: ['skyreader'] }))).toEqual(['skyreader', 'tower_chorus']);
    expect(keys(sync({ feats: ['skyreader', 'tower_chorus', 'every_spire'] }))).toEqual(['skyreader', 'tower_chorus', 'every_spire']);
    expect(keys(sync(), 'attune').length).toBe(3);
  });

  it('adds up points overall and per category', () => {
    const s = sync({ feats: ['first_steps', 'skyreader', 'tony_stark'] });
    const p = points(s);
    expect(p.earned).toBe(def('first_steps').pts + def('skyreader').pts + def('tony_stark').pts);
    expect(p.total).toBe(CONTENT.achievements.reduce((n, a) => n + a.pts, 0));
    expect(p.count).toBe(3);
    const cats = catSummaries(s);
    expect(cats.length).toBe(CONTENT.achievementCats.length);
    expect(cats.reduce((n, c) => n + c.earned, 0)).toBe(p.earned);
    expect(cats.find((c) => c.key === 'secrets')!.count).toBe(1);
  });

  it('lists the recently earned, newest first (older ones without a time after)', () => {
    const s = sync({ feats: ['first_steps', 'skyreader', 'squelch', 'zoom', 'bard', 'duelist'], earned: { first_steps: 0, skyreader: 0, squelch: 500, zoom: 900, bard: 700, duelist: 100 } });
    expect(recentEarned(s, 5).map((v) => v.def.key)).toEqual(['zoom', 'bard', 'squelch', 'duelist', 'skyreader']);
  });

  it('lists the earned titles and the shown one', () => {
    const s = sync({ feats: ['first_steps', 'skyreader', 'tony_stark'], title: 'tony_stark' });
    expect(earnedTitles(s).map((a) => a.key)).toEqual(['skyreader', 'tony_stark']);
    expect(titleText(s)).toBe(def('tony_stark').title);
    expect(titleText(sync())).toBe('');
  });
});

describe('the content reducer (Events 1000, 1002, 1240, 1241)', () => {
  beforeEach(() => resetContent());
  const state = (): ContentState => ({ ...useContent.getState(), sync: emptySync(), notes: [] });

  it('1000 carries earned times and points; 1002 adds one', () => {
    let s = state();
    s = { ...s, ...reduceContentEvent(s, ev(CEV.sync, { feats: ['first_steps'], earned: { first_steps: 0 }, points: 10, progress: { squelch: 3 }, title: '' }), 0) };
    expect(s.sync.progress.squelch).toBe(3);
    s = { ...s, ...reduceContentEvent(s, ev(CEV.achievement, { key: 'tony_stark', name: 'x', desc: 'y', title: def('tony_stark').title, tier: 2, pts: 50, at: 777 }, { value: 60, targetId: def('tony_stark').id }), 1) };
    expect(s.sync.feats).toEqual(['first_steps', 'tony_stark']);
    expect(s.sync.earned.tony_stark).toBe(777);
    expect(s.sync.points).toBe(60);
    expect(s.sync.title).toBe('tony_stark');
    expect(s.notes).toEqual([]);
  });

  it('1240: another player earned a gold one: a short note', () => {
    const s = state();
    const p = reduceContentEvent(s, ev(AEV.announce, 'Ana', { entityId: 5, targetId: def('tony_stark').id, value: 2 }), 1)!;
    expect(p.notes!.at(-1)!.title).toBe('Ana earned an achievement');
    expect(p.notes!.at(-1)!.text).toBe('Tony Stark built this in a cave with scraps (Gold)');
    expect(reduceContentEvent(s, ev(AEV.announce, 'Ana', { targetId: 9999 }), 1)).toBeNull();
  });

  it('1241: a returning character catches up at once', () => {
    let s = state();
    s = { ...s, ...reduceContentEvent(s, ev(CEV.sync, { feats: ['first_steps'] }), 0) };
    s = { ...s, ...reduceContentEvent(s, ev(AEV.caughtUp, { keys: ['first_steps', 'squelch', 'getting_the_hang'], gold: 50, xp: 250, pts: 35 }, { value: 2 }), 1) };
    expect(s.sync.feats).toEqual(['first_steps', 'squelch', 'getting_the_hang']);
    expect(s.sync.earned).toMatchObject({ squelch: 0, getting_the_hang: 0 });
  });
});

describe('the unlock toast', () => {
  const t = (key: string): AchToast => ({ key, name: key, desc: '', tier: 0, pts: 10, rewards: [] });

  it('builds the card from 1002 with its rewards, and one summary card from 1241', () => {
    const a = toastFromEvent(ev(AEV.earned, { key: 'tony_stark', name: def('tony_stark').name, desc: 'd', title: 'the Ironclad', gold: 150, xp: 600, tier: 2, pts: 50, item: 'ingot:iron', qty: 5 }))!;
    expect(a.name).toBe('Tony Stark built this in a cave with scraps');
    expect(a.tier).toBe(2);
    expect(a.rewards).toEqual(['+150 gold', '+600 XP', 'title "the Ironclad"', '5 x Iron Ingot']);
    const c = toastFromEvent(ev(AEV.caughtUp, { keys: ['first_steps', 'squelch', 'zoom', 'bard', 'duelist', 'skyreader'], gold: 10, pts: 60 }, { value: 6 }))!;
    expect(c.summary).toBe(true);
    expect(c.name).toBe('6 achievements earned from your past deeds');
    expect(c.desc).toContain('and 2 more');
    expect(toastFromEvent(ev(AEV.caughtUp, { keys: [] }))).toBeNull();
    expect(toastFromEvent(ev(AEV.earned, 'not json'))).toBeNull();
    expect(rewardLines({})).toEqual([]);
  });

  it('shows one at a time, for TOAST_MS each', () => {
    let q = emptyQueue();
    q = enqueueToast(enqueueToast(q, t('a')), t('b'));
    q = tickToasts(q, 0, false);
    expect(q.current?.key).toBe('a');
    expect(moreCount(q)).toBe(1);
    q = tickToasts(q, TOAST_MS - 1, false);
    expect(q.current?.key).toBe('a');
    q = tickToasts(q, TOAST_MS, false);
    expect(q.current?.key).toBe('b');
    q = tickToasts(q, 2 * TOAST_MS + 10, false);
    expect(q.current).toBeNull();
  });

  it('waits while blocked, and a card up is held (paused) while blocked', () => {
    let q = enqueueToast(emptyQueue(), t('a'));
    q = tickToasts(q, 0, true);
    expect(q.current).toBeNull(); // the level-up card is up: wait
    q = tickToasts(q, 1000, false);
    expect(q.current?.key).toBe('a');
    q = tickToasts(q, 3000, false); // 2 s shown
    q = tickToasts(q, 3001, true);
    q = tickToasts(q, 60000, true); // a panel for a minute: held
    expect(q.current?.key).toBe('a');
    q = tickToasts(q, 60001, false);
    expect(q.current?.left).toBeGreaterThan(TOAST_MS - 2100);
    q = tickToasts(q, 60001 + TOAST_MS, false);
    expect(q.current).toBeNull();
  });

  it('caps the queue and counts the rest as "+N more"', () => {
    let q = emptyQueue();
    for (let i = 0; i < MAX_QUEUED + 3; i++) q = enqueueToast(q, t(`k${i}`));
    expect(q.queue.length).toBe(MAX_QUEUED);
    expect(q.extra).toBe(3);
    q = tickToasts(q, 0, false);
    expect(moreCount(q)).toBe(MAX_QUEUED - 1 + 3);
    for (let i = 1; i <= MAX_QUEUED + 1; i++) q = tickToasts(q, i * TOAST_MS, false);
    expect(q.current).toBeNull();
    expect(q.extra).toBe(0);
  });

  it('the store queues 1002 and 1241 and ignores the rest', () => {
    resetAchievements();
    pushAchievementEvent(ev(AEV.earned, { key: 'zoom', tier: 0, pts: 10 }));
    pushAchievementEvent(ev(AEV.announce, 'Ana', { targetId: 1, value: 2 }));
    pushAchievementEvent(ev(AEV.caughtUp, { keys: ['first_steps'] }, { value: 1 }));
    expect(useAchievements.getState().toasts.queue.map((x) => x.name)).toEqual(['Zoom', '1 achievement earned from your past deeds']);
  });
});
