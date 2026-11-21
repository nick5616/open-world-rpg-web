import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { CONTENT, COMBAT, ITEMS } from '@lodestone/contracts';
import { FINALE, SEV, actSubtitle, memberLine, roman, secsLeft } from './events';
import { emptyStory, pruneStory, reduceStoryEvent, reviveTarget, LINE_MS } from './store';
import { creditRoll, parseCredits } from './credits';
import { E_ORDER } from '../../input/interact';
import { QUEST_KIND_LABEL } from '../quests/events';

const enc = new TextEncoder();
function ev(kind: number, data: unknown, extra: Partial<ZoneEvent> = {}): ZoneEvent {
  return { kind, entityId: 0, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: data === undefined ? new Uint8Array() : enc.encode(typeof data === 'string' ? data : JSON.stringify(data)), ...extra } as ZoneEvent;
}

describe('act card gates (co-op polish)', () => {
  it('shows the level an act asks for', () => {
    const c = { act: 6, eyebrow: 'The Last Song · Act VI', title: 'The Heartfall', subtitle: 'The Hush waits' };
    expect(actSubtitle(c)).toBe('The Hush waits');
    expect(actSubtitle({ ...c, level: 22, you: 30 })).toBe('The Hush waits · level 22+');
    expect(actSubtitle({ ...c, level: 22, you: 19 })).toContain('first reach level 22 (you are 19');
  });
});

describe('main story (CR 035)', () => {
  it('keeps the story sync, the party, the finale and the ending', () => {
    let s = { ...emptyStory(), self: 7 };
    const sync = { title: 'The Last Song', act: 3, step: 1, acts: [1, 2, 3, 4, 5, 6].map((n) => ({ n, title: `A${n}`, level: 0, done: n < 3 })), beaten: 0, together: 0, vow: false, heartfall: [3564, 437, 30], arena: 'The Verdant Downs' };
    s = reduceStoryEvent(s, ev(SEV.sync, sync), 0);
    expect(s.sync?.act).toBe(3);
    const party = { leader: 9, you: { id: 7, name: 'Nicole', act: 3, step: 1, steps: 4, text: '', title: '', dist: 0 }, members: [{ id: 9, name: 'Friend', act: 4, step: 1, steps: 6, text: 'Find Gartha', title: 'The Night Unsung', dist: 120 }], behind: true };
    s = reduceStoryEvent(s, ev(SEV.party, party), 0);
    expect(s.party?.behind).toBe(true);
    expect(memberLine(s.party!.members[0])).toBe('Friend · Act IV, step 2/6: Find Gartha');
    s = reduceStoryEvent(s, ev(SEV.party, ''), 0); // left the party
    expect(s.party).toBeNull();
    s = reduceStoryEvent(s, ev(SEV.finale, { phase: FINALE.night, x: 1, z: 2, r: 30, boss: 5, shroud: 0, shroudMs: 0, bells: 0, wells: [{ x: 1, z: 2, r: 3.5 }], nightMs: 6000, hard: false, stagger: false }), 100);
    expect(s.finale?.wells.length).toBe(1);
    expect(s.finale?.at).toBe(100);
    s = reduceStoryEvent(s, ev(SEV.finaleIntro, { eyebrow: 'The Heartfall', title: 'The Hush', subtitle: 'Mother of the Unsung', lines: ['So.'], ms: 7000, hard: false, x: 0, z: 0, boss: 5 }), 200);
    expect(s.cinematic?.title).toBe('The Hush');
    s = reduceStoryEvent(s, ev(SEV.ending, { title: 'The Last Song', lines: ['a', 'b'], together: true, hard: false, names: ['Nicole', 'Friend'], first: true, earned: 'the Dawnsinger' }), 300);
    expect(s.ending?.together).toBe(true);
    expect(s.cinematic).toBeNull();
  });

  it('shows the lines of the story speakers and refusals, briefly', () => {
    let s = { ...emptyStory(), self: 7 };
    s = reduceStoryEvent(s, ev(SEV.say, { speaker: 'The Hush', text: 'Hush now.' }), 0);
    s = reduceStoryEvent(s, ev(SEV.say, { speaker: 'The Hush', text: 'Hush now.' }), 10); // a repeat replaces
    s = reduceStoryEvent(s, ev(SEV.refused, undefined, { value: 2 }), 20);
    expect(s.lines.map((l) => l.text)).toEqual(['Hush now.', 'Nobody in your party is ahead of you in the story']);
    expect(pruneStory(s, LINE_MS + 30)?.lines).toEqual([]);
  });

  it('revives: a friend down near you, the hold, raised', () => {
    let s = { ...emptyStory(), self: 7 };
    s = reduceStoryEvent(s, ev(SEV.reviveWindow, { id: 9, name: 'Friend', ms: 20000, x: 10, y: 0, z: 10, helpers: 1 }, { entityId: 9 }), 0);
    expect(reviveTarget(s, 11, 11)?.name).toBe('Friend');
    expect(reviveTarget(s, 30, 30)).toBeNull();
    s = reduceStoryEvent(s, ev(SEV.reviveProgress, undefined, { entityId: 7, targetId: 9, value: 3000 }), 5);
    expect(s.reviving).toMatchObject({ by: 7, target: 9, ms: 3000 });
    s = reduceStoryEvent(s, ev(SEV.revived, 'Nicole', { entityId: 9, targetId: 7 }), 3100);
    expect(s.downed[9]).toBeUndefined();
    expect(s.reviving).toBeNull();
    // You, down: the window, then raised.
    s = reduceStoryEvent(s, ev(SEV.reviveWindow, { id: 7, name: 'Nicole', ms: 20000, x: 0, y: 0, z: 0, helpers: 1 }, { entityId: 7 }), 4000);
    expect(s.reviveUntil).toBe(24000);
    s = reduceStoryEvent(s, ev(SEV.revived, 'Friend', { entityId: 7, targetId: 9 }), 5000);
    expect(s.reviveUntil).toBe(0);
    expect(s.lines.at(-1)?.text).toBe('Friend raises you to your feet.');
    expect(pruneStory({ ...s, reviveUntil: 10 }, 20)?.reviveUntil).toBe(0);
  });

  it('rolls credits from CREDITS.md after the game\'s own lines', () => {
    const md = '# Credits\n\n## Textures\n\nAll sets are CC0 ([3dtextures.me](https://3dtextures.me)).\n\n| Set | Page | Used for |\n| --- | --- | --- |\n| Grass 005 | https://x | Terrain: grass |\n\n## Code\n\n- `postprocessing` (Zlib).\n<!-- audio:begin -->\n## Audio\n\nMusic: Nicole\'s tracks.\n';
    const b = parseCredits(md);
    expect(b.map((x) => x.heading)).toEqual(['Textures', 'Code', 'Audio']);
    expect(b[0].lines).toEqual(['All sets are CC0 (3dtextures.me).', 'Grass 005 — Terrain: grass']);
    expect(b[1].lines).toEqual(['postprocessing (Zlib).']);
    const roll = creditRoll(['Nicole', 'Friend']);
    expect(roll[0].heading).toBe('Lodestone');
    expect(roll[1].lines).toEqual(['Nicole', 'Friend']);
    expect(roll.some((x) => x.heading === 'Textures' && x.lines.length > 5)).toBe(true); // the real CREDITS.md
    expect(roll.at(-1)?.heading).toBe('Thank you for playing');
  });

  it('wires into the contracts and the HUD', () => {
    expect(COMBAT.enemies.some((e) => e.key === 'the_hush' && e.family === 'boss')).toBe(true);
    expect(COMBAT.enemies.some((e) => e.key === 'hollow_bell' && e.demon)).toBe(true);
    for (const k of ['quest:keepers_fork', 'quest:verse_dawn', 'quest:verse_dusk', 'quest:archon_lens', 'quest:dawnheart']) expect(ITEMS.items.some((i) => i.key === k), k).toBe(true);
    const ach = CONTENT.achievements.filter((a) => ['last_song', 'dawn_together', 'starless_unbroken', 'two_against_dark', 'not_today'].includes(a.key));
    expect(ach.length).toBe(5);
    expect(ach.find((a) => a.key === 'last_song')?.title).toBe('the Dawnsinger');
    expect(E_ORDER.indexOf('revive')).toBeLessThan(E_ORDER.indexOf('loot')); // raising a friend beats the loot at their feet
    expect(QUEST_KIND_LABEL[3]).toBe('Main story');
    expect(roman(6)).toBe('VI');
    expect(secsLeft(6100)).toBe('7 s');
  });
});
