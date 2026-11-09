// Building doors (playtest follow-up to WP20): the TS side of the door boxes
// and push-out replays server/pkg/towns/testdata/doors.json (written by the
// Go port) bit for bit; door states stamp by step; the door ground is the
// town ground while every door is open; the wire decoders and DoorSync
// (events -> states, late events re-predict, refusals, offline toggles).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DoorStates, fnv1a64, hex64, parseTowns, TownCollision, TownDoors, townsBytes, type TownCollideResult, type Towns } from '@lodestone/worldgen';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { loadWorldgenGround } from '../../sim/worldgenGround';
import { repoRoot } from '../../sim/dev/traversalRun';
import { stepClock } from '../../sim/stepClock';
import { DoorGround } from './doorGround';
import { TownGround } from './townGround';
import { ClientPrediction } from '../../net/prediction';
import { FlatGround } from '../../sim/ground';
import { makeMoveInput, NO_BUTTONS } from '../../sim/inputFrame';
import { newMoveState, stepMovement, STEP_DT, type MoveState } from '../../sim/movement';
import { DoorSync, decodeDoorBaseline, decodeDoorState, DOOR_EV } from './doors';

const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');
const vectors = path.join(repoRoot, 'server', 'pkg', 'towns', 'testdata', 'doors.json');
const hasWasm = fs.existsSync(wasm);

interface DoorFile {
  worlds: { seed: string; count: number; hash: string; boxes: { d: number; building: number; prop: number; id: string; f: string[] }[]; collide: { X: number; Y: number; Z: number; doors: string; ground: string }[] }[];
}

const bits = (v: number) => {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, v, true);
  return hex64(d.getBigUint64(0, true));
};
const res = (r: TownCollideResult) => `${bits(r.x)},${bits(r.y)},${bits(r.z)},${bits(r.pushX)},${bits(r.pushZ)},${r.ceiling ? 1 : 0}`;
const fresh = (): TownCollideResult => ({ x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false });

function doorHash(s: TownDoors): string {
  const b = new Uint8Array(s.count * 80);
  const dv = new DataView(b.buffer);
  s.doors.forEach((d, i) => {
    dv.setUint32(i * 80, d.building, true);
    dv.setUint32(i * 80 + 4, d.prop, true);
    for (let k = 0; k < 9; k++) dv.setFloat64(i * 80 + 8 + k * 8, s.f[i * 9 + k], true);
  });
  return hex64(fnv1a64(b));
}

const towns = new Map<string, Towns>();
async function townsOf(seed: string): Promise<Towns> {
  let t = towns.get(seed);
  if (!t) {
    const g = await loadWorldgenGround(fs.readFileSync(wasm), seed);
    t = parseTowns(townsBytes(g.wg, g.atlas));
    towns.set(seed, t);
  }
  return t;
}

describe.skipIf(!hasWasm)('door boxes and push-out vs the Go port (testdata/doors.json)', () => {
  const file = JSON.parse(fs.readFileSync(vectors, 'utf8')) as DoorFile;
  for (const w of file.worlds) {
    it(`seed ${w.seed}: ${w.count} doors, ${w.collide.length} vectors bit for bit`, async () => {
      const t = await townsOf(w.seed);
      const s = new TownDoors(t);
      expect(s.count).toBe(w.count);
      expect(doorHash(s)).toBe(w.hash);
      for (const b of w.boxes) {
        const d = s.doors[b.d];
        expect([d.building, d.prop, d.id.toString(16)]).toEqual([b.building, b.prop, b.id]);
        expect([...s.f.subarray(b.d * 9, b.d * 9 + 9)].map(bits)).toEqual(b.f);
      }
      const col = new TownCollision(t.boxes);
      const rule = (d: number) => d % 3 !== 1;
      let fails = 0;
      for (const v of w.collide) {
        const r0 = { x: v.X, y: v.Y, z: v.Z, pushX: 0, pushZ: 0, ceiling: false };
        const a = res(s.after(r0, rule, fresh()));
        const g = res(s.after(col.collideNew(v.X, v.Y, v.Z), rule, fresh()));
        if (a !== v.doors || g !== v.ground) fails++;
      }
      expect(fails).toBe(0);
    }, 60000);
  }
});

describe('door states', () => {
  it('a change applies from its step on; settles; baselines replace', () => {
    const s = new DoorStates(3);
    expect(s.openAt(0, 5)).toBe(true);
    expect(s.active).toBe(0);
    s.set(1, false, 100, 90);
    expect(s.active).toBe(1);
    expect(s.openAt(1, 99)).toBe(true);
    expect(s.openAt(1, 100)).toBe(false);
    s.settle(150);
    expect(s.openAt(1, 0)).toBe(false);
    s.set(1, true, 200, 160);
    expect(s.openAt(1, 199)).toBe(false);
    expect(s.openAt(1, 200)).toBe(true);
    s.settle(200);
    expect(s.active).toBe(0);
    s.put(2, true, false, 300);
    expect([s.openAt(2, 299), s.openAt(2, 300), s.active]).toEqual([true, false, 1]);
    s.put(2, true, true, 0);
    expect(s.active).toBe(0);
  });
});

describe.skipIf(!hasWasm)('door ground and sync on the official world', () => {
  it('is the town ground while every door is open; a closed door blocks from its step on', async () => {
    const t = await townsOf('20261108');
    const doors = new TownDoors(t);
    const states = new DoorStates(doors.count);
    const col = new TownCollision(t.boxes);
    const base = { heightAt: () => -1000, collide: (x: number, y: number, z: number, out: TownCollideResult) => col.collide(x, y, z, out), atLevel: undefined as never };
    const town = { heightAt: () => -1000, atLevel: () => base, collide: base.collide };
    const g = new DoorGround(town, doors, states);
    const d = doors.doors[0];
    expect(g.atLevel(d.y)).toBe(base); // all open: the town level view itself
    states.set(0, false, 50, 0);
    const lv = g.atLevel(d.y);
    expect(lv).not.toBe(base);
    stepClock.seq = 49;
    expect(lv.collide!(d.x, d.y, d.z, fresh()).pushX).toBe(col.collideNew(d.x, d.y, d.z).pushX);
    stepClock.seq = 50;
    const r = lv.collide!(d.x, d.y, d.z, fresh());
    expect(Math.hypot(r.pushX, r.pushZ)).toBeGreaterThan(0.1);
  }, 60000);

  it('DoorSync applies 970/971, re-predicts late changes, toasts refusals, toggles offline', async () => {
    const t = await townsOf('20261108');
    const doors = new TownDoors(t);
    const states = new DoorStates(doors.count);
    const sync = new DoorSync(doors, states);
    const replays: number[] = [];
    const sent: [number, bigint, number][] = [];
    const session = { eventListeners: new Set<(e: ZoneEvent) => void>(), prediction: { replayFrom: (s: number) => (replays.push(s), null) }, sendInteract: (k: number, id: bigint, a: number) => void sent.push([k, id, a]) };
    sync.localSeq = () => 100;
    sync.follow(session);
    const d = doors.doors[3];
    const data = new Uint8Array(12);
    new DataView(data.buffer).setBigUint64(0, d.id, true);
    new DataView(data.buffer).setUint32(8, 112, true);
    const ev: ZoneEvent = { type: 'Event', kind: DOOR_EV.state, entityId: 7, targetId: d.prop, value: 0, x: 0, y: 0, z: 0, data };
    expect(decodeDoorState(ev)).toMatchObject({ prop: d.prop, id: d.id, open: false, step: 112, by: 7 });
    for (const l of session.eventListeners) l(ev);
    expect([states.openAt(3, 111), states.openAt(3, 112)]).toEqual([true, false]);
    expect(replays).toEqual([112]);
    // Baseline for its settlement: door 3 listed closed, the rest open.
    const other = doors.doors.find((x) => x.settlement === d.settlement && x.index !== 3)!;
    states.set(other.index, false, 0, 0);
    const b = new Uint8Array(3 + 10);
    const bv = new DataView(b.buffer);
    bv.setUint8(0, 1);
    bv.setUint16(1, 1, true);
    bv.setUint32(3, d.prop, true);
    bv.setUint8(7, 1);
    bv.setUint8(8, 0);
    bv.setUint32(9, 130, true);
    const bev: ZoneEvent = { ...ev, kind: DOOR_EV.baseline, targetId: d.settlement, data: b };
    expect(decodeDoorBaseline(bev).entries).toEqual([{ prop: d.prop, was: true, to: false, step: 130 }]);
    for (const l of session.eventListeners) l(bev);
    expect([states.openAt(3, 129), states.openAt(3, 130), states.openAt(other.index, 0)]).toEqual([true, false, true]);
    let toast = '';
    sync.onRefused = (s) => (toast = s);
    for (const l of session.eventListeners) l({ ...ev, kind: DOOR_EV.refused, value: 3, data: new Uint8Array(8) });
    expect(toast).toMatch(/doorway/);
    // E online: Interact 34 close (door open at the current step 100).
    sync.toggle(3);
    expect(sent).toEqual([[34, d.id, 2]]);
    // Offline: the door toggles from the next step.
    sync.follow(null);
    sync.toggle(5);
    expect([states.openAt(5, 100), states.openAt(5, 101)]).toEqual([true, false]);
  }, 60000);
});

describe.skipIf(!hasWasm)('late door changes re-predict from their step', () => {
  it('ClientPrediction.replayFrom re-runs the pending steps with the door as it now is', async () => {
    const t = await townsOf('20261108');
    const doors = new TownDoors(t);
    const states = new DoorStates(doors.count);
    const d = doors.doors.find((x) => t.buildings[x.building].role === 1)!; // an inn door
    const b = t.buildings[d.building];
    const ground = new DoorGround(new TownGround(new FlatGround(d.y - 0.2), new TownCollision(t.boxes)), doors, states);
    const vx = -b.s;
    const vz = b.c;
    const vOf = (s: MoveState) => (s.pos.x - d.x) * vx + (s.pos.z - d.z) * vz;
    const pred = new ClientPrediction(ground);
    let s = newMoveState({ x: d.x - 2.5 * vx, y: d.y, z: d.z - 2.5 * vz });
    const input = makeMoveInput({ ...NO_BUTTONS, forward: true }, false, Math.atan2(-vx, -vz), 0);
    for (let seq = 1; seq <= 90; seq++) {
      stepClock.seq = seq;
      s = stepMovement(s, input, ground, STEP_DT);
      pred.store({ seq, input, state: s });
      pred.notePredicted(s);
    }
    expect(vOf(s)).toBeGreaterThan(1); // walked in through the open door
    expect(pred.replayFrom(500)).toBeNull(); // nothing predicted that late
    states.set(d.index, false, 20, 0); // closed from step 20 on: we were still outside then
    const c = pred.replayFrom(20);
    expect(c).not.toBeNull();
    expect(vOf(c!.state)).toBeLessThanOrEqual(-(d.thick / 2 + 0.4) + 1e-9);
    expect(pred.localReplays).toBe(1);
    expect(pred.reconciles).toBe(0);
  });
});
