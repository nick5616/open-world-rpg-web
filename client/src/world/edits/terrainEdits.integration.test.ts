// CR 040 across process boundaries: dig a pit with real Interact 43 swings
// against the real zone binary (Go worldedit overlay on worldhost.Terrain),
// feed the TerrainEdits it sends into the client's overlay (TS twin on
// WorldGround), then walk down into the pit with client prediction. The
// prediction must equal the server to the centimetre (the edited surface is
// the same function on both sides). Skipped without Go
// or the built wasm (LODESTONE_SKIP_GO=1 forces a skip).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorldGround } from '../core/ground';
import { hasWasm, testWorld } from '../testing/wasm';
import { buildZone, formatRun, goAvailable, repoRoot, runTimeline, startZone, type ZoneProc } from '../../sim/dev/traversalRun';
import type { ZoneSession } from '../../net/zoneSession';

const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');
const enabled = goAvailable() && fs.existsSync(wasm) && hasWasm;

// Open forest ground well away from water and towns on the official world (the same stand the evidence run uses).
const AT = { x: 2146.2, z: 2532.8 };
const YAW_DEG = 45; // forward = (-sin yaw, -cos yaw)

describe.skipIf(!enabled)('digging against the real zone process', () => {
  let zone: ZoneProc;

  beforeAll(async () => {
    zone = await startZone(buildZone(), '20261108');
  }, 180000);

  afterAll(() => zone?.proc.kill());

  it('the client mirrors the zone overlay and walks into the pit with prediction == server', async () => {
    const { wg, atlas } = await testWorld();
    const ground = new WorldGround(wg, atlas);
    const yaw = (YAW_DEG * Math.PI) / 180;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // Dig 3.3 m ahead: inside the 6 m reach from the eye (the pit gets deeper and the strike farther), and a 3 m deep pit's slope just stays off the player.
    const px = AT.x + fx * 3.3;
    const pz = AT.z + fz * 3.3;
    const target = BigInt(Math.round(px * 100)) | (BigInt(Math.round(pz * 100)) << 32n);
    const before = ground.heightAt(px, pz);
    let edits = 0;
    const refused: number[] = [];
    let sess!: ZoneSession;
    const r = await runTimeline(
      zone,
      ground,
      'dig',
      { x: AT.x, z: AT.z, yawDeg: YAW_DEG },
      [
        {
          dur: 2.4,
          note: 'dig 6 swings',
          act: () => {
            let n = 0;
            const t = setInterval(() => {
              sess.sendInteract(43, target, 1, 0);
              if (++n >= 6) clearInterval(t);
            }, 300);
          },
        },
        { dur: 0.8, note: 'let the edits land' },
      ],
      { raining: false, updraft: null },
      {
        session: (s) => {
          sess = s;
          s.terrainEditListeners.add((m) => {
            if (ground.edits.applyWire(m.cx, m.cz, m.data)) edits++;
          });
          s.eventListeners.add((ev) => {
            if (ev.kind === 1806) refused.push(ev.value);
          });
        },
      },
    );
    const after = ground.heightAt(px, pz);
    console.log(`[cr040-it] dug at (${px.toFixed(1)}, ${pz.toFixed(1)}): ${before.toFixed(2)} -> ${after.toFixed(2)} m, ${ground.edits.vertices()} vertices, ${edits} TerrainEdits messages, refusals ${JSON.stringify(refused)}; digger's rim correction max ${(r.maxCorrectionM * 100).toFixed(2)} cm`);
    expect(refused).toEqual([]);
    expect(before - after).toBeGreaterThan(2);
    expect(ground.edits.vertices()).toBeGreaterThan(20);
    // The rim under the digger's own feet moves while the swings land (the zone moves first, the client a message later): small corrections.
    expect(r.maxCorrectionM).toBeLessThan(0.1);

    // A second walker, after the pit exists: prediction on the edited ground == the zone, no corrections at all.
    const walk = await runTimeline(
      zone,
      ground,
      'pit',
      { x: AT.x, z: AT.z, yawDeg: YAW_DEG },
      [
        { dur: 4, held: { forward: true }, until: (st) => Math.hypot(st.pos.x - px, st.pos.z - pz) < 0.8, note: 'walk down to the middle of the pit' },
        { dur: 1.2, note: 'stand in it' },
      ],
      { raining: false, updraft: null },
    );
    console.log(`[cr040-it] walk into the pit
${formatRun(walk)}`);
    expect(walk.end.y).toBeLessThan(before - 0.5); // the walker went down into it
    expect(walk.maxDivM).toBeLessThan(0.02);
    expect(walk.corrections).toBe(0);
  }, 120000);
});
