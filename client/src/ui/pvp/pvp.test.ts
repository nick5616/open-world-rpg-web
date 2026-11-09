// Playtest 2 PvP and duels (CR 019): the client state machine, the hostile
// rule the combat runtime uses, chat commands and the wire decoders.

import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { parseInput } from '../../social/commands';
import { enemyInfo } from '../../combat/events';
import { DUEL_END, DUEL_PHASE, PEV, TYPE_DUELING, TYPE_PVP_FLAG, decodeDuelState, hitRefusalText, refusalText } from './events';
import { hostileTo, initialPvp, reducePvp, type PvpActions, type PvpState } from './store';
import { runPvpCommand } from './link';
import { pvpMark } from './plate';
import { ringGeometry } from './DuelRing';

const enc = new TextEncoder();
const ev = (kind: number, p: Partial<ZoneEvent> = {}): ZoneEvent => ({ type: 'Event', kind, entityId: 0, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: new Uint8Array(0), ...p });

function duelData(radiusCm: number, ms: number, name: string): Uint8Array {
  const n = enc.encode(name);
  const b = new Uint8Array(6 + n.length);
  const v = new DataView(b.buffer);
  v.setUint16(0, radiusCm, true);
  v.setUint32(2, ms, true);
  b.set(n, 6);
  return b;
}

const SELF = 7;
const OPP = 9;

/** Run events through the reducer like the store does. */
function run(events: ZoneEvent[], now = 1000, start: Partial<PvpState> = {}): PvpState {
  let s: PvpState = { ...initialPvp(), selfId: SELF, actions: null, ...start };
  for (const e of events) {
    const p = reducePvp(s, e, now);
    if (p) s = { ...s, ...p };
  }
  return s;
}

describe('flag state (990)', () => {
  it('on, turning off with a countdown, safe zone, off', () => {
    let s = run([ev(PEV.state, { value: 1 })]);
    expect(s.flagged).toBe(true);
    expect(s.notice?.text).toMatch(/PvP on/);
    s = run([ev(PEV.state, { value: 1 | 2, targetId: 10000 })], 5000, s);
    expect(s.turningOff).toBe(true);
    expect(s.offAt).toBe(15000);
    expect(s.notice?.text).toMatch(/turns off in 10 s/);
    s = run([ev(PEV.state, { value: 1 | 4, data: enc.encode('Thornbury') })], 6000, s);
    expect(s.safe).toBe(true);
    expect(s.safeName).toBe('Thornbury');
    expect(s.turningOff).toBe(false);
    s = run([ev(PEV.state, { value: 0 })], 7000, s);
    expect(s.flagged).toBe(false);
    expect(s.notice?.text).toBe('PvP off.');
  });

  it('refusals explain themselves', () => {
    expect(run([ev(PEV.refused, { value: 2, targetId: 3200 })]).notice?.text).toMatch(/Wait 4 s/);
    expect(refusalText(1)).toMatch(/fought too recently/);
    expect(refusalText(5)).toMatch(/party members/);
    expect(hitRefusalText(16)).toMatch(/Safe zone/);
    expect(hitRefusalText(17)).toMatch(/duel/);
    expect(hitRefusalText(5)).toBeNull(); // out of reach: say nothing (as for enemies)
  });
});

describe('duel flow (994-997)', () => {
  it('challenge -> countdown -> fight -> outside -> back -> won', () => {
    let s = run([ev(PEV.challenge, { entityId: OPP, targetId: 3, value: 20000, data: enc.encode('Birch') })], 100);
    expect(s.challenge).toEqual({ duelId: 3, fromId: OPP, fromName: 'Birch', until: 20100 });
    s = run([ev(PEV.duelState, { entityId: OPP, targetId: 3, value: DUEL_PHASE.countdown, x: 100000, y: 2000, z: 50000, data: duelData(2500, 3000, 'Birch') })], 200, s);
    expect(s.challenge).toBeNull();
    expect(s.duel).toMatchObject({ id: 3, opponentId: OPP, opponentName: 'Birch', phase: 2, radius: 25, phaseEnd: 3200, center: { x: 1000, y: 20, z: 500 } });
    s = run([ev(PEV.duelState, { entityId: OPP, targetId: 3, value: DUEL_PHASE.fighting, x: 100000, z: 50000, data: duelData(2500, 180000, 'Birch') })], 3200, s);
    expect(s.duel?.phase).toBe(3);
    s = run([ev(PEV.duelOutside, { value: 5000 })], 4000, s);
    expect(s.duel?.forfeitAt).toBe(9000);
    s = run([ev(PEV.duelOutside, { value: 0 })], 5000, s);
    expect(s.duel?.forfeitAt).toBe(0);
    s = run([ev(PEV.duelEnded, { entityId: SELF, targetId: OPP, value: DUEL_END.defeated, data: enc.encode('Ash defeated Birch in a duel (31 s).') })], 6000, s);
    expect(s.duel).toBeNull();
    expect(s.banner).toEqual({ text: 'Victory!|Ash defeated Birch in a duel (31 s).', kind: 'won', at: 6000 });
  });

  it('lost, draw, declined, expired', () => {
    const fight = run([ev(PEV.duelState, { entityId: OPP, value: 3, data: duelData(2500, 1000, 'Birch') })]);
    expect(run([ev(PEV.duelEnded, { entityId: OPP, targetId: SELF, value: DUEL_END.outside, data: enc.encode('x') })], 1, fight).banner?.kind).toBe('lost');
    expect(run([ev(PEV.duelEnded, { value: DUEL_END.timeUp, data: enc.encode('draw') })], 1, fight).banner?.kind).toBe('draw');
    const declined = run([ev(PEV.duelEnded, { value: DUEL_END.declined, data: enc.encode("Birch declined Ash's duel.") })], 1, fight);
    expect(declined.banner).toBeNull();
    expect(declined.notice?.text).toBe("Birch declined Ash's duel.");
    expect(run([ev(PEV.duelEnded, { value: DUEL_END.expired, data: enc.encode('went unanswered') })]).duel).toBeNull();
  });

  it('decodes 995 exactly', () => {
    const d = decodeDuelState(ev(PEV.duelState, { entityId: OPP, targetId: 4, value: 1, data: duelData(2500, 20000, 'Bïrch') }));
    expect(d).toMatchObject({ duelId: 4, opponentId: OPP, opponentName: 'Bïrch', phase: 1, radius: 25, phaseMs: 20000 });
    expect(decodeDuelState(ev(PEV.duelState, { data: new Uint8Array(3) }))).toBeNull();
  });
});

describe('kill feed (993)', () => {
  it('names you, or both', () => {
    const k = (killer: number, victim: number) => ev(PEV.kill, { entityId: killer, targetId: victim, data: enc.encode(JSON.stringify({ killer: killer === SELF ? 'Ash' : 'Rook', victim: victim === SELF ? 'Ash' : 'Birch' })) });
    const s = run([k(SELF, OPP), k(OPP, SELF), k(11, 12)]);
    expect(s.feed.map((f) => f.text)).toEqual(['You defeated Birch', 'Rook defeated you', 'Rook defeated Birch']);
    expect(s.feed.map((f) => f.mine)).toEqual([true, true, false]);
    expect(run(Array.from({ length: 9 }, () => k(11, 12))).feed).toHaveLength(5);
  });
});

describe('who the runtime may hit', () => {
  const player = (o: Partial<{ id: number; typeId: number; partyId: number; healthPct: number; kind: number }> = {}) => ({ id: OPP, kind: 1, typeId: TYPE_PVP_FLAG | 3, partyId: 0, healthPct: 80, ...o });
  it('the rules matrix (flags x party x duel)', () => {
    const fighting = { opponentId: OPP, phase: DUEL_PHASE.fighting };
    const cases: [string, ReturnType<typeof player>, Parameters<typeof hostileTo>[1], boolean][] = [
      ['both flagged, no parties', player(), { flagged: true, party: 0, duel: null }, true],
      ['both flagged, different parties', player({ partyId: 5 }), { flagged: true, party: 6, duel: null }, true],
      ['both flagged, same party', player({ partyId: 5 }), { flagged: true, party: 5, duel: null }, false],
      ['me unflagged', player(), { flagged: false, party: 0, duel: null }, false],
      ['them unflagged', player({ typeId: 3 }), { flagged: true, party: 0, duel: null }, false],
      ['duel opponent, nobody flagged, same party', player({ typeId: TYPE_DUELING, partyId: 5 }), { flagged: false, party: 5, duel: fighting }, true],
      ['duel opponent during the countdown', player({ partyId: 5 }), { flagged: false, party: 5, duel: { opponentId: OPP, phase: DUEL_PHASE.countdown } }, false],
      ['someone else while I duel', player({ id: 44, typeId: 0 }), { flagged: false, party: 5, duel: fighting }, false],
      ['a downed player', player({ healthPct: 0 }), { flagged: true, party: 0, duel: null }, false],
      ['an enemy is not a player', player({ kind: 2 }), { flagged: true, party: 0, duel: null }, false],
    ];
    for (const [name, v, me, want] of cases) expect(hostileTo(v, me), name).toBe(want);
  });

  it('players are hit as 0.4 m bodies, not as the enemy their typeId would name', () => {
    expect(enemyInfo({ kind: 1, typeId: 0x1001 })).toMatchObject({ radius: 0.4, height: 0.9, family: 'player' });
    expect(enemyInfo({ kind: 2, typeId: 1 }).family).not.toBe('player');
  });

  it('nameplate marks from the typeId bits (weapon look bits ignored)', () => {
    expect(pvpMark(0x0123)).toBe('');
    expect(pvpMark(0x0123 | TYPE_PVP_FLAG)).toBe('pvp');
    expect(pvpMark(TYPE_PVP_FLAG | TYPE_DUELING)).toBe('duel');
  });
});

describe('chat commands', () => {
  it('/pvp, /duel and /yield parse to game verbs', () => {
    const ctx = { activeTab: 'local' };
    expect(parseInput('/pvp', ctx)).toEqual({ kind: 'game', verb: 'pvp', args: '' });
    expect(parseInput('/pvp off', ctx)).toEqual({ kind: 'game', verb: 'pvp', args: 'off' });
    expect(parseInput('/duel Birch', ctx)).toEqual({ kind: 'game', verb: 'duel', args: 'Birch' });
    expect(parseInput('/forfeit', ctx)).toEqual({ kind: 'game', verb: 'yield', args: '' });
  });

  it('run against the actions', () => {
    const calls: string[] = [];
    const a: PvpActions = {
      setFlag: (on) => calls.push(`flag ${on}`),
      challenge: (id) => calls.push(`challenge ${id}`),
      answer: (yes) => calls.push(`answer ${yes}`),
      yieldDuel: () => calls.push('yield'),
    };
    expect(runPvpCommand('pvp', 'on', a)).toBeNull();
    expect(runPvpCommand('pvp', 'off', a)).toBeNull();
    expect(runPvpCommand('pvp', '', a)).toBeNull(); // toggle: not flagged -> on
    expect(runPvpCommand('pvp', 'maybe', a)).toMatch(/Usage/);
    expect(runPvpCommand('duel', 'accept', a)).toBeNull();
    expect(runPvpCommand('duel', 'no', a)).toBeNull();
    expect(runPvpCommand('duel', 'forfeit', a)).toBeNull();
    expect(runPvpCommand('yield', '', a)).toBeNull();
    expect(runPvpCommand('duel', 'Nobody', a)).toMatch(/not nearby/);
    expect(runPvpCommand('duel', '', a)).toMatch(/Usage/);
    expect(runPvpCommand('pvp', 'on', null)).toMatch(/Not in the world/);
    expect(calls).toEqual(['flag true', 'flag false', 'flag true', 'answer true', 'answer false', 'yield', 'yield']);
  });
});

describe('the duel ring', () => {
  it('lies on the ground all the way round', () => {
    const h = (x: number, z: number) => 10 + 0.2 * x - 0.1 * z;
    const g = ringGeometry(100, 50, 25, h);
    const p = g.band.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      expect(Math.abs(Math.hypot(x - 100, z - 50) - 25)).toBeLessThan(0.2);
      expect(p.getY(i)).toBeCloseTo(h(x, z) + 0.06, 5);
    }
    expect(g.curtain.getAttribute('position').count).toBe(p.count);
  });
});
