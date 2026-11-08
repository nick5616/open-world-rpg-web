// WP15 acceptance (spec 15: "two clients see the same fire spread cell for
// cell for 60 s"):
//
//   npm run fire:accept -w client      (needs Go and `npm run build:wasm`)
//
// Builds and runs the real zone binary on the official world (seed
// 20261108, real terrain), finds a meadow near the spawn, connects THREE
// Node clients over WebSocket (this package's ZoneSession, the browser's
// chemistry classes: EventSync / BitmapSync over TerrainMaterial on
// worldgen.wasm), and has client A light the grass with the dev Interact.
// Clients A and B run the event path (sync events, not results: ignite op +
// their own deterministic spread); client C asks for the bitmap fallback.
// For every chemistry step of the next 62 s it compares A's and B's state
// digests with each other and with the zone's (/debug/night?hashes=1),
// diffs A's and B's final cells one by one, and checks every bitmap C got
// against A's state at the bitmap's step. Writes
// docs/evidence/wp15-fire-sync.{txt,json}; exits non-zero on any mismatch.

import fs from 'node:fs';
import path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { ZoneSession } from '../../net/zoneSession';
import type { WebSocketLike } from '../../net/transport';
import { devTicket } from '../../net/dev/devTicket';
import { loadWorldgenGround, type WorldgenGround } from '../../sim/worldgenGround';
import { buildZone, goAvailable, repoRoot, startZone, type ZoneProc } from '../../sim/dev/traversalRun';
import { chemStep, worldClockState, worldTime } from '../clock';
import { TerrainMaterial } from '../chem/material';
import { BitmapSync, EventSync, type ChemView } from '../chem/sync';
import { cellCenter, cellId, MAT_BRUSH, MAT_GRASS, ST_BURNING } from '../chem/sim';

const SEED = '20261108';
const SECONDS = 62;
const wsFactory = (url: string) => new NodeWebSocket(url) as unknown as WebSocketLike;

/** FNV over (id, state) of every cell a view reports (both paths). */
function cellFingerprint(each: (fn: (id: number, st: number) => void) => void): { fp: number; n: number; burning: number } {
  const cells: [number, number][] = [];
  each((id, st) => cells.push([id, st]));
  cells.sort((a, b) => a[0] - b[0]);
  let h = 2166136261;
  let burning = 0;
  for (const [id, st] of cells) {
    h = Math.imul(h ^ id, 16777619) >>> 0;
    h = Math.imul(h ^ st, 16777619) >>> 0;
    if (st === ST_BURNING) burning++;
  }
  return { fp: h >>> 0, n: cells.length, burning };
}

class FireClient {
  session: ZoneSession;
  view: ChemView | null = null;
  offset = 0;
  windDeg = 0;
  hashes = new Map<number, number>();
  prints = new Map<number, { fp: number; n: number; burning: number }>();
  ignite: { step: number; cell: number } | null = null;
  bitmaps = new Map<number, Map<number, Uint8Array>>(); // step -> chunk -> bits
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly name: string,
    zone: ZoneProc,
    at: { x: number; z: number },
    readonly terrain: WorldgenGround,
    readonly mode: 'events' | 'bitmap',
  ) {
    this.session = new ZoneSession({
      wsUrl: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`,
      ticket: devTicket({ characterId: `wp15-fire-${name}-${Date.now()}`, characterName: `Fire${name}`, worldId: zone.worldId, zoneId: zone.zoneId }),
      ground: terrain,
      wsFactory,
    });
    this.session.eventListeners.add((e) => this.onEvent(e));
  }

  async start(): Promise<void> {
    await this.session.start();
    if (this.mode === 'bitmap') this.session.sendInteract(51, 0n, 10, 2);
    this.timer = setInterval(() => this.tick(), 20);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.session.close('done');
  }

  zoneStep(): number {
    return chemStep(worldTime(this.session.clock.serverNow(), this.offset));
  }

  private onEvent(e: ZoneEvent): void {
    if (e.kind === 500) {
      const v = new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      this.offset = v.getFloat64(1, true);
      this.windDeg = v.getUint16(10, true);
      const mode = e.data[12] === 2 ? 'bitmap' : 'events';
      if (mode !== this.mode) return; // the bitmap client's first clock still says events
      if (!this.view) {
        const src = new TerrainMaterial(this.terrain, BigInt(SEED), this.terrain.atlas.data);
        if (this.mode === 'events') {
          const ev = new EventSync(BigInt(SEED), this.windDeg, src, this.zoneStep() - 2);
          ev.sim.rain = false; // the zone runs with LODESTONE_ZONE_DEBUG_RAIN=0 (and says so in Event 500)
          ev.onStep = (k, sim) => {
            this.hashes.set(k, sim.hash());
            this.prints.set(k, cellFingerprint((fn) => sim.forEach((id, st) => fn(id, st))));
          };
          this.view = ev;
        } else {
          this.view = new BitmapSync(src);
        }
      }
      return;
    }
    if (e.kind >= 520 && e.kind <= 525) {
      if (e.kind === 520 && !this.ignite) {
        const step = Number(new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength).getBigInt64(0, true));
        this.ignite = { step, cell: e.targetId };
      }
      if (e.kind === 525) {
        const step = Number(new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength).getBigInt64(0, true));
        let m = this.bitmaps.get(step);
        if (!m) this.bitmaps.set(step, (m = new Map()));
        m.set(e.targetId, e.data.slice(8));
      }
      this.view?.onEvent(e);
    }
  }

  private tick(): void {
    this.view?.advanceTo(this.zoneStep());
  }
}

/** A meadow near the spawn: the spot with the most dry fuel in a 14-cell disc. */
function findMeadow(terrain: WorldgenGround): { x: number; z: number; fuel: number } {
  const d = terrain.atlas.data;
  const src = new TerrainMaterial(terrain, BigInt(SEED), d);
  let best = { x: d.spawn.x, z: d.spawn.z, fuel: -1 };
  for (let r = 80; r <= 600 && best.fuel < 0.62; r += 40) {
    for (let a = 0; a < 16; a++) {
      const x = d.spawn.x + r * Math.cos((a * Math.PI) / 8);
      const z = d.spawn.z + r * Math.sin((a * Math.PI) / 8);
      const cx = Math.floor(x / 2);
      const cz = Math.floor(z / 2);
      let n = 0;
      let f = 0;
      for (let dz = -14; dz <= 14; dz++)
        for (let dx = -14; dx <= 14; dx++) {
          if (dx * dx + dz * dz > 196) continue;
          n++;
          const m = src.material(cx + dx, cz + dz);
          if (m === MAT_GRASS || m === MAT_BRUSH) f++;
        }
      if (f / n > best.fuel) best = { x: cellCenter(cx), z: cellCenter(cz), fuel: f / n };
    }
  }
  return best;
}

async function main(): Promise<void> {
  if (!goAvailable()) throw new Error('Go not found (PATH or ~/sdk/go/bin)');
  const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');
  if (!fs.existsSync(wasm)) throw new Error('build the wasm first: npm run build:wasm');
  const terrain = await loadWorldgenGround(fs.readFileSync(wasm), SEED);
  const spot = findMeadow(terrain);
  console.log(`meadow at (${spot.x}, ${spot.z}), ${(spot.fuel * 100).toFixed(0)}% fuel`);
  console.log('building zone...');
  const bin = buildZone();
  // Noon, dry, no demons or camps: this run is about the fire.
  const tod = (Date.now() / 1000) % 3600;
  const offset = Math.round((((12 * 150 - tod) % 3600) + 3600) % 3600);
  const zone = await startZone(bin, SEED, {
    LODESTONE_ZONE_DEV_NIGHT: '1',
    LODESTONE_ZONE_DEBUG_RAIN: '0',
    LODESTONE_ZONE_NO_DEMONS: '1',
    LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1',
    LODESTONE_ZONE_TIME_OFFSET_S: String(offset),
  });
  const log: string[] = [];
  const say = (s: string) => {
    console.log(s);
    log.push(s);
  };
  try {
    const a = new FireClient('A', zone, { x: spot.x - 18, z: spot.z - 6 }, terrain, 'events');
    const b = new FireClient('B', zone, { x: spot.x + 16, z: spot.z + 10 }, terrain, 'events');
    const c = new FireClient('C', zone, { x: spot.x + 4, z: spot.z - 20 }, terrain, 'bitmap');
    await Promise.all([a.start(), b.start(), c.start()]);
    await new Promise((r) => setTimeout(r, 1500));
    worldClockState.seed = BigInt(SEED);
    say(`WP15 fire sync: zone ${zone.zoneId} (world seed ${SEED}, real terrain), clients A + B on the event path, C on the bitmap fallback`);
    say(`world clock offset ${a.offset} s, prevailing wind ${a.windDeg} deg; meadow (${spot.x}, ${spot.z}) with ${(spot.fuel * 100).toFixed(0)}% dry fuel in a 28 m disc`);
    // A lights the grass (dev Interact 51 action 1, radius 2 cells).
    const tid = BigInt(Math.round(spot.x * 100) >>> 0) | (BigInt(Math.round(spot.z * 100) >>> 0) << 32n);
    a.session.sendInteract(51, tid, 1, 2);
    const t0 = Date.now();
    while (!a.ignite && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    if (!a.ignite) throw new Error('no ignite event');
    const k0 = a.ignite.step;
    const k1 = k0 + SECONDS * 5;
    say(`ignite op: cell ${a.ignite.cell} at zone step ${k0}; comparing steps ${k0}..${k1} (${SECONDS} s at 5 Hz)`);
    let lastPrint = 0;
    while (Math.min(a.view?.step ?? 0, b.view?.step ?? 0) < k1) {
      await new Promise((r) => setTimeout(r, 250));
      const s = a.view?.step ?? 0;
      if (s - lastPrint >= 50) {
        lastPrint = s;
        const pa = a.prints.get(s);
        say(`  t=${((s - k0) / 5).toFixed(0).padStart(3)} s  step ${s}: burning A ${pa?.burning ?? 0} / cells ${pa?.n ?? 0}`);
      }
      if (Date.now() - t0 > (SECONDS + 30) * 1000) throw new Error('clients stalled');
    }
    await new Promise((r) => setTimeout(r, 1200));
    const zr = await fetch(`http://127.0.0.1:${zone.port}/debug/night?hashes=1`);
    const zd = (await zr.json()) as { hashes: { step: number; hash: number; burning: number }[]; chemLate: number };
    const zoneHash = new Map(zd.hashes.map((h) => [h.step, h.hash]));
    const zoneBurning = new Map(zd.hashes.map((h) => [h.step, h.burning]));
    let same = 0;
    let zoneSame = 0;
    let zoneMissing = 0;
    const mismatches: string[] = [];
    let peak = 0;
    const timeline: { t: number; step: number; burning: number }[] = [];
    for (let k = k0; k <= k1; k++) {
      const ha = a.hashes.get(k);
      const hb = b.hashes.get(k);
      if (ha === undefined || hb === undefined) {
        mismatches.push(`step ${k}: missing (A ${ha}, B ${hb})`);
        continue;
      }
      if (ha === hb) same++;
      else mismatches.push(`step ${k}: A ${ha.toString(16)} B ${hb.toString(16)}`);
      const hz = zoneHash.get(k);
      if (hz === undefined) zoneMissing++;
      else if (hz === ha) zoneSame++;
      else mismatches.push(`step ${k}: zone ${hz.toString(16)} A ${ha.toString(16)}`);
      const p = a.prints.get(k);
      peak = Math.max(peak, p?.burning ?? 0);
      if ((k - k0) % 25 === 0) timeline.push({ t: (k - k0) / 5, step: k, burning: zoneBurning.get(k) ?? p?.burning ?? 0 });
    }
    // Cell by cell at the end: both clients' full state at the same step.
    const ea = a.view as EventSync;
    const eb = b.view as EventSync;
    const kEnd = Math.min(ea.step, eb.step);
    ea.sim.advanceTo(kEnd);
    eb.sim.advanceTo(kEnd);
    const ta = ea.sim.sortedTriples();
    const tb = eb.sim.sortedTriples();
    let cellDiffs = 0;
    for (let i = 0; i < Math.max(ta.length, tb.length); i++) if (ta[i] !== tb[i]) cellDiffs++;
    // Bitmap fallback: every bitmap C received vs A's state at that step.
    let bmChecked = 0;
    let bmSame = 0;
    const bmNotes: string[] = [];
    for (const [step, chunks] of c.bitmaps) {
      const pa = a.prints.get(step);
      if (!pa || step < k0) continue;
      const each = (fn: (id: number, st: number) => void) => {
        for (const [ch, bits] of chunks) {
          const cx = (ch % 64) * 32;
          const cz = Math.floor(ch / 64) * 32;
          for (let l = 0; l < 1024; l++) {
            const st = (bits[l >> 2] >> (2 * (l & 3))) & 3;
            if (st) fn(cellId(cx + (l % 32), cz + Math.floor(l / 32)), st);
          }
        }
      };
      const pc = cellFingerprint(each);
      bmChecked++;
      if (pc.fp === pa.fp) bmSame++;
      else if (bmNotes.length < 5) bmNotes.push(`bitmap step ${step}: ${pc.n} cells vs A ${pa.n}`);
    }
    const steps = k1 - k0 + 1;
    say('');
    say(`A vs B, state digest per step: ${same}/${steps} identical`);
    say(`zone vs A, state digest per step: ${zoneSame}/${steps - zoneMissing} identical (${zoneMissing} steps not in the zone's ring)`);
    say(`final cells at step ${kEnd}: A ${ta.length / 3}, B ${tb.length / 3}, differing entries ${cellDiffs}`);
    say(`peak burning cells ${peak}; late ops A ${ea.stats.late} B ${eb.stats.late}; baselines A ${ea.stats.baselines} B ${eb.stats.baselines}; zone late ops ${zd.chemLate}`);
    say(`bitmap fallback (C): ${bmSame}/${bmChecked} bitmap bursts identical to A's state at the same step${bmNotes.length ? ' (' + bmNotes.join('; ') + ')' : ''}`);
    say('burning cells over time (zone): ' + timeline.map((p) => `${p.t}s:${p.burning}`).join(' '));
    for (const m of mismatches.slice(0, 10)) say('MISMATCH ' + m);
    const pass = same === steps && cellDiffs === 0 && zoneSame === steps - zoneMissing && zoneMissing < 10 && peak > 20 && bmChecked > 0 && bmSame === bmChecked;
    say(pass ? `PASS: two clients saw the same fire spread cell for cell for ${SECONDS} s (and so did the zone and the bitmap fallback)` : 'FAIL');
    const out = path.join(repoRoot, 'docs', 'evidence');
    fs.writeFileSync(path.join(out, 'wp15-fire-sync.txt'), log.join('\n') + '\n');
    fs.writeFileSync(path.join(out, 'wp15-fire-sync.json'), JSON.stringify({ spot, k0, k1, steps, same, zoneSame, zoneMissing, cellDiffs, cellsA: ta.length / 3, peak, bitmap: { checked: bmChecked, same: bmSame }, timeline, mismatches: mismatches.slice(0, 50), pass }, null, 1));
    for (const cl of [a, b, c]) cl.stop();
    if (!pass) process.exitCode = 1;
  } finally {
    zone.proc.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
