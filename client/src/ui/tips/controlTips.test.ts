// Playtest 5 (CR 055): the controls toast after a conversation.

import { afterEach, describe, expect, it } from 'vitest';
import { BINDINGS } from '../../input/bindings';
import { useDialog } from '../dialog/store';
import { useQuests } from '../quests/store';
import { announcements, controlCodes, controlKeys, controlTip, DONE, logChanges, START, type ControlId } from './controlTips';
import { installControlLink, loadControlsSeen, GRACE_MS } from './controlLink';
import { controlHover, useTips } from './store';
import type { KV } from './tips';

class MemKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const ALL: ControlId[] = ['attack', 'spells', 'dodge', 'draught', 'interact', 'torch', 'build', 'whistle', 'camp', 'inventory', 'map', 'journal', 'glider', 'guide'];

describe('the keys come from the bindings', () => {
  it('every control resolves to at least one live key (a mouse button counts)', () => {
    for (const id of ALL) expect(controlKeys(id).length, id).toBeGreaterThan(0);
  });

  it('the controls the errands talk about are the real ones', () => {
    expect(controlKeys('torch')).toEqual(['8']);
    expect(controlKeys('whistle')).toEqual(['5']); // the old line said H, which is the emote wheel
    expect(controlKeys('build')).toEqual(['9']);
    expect(controlKeys('attack')).toEqual(['LMB']);
    expect(controlKeys('spells')).toEqual(['1-4']);
    expect(controlKeys('dodge')).toEqual(['F']);
    expect(controlKeys('guide')).toEqual(['.']);
    expect(controlKeys('glider')).toContain('G');
  });

  it('a rebound key shows as rebound', () => {
    const b = BINDINGS.find((x) => x.file === 'world/lights/LightRig.tsx' && x.code === 'Digit8')!;
    try {
      b.code = 'KeyT';
      expect(controlKeys('torch')).toEqual([]); // looked up by handler file and code: the old pair is gone, nothing stale is shown
    } finally {
      b.code = 'Digit8';
    }
    expect(controlCodes('torch')).toEqual(['Digit8']);
  });

  it('no toast text names a key itself', () => {
    for (const id of ALL) expect(controlTip(id).text, id).not.toMatch(/\b(press|key)\b/i);
  });

  it('every group lists known controls and the errand quests are covered', () => {
    for (const g of [...Object.values(START), ...Object.values(DONE)]) for (const c of g.controls) expect(ALL).toContain(c);
    for (const k of ['story:meadows', 'story:errand:ore', 'story:errand:timber', 'story:errand:torch', 'story:errand:pond', 'story:errand:steed', 'story:errand:tower']) expect(START[k], k).toBeTruthy();
  });
});

const q = (key: string, step: number, first = 'Talk to Tammir, the farmer of Draedmore') => ({ key, step, first });

describe('what a conversation changed', () => {
  it('a quest that moves on from its talk step starts its controls', () => {
    const ch = logChanges([q('story:meadows', 0)], [q('story:meadows', 1)], 10);
    expect(ch).toEqual([{ key: 'story:meadows', kind: 'start', at: 10 }]);
  });

  it('a quest the chain just began on its talk step is nothing yet', () => {
    expect(logChanges([], [q('story:errand:ore', 0)], 5)).toEqual([]);
  });

  it('an offer taken in a conversation (it begins on a deed) starts its controls', () => {
    expect(logChanges([], [q('story:errand:torch', 0, 'Light your torch')], 5)).toEqual([{ key: 'story:errand:torch', kind: 'start', at: 5 }]);
  });

  it('handing in is "done"; a quest that stays put is nothing', () => {
    expect(logChanges([q('story:errand:ore', 3)], [], 7)).toEqual([{ key: 'story:errand:ore', kind: 'done', at: 7 }]);
    expect(logChanges([q('story:errand:ore', 2)], [q('story:errand:ore', 2)], 7)).toEqual([]);
    expect(logChanges([q('story:errand:ore', 1)], [q('story:errand:ore', 2)], 7)).toEqual([]);
  });

  it('announces the changes since the conversation began, once', () => {
    const changes = [
      { key: 'story:meadows', kind: 'start' as const, at: 100 },
      { key: 'story:errand:ore', kind: 'start' as const, at: 10 }, // long before
      { key: 'story:ward', kind: 'start' as const, at: 120 }, // no toast for it
    ];
    expect(announcements(changes, new Set(), 90).map((a) => a.seenKey)).toEqual(['story:meadows#start']);
    expect(announcements(changes, new Set(['story:meadows#start']), 90)).toEqual([]);
  });
});

describe('the link between the conversation and the toast', () => {
  afterEach(() => {
    useQuests.setState({ log: { tracked: 0, quests: [] } });
    useDialog.setState({ open: false });
    useTips.setState({ controls: [], enabled: true });
  });

  const log = (step: number) => ({ tracked: 1, quests: [{ id: 1, key: 'story:meadows', kind: 1, title: 'Slimes', giver: '', step, steps: [{ text: 'Talk to Tammir', done: step > 0 }], text: '', progress: 0, need: 0, markers: [], gold: 0, xp: 0 }] });

  it('toasts the fighting controls when the talk with the mentor closes, once per character', () => {
    const kv = new MemKV();
    let t = 1000;
    useQuests.setState({ log: log(0) });
    const stop = installControlLink('nic', kv, () => t);
    useDialog.setState({ open: true });
    t += 50;
    useQuests.setState({ log: log(1) }); // the talk step completes as the conversation opens
    expect(useTips.getState().controls).toHaveLength(0); // not while they are still talking
    t += 3000;
    useDialog.setState({ open: false });
    const c = useTips.getState().controls;
    expect(c).toHaveLength(1);
    expect(c[0].title).toBe('Fighting the slimes');
    expect(c[0].tips.map((x) => x.id)).toEqual(['attack', 'spells', 'dodge', 'draught']);
    expect(loadControlsSeen(kv, 'nic').has('story:meadows#start')).toBe(true);
    stop();

    // A new session of the same character does not repeat it.
    useTips.setState({ controls: [] });
    useQuests.setState({ log: log(0) });
    const stop2 = installControlLink('nic', kv, () => t);
    useDialog.setState({ open: true });
    useQuests.setState({ log: log(1) });
    useDialog.setState({ open: false });
    expect(useTips.getState().controls).toHaveLength(0);
    stop2();
  });

  it('picks up a quest update that arrives just after the close, but not much later', () => {
    let t = 0;
    useQuests.setState({ log: log(0) });
    const stop = installControlLink('late', new MemKV(), () => t);
    useDialog.setState({ open: true });
    t += 1000;
    useDialog.setState({ open: false });
    expect(useTips.getState().controls).toHaveLength(0);
    t += 800;
    useQuests.setState({ log: log(1) });
    expect(useTips.getState().controls).toHaveLength(1);
    useTips.setState({ controls: [] });
    stop();

    t = 0;
    useQuests.setState({ log: log(0) });
    const stop2 = installControlLink('later', new MemKV(), () => t);
    useDialog.setState({ open: true });
    useDialog.setState({ open: false });
    t += GRACE_MS + 500;
    useQuests.setState({ log: log(1) });
    expect(useTips.getState().controls).toHaveLength(0);
    stop2();
  });

  it('shows nothing while tips are turned off', () => {
    useTips.setState({ enabled: false });
    let t = 0;
    useQuests.setState({ log: log(0) });
    const stop = installControlLink('off', new MemKV(), () => t);
    useDialog.setState({ open: true });
    useQuests.setState({ log: log(1) });
    t += 100;
    useDialog.setState({ open: false });
    expect(useTips.getState().controls).toHaveLength(0);
    stop();
  });

  it('a toast expires after its time, and hovering holds it', () => {
    useTips.getState().pushControls(START['story:errand:torch'], 0);
    const id = useTips.getState().controls[0].id;
    useTips.getState().tickControls(11_000, 250);
    expect(useTips.getState().controls).toHaveLength(1);
    useTips.getState().tickControls(13_000, 250);
    expect(useTips.getState().controls).toHaveLength(0);
    useTips.getState().pushControls(START['story:errand:torch'], 0);
    const id2 = useTips.getState().controls[0].id;
    expect(id2).not.toBe(id);
    // The pointer over it: its clock stands still however long it stays.
    controlHover.id = id2;
    for (let i = 1; i <= 120; i++) useTips.getState().tickControls(i * 250, 250);
    expect(useTips.getState().controls).toHaveLength(1);
    controlHover.id = 0;
    useTips.getState().tickControls(30_000 + 13_000, 250);
    expect(useTips.getState().controls).toHaveLength(0);
  });
});
