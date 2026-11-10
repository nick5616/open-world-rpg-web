import { describe, expect, it } from 'vitest';
import raw from './changelog.json';
import { changelogProblems, hasOlderSettings, MAX_SHOWN, validEntries, whatsNew, type ChangelogEntry } from './news';

const e = (id: string, date = '2026-11-01'): ChangelogEntry => ({ id, date, title: id, items: ['x'] });
const list = [e('c', '2026-11-03'), e('b', '2026-11-02'), e('a', '2026-11-01')];

describe("what's new", () => {
  it('the shipped changelog is well formed (newest first, unique ids, dates, lines)', () => {
    expect(changelogProblems(raw)).toEqual([]);
    expect(validEntries(raw).length).toBe((raw as unknown[]).length);
  });

  it('shows only the entries newer than the one this browser saw', () => {
    expect(whatsNew(list, 'a', false)).toEqual({ kind: 'news', entries: [list[0], list[1]], newest: 'c' });
    expect(whatsNew(list, 'b', true)).toEqual({ kind: 'news', entries: [list[0]], newest: 'c' });
    expect(whatsNew(list, 'c', true)).toEqual({ kind: 'none' });
  });

  it('a first-time player gets a welcome, a returning one (older settings, no marker) the list', () => {
    expect(whatsNew(list, null, false)).toEqual({ kind: 'welcome', newest: 'c' });
    expect(whatsNew(list, null, true)).toMatchObject({ kind: 'news', entries: list });
    expect(hasOlderSettings(['lodestone_view_settings'])).toBe(true);
    expect(hasOlderSettings(['lodestone.audio.v1'])).toBe(true);
    expect(hasOlderSettings(['lodestone_whatsnew_seen', 'lodestone_tips_enabled', 'lodestone_tips_seen:abc', 'other'])).toBe(false);
  });

  it('an unknown id (entry removed) shows the newest few; long gaps are capped', () => {
    expect(whatsNew(list, 'gone', false)).toMatchObject({ kind: 'news', entries: list.slice(0, 3) });
    const many = Array.from({ length: 20 }, (_, i) => e(`n${20 - i}`));
    const r = whatsNew(many, 'n1', false);
    expect(r.kind === 'news' && r.entries.length).toBe(MAX_SHOWN);
    expect(whatsNew([], null, true)).toEqual({ kind: 'none' });
  });

  it('a malformed changelog is reported and filtered, never thrown', () => {
    const bad = [e('ok', '2026-11-02'), { id: 'Bad Id', date: '2026-11-01', title: 't', items: ['x'] }, { id: 'nodate', title: 't', items: ['x'] }, e('ok'), { id: 'empty', date: '2026-11-01', title: 't', items: [] }, null, e('later', '2026-12-01')];
    const problems = changelogProblems(bad);
    expect(problems.length).toBe(6);
    expect(problems.join('\n')).toMatch(/duplicate id/);
    expect(problems.join('\n')).toMatch(/newest first/);
    expect(validEntries(bad).map((x) => x.id)).toEqual(['ok', 'later']);
    expect(validEntries({ not: 'a list' })).toEqual([]);
    expect(changelogProblems('nope')).toEqual(['the changelog is not a list']);
  });
});
