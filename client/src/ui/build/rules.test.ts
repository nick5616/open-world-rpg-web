// CR 041: replays the zone's golden vectors (server/pkg/camps/testdata/build.json,
// written by `go test ./server/pkg/camps -run TestBuildVectors -update`): placement
// results over a stone-and-wood house and the walkable surface heights and
// push-outs over it, bit for bit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAMPS } from '@lodestone/contracts';
import type { CollideResult } from '../../sim/ground';
import { CampSet } from '../camps/collide';
import type { BP } from './geometry';
import { checkBuild, orphans, REFUSE, stability, type BuildEnv } from './rules';

const here = path.dirname(fileURLToPath(import.meta.url));
const vec = JSON.parse(fs.readFileSync(path.resolve(here, '../../../../server/pkg/camps/testdata/build.json'), 'utf8')) as {
  groundCm: number;
  pieces: { kind: string; rot: number; X: number; Y: number; Z: number; state?: number; owner?: string }[];
  checks: { kind: string; rot: number; X: number; Y: number; Z: number; hasY: boolean; owner: string; yOut: number; why: number }[];
  bodies: { X: number; Z: number; Y: number; h: number; ok: boolean; pushX: number; pushZ: number }[];
};

const id = (key: string) => CAMPS.pieces.find((p) => p.key === key)!.id;
const env: BuildEnv = {
  heightAt: () => 50,
  waterAt: () => -100,
  noBuild: (x, z) => (Math.hypot(x - 3000, z - 3000) < 40 ? REFUSE.site : 0),
  structure: () => false,
};
const pieces: BP[] = vec.pieces.map((p, i) => ({ id: i + 1, kind: id(p.kind), rot: p.rot, x: p.X, y: p.Y, z: p.Z, state: p.state ?? 0, owner: p.owner ?? '', party: 0, lock: 0 }));

describe('build rules (golden vectors)', () => {
  it('has vectors', () => {
    expect(vec.pieces.length).toBeGreaterThan(8);
    expect(vec.checks.length).toBeGreaterThan(1000);
    expect(vec.bodies.length).toBeGreaterThan(500);
  });

  it('every placement check agrees with the zone', () => {
    let bad = 0;
    const seen = new Set<number>();
    for (const c of vec.checks) {
      const r = checkBuild({ kind: id(c.kind), rot: c.rot, x: c.X, y: c.Y, z: c.Z, hasY: c.hasY, owner: c.owner, party: 0, feetX: c.X / 100, feetY: 60, feetZ: c.Z / 100 }, pieces, env);
      seen.add(r.reason);
      if (r.reason !== c.why || (c.why === 0 && r.y !== c.yOut)) {
        bad++;
        if (bad < 5) console.log('mismatch', c, r);
      }
    }
    expect(bad).toBe(0);
    // The vectors exercise accepted and every kind of refusal that matters.
    for (const r of [0, REFUSE.blocked, REFUSE.grid, REFUSE.support, REFUSE.otherBuild]) expect(seen.has(r)).toBe(true);
  });

  it('surface heights and push-outs match the zone', () => {
    const set = new CampSet(pieces.map((p) => ({ id: p.id, kind: p.kind, rot: p.rot, x: p.x / 100, y: p.y / 100, z: p.z / 100, state: p.state })));
    expect(set.hasSurfaces).toBe(true);
    const out: CollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };
    let pushed = 0;
    let stood = 0;
    for (const b of vec.bodies) {
      const h = set.surfaceAt(b.X, b.Z, b.Y);
      expect(h !== null).toBe(b.ok);
      if (b.ok) {
        expect(h).toBe(b.h);
        stood++;
      }
      set.after({ x: b.X, y: b.Y, z: b.Z, pushX: 0, pushZ: 0, ceiling: false }, out);
      expect(out.pushX).toBe(b.pushX);
      expect(out.pushZ).toBe(b.pushZ);
      if (b.pushX !== 0 || b.pushZ !== 0) pushed++;
    }
    expect(stood).toBeGreaterThan(20);
    expect(pushed).toBeGreaterThan(10);
  });

  it('an open door lets you through, a closed one does not', () => {
    const door = { id: 1, kind: id('door_stone'), rot: 0, x: 1003, y: 50, z: 1000 };
    const body = (set: CampSet) => set.after({ x: 1003, y: 50, z: 1000.05, pushX: 0, pushZ: 0, ceiling: false }, { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false });
    expect(Math.abs(body(new CampSet([door])).pushZ)).toBeGreaterThan(0);
    expect(body(new CampSet([{ ...door, state: 1 }])).pushZ).toBe(0);
  });

  it('support: removing the foundation orphans what stands on it', () => {
    const st = stability(pieces, env);
    expect(st.size).toBeGreaterThan(5);
    const first = pieces.find((p) => p.kind === id('foundation_stone'))!;
    expect(orphans(pieces, first.id, env).length).toBeGreaterThan(0);
  });
});
