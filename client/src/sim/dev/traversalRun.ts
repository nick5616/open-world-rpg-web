// Node-only harness for WP10's cross-process acceptance: the real zone binary
// (Go, on generated terrain through worldhost) against this package's
// LocalSim + ZoneSession + prediction, driven in real time by a scripted
// timeline of held keys, exactly as the browser drives them. For every
// snapshot it compares the server's authoritative position at ackInputSeq
// with what the client predicted for that same step, and keeps the maximum
// divergence per movement mode (the server's mode). Used by
// traversal.integration.test.ts (short) and dev/traversal-acceptance.ts (the
// evidence run). Never imported by browser code.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket as NodeWebSocket } from 'ws';
import { NO_BUTTONS, type HeldButtons } from '../inputFrame';
import { LocalSim } from '../localSim';
import { cloneMoveState, type MoveState, type StepEnv } from '../movement';
import type { GroundQuery } from '../ground';
import { StructureGround } from '../../world/structures/overlay';
import { towersFromAtlas } from '../../world/structures/towers';
import type { WorldgenGround } from '../worldgenGround';

/**
 * The ground the zone simulates on since WP12: terrain + the tower overlay
 * (server/zone/explore.go). Node clients must predict on the same.
 */
export function zoneGround(terrain: WorldgenGround): StructureGround {
  return new StructureGround(terrain, towersFromAtlas(terrain.atlas.data, terrain).overlay);
}
import { devTicket } from '../../net/dev/devTicket';
import type { WebSocketLike } from '../../net/transport';
import { ZoneSession } from '../../net/zoneSession';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const home = os.homedir();
export const goPATH = [process.env.PATH ?? process.env.Path ?? '', path.join(home, 'sdk', 'go', 'bin'), path.join(home, 'go', 'bin')].join(path.delimiter);
export const MODE_NAMES = ['ground', 'air', 'climb', 'glide', 'swim', 'fly'];

export function goAvailable(): boolean {
  return process.env.LODESTONE_SKIP_GO !== '1' && spawnSync('go', ['version'], { env: { ...process.env, PATH: goPATH } }).status === 0;
}

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export async function waitHttp(url: string, ms = 30000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} not up`);
}

/** go build ./server/zone into a temp dir (once per caller). */
export function buildZone(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp10-'));
  const bin = path.join(tmp, process.platform === 'win32' ? 'zone.exe' : 'zone');
  const b = spawnSync('go', ['build', '-o', bin, './server/zone'], { cwd: repoRoot, env: { ...process.env, PATH: goPATH }, encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`go build: ${b.stderr}`);
  return bin;
}

export interface ZoneProc {
  proc: ChildProcess;
  port: number;
  worldId: string;
  zoneId: string;
  log: string[];
}

/** Run the zone on generated terrain for `seed` (no DB/Redis), with WP10 debug env overrides. */
export async function startZone(bin: string, seed: string, extraEnv: Record<string, string> = {}): Promise<ZoneProc> {
  const port = await freePort();
  const worldId = `wp10-${Date.now()}-${port}`;
  const zoneId = `zone-wp10-${port}`;
  const log: string[] = [];
  const proc = spawn(bin, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: goPATH,
      LODESTONE_ZONE_PORT: String(port),
      LODESTONE_ZONE_WT_ADDR: 'off',
      LODESTONE_ZONE_NO_DB: '1',
      LODESTONE_ZONE_NO_REDIS: '1',
      LODESTONE_ZONE_ID: zoneId,
      LODESTONE_WORLD_ID: worldId,
      LODESTONE_WORLD_SEED: seed,
      LODESTONE_GEN_VERSION: 'dev', // spec_from_seed(seed): the official world for 20261108
      LODESTONE_ZONE_REQUIRE_TERRAIN: '1',
      LODESTONE_ZONE_DEV_SPAWN: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => {
    for (const l of b.toString().split('\n')) if (l.trim()) log.push(l);
    if (log.length > 400) log.splice(0, log.length - 400);
  };
  proc.stdout?.on('data', keep);
  proc.stderr?.on('data', keep);
  await waitHttp(`http://127.0.0.1:${port}/healthz`);
  return { proc, port, worldId, zoneId, log };
}

/** One timeline entry: hold these buttons for `dur` seconds (yaw in degrees, optional key press at the start). */
export interface Beat {
  dur: number;
  held?: Partial<HeldButtons>;
  yawDeg?: number;
  /** Tap jump or the glider key (G) at the start of the beat. */
  press?: 'jump' | 'glide';
  /** Free text for the log. */
  note?: string;
  /** End the beat early once the predicted state satisfies this (dur is then the timeout). */
  until?: (s: MoveState) => boolean;
}

export interface ModeStat {
  snapshots: number;
  maxDivM: number;
  /** Highest and lowest server y seen in this mode (climb height, glide altitude). */
  maxY: number;
  minY: number;
}

export interface RunResult {
  name: string;
  spawn: { x: number; y: number; z: number };
  seconds: number;
  steps: number;
  snapshots: number;
  perMode: Record<string, ModeStat>;
  maxDivM: number;
  corrections: number;
  agreements: number;
  maxCorrectionM: number;
  transitions: string[];
  drownedEvents: number;
  samples: string[];
  end: { mode: string; x: number; y: number; z: number; stamina: number };
}

const wsFactory = (url: string) => new NodeWebSocket(url) as unknown as WebSocketLike;

/**
 * Connect to the zone at a dev spawn, play the timeline in real time and
 * measure prediction vs server per mode.
 */
export async function runTimeline(zone: ZoneProc, ground: GroundQuery, name: string, at: { x: number; z: number; yawDeg: number }, beats: Beat[], env: StepEnv): Promise<RunResult> {
  const session = new ZoneSession({
    wsUrl: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`,
    ticket: devTicket({ characterId: `wp10-${name}-${Date.now()}`, characterName: `Wp10${name.replace(/[^a-z]/gi, '').slice(0, 10)}`, worldId: zone.worldId, zoneId: zone.zoneId }),
    ground,
    wsFactory,
  });
  await session.start();
  // The zone puts a dev spawn exactly on its (bit-identical) ground at the
  // %.2f hint; take y from our own terrain, not Welcome's cm-rounded y.
  const spawnAt = { x: Number(at.x.toFixed(2)), y: 0, z: Number(at.z.toFixed(2)) };
  spawnAt.y = ground.heightAt(spawnAt.x, spawnAt.z);
  const sim = new LocalSim(ground, spawnAt);
  sim.envSource = () => env;
  const predicted = new Map<number, MoveState>();
  sim.onStep = (r) => {
    predicted.set(r.seq, cloneMoveState(r.state));
    session.pushStep(r.seq, r.input, r.state, r.env);
  };
  const res: RunResult = {
    name,
    spawn: spawnAt,
    seconds: 0,
    steps: 0,
    snapshots: 0,
    perMode: {},
    maxDivM: 0,
    corrections: 0,
    agreements: 0,
    maxCorrectionM: 0,
    transitions: [],
    drownedEvents: 0,
    samples: [],
    end: { mode: '', x: 0, y: 0, z: 0, stamina: 0 },
  };
  let lastMode = -1;
  const t0 = performance.now();
  session.onFrame = (f) => {
    const p = predicted.get(f.ackInputSeq);
    if (!p || f.ackInputSeq === 0) return;
    const sx = f.self.x / 100;
    const sy = f.self.y / 100;
    const sz = f.self.z / 100;
    const d = Math.hypot(sx - p.pos.x, sy - p.pos.y, sz - p.pos.z);
    const mode = MODE_NAMES[f.self.mode] ?? String(f.self.mode);
    const m = (res.perMode[mode] ??= { snapshots: 0, maxDivM: 0, maxY: -Infinity, minY: Infinity });
    m.snapshots++;
    m.maxY = Math.max(m.maxY, sy);
    m.minY = Math.min(m.minY, sy);
    m.maxDivM = Math.max(m.maxDivM, d);
    res.maxDivM = Math.max(res.maxDivM, d);
    res.snapshots++;
    const t = (performance.now() - t0) / 1000;
    if (f.self.mode !== lastMode) {
      res.transitions.push(`${t.toFixed(2)}s seq ${f.ackInputSeq}: ${lastMode < 0 ? 'start' : MODE_NAMES[lastMode]} -> ${mode} at (${sx.toFixed(2)}, ${sy.toFixed(2)}, ${sz.toFixed(2)}) stamina ${(f.self.stamina / 10).toFixed(1)}`);
      lastMode = f.self.mode;
    }
    if (res.snapshots % 15 === 0) res.samples.push(`${t.toFixed(2)}s seq ${f.ackInputSeq} ${mode.padEnd(6)} server (${sx.toFixed(2)}, ${sy.toFixed(2)}, ${sz.toFixed(2)}) predicted (${p.pos.x.toFixed(3)}, ${p.pos.y.toFixed(3)}, ${p.pos.z.toFixed(3)}) div ${(d * 100).toFixed(2)} cm stamina ${(f.self.stamina / 10).toFixed(1)} flags ${f.self.flags}`);
    for (const k of [...predicted.keys()]) if (k < f.ackInputSeq - 600) predicted.delete(k);
  };
  // Event 100 (drowned) counter: hook the decoder's raw path via the transport.
  const tr = session.transport!;
  const prevOnFrame = tr.onFrame;
  tr.onFrame = (b) => {
    if (b[0] === 67) res.drownedEvents += b[1] === 100 && b[2] === 0 ? 1 : 0;
    prevOnFrame?.(b);
  };

  let held: HeldButtons = { ...NO_BUTTONS };
  let yaw = (at.yawDeg * Math.PI) / 180;
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    const c = session.prediction.takeCorrection();
    if (c) sim.rebase(c.state);
    sim.frame(dt, { held, yaw, pitch: 0, fly: false });
    session.flushInput();
  };
  const timer = setInterval(tick, 4);
  await new Promise((r) => setTimeout(r, 600)); // clock sync, first snapshots
  for (const b of beats) {
    if (b.yawDeg !== undefined) yaw = (b.yawDeg * Math.PI) / 180;
    held = { ...NO_BUTTONS, ...b.held };
    if (b.press) {
      const key = b.press === 'jump' ? 'jump' : 'glide';
      held = { ...held, [key]: true };
      await new Promise((r) => setTimeout(r, 50));
      held = { ...held, [key]: b.held?.[key] ?? false };
      await new Promise((r) => setTimeout(r, Math.max(0, b.dur * 1000 - 50)));
    } else if (b.until) {
      const t1 = performance.now();
      while (performance.now() - t1 < b.dur * 1000 && !b.until(sim.state)) await new Promise((r) => setTimeout(r, 10));
    } else {
      await new Promise((r) => setTimeout(r, b.dur * 1000));
    }
  }
  held = { ...NO_BUTTONS };
  await new Promise((r) => setTimeout(r, 700)); // let the last frames be acked
  clearInterval(timer);
  res.seconds = (performance.now() - t0) / 1000;
  res.steps = sim.seq;
  res.corrections = session.prediction.reconciles;
  res.agreements = session.prediction.agreements;
  res.maxCorrectionM = session.prediction.maxError;
  const s = sim.state;
  res.end = { mode: MODE_NAMES[s.mode], x: s.pos.x, y: s.pos.y, z: s.pos.z, stamina: s.stamina / 60 };
  session.close();
  return res;
}

export function formatRun(r: RunResult): string {
  const modes = Object.entries(r.perMode)
    .map(([m, s]) => `${m}: ${s.snapshots} snapshots, max ${(s.maxDivM * 100).toFixed(2)} cm, y ${s.minY.toFixed(1)}..${s.maxY.toFixed(1)}`)
    .join('; ');
  return [
    `== ${r.name}: ${r.seconds.toFixed(1)} s, ${r.steps} steps, ${r.snapshots} compared snapshots; spawn (${r.spawn.x}, ${r.spawn.y.toFixed(2)}, ${r.spawn.z})`,
    `   per mode: ${modes}`,
    `   overall max divergence ${(r.maxDivM * 100).toFixed(2)} cm; corrections ${r.corrections} (max ${(r.maxCorrectionM * 100).toFixed(2)} cm), agreements ${r.agreements}; drowned events ${r.drownedEvents}`,
    `   end: ${r.end.mode} at (${r.end.x.toFixed(2)}, ${r.end.y.toFixed(2)}, ${r.end.z.toFixed(2)}), stamina ${r.end.stamina.toFixed(1)}`,
    `   transitions:`,
    ...r.transitions.map((t) => `     ${t}`),
  ].join('\n');
}
