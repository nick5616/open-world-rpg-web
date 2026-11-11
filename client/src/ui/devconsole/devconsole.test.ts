// Playtest 2 dev console (CR 032): the command parser, the wire packing,
// the dev movement step, and that the catalogs hold everything in the
// contract YAML (every item key in items.yaml / content.yaml / camps.yaml /
// achievements.yaml, every spell in combat.yaml).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { COMBAT, CONTENT, ITEMS } from '@lodestone/contracts';
import { ACHIEVEMENTS, BOSSES, ENEMIES, itemCatalog, resolve, SPECIES, SPELLS, WORLD_EVENTS } from './catalog';
import { COMMANDS, complete, parseCommand, type CmdCtx } from './commands';
import { DEV_ACT, DEV_FLAG, fnv1a32, giveSend } from './events';
import { controlGroups } from '../menu/controls';
import { stepDev } from '../../sim/devStep';
import { newMoveState, NO_ENV } from '../../sim/movement';
import { InputFlag } from '@lodestone/contracts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const yaml = (f: string) => YAML.parse(readFileSync(path.join(ROOT, 'contracts', f), 'utf8'));
const ctx: CmdCtx = { flags: 0, places: [{ kind: 'town', name: 'Ashford Vale', x: 1200.5, z: 900 }], quests: [{ id: 7, title: 'Ward against the night' }] };
const one = (line: string, c = ctx) => {
  const r = parseCommand(line, c);
  if ('error' in r) throw new Error(`${line}: ${r.error}`);
  return r.sends;
};

describe('dev console wire', () => {
  it('fnv1a32 matches the zone (Go hash/fnv New32a)', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('packs a give like devconsole.go reads it', () => {
    const s = giveSend('weapon:starmetal_sword', { level: 20, rarity: 5, gem: 0, cut: 2, affix: 0, qty: 1, equip: true, loadout: 1 });
    expect(s.action).toBe(DEV_ACT.give);
    expect(Number(s.target & 0xffffffffn)).toBe(fnv1a32('weapon:starmetal_sword'));
    expect(Number((s.target >> 32n) & 0xffn)).toBe(20);
    expect(Number((s.target >> 40n) & 0xfn)).toBe(6);
    expect(Number((s.target >> 44n) & 0xfn)).toBe(1);
    expect(Number((s.target >> 48n) & 0x3n)).toBe(2);
    expect(Number((s.target >> 50n) & 0xffn)).toBe(1);
    expect(s.arg).toBe(1 | (1 << 16) | (1 << 17));
  });

  it('item hashes never collide (the zone looks items up by hash)', () => {
    const seen = new Map<number, string>();
    for (const it of itemCatalog()) {
      const h = fnv1a32(it.key);
      expect(seen.get(h), `${it.key} collides with ${seen.get(h)}`).toBeUndefined();
      seen.set(h, it.key);
    }
  });
});

describe('dev console commands', () => {
  it('parses every command with its arguments', () => {
    expect(one('/give potion:health 5')[0]).toEqual(giveSend('potion:health', { qty: 5, equip: false }));
    expect(one('/give voidglass_sword mythic lvl=30 gem=ruby:cut affix=brutal')[0]).toEqual(giveSend('weapon:voidglass_sword', { equip: false, rarity: 5, level: 30, gem: 0, cut: 1, affix: 0 }));
    expect(one('/give Healing Draught 3')[0]).toEqual(giveSend('potion:health', { qty: 3, equip: false }));
    expect(one('/equip iron helm rare l2')[0]).toEqual(giveSend('armor:iron_helm', { equip: true, rarity: 2, loadout: 1, qty: 1 }));
    expect(one('/learn all')[0]).toMatchObject({ action: DEV_ACT.learn, target: 0n });
    const fireball = SPELLS.find((s) => s.key === 'fireball')!;
    expect(one('/learn fireball')[0]).toMatchObject({ action: DEV_ACT.learn, target: BigInt(fireball.id) });
    expect(one('/unlearn all')[0]).toMatchObject({ action: DEV_ACT.unlearn, target: 0n });
    expect(one('/level 30')[0]).toMatchObject({ action: DEV_ACT.level, arg: 30 });
    expect(one('/xp 5000')[0]).toMatchObject({ action: DEV_ACT.xp, target: 5000n });
    expect(one('/gold 999')[0]).toMatchObject({ action: DEV_ACT.gold, arg: 999 });
    expect(one('/sp 12')[0]).toMatchObject({ action: DEV_ACT.skillPoints, arg: 12 });
    expect(one('/skill swordsmanship 40')[0]).toMatchObject({ action: DEV_ACT.weaponSkill, target: 1n, arg: 40 });
    expect(one('/skill all 100')[0]).toMatchObject({ action: DEV_ACT.weaponSkill, target: 0n, arg: 100 });
    expect(one('/heal')[0]).toMatchObject({ action: DEV_ACT.refill });
    expect(one('/god')[0]).toMatchObject({ action: DEV_ACT.flags, arg: DEV_FLAG.god });
    expect(one('/god', { ...ctx, flags: DEV_FLAG.god | DEV_FLAG.fly })[0]).toMatchObject({ arg: DEV_FLAG.fly }); // a toggle keeps the others
    expect(one('/fly on', { ...ctx, flags: DEV_FLAG.fly })[0]).toMatchObject({ arg: DEV_FLAG.fly });
    expect(one('/nocd')[0]).toMatchObject({ arg: DEV_FLAG.cooldowns });
    expect(one('/speed 3.5')[0]).toMatchObject({ action: DEV_ACT.speed, arg: 350 });
    expect(one('/tp 1200 900')[0]).toMatchObject({ action: DEV_ACT.teleport, target: 120000n | (90000n << 32n) });
    expect(one('/tp ashford')[0]).toMatchObject({ action: DEV_ACT.teleport, target: 120050n | (90000n << 32n) });
    expect(one('/time 21:30')[0]).toMatchObject({ action: DEV_ACT.time, arg: 2150 });
    expect(one('/time 6')[0]).toMatchObject({ arg: 600 });
    expect(one('/weather thunderstorm')[0]).toMatchObject({ action: DEV_ACT.weather, arg: 7 });
    expect(one('/weather seeded')[0]).toMatchObject({ arg: 0 });
    const boar = ENEMIES.find((e) => e.key === 'boar')!;
    expect(one('/spawn boar 3 5 shielded')[0]).toMatchObject({ action: DEV_ACT.spawn, target: BigInt(boar.id), arg: 3 | (5 << 8) | (2 << 17) });
    expect(one('/spawn warden 12')[0]).toMatchObject({ action: DEV_ACT.spawn, target: BigInt(BOSSES.find((b) => b.key === 'warden')!.id), arg: 1 | (12 << 8) | (1 << 16) });
    expect(one('/despawn')[0]).toMatchObject({ action: DEV_ACT.despawn });
    expect(one(`/event ${WORLD_EVENTS[1].key}`)[0]).toMatchObject({ action: DEV_ACT.event, arg: 2 });
    expect(one(`/tame ${SPECIES[0].key}`)[0]).toMatchObject({ action: DEV_ACT.tameable, target: BigInt(SPECIES[0].id) });
    expect(one(`/pet ${SPECIES[0].key} shiny 9`)[0]).toMatchObject({ action: DEV_ACT.pet, arg: 1 | (9 << 8) });
    expect(one(`/pet ${SPECIES[0].key} elemental:ice`)[0]).toMatchObject({ arg: 2 | (2 << 4) | (1 << 8) });
    expect(one('/steed 3')[0]).toMatchObject({ action: DEV_ACT.steed, arg: 3 });
    expect(one('/quest 7 step')[0]).toMatchObject({ action: DEV_ACT.quest, target: 7n, arg: 1 });
    expect(one('/quest ward')[0]).toMatchObject({ target: 7n, arg: 2 });
    expect(one('/quest all abandon')[0]).toMatchObject({ target: 0n, arg: 3 });
    expect(one('/reveal')[0]).toMatchObject({ action: DEV_ACT.reveal });
    expect(one('/attune')[0]).toMatchObject({ action: DEV_ACT.attune });
    expect(one('/achieve all')[0]).toMatchObject({ action: DEV_ACT.achieve, target: 0n });
    expect(one(`/achieve ${ACHIEVEMENTS[3].key}`)[0]).toMatchObject({ action: DEV_ACT.achieve, target: BigInt(ACHIEVEMENTS[3].id) });
    expect(one('/reset yes')[0]).toMatchObject({ action: DEV_ACT.reset });
    expect(one('/story act 4 2')[0]).toMatchObject({ action: DEV_ACT.story, target: BigInt(4 | (2 << 8)), arg: 1 }); // CR 035
    expect(one('/story heartfall')[0]).toMatchObject({ action: DEV_ACT.story, arg: 2 });
    expect(one('/story hush 34')[0]).toMatchObject({ action: DEV_ACT.story, target: 34n, arg: 5 });
    expect(one('/story win')[0]).toMatchObject({ action: DEV_ACT.story, arg: 3 });
    expect(parseCommand('/help', ctx)).toMatchObject({ local: 'help' });
    expect(parseCommand('give potion:health', ctx)).not.toHaveProperty('error'); // the slash is optional
  });

  it('refuses what it cannot parse, with a reason', () => {
    for (const bad of ['/give', '/give nothing_like_this', '/level 0', '/level abc', '/reset', '/tp nowhere', '/weather sunny_spells', '/spawn dragon', '/frobnicate', '/give potion:health legendaryish', '/time 25']) {
      const r = parseCommand(bad, ctx);
      expect('error' in r, bad).toBe(true);
    }
  });

  it('documents every command and completes names', () => {
    for (const c of COMMANDS) expect(c.usage.startsWith(`/${c.name}`), c.name).toBe(true);
    expect(complete('/gi', ctx)).toEqual(['/give ']);
    expect(complete('/give voidglass_s', ctx)).toContain('/give weapon:voidglass_sword');
    expect(complete('/learn ', ctx)[0]).toBe('/learn all');
    expect(complete('/weather thun', ctx)).toEqual(['/weather thunderstorm']);
    expect(complete('/tp ash', ctx)).toEqual(['/tp "Ashford Vale"']);
    expect(one('/tp "Ashford Vale"')[0].action).toBe(DEV_ACT.teleport);
  });
});

describe('dev console catalogs', () => {
  const catalog = new Set(itemCatalog().map((i) => i.key));

  it('every item in items.yaml, its families and every tome are in the Items tab', () => {
    const y = yaml('items.yaml');
    const want = new Set<string>(Object.keys(y.items));
    for (const g of Object.keys(y.gems)) for (const c of y.cuts) want.add(`gem:${g}:${c.key}`);
    for (const o of Object.keys(y.ores)) want.add(`ore:${o}`).add(`ingot:${o}`);
    for (const k of Object.keys(y.items)) expect(catalog.has(k), k).toBe(true);
    for (const k of want) expect(catalog.has(k), k).toBe(true);
    for (const k of ITEMS.items.map((i) => i.key)) expect(catalog.has(k), k).toBe(true); // blueprints and anything else the generator expands
    expect(itemCatalog().filter((i) => i.group === 'blueprint').length).toBeGreaterThan(0);
    for (const s of Object.keys(yaml('combat.yaml').spells)) expect(catalog.has(`tome:${s}`), `tome:${s}`).toBe(true);
    // no catalog item the zone would not know
    for (const k of catalog) expect(ITEMS.items.some((i) => i.key === k) || (k.startsWith('tome:') && COMBAT.spells.some((s) => `tome:${s.key}` === k)), k).toBe(true);
  });

  it('every item key content.yaml, camps.yaml and achievements.yaml mention is giveable', () => {
    const KEY = /^(weapon|armor|ammo|potion|food|meat|herb|hide|fish|seed|quest|wood|camp|instrument|tool|currency|gem|ore|ingot|blueprint|key|tome):[a-z0-9_]+(:[a-z0-9_]+)?$/;
    const found = new Set<string>();
    const walk = (v: unknown, k = ''): void => {
      if (typeof v === 'string' && KEY.test(v)) found.add(v);
      else if (Array.isArray(v)) v.forEach((x) => walk(x));
      else if (v && typeof v === 'object')
        for (const [kk, vv] of Object.entries(v)) {
          if (KEY.test(kk)) found.add(kk);
          walk(vv, kk);
        }
      void k;
    };
    for (const f of ['content.yaml', 'camps.yaml', 'achievements.yaml']) walk(yaml(f));
    expect(found.size).toBeGreaterThan(30);
    for (const k of found) expect(catalog.has(k), k).toBe(true);
  });

  it('every spell in combat.yaml is in the Spells tab, every enemy, boss, species and achievement resolvable', () => {
    const spells = Object.keys(yaml('combat.yaml').spells);
    expect(SPELLS.map((s) => s.key).sort()).toEqual([...spells].sort());
    expect(SPELLS.length).toBe(COMBAT.spells.length);
    for (const e of COMBAT.enemies) expect(resolve(ENEMIES, e.key)?.id).toBe(e.id);
    for (const b of COMBAT.bosses) expect(resolve(BOSSES, b.key)?.key).toBe(b.key);
    for (const s of CONTENT.taming.species) expect(resolve(SPECIES, s.key)?.id).toBe(s.id);
    expect(ACHIEVEMENTS.length).toBe(CONTENT.achievements.length);
  });
});

describe('dev console movement and controls', () => {
  const ground = { heightAt: () => 0, waterAt: () => -100 };

  it('fly rises at FLY_SPEED x the speed; stamina refills before the step', () => {
    const s0 = { ...newMoveState({ x: 100, y: 0, z: 100 }), stamina: 3, staminaMax: 1000 };
    const up = { flags: InputFlag.jump, yaw: 0, pitch: 0, castSlot: 0 };
    const flown = stepDev(s0, up, ground, 1 / 60, { ...NO_ENV, dev: { fly: 2, stamina: false } });
    expect(flown.pos.y).toBeCloseTo((20 * 2) / 60, 6);
    const walked = stepDev(s0, { ...up, flags: 0 }, ground, 1 / 60, { ...NO_ENV, dev: { fly: 0, stamina: true } });
    expect(walked.stamina).toBeGreaterThan(900);
    expect(stepDev(s0, { ...up, flags: 0 }, ground, 1 / 60, NO_ENV).stamina).toBeLessThan(100);
  });

  it('the Esc menu lists F2 under Dev only on a dev zone', () => {
    const keys = (dev: boolean) => controlGroups(true, dev).flatMap((g) => g.rows.flatMap((r) => r.keys));
    expect(keys(true)).toContain('F2');
    expect(keys(false)).not.toContain('F2');
    expect(controlGroups(false, true).some((g) => g.title.startsWith('Dev'))).toBe(false);
    const src = readFileSync(path.join(ROOT, 'client/src/ui/devconsole/DevConsole.tsx'), 'utf8');
    expect(src).toContain("DEV_KEY = 'F2'");
  });
});
