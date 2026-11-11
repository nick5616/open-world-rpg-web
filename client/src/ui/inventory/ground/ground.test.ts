import { describe, expect, it } from 'vitest';
import { ITEMS } from '@lodestone/contracts';
import { beamParams } from './beam';
import { allDropKeys, coinCount, dropGeometry, dropModelOf, HOVER_FROM_RARITY, PROP_SHAPES } from './models';
import { HUM_BY_RARITY, humEmitters, humFor, humKind } from './hum';
import { RESEND_MS, shouldSendAutoLoot } from './autoLoot';
import { loopTarget, MAX_LOOP_VOICES, selectLoops, type LoopEmitter, type LoopListener } from '../../../audio/loopPool';
import { LOOP_PROFILES, SPACE_CAVE, SPACE_OUTDOORS } from '../../../audio/spatial';

const L: LoopListener = { x: 0, y: 1.6, z: 0, space: SPACE_OUTDOORS, leak: 1 };
const at = (key: string, rarity: number, x: number, id = x * 100 + rarity): LoopEmitter => ({ ...humEmitters([{ id, key, rarity, x, y: 1.2, z: 0 }], 0, 0, 1e9)[0], space: SPACE_OUTDOORS });

describe('loot beams by rarity', () => {
  it('common has no beam; every tier above is taller, wider and brighter', () => {
    expect(beamParams(0).visible).toBe(false);
    for (let r = 1; r <= 7; r++) {
      const p = beamParams(r);
      const q = beamParams(r - 1);
      expect(p.visible).toBe(true);
      expect(p.height).toBeGreaterThan(q.height);
      expect(p.width).toBeGreaterThan(q.width);
      expect(p.intensity).toBeGreaterThan(q.intensity);
      expect(p.ring).toBeGreaterThan(q.ring);
    }
    expect(beamParams(4).height).toBeGreaterThanOrEqual(20); // a legendary is seen over the trees
  });

  it("only Bitchin' is holographic; rare+ are seen across the mid ring", () => {
    for (let r = 0; r <= 7; r++) expect(beamParams(r).holo).toBe(r === 7);
    expect(beamParams(1).far).toBeLessThan(100);
    for (let r = 2; r <= 7; r++) expect(beamParams(r).far).toBeGreaterThanOrEqual(200);
  });

  it('Low quality drops the motes, Medium thins them', () => {
    for (let r = 0; r <= 7; r++) {
      expect(beamParams(r, 'low').motes).toBe(0);
      expect(beamParams(r, 'medium').motes).toBeLessThanOrEqual(beamParams(r, 'high').motes);
      expect(beamParams(r, 'low').height).toBe(beamParams(r, 'high').height);
    }
    expect(beamParams(7, 'ultra').motes).toBeGreaterThan(beamParams(2, 'ultra').motes);
  });
});

describe('ground models for every item', () => {
  const keys = allDropKeys();

  it('maps every item key to a model', () => {
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      const m = dropModelOf(key, 0);
      const d = ITEMS.items.find((i) => i.key === key);
      if (key.startsWith('ore:') || key.startsWith('gem:')) expect(m.kind, key).toBe('cave');
      else if (d?.kind === 'weapon') expect([m.kind, m.shape], key).toEqual(['weapon', d.weapon]);
      else if (d?.kind === 'armor') expect([m.kind, m.shape], key).toEqual(['armor', d.armor]);
      else {
        expect(m.kind, key).toBe('prop');
        expect(PROP_SHAPES as readonly string[], key).toContain(m.shape);
        expect(m.shape, `${key} fell through to the generic sack`).not.toBe('sack');
      }
    }
  });

  it('builds a real geometry for every drawn item, common and Bitchin', () => {
    for (const key of keys) {
      for (const r of [0, 7]) {
        const g = dropGeometry(key, r, 25);
        if (dropModelOf(key, r).kind === 'cave') {
          expect(g).toBeNull();
          continue;
        }
        expect(g, key).not.toBeNull();
        const n = g!.getAttribute('position').count;
        expect(n, key).toBeGreaterThan(8);
        expect(g!.getAttribute('surf'), key).toBeDefined();
        const tris = (g!.index?.count ?? n) / 3;
        expect(tris, `${key}: ${tris} triangles`).toBeLessThan(3000);
        if (r === 7 && dropModelOf(key, r).kind !== 'armor') {
          const s = g!.getAttribute('surf');
          expect(s.getZ(0), `${key} Bitchin' copy is holographic`).toBeLessThan(0);
        }
      }
    }
  });

  it('weapons are the real weapon model (third-person detail)', () => {
    const g = dropGeometry('weapon:sunsteel_blade', 3)!;
    expect(g.name).toContain('weapon:sword|sunsteel');
    const bb = g.boundingBox!;
    expect(bb.max.y - bb.min.y).toBeGreaterThan(0.6); // a sword, not a stick
  });

  it('armor pieces are their armor model, centred', () => {
    for (const key of ['armor:leather_cap', 'armor:leather_jerkin', 'armor:leather_leggings']) {
      const g = dropGeometry(key, 2)!;
      expect(g.name, key).toContain('armor-piece');
      const c = g.boundingBox!.getCenter(g.boundingBox!.min.clone());
      expect(Math.hypot(c.x, c.y, c.z), key).toBeLessThan(1e-3);
    }
  });

  it('rare and better hover in their beam, commoner lie on the ground', () => {
    for (let r = 0; r <= 7; r++) expect(dropModelOf('weapon:iron_sword', r).pose).toBe(r >= HOVER_FROM_RARITY ? 'hover' : 'lie');
  });

  it('a coin pile grows with the amount, within bounds', () => {
    let last = 0;
    for (const q of [1, 2, 5, 20, 100, 1000, 1e6]) {
      const n = coinCount(q);
      expect(n).toBeGreaterThanOrEqual(last);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(14);
      last = n;
    }
    expect(dropGeometry('currency:gold', 0, 500)).not.toBe(dropGeometry('currency:gold', 0, 2));
  });
});

describe('loot hums', () => {
  it('common is silent (gems still chime softly); level and reach rise with rarity', () => {
    expect(humFor('weapon:iron_sword', 0)).toBeNull();
    expect(humFor('meat:raw', 0)).toBeNull();
    expect(humFor('gem:ruby:rough', 0)?.kind).toBe('lootChime');
    for (let r = 2; r <= 7; r++) {
      expect(HUM_BY_RARITY[r]!.level).toBeGreaterThan(HUM_BY_RARITY[r - 1]!.level);
      expect(HUM_BY_RARITY[r]!.reach).toBeGreaterThan(HUM_BY_RARITY[r - 1]!.reach);
    }
  });

  it('each rarity has its own note', () => {
    const rates = [1, 2, 3, 4, 5, 6].map((r) => HUM_BY_RARITY[r]!.rate);
    expect(new Set(rates).size).toBe(rates.length);
  });

  it('the family follows the item: weapons ring, gems chime, tomes whisper', () => {
    expect(humKind('weapon:iron_sword', 3)).toBe('lootMetal');
    expect(humKind('armor:iron_helm', 3)).toBe('lootMetal');
    expect(humKind('ammo:iron_arrow', 3)).toBe('lootMetal');
    expect(humKind('gem:ruby:cut', 3)).toBe('lootChime');
    expect(humKind('tome:ember_flick', 3)).toBe('lootWhisper');
    expect(humKind('blueprint:sunsteel_blade', 3)).toBe('lootWhisper');
    expect(humKind('potion:health', 3)).toBe('lootHum');
    expect(humKind('weapon:iron_sword', 7)).toBe('lootHolo');
    for (const k of ['lootHum', 'lootMetal', 'lootChime', 'lootWhisper', 'lootHolo'] as const) expect(LOOP_PROFILES[k].family.startsWith('hum')).toBe(true);
  });

  it('range: a legendary is heard at 30 m and gone by 40 m; an uncommon only up close', () => {
    expect(loopTarget(at('weapon:iron_sword', 4, 30), L).gain).toBeGreaterThan(0.005);
    expect(loopTarget(at('weapon:iron_sword', 4, 40), L).gain).toBe(0);
    expect(loopTarget(at('weapon:iron_sword', 1, 3), L).gain).toBeGreaterThan(0.01);
    expect(loopTarget(at('weapon:iron_sword', 1, 12), L).gain).toBe(0);
    expect(loopTarget(at('weapon:iron_sword', 7, 50), L).gain).toBeGreaterThan(0);
    // nearer is louder; rarer is louder at the same spot
    expect(loopTarget(at('weapon:iron_sword', 4, 5), L).gain).toBeGreaterThan(loopTarget(at('weapon:iron_sword', 4, 15), L).gain);
    expect(loopTarget(at('weapon:iron_sword', 5, 8), L).gain).toBeGreaterThan(loopTarget(at('weapon:iron_sword', 3, 8), L).gain);
  });

  it('muffled from a cave like the fires', () => {
    const open = loopTarget(at('weapon:iron_sword', 4, 6), L);
    const cave = loopTarget({ ...at('weapon:iron_sword', 4, 6), space: SPACE_CAVE }, L);
    expect(cave.gain).toBeLessThan(open.gain * 0.5);
    expect(cave.lowpassHz).toBeLessThan(open.lowpassHz);
  });

  it('the loop pool keeps the nearest and rarest within its voice cap', () => {
    const drops: LoopEmitter[] = [];
    for (let i = 0; i < 12; i++) drops.push(at('weapon:iron_sword', 4, 2 + i * 2, i));
    const near = selectLoops(drops, L, new Set());
    expect(near.length).toBe(MAX_LOOP_VOICES);
    expect(near.map((t) => t.emitter.id).sort()).toEqual(drops.slice(0, MAX_LOOP_VOICES).map((d) => d.id).sort());
    // the same spot: the rarer wins
    const same = [1, 2, 3, 4, 5, 6, 7].flatMap((r) => [at('weapon:iron_sword', r, 4, 100 + r), at('weapon:iron_sword', r, 4.1, 200 + r)]);
    const picked = selectLoops(same, L, new Set()).map((t) => t.emitter.id);
    expect(picked).toContain('loot:107');
    expect(picked).not.toContain('loot:101');
  });

  it('emitters: one per audible drop near the listener, placed by the engine', () => {
    const e = humEmitters(
      [
        { id: 1, key: 'weapon:iron_sword', rarity: 4, x: 5, y: 0, z: 0 },
        { id: 2, key: 'meat:raw', rarity: 0, x: 3, y: 0, z: 0 },
        { id: 3, key: 'weapon:iron_sword', rarity: 4, x: 500, y: 0, z: 0 },
      ],
      0,
      0,
    );
    expect(e.map((x) => x.id)).toEqual(['loot:1']);
    expect(Number.isNaN(e[0].space)).toBe(true);
    expect(e[0].rate).toBe(HUM_BY_RARITY[4]!.rate);
  });
});

describe('auto-collect setting sync', () => {
  it('sends when the zone disagrees, not more often than RESEND_MS', () => {
    expect(shouldSendAutoLoot(false, true, -1e9, 0)).toBe(true);
    expect(shouldSendAutoLoot(undefined, true, -1e9, 0)).toBe(true);
    expect(shouldSendAutoLoot(true, true, -1e9, 0)).toBe(false);
    expect(shouldSendAutoLoot(false, true, 0, RESEND_MS - 1)).toBe(false);
    expect(shouldSendAutoLoot(false, true, 0, RESEND_MS)).toBe(true);
    expect(shouldSendAutoLoot(undefined, false, -1e9, 0)).toBe(false);
  });
});
