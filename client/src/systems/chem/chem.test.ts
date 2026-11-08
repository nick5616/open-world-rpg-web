// The TS chemistry is the Go chemistry: replay the scenarios
// server/zone/internal/chem wrote (testdata/sim_vectors.json) and check
// every 10th-step digest, the burning counts and the final cells.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { biomeMaterial, ChemSim, inWorld, MAT_NONE, MAT_WATER, seedWords, type ChemSource } from './sim';
import { ChemGround, chemRuntime, pillarHeight } from './ground';
import { EventSync } from './sync';
import { FlatGround } from '../../sim/ground';

interface Scenario {
  name: string;
  seed: string;
  windDeg: number;
  start: number;
  steps: number;
  rain: boolean | null;
  ops: { step: number; kind: number; cell: number; radius: number }[];
  hashes: number[];
  burning: number[];
  final: number[];
}

const scenarios = JSON.parse(readFileSync(new URL('../../../../server/zone/internal/chem/testdata/sim_vectors.json', import.meta.url), 'utf8')) as Scenario[];

/** The synthetic world of chem/sim_test.go: biome bands and a round lake. */
function synth(seed: bigint): ChemSource {
  const w = seedWords(seed);
  const lake = (ix: number, iz: number) => (ix - 1000) ** 2 + (iz - 1000) ** 2 < 30 * 30;
  return {
    material: (ix, iz) => (!inWorld(ix, iz) ? MAT_NONE : lake(ix, iz) ? MAT_WATER : biomeMaterial(w, ix, iz, ((ix >> 4) + (iz >> 4)) % 6)),
    height: (ix) => 100 + (ix % 7) * 0.25,
    water: (ix, iz) => (lake(ix, iz) ? 101.5 : -Infinity),
  };
}

describe('chemistry simulation (Go twin vectors)', () => {
  for (const sc of scenarios) {
    it(sc.name, () => {
      const seed = BigInt(sc.seed);
      const sim = new ChemSim(seed, sc.windDeg, synth(seed), sc.start);
      sim.rain = sc.rain;
      for (const o of sc.ops) sim.schedule({ ...o });
      const hashes: number[] = [];
      const burning: number[] = [];
      for (let i = 1; i <= sc.steps; i++) {
        sim.advanceTo(sc.start + i);
        if (i % 10 === 0) {
          hashes.push(sim.hash());
          burning.push(sim.burning());
        }
      }
      expect(burning).toEqual(sc.burning);
      expect(hashes).toEqual(sc.hashes);
      expect(sim.sortedTriples()).toEqual(sc.final);
    });
  }

  it('two event clients fed the same ops agree cell for cell, whatever their join timing', () => {
    const seed = 20261108n;
    const src = synth(seed);
    const a = new EventSync(seed, 90, src, 5000);
    const b = new EventSync(seed, 90, src, 5000);
    const ops = scenarios[1].ops.map((o) => ({ ...o, step: o.step - scenarios[1].start + 5000 }));
    const ev = (o: (typeof ops)[number]) => {
      const d = new Uint8Array(8);
      new DataView(d.buffer).setBigInt64(0, BigInt(o.step), true);
      return { kind: o.kind === 3 ? 520 : o.kind === 1 ? 521 : 522, targetId: o.cell, value: o.radius, x: 0, y: 0, z: 0, data: d };
    };
    for (const o of ops) a.onEvent(ev(o));
    let bi = 0;
    for (let k = 5000; k < 5400; k += 3) {
      a.advanceTo(k);
      while (bi < ops.length && ops[bi].step < k + 1) b.onEvent(ev(ops[bi++])); // b hears each op just in time
      b.advanceTo(k + 1);
      b.advanceTo(k);
    }
    a.advanceTo(5400);
    b.advanceTo(5400);
    expect(a.step).toBe(b.step);
    expect(a.hash()).toBe(b.hash());
    expect(a.sim.burning() + a.sim.activeChunks().length).toBeGreaterThan(0);
  });

  it('pillars and ice on the ground', () => {
    const p = { id: 1, x: 200, z: 200, baseY: 5, height: 6, half: 1.5, run: 1.06, until: 0 };
    expect(pillarHeight(p, 200.5, 199)).toBe(11);
    expect(Math.abs((pillarHeight(p, 200 + 1.5 + 0.53, 200) ?? 0) - 8)).toBeLessThan(1e-9);
    const src: ChemSource = { material: () => MAT_WATER, height: () => 10, water: () => 11 };
    const view = new EventSync(1n, 0, src, 0);
    view.sim.schedule({ step: 1, kind: 2, cell: 50 * 2048 + 50, radius: 1 });
    view.advanceTo(1 + 2);
    chemRuntime.view = view;
    const g = new ChemGround(new FlatGround(5));
    expect(g.heightAt(101, 101)).toBe(11);
    expect(g.atLevel(-30).heightAt(101, 101)).toBe(5);
    expect(g.collide).toBeUndefined();
    chemRuntime.view = null;
    expect(g.heightAt(101, 101)).toBe(5);
  });
});
