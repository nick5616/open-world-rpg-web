// Playtest doors acceptance: walk through a building door with client
// prediction against the real zone binary, closing and opening it on the
// way. The zone (Go) runs server/pkg/towns doors.go and schedules every
// open/close at a stamped input seq (Events 970); this Node client predicts
// on worldgen/js doors.ts through DoorGround with DoorSync applying those
// events, exactly as the browser does. Script, from the street in front of
// the door: close it, walk into it (blocked), open it, walk in, turn and
// close it behind you from inside, push into it (blocked), open it, walk
// out. Prediction must equal the server to the centimetre with no
// corrections, and the walker must really have been stopped by the closed
// door on both sides.
//
// Evidence run: `npx vite-node src/world/buildings/dev/door-acceptance.ts`
// (from client/; writes docs/evidence/pt-ux-door-walkthrough.txt).
// Short test: doorWalk.integration.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { BUILDING_ROLES, DoorStates, parseTowns, TownCollision, TownDoors, townsBytes, type Building, type TownDoor, type Towns } from '@lodestone/worldgen';
import { loadWorldgenGround } from '../../../sim/worldgenGround';
import { formatRun, repoRoot, runTimeline, zoneGround, type RunResult, type ZoneProc } from '../../../sim/dev/traversalRun';
import type { MoveState } from '../../../sim/movement';
import { TownGround } from '../townGround';
import { DoorGround } from '../doorGround';
import { DOOR_ACT, DoorSync, INTERACT_DOOR } from '../doors';
import type { ZoneSession } from '../../../net/zoneSession';

export interface DoorWalkSetup {
  ground: DoorGround;
  towns: Towns;
  doors: TownDoors;
  states: DoorStates;
  settlement: number;
}

export async function setupDoorWalk(seed = '20261108'): Promise<DoorWalkSetup> {
  const wasm = fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm'));
  const terrain = await loadWorldgenGround(wasm, seed);
  const towns = parseTowns(townsBytes(terrain.wg, terrain.atlas));
  const doors = new TownDoors(towns);
  const states = new DoorStates(doors.count);
  const ground = new DoorGround(new TownGround(zoneGround(terrain), new TownCollision(towns.boxes)), doors, states);
  const sp = terrain.atlas.data.spawn;
  let best = towns.settlements[0];
  for (const s of towns.settlements) if (Math.hypot(s.x - sp.x, s.z - sp.z) < Math.hypot(best.x - sp.x, best.z - sp.z)) best = s;
  return { ground, towns, doors, states, settlement: best.index };
}

/** The spawn settlement's doors, inn first. */
export function doorsToWalk(s: DoorWalkSetup): TownDoor[] {
  const ds = s.doors.doors.filter((d) => d.settlement === s.settlement);
  const role = (d: TownDoor) => BUILDING_ROLES[s.towns.buildings[d.building].role];
  return [...ds.filter((d) => role(d) === 'inn'), ...ds.filter((d) => role(d) !== 'inn')];
}

/** Zone clock offset that makes it `hour` o'clock now (NPCs at work, nobody walking in and out). */
export function offsetForHour(hour: number): string {
  const now = Date.now() / 1000;
  return String(Math.round((hour / 24) * 3600 - (now % 3600)));
}

export interface DoorWalkResult {
  run: RunResult;
  events: { states: number; baselines: number; refused: number; late: number };
  /** Closest the body centre got to the door's mid-plane while closed, from outside / inside (m; positive = on its own side). */
  outsideGap: number;
  insideGap: number;
  /** The body limit: half the door thickness + the body radius. */
  limit: number;
  inside: boolean;
  out: boolean;
  lines: string[];
}

export async function walkThroughDoor(zone: ZoneProc, s: DoorWalkSetup, door: TownDoor, name = 'door'): Promise<DoorWalkResult> {
  const b: Building = s.towns.buildings[door.building];
  const vx = -b.s;
  const vz = b.c; // inward
  const vOf = (st: MoveState) => (st.pos.x - door.x) * vx + (st.pos.z - door.z) * vz;
  const half = door.thick / 2;
  const back = 3.5; // within reach (4.5 m eye to door), porch or not
  const start = { x: door.x - back * vx, z: door.z - back * vz };
  const inward = Math.atan2(-vx, -vz);
  const yawIn = (inward * 180) / Math.PI;
  const yawOut = yawIn + 180;
  let session: ZoneSession | null = null;
  let sync: DoorSync | null = null;
  let phase: 'open' | 'closedOut' | 'closedIn' = 'open';
  let outsideGap = Infinity;
  let insideGap = Infinity;
  let inside = false;
  let out = false;
  const track = (st: MoveState) => {
    const v = vOf(st);
    if (phase === 'closedOut') outsideGap = Math.min(outsideGap, -v);
    if (phase === 'closedIn') insideGap = Math.min(insideGap, v);
    return false;
  };
  const send = (action: number, next: typeof phase) => () => {
    phase = next;
    session!.sendInteract(INTERACT_DOOR, door.id, action, 0);
  };
  const run = await runTimeline(
    zone,
    s.ground,
    name,
    { x: start.x, z: start.z, yawDeg: yawIn },
    [
      { dur: 0.5, note: 'settle' },
      { dur: 0.6, act: send(DOOR_ACT.close, 'closedOut'), note: 'close the door from the street' },
      { dur: 3.0, held: { forward: true }, until: track, note: 'walk into the closed door' },
      { dur: 0.6, act: send(DOOR_ACT.open, 'open'), note: 'open it' },
      {
        dur: 4.0,
        held: { forward: true },
        until: (st) => {
          if (vOf(st) > half + 1.6) inside = true;
          return inside;
        },
        note: 'walk in',
      },
      { dur: 0.4, yawDeg: yawOut, note: 'turn round' },
      { dur: 0.6, yawDeg: yawOut, act: send(DOOR_ACT.close, 'closedIn'), note: 'close it behind you from inside' },
      { dur: 2.5, yawDeg: yawOut, held: { forward: true }, until: track, note: 'push into it' },
      { dur: 0.6, yawDeg: yawOut, act: send(DOOR_ACT.open, 'open'), note: 'open it' },
      {
        dur: 4.0,
        yawDeg: yawOut,
        held: { forward: true },
        until: (st) => {
          if (vOf(st) < -half - 2) out = true;
          return out;
        },
        note: 'walk out',
      },
      { dur: 0.3, yawDeg: yawOut },
    ],
    { raining: false, updraft: null },
    {
      session: (sess, sim) => {
        session = sess;
        sync = new DoorSync(s.doors, s.states);
        sync.localSeq = () => sim.seq;
        sync.follow(sess);
      },
    },
  );
  sync!.follow(null);
  const limit = half + 0.4;
  const ev = { ...sync!.stats };
  const lines = [
    `door ${door.index} (prop ${door.prop}, id ${door.id.toString(16)}) of building ${b.id.toString(16)} (${BUILDING_ROLES[b.role]}, style ${b.style}) at (${door.x.toFixed(2)}, ${door.y.toFixed(2)}, ${door.z.toFixed(2)}), doorway ${door.width.toFixed(2)} m x ${door.thick.toFixed(2)} m`,
    `door events: ${ev.states} door_state, ${ev.baselines} baselines, ${ev.refused} refused, ${ev.late} late re-predictions (localReplays ${run.localReplays})`,
    `closed from the street: body centre stopped ${outsideGap.toFixed(3)} m outside the door's mid-plane (limit ${limit.toFixed(3)}); closed from inside: stopped ${insideGap.toFixed(3)} m inside (limit ${limit.toFixed(3)}); got inside ${inside}, back out ${out}`,
    formatRun(run),
  ];
  return { run, events: ev, outsideGap, insideGap, limit, inside, out, lines };
}

export function doorWalkPass(r: DoorWalkResult): boolean {
  return r.run.corrections === 0 && r.run.maxDivM < 0.02 && r.inside && r.out && r.events.states === 4 && r.events.refused === 0 && r.outsideGap >= r.limit - 0.01 && r.insideGap >= r.limit - 0.01 && r.outsideGap < r.limit + 0.05 && r.insideGap < r.limit + 0.05;
}
