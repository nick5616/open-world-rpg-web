// Discovery intros: queue ordering, dedupe, collapse, card rate limits, the
// Event -> intro mapping (600 / 601 / 602 and the future tower_attuned) and
// site kind -> subtitle.
import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import type { Region, Site } from '@lodestone/worldgen';
import { EV } from '../map/events';
import {
  CARD_GAP_MS,
  CARD_REPEAT_MS,
  emptyIntroState,
  enqueueIntro,
  INTRO_MS,
  MAX_WAITING,
  skipIntro,
  tickIntro,
  type IntroQueueState,
  type IntroSpec,
} from './queue';
import { discoveryIntro, INTRO_FOR_EVENT, INTRO_TOAST_KINDS, introForEvent, regionIndexAt, regionIntro, siteKindLabel, towerAttunedIntro, townCard, type IntroWorld } from './intros';

const spec = (key: string, variant: IntroSpec['variant'] = 'major'): IntroSpec => ({ key, variant, title: key });
const run = (specs: IntroSpec[], now = 0) => specs.reduce<IntroQueueState>((s, x) => enqueueIntro(s, x, now), emptyIntroState());

function site(p: Partial<Site> & Pick<Site, 'index' | 'category' | 'kind'>): Site {
  return { id: 0n, size: 0, region: 0, x: 0, y: 0, z: 0, radius: 30, score: 0, name: null, biome: 'forest', element: null, visHeight: 0, visCount: 0, seed: 0, yaw: 0, link: -1, ...p };
}
function region(index: number, name: string, biome: Region['biome'] = 'highlands'): Region {
  return { index, biome, element: 'fire', element2: 'ice', name, tower: -1, danger: 1, landFraction: 1, biomeMix: [], settlements: 0, sites: 0 };
}
const world: IntroWorld = {
  regions: [region(0, 'Ashen Vale', 'forest'), region(1, 'The Forgotten Heights')],
  sites: [
    site({ index: 0, category: 'settlement', kind: 'settlement', size: 1, name: 'Draedmore', region: 0 }),
    site({ index: 1, category: 'poi', kind: 'tower', name: 'The Forgotten Spire', region: 1 }),
    site({ index: 2, category: 'poi', kind: 'cave_mouth', name: null, region: 0 }),
    site({ index: 3, category: 'structure', kind: 'ruin', name: 'Old Keep', region: 1 }),
    site({ index: 4, category: 'poi', kind: 'tower', name: null, region: 0 }),
  ],
};
const ev = (kind: number, targetId: number, value: number, name = ''): ZoneEvent => ({ type: 'Event', kind, entityId: 1, targetId, value, x: 0, y: 0, z: 0, data: new TextEncoder().encode(name) });

describe('intro queue', () => {
  it('shows one at a time, in arrival order', () => {
    let s = run([spec('a'), spec('b'), spec('c')]);
    expect(s.current?.key).toBe('a');
    expect(s.queue.map((q) => q.key)).toEqual(['b', 'c']);
    s = tickIntro(s, s.current!.endsAt);
    expect(s.current?.key).toBe('b');
    s = tickIntro(s, s.current!.endsAt);
    expect(s.current?.key).toBe('c');
    s = tickIntro(s, s.current!.endsAt);
    expect(s.current).toBeNull();
  });

  it('dedupes: once per session, and never twice in the queue', () => {
    let s = run([spec('site:1'), spec('site:2'), spec('site:2')]);
    expect(s.queue.map((q) => q.key)).toEqual(['site:2']);
    s = tickIntro(tickIntro(s, s.current!.endsAt), 1e6);
    expect(s.current).toBeNull();
    expect(enqueueIntro(s, spec('site:1'), 2e6)).toBe(s); // seen this session
  });

  it('runs at full length alone and paces up when others wait', () => {
    const alone = run([spec('a')]);
    expect(alone.current!.endsAt - alone.current!.startedAt).toBe(INTRO_MS.major);
    expect(alone.current!.inMs).toBe(Math.round(INTRO_MS.major * 0.18));
    let s = run([spec('a'), spec('b'), spec('c'), spec('d')]);
    s = tickIntro(s, s.current!.endsAt);
    expect(s.current!.key).toBe('b');
    expect(s.current!.pace).toBe(0.55); // two still waiting
    s = tickIntro(s, s.current!.endsAt);
    expect(s.current!.pace).toBe(0.75);
    s = tickIntro(s, s.current!.endsAt);
    expect(s.current!.pace).toBe(1);
  });

  it('collapses the intro on screen when a second one queues behind it', () => {
    let s = run([spec('a'), spec('b')], 0);
    const full = s.current!.endsAt;
    s = enqueueIntro(s, spec('c'), 100);
    const c = s.current!;
    expect(c.endsAt).toBeLessThan(full);
    expect(c.endsAt).toBeGreaterThanOrEqual(100 + c.outMs);
    expect(c.endsAt).toBe(c.startedAt + c.inMs + 700 + c.outMs);
  });

  it('drops the lowest-priority waiting intro past the limit', () => {
    let s = run([spec('now', 'region'), spec('w1', 'minor'), spec('m1'), spec('m2'), spec('m3')], 0);
    expect(s.queue).toHaveLength(MAX_WAITING);
    s = enqueueIntro(s, spec('r1', 'region'), 10);
    expect(s.queue).toHaveLength(MAX_WAITING);
    expect(s.queue.map((q) => q.key)).toEqual(['m1', 'm2', 'm3', 'r1']); // the minor went first
  });

  it('name cards never wait and are rate-limited', () => {
    let s = run([spec('a')]);
    expect(enqueueIntro(s, spec('card:7', 'card'), 10).queue).toHaveLength(0); // busy: dropped
    s = tickIntro(s, 1e6);
    s = enqueueIntro(s, spec('card:7', 'card'), 1e6);
    expect(s.current?.key).toBe('card:7');
    s = tickIntro(s, 1e6 + INTRO_MS.card);
    expect(enqueueIntro(s, spec('card:8', 'card'), 1e6 + CARD_GAP_MS - 1).current).toBeNull(); // global gap
    expect(enqueueIntro(s, spec('card:7', 'card'), 1e6 + CARD_REPEAT_MS - 1).current).toBeNull(); // same town too soon
    expect(enqueueIntro(s, spec('card:7', 'card'), 1e6 + CARD_REPEAT_MS).current?.key).toBe('card:7');
    // No card right after the town's own discovery intro.
    let d = run([spec('site:9')], 0);
    d = tickIntro(d, 1e4);
    expect(enqueueIntro(d, spec('card:9', 'card'), 1e4 + 1).current).toBeNull();
  });

  it('a region reveal covers that region\'s entry intro (waiting or later)', () => {
    const reveal = introForEvent(ev(EV.towerUnlocked, 1, 1, 'The Forgotten Heights'), world)!;
    let s = run([spec('site:1'), regionIntro(world.regions[1], false), reveal]);
    expect(s.queue.map((q) => q.key)).toEqual(['reveal:1']);
    s = tickIntro(tickIntro(s, 1e6), 2e6);
    expect(enqueueIntro(s, regionIntro(world.regions[1], true), 3e6).current).toBeNull();
  });

  it('skip retires the current intro and starts the next', () => {
    const s = skipIntro(run([spec('a'), spec('b')], 0), 50);
    expect(s.current?.key).toBe('b');
    expect(s.current?.startedAt).toBe(50);
  });
});

describe('site kind -> subtitle', () => {
  it('names every kind', () => {
    expect(siteKindLabel({ category: 'settlement', kind: 'settlement', size: 0 })).toBe('Hamlet');
    expect(siteKindLabel({ category: 'settlement', kind: 'settlement', size: 1 })).toBe('Village');
    expect(siteKindLabel({ category: 'settlement', kind: 'settlement', size: 2 })).toBe('Town');
    expect(siteKindLabel({ category: 'poi', kind: 'tower', size: 0 }, 'Ashen Vale')).toBe('Tower of Ashen Vale');
    expect(siteKindLabel({ category: 'poi', kind: 'cave_mouth', size: 0 })).toBe('Cave');
    expect(siteKindLabel({ category: 'poi', kind: 'landmark', size: 1 })).toBe('Great Tree');
    expect(siteKindLabel({ category: 'structure', kind: 'ruin', size: 2 })).toBe('Ruins');
    expect(siteKindLabel({ category: 'structure', kind: 'wizard_tower', size: 0 })).toBe("Wizard's Tower");
    expect(siteKindLabel({ category: 'structure', kind: 'brand_new_thing', size: 0 })).toBe('Brand New Thing');
  });
});

describe('zone Event -> intro', () => {
  it('602 discovery: name, kind and region, +XP; the toast is replaced', () => {
    expect(discoveryIntro(ev(EV.discovery, 0, 80, 'Draedmore'), world)).toMatchObject({ key: 'site:0', variant: 'major', title: 'Draedmore', subtitle: 'Village · Ashen Vale', detail: '+80 XP' });
    expect(introForEvent(ev(EV.discovery, 1, 40, 'The Forgotten Spire'), world)).toMatchObject({ title: 'The Forgotten Spire', subtitle: 'Tower of The Forgotten Heights' });
    expect(introForEvent(ev(EV.discovery, 2, 50), world)).toMatchObject({ title: 'Cave', subtitle: 'Ashen Vale' });
    expect(introForEvent(ev(EV.discovery, 3, 75, 'Old Keep'), world)).toMatchObject({ subtitle: 'Ruins · The Forgotten Heights' });
    expect(introForEvent(ev(EV.discovery, 4, 40), world)).toMatchObject({ title: 'Tower of Ashen Vale', subtitle: undefined });
    // World not loaded yet: still an intro (the toast it replaces is hidden).
    expect(introForEvent(ev(EV.discovery, 99, 30, 'Somewhere'), null)).toMatchObject({ title: 'Somewhere', detail: '+30 XP' });
    expect(INTRO_TOAST_KINDS.has('discovery') && INTRO_TOAST_KINDS.has('tower') && INTRO_TOAST_KINDS.has('waypoint')).toBe(true);
    expect(INTRO_TOAST_KINDS.has('level')).toBe(false);
  });

  it('600 tower_unlocked: the big region reveal', () => {
    expect(introForEvent(ev(EV.towerUnlocked, 1, 1, 'The Forgotten Heights'), world)).toMatchObject({ key: 'reveal:1', variant: 'region', eyebrow: 'Region revealed', title: 'The Forgotten Heights', subtitle: 'Highlands' });
  });

  it('601 waypoint: the small variant', () => {
    expect(introForEvent(ev(EV.waypoint, 0, 0, 'Draedmore'), world)).toMatchObject({ key: 'waypoint:0', variant: 'minor', title: 'Draedmore', subtitle: 'Waypoint' });
  });

  it('tower_attuned has a builder; wiring it is one INTRO_FOR_EVENT line', () => {
    const KIND = 609; // whatever number the progression work picks
    expect(introForEvent(ev(KIND, 1, 0), world)).toBeNull();
    INTRO_FOR_EVENT[KIND] = towerAttunedIntro;
    try {
      expect(introForEvent(ev(KIND, 1, 25), world)).toMatchObject({ key: 'attuned:1', variant: 'major', eyebrow: 'Tower attuned', title: 'The Forgotten Spire', subtitle: 'Tower of The Forgotten Heights', detail: '+25 XP' });
    } finally {
      delete INTRO_FOR_EVENT[KIND];
    }
    // Different keys from the unlock: attuning a tower is announced even after its region reveal.
    const s = run([introForEvent(ev(EV.towerUnlocked, 1, 1), world)!, towerAttunedIntro(ev(KIND, 1, 0), world)]);
    expect([s.current!.key, ...s.queue.map((q) => q.key)]).toEqual(['reveal:1', 'attuned:1']);
  });

  it('non-intro Events map to nothing', () => {
    expect(introForEvent(ev(EV.levelUp, 0, 3), world)).toBeNull();
    expect(introForEvent(ev(EV.progress, 0, 1), world)).toBeNull();
  });
});

describe('position-driven intros', () => {
  it('region index from the atlas region grid', () => {
    const d = { worldSize: 4096, regionsPerEdge: 4 };
    expect(regionIndexAt(d, 10, 10)).toBe(0);
    expect(regionIndexAt(d, 1888, 1760)).toBe(5);
    expect(regionIndexAt(d, 4095, 4095)).toBe(15);
    expect(regionIndexAt(d, -1, 10)).toBe(-1);
    expect(regionIndexAt(d, 4096, 10)).toBe(-1);
  });
  it('region entry and town cards', () => {
    expect(regionIntro(world.regions[0], false)).toMatchObject({ key: 'region:0', variant: 'region', title: 'Ashen Vale', subtitle: 'Forest', detail: 'Uncharted · climb its tower to map it' });
    expect(regionIntro(world.regions[0], true).detail).toBeUndefined();
    expect(townCard(world.sites[0])).toMatchObject({ key: 'card:0', variant: 'card', title: 'Draedmore', subtitle: 'Village' });
  });
});
