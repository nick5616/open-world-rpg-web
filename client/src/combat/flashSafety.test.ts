import { describe, expect, it } from 'vitest';
import { CALM, PUNCHY, FlashGate, HitTint, flashEnvelope, lightEnvelope, pickProfile, type FlashProfile } from './flashSafety';

/** WCAG-style count on a 0..1 signal: transitions are monotonic runs of >= `min`; flashes = pairs. */
function flashesPerSecond(samples: { t: number; v: number }[], min: number): number {
  const trans: number[] = [];
  let start = samples[0].v;
  let last = start;
  let dir = 0;
  for (const s of samples.slice(1)) {
    const d = s.v - last;
    if (Math.abs(d) < 1e-6) continue;
    const sg = d > 0 ? 1 : -1;
    if (dir === 0 || dir === sg) {
      dir = sg;
      last = s.v;
      continue;
    }
    if (Math.abs(last - start) >= min) trans.push(s.t);
    start = last;
    last = s.v;
    dir = sg;
  }
  let worst = 0;
  let j = 0;
  for (let i = 0; i < trans.length; i++) {
    while (trans[i] - trans[j] > 1000) j++;
    worst = Math.max(worst, Math.floor((i - j + 1) / 2));
  }
  return worst;
}

/** Hits every `everyMs` for `ms`, sampled at 60 fps. */
function drive(p: FlashProfile, everyMs: number, ms = 4000): { samples: { t: number; v: number }[]; tint: HitTint } {
  const tint = new HitTint();
  const samples: { t: number; v: number }[] = [];
  let nextHit = 0;
  for (let t = 0; t <= ms; t += 1000 / 60) {
    while (t >= nextHit && nextHit <= ms - 600) {
      tint.hit(nextHit, p);
      nextHit += everyMs;
    }
    samples.push({ t, v: tint.update(t, 1000 / 60, p) });
  }
  return { samples, tint };
}

describe('flash safety (playtest 2 calm kills)', () => {
  it('picks calm by default, with reduced motion, and punchy only when both are off', () => {
    expect(pickProfile(true, false)).toBe(CALM);
    expect(pickProfile(false, true)).toBe(CALM);
    expect(pickProfile(true, true)).toBe(CALM);
    expect(pickProfile(false, false)).toBe(PUNCHY);
  });

  it('keeps both profiles inside WCAG 2.3.1 and calm under the bloom threshold', () => {
    for (const p of [CALM, PUNCHY]) {
      expect(1000 / p.hitMinIntervalMs).toBeLessThanOrEqual(3);
      expect(1000 / p.fxMinIntervalMs).toBeLessThanOrEqual(3);
      expect(p.tellHz).toBeLessThanOrEqual(2);
      expect(p.allyFadeHz).toBeLessThanOrEqual(2);
      expect(p.hitPeak).toBeLessThanOrEqual(0.5); // a tint of the body's colour, never the old 1.0 white
      expect(p.hitRiseMs).toBeGreaterThan(0);
    }
    // the post chain's bloom threshold is 1.25: calm flashes, the death edge and spell cores stay below it
    expect(CALM.fxFlashMaxChannel).toBeLessThan(1.25);
    expect(CALM.deathEdge).toBe(0);
    expect(CALM.hdrMax).toBeLessThan(1.5);
    expect(CALM.hitPeak).toBeLessThan(PUNCHY.hitPeak);
    expect(CALM.fxFlashOpacity).toBeLessThan(PUNCHY.fxFlashOpacity);
    // fresh particles barely white-hot, a thin swing arc, half the shake
    expect(CALM.particleHot).toBeLessThan(0.5);
    expect(CALM.swingTrail).toBeLessThan(0.5);
    expect(CALM.shake).toBeLessThanOrEqual(0.5);
    for (const p of [CALM, PUNCHY]) expect(p.particleHot).toBeLessThanOrEqual(1);
  });

  it('limits a strobe of hits (wand 4/s, a pack, a 15 Hz stream) to at most 3 flashes a second', () => {
    for (const p of [CALM, PUNCHY]) {
      for (const every of [66, 120, 250, 300, 340, 400, 500, 700]) {
        const { samples, tint } = drive(p, every);
        // any swing of a third of the peak counts as a transition (stricter than the 10 % luminance rule)
        expect(flashesPerSecond(samples, p.hitPeak / 3), `${p.name} every ${every} ms`).toBeLessThanOrEqual(3);
        expect(tint.pulses).toBeLessThanOrEqual(Math.ceil(4000 / p.hitMinIntervalMs) + 1);
        expect(Math.max(...samples.map((s) => s.v))).toBeLessThanOrEqual(p.hitPeak + 1e-9);
      }
    }
  });

  it('a stream of hits holds a steady tint instead of re-flashing it', () => {
    const { samples } = drive(CALM, 66, 3000);
    const mid = samples.filter((s) => s.t > 500 && s.t < 2300).map((s) => s.v);
    // after the first pulse it never drops back toward zero while the hits keep coming
    expect(Math.min(...mid)).toBeGreaterThan(CALM.hitPeak * 0.5);
  });

  it('a single hit eases in and out (no one-frame jump to full)', () => {
    const t = new HitTint();
    t.hit(0, CALM);
    const first = t.update(1000 / 60, 1000 / 60, CALM);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(CALM.hitPeak * 0.5);
    let v = first;
    let tt = 1000 / 60;
    for (; tt < 1500; tt += 1000 / 60) v = t.update(tt, 1000 / 60, CALM);
    expect(v).toBe(0);
  });

  it('merges the duplicate flashes of one hit and spaces flashes in one spot', () => {
    const g = new FlashGate();
    expect(g.allow(10.2, 5.1, 0, CALM)).toBe(true);
    // the projectile's impact, the hit burst and an observer's Event 200 burst: same spot, same moment
    expect(g.allow(10.6, 5.4, 3, CALM)).toBe(false);
    expect(g.allow(11.9, 6.3, 8, CALM)).toBe(false); // the next cell over still merges
    expect(g.allow(30, 5, 10, CALM)).toBe(true); // a different enemy across the field
    expect(g.allow(10.2, 5.1, CALM.fxMinIntervalMs - 1, CALM)).toBe(false);
    expect(g.allow(10.2, 5.1, CALM.fxMinIntervalMs + 1, CALM)).toBe(true);
    // a 15 Hz stream into one spot for 3 s: at most 3 a second get through
    const g2 = new FlashGate();
    let n = 0;
    for (let t = 0; t < 3000; t += 66) if (g2.allow(0, 0, t, PUNCHY)) n++;
    expect(n).toBeLessThanOrEqual(9);
  });

  it('flash and light envelopes start dark, peak at 1 at most, end dark', () => {
    for (const rise of [0.2, 0.35, 0.4]) {
      expect(flashEnvelope(0, rise)).toBe(0);
      expect(flashEnvelope(1, rise)).toBe(0);
      expect(flashEnvelope(0.02, rise)).toBeLessThan(0.05);
      let max = 0;
      let prev = 0;
      let maxStep = 0;
      for (let k = 0; k <= 1; k += 0.01) {
        const v = lightEnvelope(k, rise);
        max = Math.max(max, v);
        maxStep = Math.max(maxStep, Math.abs(v - prev));
        prev = v;
      }
      expect(max).toBeLessThanOrEqual(1);
      expect(max).toBeGreaterThan(0.95);
      expect(maxStep).toBeLessThan(0.1); // smooth: no step from dark to full
    }
  });
});
