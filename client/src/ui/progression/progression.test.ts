import { describe, expect, it } from 'vitest';
import { COMBAT, type Event as ZoneEvent } from '@lodestone/contracts';
import { decodeArea, decodeStats, encodeArea, encodeStats, PEV, STATS_REASON } from './events';
import { gainLines, learnable, statsAt, tierLevel, unlocksAt, upcoming } from './gains';
import { reduceProgressionEvent, type ProgressionState } from './store';
import { towerPrompt, type TowerLike } from './towerPrompt';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
// The same vectors as server/zone/internal/game/progression_test.go.
const STATS_HEX = '010104000100cc0100000000000028000000dc000000880079006a00f000050501010001';
const AREA_HEX = '01040300010f005665746572616e';

const ev = (kind: number, value: number, targetId: number, data: Uint8Array): ZoneEvent => ({ type: 'Event', kind, entityId: 1, targetId, value, x: 1000, y: 0, z: 2000, data });

const empty = (): ProgressionState => ({ stats: null, area: null, fanfare: null, notices: [], panelOpen: false, attuned: null, actions: null });

describe('progression wire (Go vectors)', () => {
  it('decodes character_stats', () => {
    const s = decodeStats(hex(STATS_HEX))!;
    expect(s).toMatchObject({ reason: STATS_REASON.levelUp, level: 4, prevLevel: 1, xpInto: 40, xpNext: 220, healthMax: 136, manaMax: 121, staminaMax: 106, damagePct: 24, skillFree: 5, skillTotal: 5, attunedCount: 1 });
    expect(s.xp).toBe(460n);
    expect(Array.from(s.attuned)).toEqual([1]);
    const back = encodeStats({ ...s });
    expect(Buffer.from(back).toString('hex')).toBe(STATS_HEX);
  });
  it('decodes area', () => {
    const a = decodeArea({ targetId: 77, value: 15, x: 1000, z: 2000, data: hex(AREA_HEX) })!;
    expect(a).toMatchObject({ cell: 77, level: 15, tierIndex: 4, tierKey: 'dread', haven: true, byYou: true, provisional: false, cellM: 256, byLevel: 15, by: 'Veteran', x: 10, z: 20 });
    expect(Buffer.from(encodeArea(4, 3, 256, 15, 'Veteran')).toString('hex')).toBe(AREA_HEX);
  });
});

describe('leveling (combat.yaml leveling)', () => {
  it('grows every level', () => {
    const a = statsAt(1);
    const b = statsAt(4);
    expect(a.health).toBe(COMBAT.leveling.health.base);
    expect(b.health - a.health).toBe(3 * COMBAT.leveling.health.perLevel);
    expect(b.damagePct).toBe(3 * COMBAT.leveling.damagePctPerLevel);
    expect(b.skillPoints - a.skillPoints).toBe(3);
    expect(statsAt(1, 2).stamina - a.stamina).toBe(2 * COMBAT.leveling.attune.stamina);
  });
  it('lists gains and tier unlocks for the fanfare', () => {
    const lines = gainLines(2, 3);
    expect(lines[0]).toBe(`+${COMBAT.leveling.health.perLevel} health`);
    expect(lines).toContain('+1 skill point');
    expect(lines.some((l) => l.startsWith('Unlocked: Spell trees tier 4'))).toBe(true);
    expect(unlocksAt(14)[0]).toContain('domain');
    expect(tierLevel(1)).toBe(1);
    expect(tierLevel(12)).toBe(18);
  });
  it('always shows a goal ahead', () => {
    const u = upcoming(4);
    expect(u.slice(0, 4).map((x) => x.level)).toEqual([5, 6, 7, 8]);
    expect(u.find((x) => x.level === 6)!.lines.some((l) => l.includes('tier 6'))).toBe(true);
    expect(u[u.length - 1].level).toBe(10);
  });
  it('knows which spells a skill point can learn', () => {
    const l = learnable(COMBAT.start.spells, 1);
    const fireball = l.find((s) => s.key === 'spark_shot');
    expect(fireball?.ready).toBe(true);
    expect(l.find((s) => s.key === 'glint')?.ready).toBe(true); // Light: the anti-demon school, open from level 1
    expect(l.every((s) => !COMBAT.start.spells.includes(s.key))).toBe(true);
  });
});

describe('progression store', () => {
  it('a level-up stats event raises the fanfare with what was gained', () => {
    const p = reduceProgressionEvent(empty(), ev(PEV.characterStats, 4, 1, hex(STATS_HEX)), 1000)!;
    expect(p.stats?.level).toBe(4);
    expect(p.fanfare).toMatchObject({ level: 4, prev: 1 });
    expect(p.fanfare!.lines[0]).toBe(`+${3 * COMBAT.leveling.health.perLevel} health`);
  });
  it('a sync stats event does not', () => {
    const d = encodeStats({ reason: 0, level: 4, prevLevel: 4, xp: 460n, xpInto: 40, xpNext: 220, healthMax: 136, manaMax: 121, staminaMax: 106, damagePct: 24, skillFree: 5, skillTotal: 5, attunedCount: 0 });
    expect(reduceProgressionEvent(empty(), ev(PEV.characterStats, 4, 0, d), 1000)!.fanfare).toBeUndefined();
  });
  it('area notices: stamped by you, tier changes, the Haven', () => {
    const s = empty();
    const byYou = reduceProgressionEvent(s, ev(PEV.area, 15, 1, encodeArea(4, 2, 256, 15, 'Veteran')), 0)!;
    expect(byYou.notices![0].title).toContain('takes your measure');
    const haven = reduceProgressionEvent(s, ev(PEV.area, 1, 1, encodeArea(0, 1, 256, 0, '')), 0)!;
    expect(haven.notices![0]).toMatchObject({ kind: 'safe', title: 'The Haven' });
    const same = reduceProgressionEvent({ ...s, area: haven.area! }, ev(PEV.area, 1, 2, encodeArea(0, 1, 256, 0, '')), 0)!;
    expect(same.notices).toBeUndefined();
  });
  it('tower_attuned names the region and the boon', () => {
    const p = reduceProgressionEvent(empty(), ev(PEV.towerAttuned, 5, 12, new TextEncoder().encode('Ashmoor')), 0)!;
    expect(p.attuned).toMatchObject({ site: 12, region: 5, name: 'Ashmoor' });
    expect(p.notices![0].title).toBe('Crystal attuned: Ashmoor');
  });
});

describe('crystal tower prompt', () => {
  const towers: TowerLike[] = [{ site: 3, cx: 100, cz: 100, topY: 60, maxR: 14 }];
  const no = () => false;
  it('hints to climb when near a tower you have not climbed', () => {
    expect(towerPrompt(towers, 140, 10, 100, no, no)?.kind).toBe('climb');
    expect(towerPrompt(towers, 400, 10, 100, no, no)).toBeNull();
  });
  it('offers the attunement on the top, then says it is done', () => {
    expect(towerPrompt(towers, 101, 60, 100, () => true, no)).toMatchObject({ kind: 'attune', site: 3 });
    expect(towerPrompt(towers, 101, 60, 100, () => true, () => true)?.kind).toBe('attuned');
    expect(towerPrompt(towers, 120, 10, 100, () => true, no)?.kind).toBe('return');
    expect(towerPrompt(towers, 120, 10, 100, () => true, () => true)).toBeNull();
  });
});
