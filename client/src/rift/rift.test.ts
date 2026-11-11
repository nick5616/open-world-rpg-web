// CR 040: the client's arena and bullet math replays the zone's golden
// vectors (server/zone/internal/rift/testdata/rift_golden.json, written by
// `go test ./internal/rift -run TestGoldenForTheClient -update`).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collide, hash, mix, spikesUp, stageLayout, SPIKES } from './layout';
import { bulletPos, bullets, decodeVolley, laserAt, rainAt, seekers, seekerStep, KIND_LASER, KIND_RAIN, KIND_SEEKER, type Volley } from './patterns';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(readFileSync(path.resolve(HERE, '../../../server/zone/internal/rift/testdata/rift_golden.json'), 'utf8'));

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('rift golden vectors (Go = TS)', () => {
  it('hashes', () => {
    for (const [i, h, m] of G.hashes) {
      expect(hash(i, 3, (0xffffffff - i / 977) >>> 0)).toBe(h);
      expect(mix(Math.imul(i / 977, 2654435761) >>> 0)).toBe(m);
    }
  });

  it('layouts, collision and spikes', () => {
    for (const g of G.layouts) {
      const l = stageLayout(g.Chapter, g.Stage);
      expect(l.template).toBe(g.Template);
      expect(l.obstacles.map((o) => [o.kind, o.x, o.z, o.r, o.h, o.phase])).toEqual((g.Obstacles ?? []).map((o: Record<string, number>) => [o.Kind, o.X, o.Z, o.R, o.H, o.Phase]));
      expect(l.slots).toEqual(g.Slots ?? []);
      for (const [x, z, cx, cz] of g.Collide ?? []) {
        const [px, pz] = collide(l, x, z);
        expect(px).toBe(cx);
        expect(pz).toBe(cz);
      }
      const sp = l.obstacles.filter((o) => o.kind === SPIKES);
      let k = 0;
      for (const o of sp)
        for (const t of [0, 1.3, 2.5, 7.9]) {
          const [gt, up, warn] = g.Spikes[k++];
          expect(gt).toBe(t);
          const s = spikesUp(o, t);
          expect([s.up ? 1 : 0, s.warn ? 1 : 0]).toEqual([up, warn]);
        }
    }
  });

  it('every pattern kind: bullets, lasers, rain, seekers', () => {
    for (const g of G.volleys) {
      const l = stageLayout(g.Chapter, g.Stage);
      const w = g.v;
      const v: Volley = { id: 1, kind: w.kind, fire: w.fire, windup: w.windup, ox: w.ox, oz: w.oz, angle: (w.angleU16 * 2 * Math.PI) / 65536, count: w.count, speed: w.speed, radius: w.radius, p1: w.p1, p2: w.p2, p3: w.p3, seed: w.seed, life: w.life, src: 0 };
      expect(g.Bullets?.length ?? g.bullets?.length ?? 0).toBe(bullets(v) * 5);
      for (const b of g.bullets ?? []) {
        const p = bulletPos(v, b.i, b.t, l);
        expect(!!p, `kind ${v.kind} bullet ${b.i} at ${b.t}`).toBe(b.alive);
        if (p) {
          expect(near(p[0], b.x, 1e-7) && near(p[1], b.z, 1e-7), `kind ${v.kind} bullet ${b.i} at ${b.t}: ${p} vs ${b.x},${b.z}`).toBe(true);
        }
      }
      if (v.kind === KIND_LASER) {
        for (const [t, a, len] of g.laser) {
          const r = laserAt(v, t, l);
          expect(near(r.a, a, 1e-9)).toBe(true);
          expect(near(r.live ? r.length : -r.length, len, 1e-7)).toBe(true);
        }
      }
      if (v.kind === KIND_RAIN) {
        g.rain.forEach(([x, z, r, land]: number[], i: number) => {
          const q = rainAt(v, i);
          expect([q.x, q.z, q.r, q.land]).toEqual([x, z, r, land]);
        });
      }
      if (v.kind === KIND_SEEKER) {
        const ss = seekers(v);
        let n = 0;
        for (let k = 0; k < 60; k++) {
          const tx = 3 * Math.cos(k / 20);
          const tz = 6 + 2 * Math.sin(k / 15);
          for (const s of ss) seekerStep(v, s, tx, tz, l);
          if (k % 10 === 9)
            for (const s of ss) {
              const [x, z, d] = g.seekers[n++];
              expect(near(s.x, x, 1e-6) && near(s.z, z, 1e-6) && (s.dead ? 1 : 0) === d).toBe(true);
            }
        }
      }
    }
  });

  it('decodes Event 1702 (game/rift.go encodeVolley)', () => {
    const b = new Uint8Array(39);
    const dv = new DataView(b.buffer);
    b[0] = 3;
    dv.setUint32(1, 1234, true);
    dv.setUint16(5, 650, true);
    dv.setInt16(7, -250, true);
    dv.setInt16(9, -900, true);
    dv.setUint16(11, 16384, true);
    b[13] = 7;
    dv.setUint16(14, 420, true);
    b[16] = 30;
    dv.setInt32(17, 550, true);
    dv.setInt32(21, -2, true);
    dv.setInt32(25, 320, true);
    dv.setUint32(29, 0xdeadbeef, true);
    dv.setUint16(33, 8000, true);
    dv.setUint32(35, 77, true);
    const v = decodeVolley(9, b)!;
    expect(v).toMatchObject({ id: 9, kind: 3, fire: 1234, windup: 650, ox: -2.5, oz: -9, count: 7, speed: 4.2, radius: 0.3, p1: 550, p2: -2, p3: 320, seed: 0xdeadbeef, life: 8, src: 77 });
    expect(v.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(KIND_RAIN).toBe(8);
  });
});
