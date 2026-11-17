import { describe, expect, it } from 'vitest';
import {
  A,
  BUBBLE_M,
  CHAT_M,
  GreetLimiter,
  H,
  HEAD_MAX,
  NPC_ROLE,
  PROP,
  T,
  blinking,
  bubbleAlpha,
  buildOf,
  carryProp,
  chatLine,
  chatPairs,
  dressFor,
  easeTo,
  hammerArm,
  lookAround,
  lookAt,
  newPose,
  resetPose,
  selectBubbles,
  smithState,
  wavePose,
  workPose,
  wrapPi,
} from './npcLife';
import { CONVOS, CONVO_COUNT, cryFor, greetingFor, h32, timeBucket } from './npcLines';

describe('looking', () => {
  it('turns the head toward a target in front and limits the angle', () => {
    // NPC at the origin facing +x (yaw 0); a target at +z is 90 degrees to its side.
    const r = lookAt(0, 0, 0, 0, 5);
    expect(r.reach).toBe(true);
    expect(r.head).toBeCloseTo(HEAD_MAX, 5); // 90 degrees clamps at the head limit
    expect(r.torso).toBeGreaterThan(0);
    expect(r.torso).toBeLessThan(r.head);
    const small = lookAt(0, 0, 0, 5, 1);
    expect(small.head).toBeCloseTo(Math.atan2(1, 5), 5);
    expect(lookAt(0, 0, 0, 5, -1).head).toBeLessThan(0);
  });
  it('gives up on a target behind it so the head eases back', () => {
    const r = lookAt(0, 0, 0, -5, 0.5);
    expect(r.reach).toBe(false);
    expect(r.head).toBe(0);
    expect(r.torso).toBe(0);
  });
  it('takes the body yaw into account and wraps', () => {
    const r = lookAt(Math.PI - 0.1, 0, 0, -5, -0.2);
    expect(Math.abs(r.head)).toBeLessThan(0.5);
    expect(Math.abs(wrapPi(3 * Math.PI))).toBeCloseTo(Math.PI, 5);
  });
  it('eases toward a target without overshooting, independent of frame rate', () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = easeTo(a, 1, 1 / 60, 6);
    let b = 0;
    for (let i = 0; i < 30; i++) b = easeTo(b, 1, 1 / 30, 6);
    expect(a).toBeGreaterThan(0.99);
    expect(a).toBeLessThanOrEqual(1);
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });
  it('wanders the head slowly and blinks briefly', () => {
    let max = 0;
    for (let t = 0; t < 200; t += 0.5) max = Math.max(max, Math.abs(lookAround(t, 7)));
    expect(max).toBeGreaterThan(0.2);
    expect(max).toBeLessThanOrEqual(0.62 + 1e-9);
    let closed = 0;
    for (let t = 0; t < 60; t += 0.02) if (blinking(t, 3)) closed++;
    expect(closed / 3000).toBeGreaterThan(0.01);
    expect(closed / 3000).toBeLessThan(0.1);
  });
});

describe('greeting rate limit', () => {
  it('lets a walk through town produce a few greetings, not a chorus', () => {
    const g = new GreetLimiter();
    let n = 0;
    // 25 NPCs passed in 60 s, one every 2.4 s.
    for (let i = 0; i < 25; i++) if (g.tryGreet(i, i * 2400)) n++;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(4);
  });
  it('keeps one NPC quiet toward you for a while, then lets it greet again', () => {
    const g = new GreetLimiter();
    expect(g.tryGreet(1, 0)).toBe(true);
    expect(g.tryGreet(1, 20_000)).toBe(false);
    expect(g.tryGreet(1, 200_000)).toBe(true);
  });
  it('enforces the gap between any two greetings', () => {
    const g = new GreetLimiter();
    expect(g.tryGreet(1, 0)).toBe(true);
    expect(g.tryGreet(2, 3000)).toBe(false);
    expect(g.tryGreet(2, 9000)).toBe(true);
  });
});

describe('chatting', () => {
  const c = (key: number, x: number, z: number, speed = 0) => ({ key, stable: key, x, z, speed });
  it('pairs idle neighbours, nearest first, each in at most one pair', () => {
    const pairs = chatPairs([c(1, 0, 0), c(2, 1.5, 0), c(3, 20, 0), c(4, 21, 1), c(5, 40, 0)]);
    expect(pairs).toEqual([
      [0, 1],
      [2, 3],
    ]);
    // A three-way crowd: the closest two pair, the third is left out.
    const crowd = chatPairs([c(1, 0, 0), c(2, 1, 0), c(3, 2.9, 0)]);
    expect(crowd).toHaveLength(1);
    expect(crowd[0]).toEqual([0, 1]);
  });
  it('does not pair walkers or people out of earshot', () => {
    expect(chatPairs([c(1, 0, 0, 1.4), c(2, 1, 0)])).toEqual([]);
    expect(chatPairs([c(1, 0, 0), c(2, CHAT_M + 0.5, 0)])).toEqual([]);
  });
  it('orders each pair by stable id', () => {
    const pairs = chatPairs([c(9, 0, 0), c(2, 1, 0)]);
    expect(pairs).toEqual([[1, 0]]);
  });
  it('is deterministic from the ids and the clock, alternates speakers and ends', () => {
    // Find a minute slot in which 4 and 9 talk.
    let slot = 0;
    while (!chatLine(4, 9, slot * 60 + 12)) slot++;
    const base = slot * 60;
    const lines: { text: string; speakerIsA: boolean; index: number }[] = [];
    for (let s = 0; s < 40; s += 0.5) {
      const l = chatLine(4, 9, base + s);
      expect(chatLine(4, 9, base + s)).toEqual(l); // pure
      if (l && lines[lines.length - 1]?.index !== l.index) lines.push(l);
    }
    expect(lines.length).toBeGreaterThanOrEqual(3);
    lines.forEach((l, i) => expect(l.speakerIsA).toBe(i % 2 === 0));
    expect(chatLine(4, 9, base + 59.9)).toBeNull(); // the conversation has ended before the minute does
  });
  it('talks in some minutes, not all, and never indexes past a conversation', () => {
    let talking = 0;
    for (let s = 0; s < 200; s++) {
      const l = chatLine(11, 23, s * 60 + 20);
      if (l) {
        talking++;
        expect(l.index).toBeLessThan(CONVOS[l.convo].length);
        expect(l.text.length).toBeGreaterThan(5);
      }
    }
    expect(talking).toBeGreaterThan(60);
    expect(talking).toBeLessThan(160);
  });
  it('has a pool of overheard conversations with gossip about the region', () => {
    expect(CONVO_COUNT).toBeGreaterThanOrEqual(15);
    const all = CONVOS.flat().join(' ').toLowerCase();
    for (const topic of ['light', 'dwarves', 'bandits', 'sky']) expect(all).toContain(topic);
    for (const convo of CONVOS) {
      expect(convo.length).toBeGreaterThanOrEqual(3);
      for (const line of convo) expect(line.length).toBeLessThan(110);
    }
  });
});

describe('bubbles', () => {
  const cand = (key: number, d: number, toYou = false, onScreen = true) => ({ key, d, toYou, onScreen });
  it('shows the nearest few within range, on screen', () => {
    const picked = selectBubbles([cand(1, 20), cand(2, 5), cand(3, 30), cand(4, 8, false, false), cand(5, 12), cand(6, 3), cand(7, 15), cand(8, 6)]);
    expect(picked.map((x) => x.key)).toEqual([6, 2, 8, 5]);
    expect(picked.every((x) => x.d <= BUBBLE_M)).toBe(true);
  });
  it('slightly prefers a line addressed to you', () => {
    const picked = selectBubbles([cand(1, 6), cand(2, 9, true)], 1);
    expect(picked[0].key).toBe(2);
    expect(selectBubbles([cand(1, 3), cand(2, 20, true)], 1)[0].key).toBe(1); // but not over someone right beside you
  });
  it('fades in, holds, fades out and fades toward the range edge', () => {
    expect(bubbleAlpha(1000, 1000, 5000, 5)).toBe(0);
    expect(bubbleAlpha(1100, 1000, 5000, 5)).toBeCloseTo(0.5, 5);
    expect(bubbleAlpha(3000, 1000, 5000, 5)).toBe(1);
    expect(bubbleAlpha(4800, 1000, 5000, 5)).toBeCloseTo(0.4, 5);
    expect(bubbleAlpha(3000, 1000, 5000, 24)).toBeLessThan(0.5);
  });
});

describe('work poses', () => {
  it('strikes the anvil in bursts and counts every blow once', () => {
    let last = -1;
    let changes = 0;
    for (let t = 0; t < 60; t += 0.05) {
      const s = smithState(t);
      expect(s.strikes).toBeGreaterThanOrEqual(last);
      if (s.strikes !== last) changes++;
      last = s.strikes;
    }
    expect(last).toBeGreaterThan(30);
    expect(changes).toBe(last + 1); // one step per blow (the first reading counts as a change)
    // A rest between bursts.
    let resting = false;
    for (let t = 0; t < 12; t += 0.1) if (smithState(t).ph < 0) resting = true;
    expect(resting).toBe(true);
  });
  it('lifts the hammer, then brings it down on the blow', () => {
    expect(hammerArm(0)).toBeGreaterThan(hammerArm(0.5));
    expect(hammerArm(0.5)).toBeLessThan(hammerArm(0.99));
    expect(hammerArm(0.5)).toBeCloseTo(0.8, 5);
  });
  it('gives each role its own work and held prop', () => {
    const p = newPose();
    const propOf = (role: number, variant = 0) => {
      resetPose(p);
      workPose(p, role, 3.3, 5, variant);
      return p.prop;
    };
    expect(propOf(NPC_ROLE.blacksmith)).toBe(PROP.hammer);
    expect(propOf(NPC_ROLE.farmer, 0)).toBe(PROP.hoe);
    expect(propOf(NPC_ROLE.farmer, 1)).toBe(PROP.scythe);
    expect(propOf(NPC_ROLE.guard)).toBe(PROP.spear);
    expect(propOf(NPC_ROLE.villager, 0)).toBe(PROP.broom);
    expect(propOf(NPC_ROLE.villager, 1)).toBe(PROP.basket);
    expect(propOf(NPC_ROLE.villager, 2)).toBe(PROP.bucket);
    expect(propOf(NPC_ROLE.merchant, 0)).toBe(PROP.crate);
    expect(propOf(NPC_ROLE.merchant, 1)).toBe(-1);
    // The innkeeper wipes the counter, then carries a mug.
    const props = new Set<number>();
    for (let t = 0; t < 24; t += 1) {
      resetPose(p);
      workPose(p, NPC_ROLE.innkeeper, t, 0, 0);
      props.add(p.prop);
    }
    expect(props.has(PROP.mug)).toBe(true);
    expect(props.has(-1)).toBe(true);
  });
  it('keeps every pose angle in a sane range', () => {
    const p = newPose();
    for (let role = 0; role <= 6; role++)
      for (let v = 0; v < 4; v++)
        for (let t = 0; t < 30; t += 0.37) {
          resetPose(p);
          workPose(p, role, t, role * 13 + v, v);
          for (const k of ['rFwd', 'lFwd'] as const) {
            expect(p[k]).toBeGreaterThan(-0.5);
            expect(p[k]).toBeLessThan(3.1);
          }
          expect(Math.abs(p.bend)).toBeLessThan(0.7);
          expect(Math.abs(p.twist)).toBeLessThan(1);
        }
  });
  it('carries chores while walking and waves for 1.6 s', () => {
    expect(carryProp(NPC_ROLE.villager, 1)).toBe(PROP.basket);
    expect(carryProp(NPC_ROLE.villager, 2)).toBe(PROP.bucket);
    expect(carryProp(NPC_ROLE.guard, 0)).toBe(PROP.spear);
    expect(carryProp(NPC_ROLE.merchant, 0)).toBe(-1);
    const p = newPose();
    expect(wavePose(p, -0.1)).toBe(false);
    expect(wavePose(p, 0.8)).toBe(true);
    expect(p.rFwd).toBeGreaterThan(2);
    expect(wavePose(newPose(), 1.7)).toBe(false);
  });
});

describe('variety', () => {
  it('gives townsfolk different builds; elders stoop and walk slower', () => {
    const builds = Array.from({ length: 300 }, (_, i) => buildOf(NPC_ROLE.villager, i & 255, i));
    const heights = new Set(builds.map((b) => b.h.toFixed(2)));
    expect(heights.size).toBeGreaterThan(8);
    const elders = builds.filter((b) => b.elder);
    expect(elders.length).toBeGreaterThan(20);
    expect(elders.length).toBeLessThan(110);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(elders.map((b) => b.gait))).toBeLessThan(avg(builds.filter((b) => !b.elder).map((b) => b.gait)));
    for (const b of builds) {
      expect(b.h).toBeGreaterThan(0.85);
      expect(b.h).toBeLessThan(1.12);
      expect(b.w).toBeGreaterThan(0.85);
      expect(b.w).toBeLessThan(1.15);
    }
  });
  it('dresses villagers in many different looks, and keeps role looks', () => {
    const looks = new Set<string>();
    const heads = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const d = dressFor(NPC_ROLE.villager, (i * 37) & 255, i, false, false);
      looks.add(`${d.head}/${d.torso}/${d.arm}/${d.hairCol}`);
      heads.add(d.head);
    }
    expect(looks.size).toBeGreaterThan(120);
    const seen = (bit: number) => [...heads].some((h) => (h >> bit) % 2 === 1);
    for (const bit of [H.short, H.long, H.bun, H.curls, H.pony, H.cap, H.hood, H.scarf, H.beardShort, H.beardFull, H.moustache, H.flatCap, H.bald]) expect(seen(bit)).toBe(true);
    for (let i = 0; i < 60; i++) {
      const g = dressFor(NPC_ROLE.guard, i, i, false, false);
      expect((g.head >> H.helm) % 2).toBe(1);
      expect((g.torso >> T.tabard) % 2).toBe(1);
      expect((g.arm >> A.bracer) % 2).toBe(1);
      expect(dressFor(NPC_ROLE.blacksmith, i, i, false, false).torso & (1 << T.apron)).toBeTruthy();
      expect(dressFor(NPC_ROLE.blacksmith, i, i, false, false).arm).toBe(0); // bare forearms
      expect((dressFor(NPC_ROLE.villager, i, i, true, false).head >> H.beardDwarf) % 2).toBe(1);
    }
  });
  it('never puts two hair styles through each other', () => {
    for (let i = 0; i < 500; i++) {
      const d = dressFor(i % 7, (i * 11) & 255, i, false, false);
      const hair = [H.short, H.long, H.bun, H.curls, H.pony].filter((b) => (d.head >> b) % 2 === 1);
      const hat = [H.cap, H.flatCap, H.hat, H.helm].filter((b) => (d.head >> b) % 2 === 1);
      expect(hair.length).toBeLessThanOrEqual(1);
      expect(hat.length).toBeLessThanOrEqual(1);
      if (hat.length) expect(hair.every((b) => b === H.short)).toBe(true);
    }
  });
});

describe('lines', () => {
  it('greets by role, time of day and weather, deterministically', () => {
    expect(greetingFor(NPC_ROLE.guard, 22, false, 3)).toBe(greetingFor(NPC_ROLE.guard, 22, false, 3));
    expect(timeBucket(8)).toBe('morning');
    expect(timeBucket(23)).toBe('night');
    const rainy = new Set<string>();
    for (let s = 0; s < 40; s++) rainy.add(greetingFor(NPC_ROLE.villager, 12, true, s));
    expect([...rainy].some((l) => /wet|rain|roof|ducks/i.test(l))).toBe(true);
    for (let role = 0; role <= 6; role++) for (let s = 0; s < 20; s++) expect(greetingFor(role, (s * 7) % 24, s % 3 === 0, s).length).toBeGreaterThan(3);
  });
  it('merchants call out wares by kind', () => {
    const provisions = new Set<string>();
    for (let s = 0; s < 30; s++) provisions.add(cryFor(NPC_ROLE.merchant, 1, s));
    expect([...provisions].some((l) => /apple|bread|cheese|pie/i.test(l))).toBe(true);
    expect(cryFor(NPC_ROLE.merchant, 99, 1).length).toBeGreaterThan(3);
  });
  it('hashes stably', () => {
    expect(h32(1, 2, 3)).toBe(h32(1, 2, 3));
    expect(h32(1, 2, 3)).not.toBe(h32(1, 2, 4));
  });
});
