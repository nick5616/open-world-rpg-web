// Integration across process boundaries: the real zone binary (Go) and the
// netsim proxy (Node child process), driven by this package's ZoneSession,
// LocalSim and prediction exactly as the browser drives them, over real
// WebSockets. Player B connects through the "thailand" profile (~160 ms RTT,
// 3% loss as TCP stalls) and walks; player A watches. Skipped when Go is not
// installed (LODESTONE_SKIP_GO=1 forces a skip).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { FlatGround } from '../sim/ground';
import { NO_BUTTONS, type HeldButtons } from '../sim/inputFrame';
import { LocalSim } from '../sim/localSim';
import { devTicket } from './dev/devTicket';
import type { WebSocketLike } from './transport';
import { ZoneSession } from './zoneSession';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const home = os.homedir();
const PATH = [process.env.PATH ?? process.env.Path ?? '', path.join(home, 'sdk', 'go', 'bin'), path.join(home, 'go', 'bin')].join(path.delimiter);
const goAvailable = process.env.LODESTONE_SKIP_GO !== '1' && spawnSync('go', ['version'], { env: { ...process.env, PATH } }).status === 0;
const ground = new FlatGround(0);
const wsFactory = (url: string) => {
  const ws = new NodeWebSocket(url);
  return ws as unknown as WebSocketLike;
};

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function waitHttp(url: string, ms = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} not up`);
}

/** A headless client: LocalSim stepping at real time, prediction, input, corrections. */
class Bot {
  sim: LocalSim;
  held: HeldButtons = { ...NO_BUTTONS };
  yaw = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = performance.now();
  constructor(readonly s: ZoneSession, spawnAt: { x: number; y: number; z: number }) {
    this.sim = new LocalSim(ground, spawnAt);
    this.sim.onStep = (r) => s.pushStep(r.seq, r.input, r.state);
  }
  run(): void {
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = (now - this.last) / 1000;
      this.last = now;
      const c = this.s.prediction.takeCorrection();
      if (c) this.sim.rebase(c.state);
      this.sim.frame(dt, { held: this.held, yaw: this.yaw, pitch: 0, fly: false });
      this.s.flushInput();
      this.s.views(dt * 1000);
    }, 8);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

describe.skipIf(!goAvailable)('zone session against the real zone process', () => {
  const children: ChildProcess[] = [];
  let zonePort = 0;
  let proxyPort = 0;
  const world = `vitest-${Date.now()}`;
  const zoneId = 'zone-vitest';

  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-net-it-'));
    const bin = path.join(tmp, process.platform === 'win32' ? 'zone.exe' : 'zone');
    const b = spawnSync('go', ['build', '-o', bin, './server/zone'], { cwd: root, env: { ...process.env, PATH }, encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`go build: ${b.stderr}`);
    zonePort = await freePort();
    proxyPort = await freePort();
    children.push(
      spawn(bin, [], {
        env: { ...process.env, PATH, LODESTONE_ZONE_PORT: String(zonePort), LODESTONE_ZONE_WT_ADDR: 'off', LODESTONE_ZONE_NO_DB: '1', LODESTONE_ZONE_NO_REDIS: '1', LODESTONE_ZONE_ID: zoneId, LODESTONE_WORLD_ID: world,
          // This test predicts on FlatGround; since WP07 the zone simulates on
          // generated terrain when worldgen.wasm is built, so point it at a
          // missing wasm to get WP07's documented flat fallback.
          LODESTONE_WORLDGEN_WASM: path.join(tmp, 'no-worldgen.wasm') },
        stdio: 'ignore',
      }),
    );
    children.push(spawn(process.execPath, [path.join(root, 'tools/netsim/proxy.mjs'), '--profile', 'thailand', '--listen', String(proxyPort), '--target', `ws://127.0.0.1:${zonePort}`], { stdio: 'ignore' }));
    await waitHttp(`http://127.0.0.1:${zonePort}/healthz`);
    await waitHttp(`http://127.0.0.1:${proxyPort}/config`);
  }, 120000);

  afterAll(() => {
    for (const c of children) c.kill();
  });

  it('two players: B walks under "thailand", prediction holds and A sees smooth motion', async () => {
    const mk = (name: string, url: string) =>
      new ZoneSession({ wsUrl: url, ticket: devTicket({ characterId: `vt-${name}`, characterName: name, worldId: world, zoneId }), ground, wsFactory });
    const a = mk('Ay', `ws://127.0.0.1:${zonePort}/ws?spawn=2048,2048`);
    const b = mk('Bee', `ws://127.0.0.1:${proxyPort}/ws?spawn=2052,2040`);
    const wa = await a.start();
    const wb = await b.start();
    expect(b.transport?.kind).toBe('websocket');
    const botA = new Bot(a, { x: wa.x / 100, y: wa.y / 100, z: wa.z / 100 });
    const botB = new Bot(b, { x: wb.x / 100, y: wb.y / 100, z: wb.z / 100 });
    botA.run();
    botB.run();
    await new Promise((r) => setTimeout(r, 1500)); // clock sync + jitter window
    // B walks a square at walking speed: 4 legs of 1.5 s.
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      botB.yaw = yaw;
      botB.held = { ...NO_BUTTONS, forward: true };
      await new Promise((r) => setTimeout(r, 1500));
    }
    botB.held = { ...NO_BUTTONS };
    await new Promise((r) => setTimeout(r, 1500));
    botA.stop();
    botB.stop();

    // B's prediction: the server ran the same frames.
    const pb = b.prediction;
    expect(pb.agreements).toBeGreaterThan(50);
    expect(pb.maxError).toBeLessThan(0.05);
    // A saw B (interpolated, named), never teleporting.
    const views = a.views(16);
    const seen = views.find((v) => v.name === 'Bee');
    expect(seen).toBeDefined();
    expect(Math.hypot(seen!.x - botB.sim.state.pos.x, seen!.z - botB.sim.state.pos.z)).toBeLessThan(0.5);
    expect(a.interp.metrics.teleports).toBe(0);
    // Uplink inside the spec 9 budget (24 kbps).
    expect((b.transport!.bytesOut * 8) / 1000 / 9).toBeLessThan(24);
    console.log(
      `[net-it] B corrections ${pb.reconciles} (max ${(pb.maxError * 100).toFixed(2)} cm), agreements ${pb.agreements}, rtt ${b.clock.minRtt.toFixed(0)} ms; ` +
        `A interp extrap events ${a.interp.metrics.extrapEvents}, visible jumps ${a.interp.metrics.visibleJumps} (max ${(a.interp.metrics.maxJumpM * 100).toFixed(1)} cm), link delay ${a.interp.linkDelay.toFixed(0)} ms`,
    );
    a.close();
    b.close();
  }, 60000);
});
