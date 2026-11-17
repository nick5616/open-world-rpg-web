import { describe, expect, it } from 'vitest';
import { BASELINE_RING, decodeMessage, encodeMessage, InputFlag, metersToCm, velToCms, yawToU16, type EntityRecord, type Snapshot } from '@lodestone/contracts';
import { FlatGround } from '../sim/ground';
import { newMoveState, stepMovement, STEP_DT, type MoveInput, type MoveState } from '../sim/movement';
import { selfFields } from '../sim/moveWire';
import { ClockSync } from './clockSync';
import { EntityInterpolation, ringFor } from './interpolation';
import { ClientPrediction } from './prediction';
import { applyRecord, SnapshotDecoder, type EntState, type FullSelf } from './snapshotDecoder';
import { FrameParser, lengthPrefixed, splitCertHash, wsHeaderLen } from './transport';
import { activityLabels } from './avatar';

const ground = new FlatGround(0);

// ---------------------------------------------------------------- clock
describe('ClockSync', () => {
  it('trusts the lowest-RTT sample and slews small changes', () => {
    let now = 1000;
    const c = new ClockSync(() => now);
    // Server is 5000 ms ahead; symmetric 40 ms RTT.
    now = 1040;
    c.onPong(1000, 6020, 6020);
    expect(c.offset).toBeCloseTo(5000, 6);
    expect(c.rtt).toBe(40);
    // A queued sample (asymmetric, 200 ms RTT) must not move the estimate.
    now = 2200;
    c.onPong(2000, 7180, 7180);
    expect(c.offset).toBeCloseTo(5000, 6);
    expect(c.minRtt).toBe(40);
    // A better sample 10 ms off is slewed in at <= 3 ms per sample.
    now = 3020;
    c.onPong(3000, 8020, 8020); // offset 5010, rtt 20
    expect(c.offset).toBeCloseTo(5003, 6);
    expect(c.serverNow()).toBeCloseTo(3020 + 5003, 6);
  });
});

// ---------------------------------------------------------------- decoder
function ent(id: number, x: number): EntState {
  return { id, kind: 1, x, y: 0, z: 500, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, healthPct: 100, activity: 0, typeId: 0, name: 'p', level: 1, partyId: 0, appearance: 0, light: 0 };
}

/** Reference delta encoder mirroring server/pkg/snapshot Diff (presence = mask bit). */
function diff(base: EntState | undefined, cur: EntState): EntityRecord {
  const r: EntityRecord = { id: cur.id };
  const z = base ?? { ...ent(cur.id, 0), kind: 0, z: 0, healthPct: 0, name: '', level: 0 };
  const keys = ['kind', 'x', 'y', 'z', 'yaw', 'pitch', 'vx', 'vy', 'vz', 'healthPct', 'activity', 'typeId', 'name', 'level', 'partyId', 'appearance'] as const;
  for (const k of keys) {
    if (cur[k] !== z[k] || (!base && (k === 'kind' || k === 'name'))) (r as unknown as Record<string, unknown>)[k] = cur[k];
  }
  return r;
}

describe('SnapshotDecoder', () => {
  it('applies masked deltas against the acked baseline, zero-state first sight, removals', () => {
    const d = new SnapshotDecoder();
    const self = { x: 1 };
    const s1 = decodeMessage(encodeMessage({ type: 'Snapshot', tick: 1, baselineTick: 0, ackInputSeq: 0, serverTime: 10, self, entities: [diff(undefined, ent(1, 0)), diff(undefined, ent(2, 0))], removed: [] })) as Snapshot;
    const r1 = d.apply(s1);
    expect(r1.ok && r1.frame.ents.length).toBe(2);
    // First sight omitted zero fields (x = 0) but they decode as 0.
    expect(s1.entities[0].x).toBeUndefined();
    const a = { ...ent(1, 10), yaw: 7 };
    const s2 = decodeMessage(encodeMessage({ type: 'Snapshot', tick: 2, baselineTick: 1, ackInputSeq: 5, serverTime: 43, self: {}, entities: [diff(ent(1, 0), a), diff(undefined, ent(3, 0))], removed: [2] })) as Snapshot;
    const r2 = d.apply(s2);
    if (!r2.ok) throw new Error(r2.reason);
    expect(r2.frame.ents.map((e) => e.id)).toEqual([1, 3]);
    expect(r2.frame.ents[0]).toEqual(a);
    expect(r2.frame.self.x).toBe(1); // unchanged self field carried from the baseline
    expect([...r2.frame.updated].sort()).toEqual([1, 3]);
    expect(d.apply(s2)).toEqual({ ok: false, reason: 'stale' });
    expect(d.apply({ ...s2, tick: 50, baselineTick: 40 })).toEqual({ ok: false, reason: 'no_baseline' });
  });

  it('agrees with a reference encoder under random motion, loss and lagging acks', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const world = new Map<number, EntState>();
    for (let id = 1; id <= 30; id++) world.set(id, ent(id, Math.floor(rand() * 1000)));
    const sent = new Map<number, EntState[]>(); // encoder frames by tick
    const dec = new SnapshotDecoder();
    let acked = 0;
    for (let tick = 1; tick < 600; tick++) {
      for (const e of world.values()) if (rand() < 0.3) e.x += Math.floor(rand() * 21) - 10;
      const interest = [...world.values()].filter(() => rand() < 0.85).map((e) => ({ ...e }));
      const base = acked && tick - acked < BASELINE_RING ? sent.get(acked) : undefined;
      const recs: EntityRecord[] = [];
      for (const e of interest) {
        const b = base?.find((x) => x.id === e.id);
        const r = diff(b, e);
        if (!b || Object.keys(r).length > 1) recs.push(r);
      }
      const removed = base ? base.filter((b) => !interest.some((e) => e.id === b.id)).map((b) => b.id) : [];
      sent.set(tick, interest.sort((x, y) => x.id - y.id));
      const s = decodeMessage(encodeMessage({ type: 'Snapshot', tick, baselineTick: base ? acked : 0, ackInputSeq: 0, serverTime: tick, self: {}, entities: recs, removed })) as Snapshot;
      if (rand() < 0.2) continue; // lost
      const r = dec.apply(s);
      if (!r.ok) throw new Error(`tick ${tick}: ${r.reason}`);
      expect(r.frame.ents).toEqual(sent.get(tick));
      if (rand() < 0.75) acked = dec.latest;
    }
  });

  it('applyRecord onto zero state', () => {
    expect(applyRecord(undefined, { id: 9, kind: 1, name: 'Ann' })).toMatchObject({ id: 9, kind: 1, name: 'Ann', x: 0, healthPct: 0 });
  });
});

// ---------------------------------------------------------------- prediction
function walkInput(): MoveInput {
  return { flags: InputFlag.forward, yaw: yawToU16(0.3), pitch: 0 };
}

function quant(s: MoveState, airJumps = s.airJumps): FullSelf {
  return { x: metersToCm(s.pos.x), y: metersToCm(s.pos.y), z: metersToCm(s.pos.z), vx: velToCms(s.vel.x), vy: velToCms(s.vel.y), vz: velToCms(s.vel.z), health: 100, healthMax: 100, ...selfFields(s), airJumps };
}

describe('ClientPrediction', () => {
  it('agrees silently when the server ran the same frames, and corrects with replay when it did not', () => {
    const p = new ClientPrediction(ground);
    let s: MoveState = newMoveState({ x: 2048, y: 0, z: 2048 });
    const states: MoveState[] = [];
    for (let seq = 1; seq <= 30; seq++) {
      s = stepMovement(s, walkInput(), ground, STEP_DT);
      states.push(s);
      p.store({ seq, input: walkInput(), state: s });
      p.notePredicted(s);
    }
    // Server acks frame 20 with exactly our state: no correction.
    expect(p.reconcile(quant(states[19]), 20)).toBeNull();
    expect(p.agreements).toBe(1);
    expect(p.unacked).toBe(10);
    // Server dropped a frame (its state at "25" is our state at 24): replay.
    const c = p.reconcile(quant(states[23]), 25);
    expect(c).not.toBeNull();
    expect(c!.unacked).toBe(5);
    // The corrected present is one step behind ours, ~8 cm at walking speed.
    expect(c!.magnitude).toBeGreaterThan(0.05);
    expect(c!.magnitude).toBeLessThan(0.12);
    expect(p.takeCorrection()).toBe(c);
    expect(p.takeCorrection()).toBeNull();
    expect(p.log.length).toBe(1);
  });

  it('replays a grounded server state from the ground, not from its cm-rounded y (G3)', () => {
    // Standing on ground whose height is not a whole centimetre: the wire y
    // is 0.44 cm above it. The replay must keep the WP10 timer in step with
    // the server, or every later snapshot disagrees again.
    const g = new FlatGround(100.3456);
    const idle: MoveInput = { flags: 0, yaw: 0, pitch: 0 };
    let server: MoveState = newMoveState({ x: 10, y: 100.3456, z: 10 });
    const p = new ClientPrediction(g);
    let client: MoveState = { ...newMoveState({ x: 10, y: 100.3456, z: 10 }), timer: 7 }; // out of step (as after a teleport)
    const serverAt: MoveState[] = [];
    for (let seq = 1; seq <= 12; seq++) {
      server = stepMovement(server, idle, g, STEP_DT);
      serverAt.push(server);
      client = stepMovement(client, idle, g, STEP_DT);
      p.store({ seq, input: idle, state: client });
      p.notePredicted(client);
    }
    const c = p.reconcile(quant(serverAt[3]), 4);
    expect(c).not.toBeNull();
    expect(c!.state.timer).toBe(serverAt[11].timer);
    expect(c!.state.mode).toBe(serverAt[11].mode);
    // The replayed history now matches the server: the next ack agrees.
    expect(p.reconcile(quant(serverAt[7]), 8)).toBeNull();
    expect(p.reconciles).toBe(1);
  });

  it('adopts a grown stamina wheel (level-up, tower boon) without counting a correction (playtest 1)', () => {
    const p = new ClientPrediction(ground);
    let s: MoveState = newMoveState({ x: 2048, y: 0, z: 2048 });
    const states: MoveState[] = [];
    for (let seq = 1; seq <= 10; seq++) {
      s = stepMovement(s, walkInput(), ground, STEP_DT);
      states.push(s);
      p.store({ seq, input: walkInput(), state: s });
      p.notePredicted(s);
    }
    // The zone grew the wheel by 2 points and refilled it at frame 5.
    const grown = { ...states[4], staminaMax: states[4].staminaMax + 120, stamina: states[4].staminaMax + 120 };
    const c = p.reconcile(quant(grown), 5);
    expect(c).not.toBeNull();
    expect(c!.magnitude).toBeLessThan(0.02); // cm quantization only
    expect(c!.state.staminaMax).toBe(grown.staminaMax);
    expect(p.reconciles).toBe(0);
    expect(p.wheelResyncs).toBe(1);
  });

  it('ignores older acks and the spawn snapshot before any input is applied', () => {
    const p = new ClientPrediction(ground);
    expect(p.reconcile(quant(newMoveState({ x: 1, y: 0, z: 1 })), 0)).toBeNull();
    const s = stepMovement(newMoveState({ x: 1, y: 0, z: 1 }), walkInput(), ground, STEP_DT);
    p.store({ seq: 1, input: walkInput(), state: s });
    expect(p.reconcile(quant(s), 1)).toBeNull();
    expect(p.reconcile(quant(s), 0)).toBeNull();
  });
});

// ---------------------------------------------------------------- interpolation
describe('EntityInterpolation', () => {
  const local = { x: 0, z: 0 };
  function feed(it: EntityInterpolation, ticks: number, opts: { lossEvery?: number; speedCms?: number; t0?: number } = {}) {
    const t0 = opts.t0 ?? 1_000_000;
    const v = opts.speedCms ?? 489;
    for (let k = 0; k < ticks; k++) {
      const st = t0 + k * (1000 / 30);
      it.onSnapshot(st, st + 50); // constant 50 ms one-way, no jitter
      if (opts.lossEvery && k % opts.lossEvery === 0) continue;
      const e = { ...ent(7, Math.round((k * v) / 30)), vx: v, name: 'Remy' };
      it.record(e, st, local);
    }
    return t0 + (ticks - 1) * (1000 / 30) + 50; // arrival time of the last
  }

  it('interpolates smoothly behind real time with the near-ring delay, no extrapolation on a clean link', () => {
    const it = new EntityInterpolation(ground);
    const now = feed(it, 60);
    const views = [];
    for (let f = 0; f < 30; f++) views.push(...it.update(now + f * 16.7 - 500, 16.7).map((v) => ({ ...v })));
    expect(views.every((v) => v.mode === 'interp')).toBe(true);
    expect(it.metrics.extrapEvents).toBe(0);
    expect(it.metrics.teleports).toBe(0);
    // Positions advance monotonically at ~4.89 m/s.
    for (let k = 1; k < views.length; k++) expect(views[k].x).toBeGreaterThanOrEqual(views[k - 1].x - 1e-9);
    expect(views[0].name).toBe('Remy');
    expect(views[0].ring).toBe('near');
  });

  it('dead-reckons with the wire velocity when samples stop, and counts it', () => {
    const it = new EntityInterpolation(ground);
    const now = feed(it, 30);
    // 250 ms after the last arrival, render time is past the newest sample.
    it.update(now + 250, 16.7);
    const [v] = it.update(now + 267, 16.7);
    expect(v.mode).toBe('extrap');
    expect(it.metrics.extrapEvents).toBe(1);
    // Standing still is never counted as extrapolation.
    const still = new EntityInterpolation(ground);
    const n2 = feed(still, 30, { speedCms: 0 });
    still.update(n2 + 400, 16.7);
    expect(still.metrics.extrapEvents).toBe(0);
  });

  it('cuts teleports instead of lerping across the map, and removes after the render clock passes', () => {
    const it = new EntityInterpolation(ground);
    const t0 = 2_000_000;
    it.onSnapshot(t0, t0);
    it.record(ent(1, 0), t0, local);
    it.onSnapshot(t0 + 33, t0 + 33);
    it.record(ent(1, 50_000), t0 + 33, local); // 500 m in a tick
    expect(it.metrics.teleports).toBe(1);
    it.remove(1, t0 + 40);
    expect(it.update(t0 + 120, 16).length).toBe(1); // render time t0+20: still before the removal
    expect(it.update(t0 + 2000, 16).length).toBe(0);
  });

  it('uses per-ring delay floors', () => {
    expect(ringFor(10)).toBe('near');
    expect(ringFor(100)).toBe('mid');
    expect(ringFor(400)).toBe('far');
    const it = new EntityInterpolation(ground);
    const t0 = 3_000_000;
    for (let k = 0; k < 20; k++) {
      it.onSnapshot(t0 + k * 500, t0 + k * 500);
      it.record({ ...ent(5, 40000 + k * 100), vx: 200 }, t0 + k * 500, local); // 400 m away, 2 Hz
    }
    for (let f = 0; f < 400; f++) it.update(t0 + 9500 + f * 16, 16);
    const [v] = it.update(t0 + 9500 + 400 * 16, 16);
    expect(v.ring).toBe('far');
    expect(v.delayMs).toBeGreaterThanOrEqual(1000);
  });
});

// ---------------------------------------------------------------- transport helpers
describe('transport framing', () => {
  it('reassembles length-prefixed frames split across chunks', () => {
    const p = new FrameParser();
    const a = lengthPrefixed(new Uint8Array([64, 1, 2]));
    const b = lengthPrefixed(new Uint8Array(300).fill(7));
    const all = new Uint8Array([...a, ...b]);
    const out = [...p.push(all.slice(0, 2)), ...p.push(all.slice(2, 100)), ...p.push(all.slice(100))];
    expect(out.length).toBe(2);
    expect([...out[0]]).toEqual([64, 1, 2]);
    expect(out[1].length).toBe(300);
    expect(() => new FrameParser(10).push(lengthPrefixed(new Uint8Array(11)))).toThrow();
  });

  it('splits the #certHash fragment like the Go side', () => {
    const hash = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const r = splitCertHash(`https://localhost:8092/wt#certHash=${hash}`);
    expect(r.url).toBe('https://localhost:8092/wt');
    expect(r.hash?.length).toBe(32);
    expect(splitCertHash('https://x/wt').hash).toBeNull();
    expect(wsHeaderLen(100, true)).toBe(6);
    expect(wsHeaderLen(200, false)).toBe(4);
  });

  it('names activity flags for nameplates', () => {
    expect(activityLabels(0)).toEqual([]);
    expect(activityLabels(32 | 128)).toEqual(['typing…', 'airborne']);
  });
});
