import { describe, expect, it } from 'vitest';
import { CONTENT, type Event as ZoneEvent } from '@lodestone/contracts';
import { Fight, FIGHT, fightMinMs, rng, type FightEnd } from './minigame';
import { castPoint, FEV, packCast, waterSurface, weightText } from './fish';
import { applyFishEvent, fishLive, fishingTick, floatState, press, resetFishing, useFishing } from './store';

const species = CONTENT.fishing.species;

/** A good angler: reel while the fish rests and the line has slack, let go when it surges. */
function play(f: Fight, policy: (f: Fight) => boolean, maxS = 120): FightEnd | null {
  for (let i = 0; i < maxS * 60 && !f.done; i++) f.step(policy(f));
  return f.done;
}
/** Watching the bar: reel until the tension reddens, let go until it eases (what the HUD asks for). */
function skilled(): (f: Fight) => boolean {
  let held = true;
  return (f) => {
    if (held && f.tension > 0.85) held = false;
    else if (!held && f.tension < 0.45) held = true;
    return held;
  };
}

describe('fishing minigame', () => {
  it('is deterministic per seed', () => {
    const a = new Fight({ seed: 1234, strength: 0.7, erratic: 0.5, stamina: 3.5 });
    const b = new Fight({ seed: 1234, strength: 0.7, erratic: 0.5, stamina: 3.5 });
    for (let i = 0; i < 600; i++) {
      a.step(i % 3 !== 0);
      b.step(i % 3 !== 0);
    }
    expect(a.tension).toBe(b.tension);
    expect(a.progress).toBe(b.progress);
    expect(a.done).toBe(b.done);
    const r1 = rng(9);
    const r2 = rng(9);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });

  it('an angler who watches the tension lands every species, never faster than the zone allows', () => {
    for (const sp of species) {
      let landed = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const f = new Fight({ seed: seed * 7919, ...sp.fight });
        if (play(f, skilled()) === 'landed') {
          landed++;
          expect(f.ms).toBeGreaterThanOrEqual(fightMinMs(sp.fight.stamina) - 50);
          expect(f.t).toBeLessThan(CONTENT.fishing.maxFightS);
        }
      }
      // legendary fish may still win now and then
      expect(landed, sp.key).toBeGreaterThanOrEqual(sp.rarity === 3 ? 16 : 20);
    }
  });

  it('perfect reeling against a calm fish is exactly the fastest fight', () => {
    const f = new Fight({ seed: 5, strength: 0, erratic: 0, stamina: 3 });
    expect(play(f, () => true)).toBe('landed');
    expect(Math.abs(f.ms - fightMinMs(3))).toBeLessThanOrEqual(20);
    expect(fightMinMs(2.6)).toBe(3250); // Go: int(1250 * stamina)
  });

  it('reeling through every surge snaps the line on a strong fish; never reeling lets it go', () => {
    const strong = species.find((s) => s.key === 'deepmaw')!;
    let snapped = 0;
    for (let seed = 1; seed <= 10; seed++) if (play(new Fight({ seed, ...strong.fight }), () => true) === 'snapped') snapped++;
    expect(snapped).toBeGreaterThanOrEqual(9);
    const weak = species.find((s) => s.key === 'silverfin')!;
    expect(play(new Fight({ seed: 3, ...weak.fight }), () => false)).toBe('escaped');
    // a minnow can't snap the line even if you never let go
    expect(play(new Fight({ seed: 3, ...weak.fight }), () => true)).toBe('landed');
  });

  it('the red zone needs a moment before the line goes', () => {
    const f = new Fight({ seed: 1, strength: 1, erratic: 0, stamina: 12 });
    f.tension = 0.99;
    (f as unknown as { target: number }).target = 1;
    f.pull = 1;
    let steps = 0;
    while (!f.done && steps < 200) {
      f.step(true);
      steps++;
    }
    expect(f.done).toBe('snapped');
    expect(steps * FIGHT.stepS).toBeGreaterThanOrEqual(FIGHT.redS - 0.02);
  });
});

describe('casting', () => {
  // A lake east of x = 2060 (surface 11.5 m over ground at 10 m).
  const pond = { heightAt: () => 10, waterAt: (x: number) => (x > 2060 ? 11.5 : -Infinity) };
  it('finds deep water ahead, near where the view meets it', () => {
    const eye = { x: 2050, y: 11.6, z: 2048 };
    const east = -Math.PI / 2; // forward is (-sin, -cos): yaw -pi/2 looks +x
    const level = castPoint(pond, eye, east, 0)!;
    expect(level.x).toBeGreaterThan(2060);
    expect(level.d).toBeLessThanOrEqual(CONTENT.fishing.castM[1] - 3);
    const down = castPoint(pond, eye, east, -0.25)!;
    expect(down.x).toBeGreaterThan(2060);
    expect(down.d).toBeLessThan(level.d);
    expect(castPoint(pond, eye, Math.PI / 2, 0)).toBeNull(); // west: dry land
    expect(waterSurface(pond, 2070, 0)).toBe(11.5);
    expect(waterSurface({ heightAt: () => 11.3, waterAt: () => 11.5 }, 0, 0)).toBeNull(); // too shallow
  });
  it('packs the bobber like the zone unpacks it', () => {
    const id = packCast(2066.5, 2048.25);
    expect(Number(id & 0xffffffffn)).toBe(206650);
    expect(Number(id >> 32n)).toBe(204825);
    expect(weightText(340)).toBe('340 g');
    expect(weightText(2400)).toBe('2.40 kg');
  });
});

describe('fishing state', () => {
  const ev = (kind: number, targetId: number, value: number, data: unknown, x = 0): ZoneEvent => ({ kind, entityId: 1, targetId, value, x, y: 1150, z: 0, data: new TextEncoder().encode(JSON.stringify(data)) }) as unknown as ZoneEvent;
  it('cast, nibble, bite, hook, fight, land', () => {
    resetFishing();
    const sent: [number, bigint, number][] = [];
    fishLive.send = { interact: (a, t, arg = 0) => sent.push([a, t, arg]) };
    fishLive.target = { x: 2066, y: 11.5, z: 2048 };
    useFishing.setState({ phase: 'idle' });
    // the store's cast() is what E calls
    expect(useFishing.getState().phase).toBe('idle');
    const pos = { x: 2050, z: 2048 };
    applyFishEvent(ev(FEV.cast, 1, 3000, { seq: 1, water: 'lake', biteMs: 3000, windowMs: 1200, nibbles: [1200] }, 206600), pos, 1000);
    const s = useFishing.getState();
    expect(s.phase).toBe('waiting');
    expect(floatState(s, 1000 + 500)).toBe('calm');
    expect(floatState(s, 1000 + 1300)).toBe('nibble');
    expect(floatState(s, 1000 + 3100)).toBe('bite');
    expect(press()).toBe(true);
    expect(sent.at(-1)![0]).toBe(2); // hook
    applyFishEvent(ev(FEV.hooked, 1, 0, { seq: 1, seed: 77, strength: 0.2, erratic: 0.2, stamina: 2, rarity: 0, minMs: 2500 }), pos, 4200);
    expect(useFishing.getState().phase).toBe('fight');
    fishLive.reel = true;
    for (let t = 0; t < 4000 && useFishing.getState().phase === 'fight'; t += 16) fishingTick(16, pos, 4200 + t);
    expect(useFishing.getState().phase).toBe('landing');
    const land = sent.at(-1)!;
    expect(land[0]).toBe(3);
    expect(land[2]).toBeGreaterThanOrEqual(2450);
    applyFishEvent(ev(FEV.caught, 1, 180, { key: 'silverfin', name: 'Silverfin Minnow', item: 'fish:silverfin', weightG: 180, rarity: 0, water: 'lake', first: true, record: false, count: 1, best: 180 }), pos, 9000);
    expect(useFishing.getState().phase).toBe('result');
    expect(useFishing.getState().caught?.name).toBe('Silverfin Minnow');
  });
  it('a missed bite reels in by itself; walking off reels in', () => {
    resetFishing();
    const sent: number[] = [];
    fishLive.send = { interact: (a, _t, arg = 0) => sent.push(a * 100 + arg) };
    const pos = { x: 2050, z: 2048 };
    applyFishEvent(ev(FEV.cast, 4, 2000, { seq: 4, water: 'river', biteMs: 2000, windowMs: 1000, nibbles: [] }), pos, 0);
    fishingTick(16, pos, 3500);
    expect(useFishing.getState().phase).toBe('result');
    expect(sent.at(-1)).toBe(402); // lose, missed
    resetFishing();
    applyFishEvent(ev(FEV.cast, 5, 6000, { seq: 5, water: 'river', biteMs: 6000, windowMs: 1000, nibbles: [] }), pos, 0);
    fishingTick(16, { x: 2054, z: 2048 }, 500);
    expect(useFishing.getState().phase).toBe('result');
    expect(sent.at(-1)).toBe(406); // lose, walked away
  });
});

describe('fishing is heard (playtest 2 immersion pass)', () => {
  it('cast, plop, nibbles and the bite on time, the hook, the catch', async () => {
    const { setTriggerSink } = await import('../../audio/bridge');
    const { fishingSounds, useFishing } = await import('./store');
    useFishing.setState({ phase: 'waiting', seq: 5 }); // the live state the timers check (before listening: the store's own subscription speaks too)
    const heard: string[] = [];
    setTriggerSink((n) => heard.push(n));
    const timers: [() => void, number][] = [];
    const later = (fn: () => void, ms: number) => void timers.push([fn, ms]);
    const s0 = useFishing.getState();
    const st = (o: Partial<typeof s0>) => ({ ...s0, ...o });
    fishingSounds(st({ phase: 'casting' }), st({ phase: 'idle' }), later);
    const waiting = st({ phase: 'waiting', seq: 5, nibbles: [800, 1900], biteMs: 3200 });
    fishingSounds(waiting, st({ phase: 'casting' }), later);
    expect(timers.map((t) => t[1])).toEqual([800, 1900, 3200]);
    for (const [fn] of timers) fn();
    fishingSounds(st({ phase: 'fight' }), waiting, later);
    fishingSounds(st({ phase: 'result', caught: { key: 'k', name: 'n', item: 'fish:k', weightG: 1, rarity: 2, water: 'lake', first: false, record: false, count: 1, best: 1, id: 1 } }), st({ phase: 'landing' }), later);
    fishingSounds(st({ phase: 'result' }), st({ phase: 'result' }), later); // no change: silent
    expect(heard).toEqual(['fish_cast', 'fish_plop', 'fish_nibble', 'fish_nibble', 'fish_bite', 'fish_hooked', 'fish_caught']);
    setTriggerSink(null);
    useFishing.setState({ phase: 'idle', seq: 0 });
  });
});
