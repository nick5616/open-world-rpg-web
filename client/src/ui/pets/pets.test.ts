// CR 029 (playtest 2 taming and pets) in the browser: the wire decoders and
// the store (your pets, calm creatures, the taming meter from start to
// tamed / interrupted / failed, notes, acts), the numbers the zone uses
// (meter time, XP curve, stats), the crosshair pick for "attack that", name
// chunks, and the pet model: every tameable creature builds with a collar
// (gold for a shiny), friendly and within the triangle budget.
import { beforeAll, describe, expect, it } from 'vitest';
import { COMBAT, CONTENT, type Event as ZoneEvent } from '@lodestone/contracts';
import { ACT, decodeAct, likedFood, meterFill, nameChunks, NOTE, pickAlong, petStats, PET_EV, species, speciesName, TAME, tameSeconds, tameableEnemy, xpToNext } from './events';
import { initialPets, petOut, reducePetEvent } from './store';
import { isPetTypeId, petSpec, petTypeId, PET_TYPE_BIT } from '../../combat/enemies/spec';
import { modelFor } from '../../combat/enemies/models';

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
});

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const ev = (kind: number, entityId: number, value: number, data: unknown, targetId = 0, x = 0): ZoneEvent => ({ kind, entityId, targetId, value, x, y: 0, z: 0, data: data === null ? new Uint8Array() : data instanceof Uint8Array ? data : enc(data) }) as unknown as ZoneEvent;

const SYNC = { pets: [{ id: 1, sp: 'wolf', name: 'Fang', variant: 0, el: -1, lv: 3, xp: 10, next: 68, hp: 0.8, hpMax: 160, dmg: 12.8, koMs: 0, active: true, out: 77, kills: 4, tamedAt: 1 }], active: 1, mode: 0, stable: false, max: 6 };

describe('pet events and store', () => {
  it('1200 is your pets; the pet out is found by its entity', () => {
    let s = { ...initialPets(), selfId: 5 };
    s = reducePetEvent(s, ev(PET_EV.sync, 5, 1, SYNC, 77), 1000);
    expect(s.mine?.pets[0].name).toBe('Fang');
    expect(petOut(s)?.out).toBe(77);
    s = reducePetEvent(s, ev(PET_EV.sync, 5, 1, { ...SYNC, active: 0, pets: [{ ...SYNC.pets[0], active: false, out: 0 }] }), 1100);
    expect(petOut(s)).toBeNull();
  });

  it('a calm creature, the meter, then tamed: the calm goes, a note, a burst', () => {
    let s = { ...initialPets(), selfId: 5 };
    s = reducePetEvent(s, ev(PET_EV.calm, 40, 30000, null, 4), 1000);
    expect(s.calm[40].species).toBe(4);
    expect(s.calm[40].until).toBe(31000);
    s = reducePetEvent(s, ev(PET_EV.progress, 40, TAME.started, { sp: 'wolf', food: 'meat:raw', fav: true, by: 5, ms: 3600 }, 3600), 2000);
    expect(s.meter).toMatchObject({ creature: 40, ms: 3600, fav: true });
    expect(meterFill(s.meter!, 3800)).toBeCloseTo(0.5, 5);
    // someone else's meter is not yours
    const other = reducePetEvent(s, ev(PET_EV.progress, 41, TAME.started, { sp: 'boar', by: 9 }, 5000), 2100);
    expect(other.meter?.creature).toBe(40);
    s = reducePetEvent(s, ev(PET_EV.progress, 40, TAME.tamed, { sp: 'wolf', variant: 1, el: -1, name: 'Shiny Timber Wolf', by: 5 }, 2, 1200), 5600);
    expect(s.meter).toBeNull();
    expect(s.calm[40]).toBeUndefined();
    expect(s.tamed).toMatchObject({ creature: 40, variant: 1, x: 12 });
    expect(s.notes.at(-1)?.text).toMatch(/shiny/);
    s = reducePetEvent(s, ev(PET_EV.calm, 40, 0, null, 4), 5700);
    expect(Object.keys(s.calm)).toHaveLength(0);
  });

  it('interrupted and failed tamings say why; refusals and notes', () => {
    let s = { ...initialPets(), selfId: 5 };
    s = reducePetEvent(s, ev(PET_EV.progress, 40, TAME.started, { sp: 'slime', by: 5 }, 1800), 1000);
    s = reducePetEvent(s, ev(PET_EV.progress, 40, TAME.interrupted, { sp: 'slime', reason: 3, by: 5 }), 1500);
    expect(s.meter).toBeNull();
    expect(s.notes.at(-1)?.text).toMatch(/walked away/);
    s = reducePetEvent(s, ev(PET_EV.progress, 40, TAME.failed, { sp: 'slime', by: 5 }), 1600);
    expect(s.notes.at(-1)?.text).toMatch(/snatched/);
    s = reducePetEvent(s, ev(PET_EV.refused, 5, 7, new Uint8Array([6])), 1700);
    expect(s.notes.at(-1)?.text).toMatch(/stable/);
    s = reducePetEvent(s, ev(PET_EV.note, 5, NOTE.ko, new TextEncoder().encode('Fang was knocked out')), 1800);
    expect(s.notes.at(-1)).toMatchObject({ text: 'Fang was knocked out', bad: true });
  });

  it('1205 acts decode the ability target and are kept a little while', () => {
    const data = new Uint8Array([0x10, 0x27, 0, 0]); // 10000
    const a = decodeAct(ev(PET_EV.act, 77, ACT.ability, data, 3), 50);
    expect(a).toMatchObject({ pet: 77, act: ACT.ability, target: 3, on: 10000 });
    let s = initialPets();
    s = reducePetEvent(s, ev(PET_EV.act, 77, ACT.petted, null, 5), 0);
    s = reducePetEvent(s, ev(PET_EV.act, 77, ACT.fed, null, 5), 4000);
    expect(s.acts).toHaveLength(1);
  });
});

describe('the numbers the zone uses', () => {
  it('meter time, XP, stats, foods match content.yaml', () => {
    const t = CONTENT.taming;
    const sp = species('slime')!;
    expect(tameSeconds(sp, true)).toBeCloseTo(sp.tameS * t.favouriteMult, 9);
    expect(tameSeconds(sp, false)).toBe(sp.tameS);
    expect(xpToNext(1)).toBe(t.xpBase);
    expect(xpToNext(2)).toBe(Math.round(t.xpBase * t.xpGrowth));
    expect(xpToNext(t.levelMax)).toBe(0);
    expect(petStats(sp, 1, 0)).toEqual({ hp: sp.hp, damage: sp.damage });
    expect(petStats(sp, 5, 1).hp).toBeGreaterThan(petStats(sp, 5, 0).hp);
    const have = (k: string) => (k === sp.foods[1] ? 1 : 0);
    expect(likedFood(sp, have)).toEqual({ item: sp.foods[1], fav: false });
    expect(likedFood(sp, (k) => (k === sp.foods[0] ? 2 : 1))).toEqual({ item: sp.foods[0], fav: true });
    expect(speciesName('moss_slime')).toBe(COMBAT.enemies.find((e) => e.key === 'moss_slime')!.name);
    // the bestiary: tameable creatures are the taming species; demons and bosses never
    for (const e of COMBAT.enemies) {
      if (e.family === 'demon' || e.family === 'boss') expect(tameableEnemy(e.key)).toBeUndefined();
    }
    expect(tameableEnemy('wolf')?.key).toBe('wolf');
  });

  it('name chunks end with a 0 byte', () => {
    const c = nameChunks('Blobby');
    expect(c).toHaveLength(2);
    expect(c[0]).toBe(0x62_6f_6c_42);
    expect(c[1] & 0xffff).toBe(0x7962);
    expect((c[1] >> 16) & 0xff).toBe(0);
  });

  it('the crosshair picks the creature you look at, not one beside it', () => {
    const views = [
      { id: 1, kind: 2, x: 0, y: 0, z: -10, healthPct: 100 },
      { id: 2, kind: 2, x: 6, y: 0, z: -10, healthPct: 100 },
      { id: 3, kind: 7, x: 0, y: 0, z: -5, healthPct: 100 }, // a pet: never
      { id: 4, kind: 2, x: 0, y: 0, z: -60, healthPct: 100 }, // too far
    ];
    const eye = { x: 0, y: 1.6, z: 0 };
    expect(pickAlong(views, eye, { x: 0, y: -0.09, z: -1 })).toBe(1);
    expect(pickAlong(views, eye, { x: 0.51, y: -0.08, z: -0.86 })).toBe(2);
    expect(pickAlong(views, eye, { x: -1, y: 0, z: 0 })).toBe(0);
  });
});

describe('pet models', () => {
  it('every tameable creature builds as a pet with a collar, within budget', () => {
    for (const sp of CONTENT.taming.species) {
      for (const shiny of [false, true]) {
        const t = petTypeId(sp.enemyId, -1, shiny);
        expect(isPetTypeId(t)).toBe(true);
        expect(t & PET_TYPE_BIT).toBe(PET_TYPE_BIT);
        const spec = petSpec(t);
        expect(spec.key).toBe(sp.enemy);
        expect(spec.collar).toBe(shiny ? 2 : 1);
        expect(spec.glowEyes).toBe(false);
        expect(spec.spectral).toBe(false);
        const m = modelFor(spec);
        expect(m.tris, spec.variant).toBeLessThan(3200);
        for (const p of m.parts) {
          const a = p.geo.getAttribute('position').array as Float32Array;
          for (let i = 0; i < a.length; i++) expect(Number.isFinite(a[i])).toBe(true);
        }
      }
    }
    // the plain and the shiny one differ; an elemental carries its element
    const wolf = species('wolf')!;
    expect(petSpec(petTypeId(wolf.enemyId, -1, true)).color).not.toBe(petSpec(petTypeId(wolf.enemyId)).color);
    expect(petSpec(petTypeId(wolf.enemyId, 2)).element).toBe(2);
  });
});
