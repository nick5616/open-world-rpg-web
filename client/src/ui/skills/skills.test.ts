import { describe, expect, it } from 'vitest';
import { COMBAT } from '@lodestone/contracts';
import { learnable, skillXpFor } from '../progression/gains';
import { mockItems } from '../inventory/dev';
import { buildOverview, fmt, gearFor, spellHitWith, treeDamageMults, type BuildInput } from './build';
import { castable, layoutTree, learnedCounts, needLine, nodeState, passiveLines, spellByKey, spellFacts, TECHNIQUE_INFO, TREE_ORDER, treeByKey } from './tree';
import { MOCK } from './dev';
import { closeSkillScreen, setSkillTab, toggleSkillScreen, useSkillScreen } from './store';

describe('tree layout', () => {
  for (const tree of COMBAT.trees) {
    it(`${tree.key}: every node placed once, columns by tier, no overlaps`, () => {
      const l = layoutTree(tree);
      expect(l.nodes.map((n) => n.key).sort()).toEqual(tree.nodes.map((n) => n.key).sort());
      const tiers = l.cols.map((c) => c.tier);
      expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
      const seen = new Set<string>();
      for (const n of l.nodes) {
        expect(l.cols[n.col].tier).toBe(spellByKey.get(n.key)!.tier);
        expect(n.lane).toBeGreaterThanOrEqual(0);
        expect(n.lane).toBeLessThan(l.lanes);
        expect(Number.isInteger(n.lane)).toBe(true);
        const cell = `${n.col}:${n.lane}`;
        expect(seen.has(cell)).toBe(false);
        seen.add(cell);
      }
      // Every prerequisite is an edge, and edges never run right to left.
      const col = new Map(l.nodes.map((n) => [n.key, n.col]));
      expect(l.edges.length).toBe(tree.nodes.reduce((a, n) => a + n.prereqs.length, 0));
      for (const e of l.edges) {
        expect(col.get(e.from)!).toBeLessThanOrEqual(col.get(e.to)!);
        expect(e.sameCol).toBe(col.get(e.from) === col.get(e.to));
      }
      // Column headers carry the level skill points need.
      for (const c of l.cols) expect(c.level).toBe(COMBAT.leveling.spellTierLevels.reduce((lv, t) => (c.tier >= t.tier ? t.level : lv), 1));
      expect(layoutTree(tree)).toEqual(l); // deterministic
    });
  }
  it('keeps single chains straight (Light: Glint -> ... -> Let There Be Light)', () => {
    const l = layoutTree(treeByKey.get('light')!);
    const lane = new Map(l.nodes.map((n) => [n.key, n.lane]));
    for (const k of ['glint', 'radiant_lance', 'sunburst', 'dawnbreak', 'sunlit', 'high_noon', 'let_there_be_light']) expect(lane.get(k)).toBe(lane.get('glint'));
  });
  it('has a tab per spell tree in element order', () => {
    expect(TREE_ORDER).toEqual(['fire', 'ice', 'lightning', 'earth', 'wind', 'light', 'dark', 'void']);
  });
});

describe('node state', () => {
  const known = new Set(COMBAT.start.spells);
  it('learned, learnable, no points, needs level, needs prerequisite', () => {
    expect(nodeState('fire', 'ember_flick', known, 1, 2).status).toBe('learned');
    expect(nodeState('fire', 'spark_shot', known, 1, 2).status).toBe('learnable');
    expect(nodeState('fire', 'spark_shot', known, 1, 0).status).toBe('noPoints');
    expect(nodeState('light', 'glint', known, 1, 1).status).toBe('learnable'); // a root
    const fb = nodeState('fire', 'fireball', known, 1, 2);
    expect(fb.status).toBe('needsPrereq');
    expect(needLine(fb)).toBe('Needs Spark Shot or Kindling first');
    // Prerequisites are OR'd: either one opens Fireball.
    expect(nodeState('fire', 'fireball', new Set([...known, 'kindling']), 1, 2).status).toBe('learnable');
    const comb = nodeState('fire', 'combustion', new Set([...known, 'kindling', 'fireball']), 2, 2);
    expect(comb).toMatchObject({ status: 'needsLevel', needsLevel: 3 });
    expect(needLine(comb)).toBe('Needs character level 3');
    expect(nodeState('fire', 'combustion', new Set([...known, 'kindling', 'fireball']), 3, 2).status).toBe('learnable');
  });
  it('agrees with the character panel (gains.learnable) for every node', () => {
    for (const level of [1, 3, 6, 10, 14, 18]) {
      const k = [...MOCK.known];
      const set = new Set(k);
      const ready = new Map(learnable(k, level).map((s) => [s.key, s.ready]));
      for (const t of COMBAT.trees)
        for (const n of t.nodes) {
          const st = nodeState(t.key, n.key, set, level, 3).status;
          if (st === 'learnable') expect(ready.get(n.key)).toBe(true);
          else if (st === 'needsLevel') expect(ready.get(n.key)).toBe(false);
          else expect(ready.has(n.key)).toBe(false);
        }
    }
  });
  it('counts learned nodes per tree', () => {
    const c = learnedCounts(MOCK.known);
    expect(c.fire).toEqual({ learned: 6, total: 19 });
    expect(c.light).toEqual({ learned: 3, total: 11 });
  });
});

describe('tooltip facts', () => {
  const facts = (k: string) => Object.fromEntries(spellFacts(spellByKey.get(k)!).map((f) => [f.label, f.value]));
  it('lists damage, cooldown, mana, type, status, kills demons', () => {
    expect(facts('fireball')).toMatchObject({ Type: 'Lobbed', Damage: '85', Cooldown: '2.2 s', Mana: String(COMBAT.mana.byTier[3]), Status: 'Burn' });
    expect(facts('glint')).toMatchObject({ Type: 'Projectile', Demons: 'kills demons (Light)' });
    expect(facts('fireball').Demons).toBeUndefined();
    expect(facts('cauterize').Damage).toBe('12 x up to 8 hits');
    expect(facts('death_note').Damage).toBe('kills outright');
    expect(facts('unwritten').Damage).toBe('kills outright (bosses take 800)');
    expect(facts('magma_dash').Mana).toBe('none');
    expect(facts('magma_dash').Dash).toContain('m/s');
  });
  it('says what passives do and which are not in effect yet', () => {
    expect(passiveLines(spellByKey.get('kindling')!)).toEqual([{ text: '+10% Fire spell damage', active: true }]);
    expect(passiveLines(spellByKey.get('static_charge')!)).toEqual([{ text: '25% chance: Lightning spells also inflict Stun', active: true }]);
    expect(passiveLines(spellByKey.get('thick_bark')!)).toEqual([{ text: '-5% damage taken', active: false }]);
    expect(passiveLines(spellByKey.get('phoenix')!)[0].active).toBe(false);
    for (const s of COMBAT.spells.filter((x) => x.type === 'passive')) expect(passiveLines(s).length).toBeGreaterThan(0);
  });
  it('describes every technique', () => {
    for (const sk of COMBAT.skills.list) for (const t of sk.techniques) expect(TECHNIQUE_INFO[t.key], t.key).toBeTruthy();
  });
  it('only castable spells go in slots', () => {
    expect(castable('fireball')).toBe(true);
    expect(castable('kindling')).toBe(false);
  });
});

// The Go twin: server/zone/internal/items/gear_vector_test.go (TestGearClientVector).
describe('gear (items.Inventory.Gear twin)', () => {
  const items = mockItems().items;
  it('loadout 1: sunsteel blade with a cut topaz, the armor', () => {
    const g = gearFor(items, 0);
    expect(g).toMatchObject({ weaponType: 'sword', material: 'sunsteel', gemElement: 2, formMult: 1.25, killsDemons: true, stagger: false, lootFindPct: 3.5, staminaPct: 0 });
    expect(g.weaponMult).toBeCloseTo(1.2 * 1.02, 9);
    expect(g.damagePct).toBeCloseTo(8.4, 9);
    expect(g.critPct).toBeCloseTo(3.1, 9);
    expect(g.health).toBe(77);
    expect(g.armorPct).toBeCloseTo(17.2, 9);
  });
  it('loadout 2: oak staff, same armor', () => {
    const g = gearFor(items, 1);
    expect(g).toMatchObject({ weaponType: 'staff', gemElement: -1, killsDemons: false, health: 77 });
    expect(g.weaponMult).toBeCloseTo(1.04, 9);
  });
  it('caps armor at 60%', () => {
    const big = [0, 1, 2].map((i) => ({ h: i, b: ['armor:voidglass_helm', 'armor:voidglass_cuirass', 'armor:voidglass_greaves'][i], q: 1, l: 18, r: 0, s: ['eq:head', 'eq:body', 'eq:legs'][i], t: true, v: true, p: 0, a: [{ k: 'warding', s: 'armorPct', v: 20 }] }));
    expect(gearFor(big, 0).armorPct).toBe(60);
  });
});

describe('build overview', () => {
  const input = (over: Partial<BuildInput> = {}): BuildInput => ({
    level: MOCK.level,
    attuned: MOCK.attuned,
    skillFree: 4,
    skillTotal: 15,
    known: MOCK.known,
    skillXp: Object.fromEntries(Object.entries(MOCK.skills).map(([k, lv]) => [k, skillXpFor(lv) + 5])),
    loadouts: MOCK.loadouts,
    activeLoadout: 0,
    items: mockItems().items,
    ...over,
  });
  const v = buildOverview(input());
  const stat = (key: string, lo?: number) => (lo === undefined ? v.character : v.loadouts[lo].stats).find((s) => s.key === key)!;

  it('adds up health from the level, crystal boons and every gear piece', () => {
    const h = stat('health');
    expect(h.total).toBe(100 + 12 * 11 + 5 * 2 + 77);
    expect(h.parts.map((p) => p.from)).toEqual(['Base', 'Level 12 (+12 per level)', '2 crystals attuned (+5 each)', 'Iron Helm', 'Iron Helm · Sturdy', 'Silver Cuirass', 'Silver Cuirass · Hale', 'Leather Leggings']);
    expect(stat('mana').total).toBe(100 + 7 * 11);
    expect(stat('stamina').total).toBe(100 + 22 + 16);
    expect(stat('damage').total).toBe(110);
    expect(stat('armor').total).toBeCloseTo(17.2, 9);
    expect(stat('loot').total).toBeCloseTo(3.5, 9);
    expect(stat('forge').total).toBe(15);
  });
  it('mirrors the zone damage factors per loadout', () => {
    expect(stat('weaponHit', 0).total).toBeCloseTo(2.1 * 1.34 * 1.224 * 1.084, 9);
    expect(stat('spell', 0).total).toBeCloseTo(2.1 * 1.0 * 1.22, 9);
    expect(stat('crit', 0).total).toBeCloseTo(8.1, 9);
    expect(stat('regen', 0).total).toBeCloseTo(16.5 * 1.2, 9); // Mana Flow at Spellcraft 10
    expect(stat('cooldown', 0).total).toBeCloseTo(0.9, 9); // Quick Cast at Spellcraft 20
    // Loadout 2: a staff (spellcraft skill, 1.25 spell power and regen).
    expect(stat('weaponHit', 1).total).toBeCloseTo(2.1 * 1.22 * 1.04, 9);
    expect(stat('spell', 1).total).toBeCloseTo(2.1 * 1.25 * 1.22, 9);
    expect(stat('regen', 1).total).toBeCloseTo(16.5 * 1.25 * 1.2, 9);
  });
  it('every total is its parts', () => {
    for (const s of [...v.character, ...v.loadouts.flatMap((l) => l.stats)]) {
      const live = s.parts.filter((p) => !p.inactive);
      if (s.unit === 'mult' || s.unit === 'perS') expect(s.total).toBeCloseTo(live.reduce((a, p) => a * p.value, 1), 9);
      else if (s.key === 'armor') expect(s.total).toBeCloseTo(Math.min(60, live.reduce((a, p) => a + p.value, 0)), 9);
      else expect(s.total).toBeCloseTo(live.reduce((a, p) => a + p.value, 0), 9);
    }
  });
  it('shows gear per slot, both loadouts, forms and demons', () => {
    const [l1, l2] = v.loadouts;
    expect(l1).toMatchObject({ active: true, weapon: 'sword', weaponName: 'Sunsteel Blade', training: false, demons: 'Weapon kills demons (sunsteel)' });
    expect(l1.main.sockets).toEqual([{ key: 'gem:topaz:cut', name: 'Cut Topaz', color: expect.any(String), effect: 'Lightning element, form x1.25' }]);
    expect(l1.main.sub).toBe('Sunsteel · item level 11 · Rare');
    expect(l1.form).toMatchObject({ element: 'lightning', name: COMBAT.names.form_lightning, unlocked: true, damage: Math.round(45 * 1.34 * 1.224 * 1.084 * 1.25 * 2.1) });
    expect(l1.spells.map((s) => s.key)).toEqual(MOCK.loadouts[0].spells);
    expect(l2).toMatchObject({ active: false, weapon: 'staff', weaponName: 'Oak Staff', form: null });
    expect(l2.demons).toBe('Only Light spells kill demons with this loadout');
    expect(v.armor.map((a) => a.name)).toEqual(['Iron Helm', 'Silver Cuirass', 'Leather Leggings']);
  });
  it('a training weapon (nothing equipped) still adds up', () => {
    const t = buildOverview(input({ items: [] }));
    expect(t.loadouts[0]).toMatchObject({ training: true, weaponName: 'Training sword', form: null });
    expect(t.character.find((s) => s.key === 'health')!.total).toBe(242);
  });
  it('spent vs unspent points, per tree', () => {
    expect(v.points).toMatchObject({ total: 15, free: 4, spent: 11 });
    expect(v.points.parts.reduce((a, p) => a + p.value, 0)).toBe(15);
    expect(v.points.perTree.reduce((a, t) => a + t.learned, 0)).toBe(MOCK.known.length);
    expect(v.points.perTree.map((t) => t.tree)).toEqual(TREE_ORDER);
  });
  it('passives, tree multipliers and elements', () => {
    expect(v.passives.map((p) => p.key).sort()).toEqual(['brittle', 'combustion', 'kindling']);
    expect(treeDamageMults(MOCK.known)).toEqual([{ tree: 'fire', mult: 1.1, from: ['Kindling'] }]);
    expect(v.elemental).toContain('Fire spells also inflict Burn (Combustion)');
    expect(v.elemental.some((l) => l.startsWith('Lightning gem socketed'))).toBe(true);
    expect(spellHitWith(spellByKey.get('fireball')!, v, 0, new Set(MOCK.known))).toBe(Math.round(85 * 2.1 * 1.22 * 1.1));
  });
  it('formats units', () => {
    expect(fmt(1.2345, 'mult')).toBe('x1.23');
    expect(fmt(8.4, 'pct', true)).toBe('+8.4%');
    expect(fmt(19.8, 'perS')).toBe('19.8/s');
    expect(fmt(12, 'pts', true)).toBe('+12');
  });
});

describe('screen state', () => {
  it('N toggles the last tree, B the build, Esc closes', () => {
    closeSkillScreen();
    setSkillTab('ice');
    toggleSkillScreen();
    expect(useSkillScreen.getState()).toMatchObject({ open: true, tab: 'ice' });
    toggleSkillScreen('build');
    expect(useSkillScreen.getState()).toMatchObject({ open: true, tab: 'build', lastTree: 'ice' });
    toggleSkillScreen();
    expect(useSkillScreen.getState()).toMatchObject({ open: true, tab: 'ice' });
    toggleSkillScreen();
    expect(useSkillScreen.getState().open).toBe(false);
    toggleSkillScreen('build');
    toggleSkillScreen('build');
    expect(useSkillScreen.getState().open).toBe(false);
  });
});
