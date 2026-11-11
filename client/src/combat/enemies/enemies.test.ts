// Playtest 2 enemy models: every contract enemy and summon has a model of
// its family, the models build within budget, the animation state machine
// follows telegraphs / hits / staggers / deaths, the poses stay finite, and
// the renderer batches a crowd into a handful of draws with LOD.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { COMBAT } from '@lodestone/contracts';
import { ALL_STYLES, contractEnemies, contractSummons, modelSpec, rigFor, styleFor, summonSpec } from './spec';
import { modelFor } from './models';
import { EnemyAnimator, attackAnim, attackAnimByKey, attackKindFor, type AnimInput } from './anim';
import { writePose, kindsByRig } from './pose';
import { JOINT_COUNT, MAX_JOINTS, POSE_STRIDE } from './rigs';
import { EnemyRenderer } from './renderer';
import type { RemoteView } from '../../net/interpolation';

const info = (e: ReturnType<typeof contractEnemies>[number], affix = 0) => ({ ...e, affix, element: e.element });

describe('family -> model spec', () => {
  it('gives every contract enemy its own style, and the rig of its family', () => {
    const famRig: Record<string, string[]> = {
      slime: ['slime'],
      beast: ['quadruped', 'crawler'],
      bandit: ['biped'],
      guardian: ['biped', 'floater'],
      elemental: ['biped', 'floater', 'winged', 'crawler'],
      cave: ['crawler', 'winged', 'biped'],
      demon: ['biped', 'floater'],
      boss: ['biped', 'floater'],
      critter: ['quadruped'],
      hunt: ['quadruped', 'biped'],
    };
    for (const e of contractEnemies()) {
      const s = modelSpec(info(e));
      expect(ALL_STYLES, e.key).toContain(s.style);
      // no enemy falls back to a generic look: a style named after it (or an explicit alias)
      expect(s.style === e.key || ['sovereign', 'behemoth'].includes(s.style), e.key).toBe(true);
      expect(famRig[e.family], `${e.key} (${e.family})`).toContain(s.rig);
      if (e.behavior === 'flyer') expect(['floater', 'winged'], e.key).toContain(s.rig);
    }
  });

  it('falls back by family for an enemy the models do not know yet', () => {
    expect(rigFor(styleFor('new_slime', 'slime', 'melee'))).toBe('slime');
    expect(rigFor(styleFor('new_beast', 'beast', 'melee'))).toBe('quadruped');
    expect(rigFor(styleFor('new_bandit', 'bandit', 'ranged'))).toBe('biped');
    expect(rigFor(styleFor('new_bat', 'cave', 'flyer'))).toBe('winged');
    expect(styleFor('new_demon', 'demon', 'melee')).toBe('gloamling');
    expect(rigFor(styleFor('x', 'unknown', 'melee'))).toBe('quadruped');
  });

  it('scales elites, marks bosses, tints by element, glows demon eyes', () => {
    const wolf = contractEnemies().find((e) => e.key === 'wolf')!;
    const plain = modelSpec(info(wolf));
    const elite = modelSpec({ ...info(wolf, 1), element: 0 });
    expect(elite.scale).toBeCloseTo(plain.scale * 1.2);
    expect(elite.elite).toBe(true);
    expect(elite.accent).toBe('#ff6b2b');
    expect(elite.variant).not.toBe(plain.variant);
    const warden = modelSpec(info(contractEnemies().find((e) => e.key === 'warden')!, 7));
    expect(warden.boss).toBe(true);
    const gloam = modelSpec(info(contractEnemies().find((e) => e.key === 'gloamling')!));
    expect(gloam.glowEyes).toBe(true);
    expect(gloam.hunch).toBeGreaterThan(0);
    expect(gloam.deathFx).toBe('smoke');
    expect(modelSpec(info(contractEnemies().find((e) => e.key === 'slime')!)).deathFx).toBe('splat');
  });

  it('draws every summon spectral in its element colour, on its family rig', () => {
    const rigs: Record<string, string> = { wraith_hound: 'quadruped', gale_phantom: 'biped', sunlit_sentinel: 'floater' };
    for (const m of contractSummons()) {
      const s = summonSpec(m.typeId);
      expect(s.spectral).toBe(true);
      expect(s.rig).toBe(rigs[m.key] ?? s.rig);
      expect(s.color).toBe(COMBAT.summons.find((x) => x.key === m.key)!.color);
    }
  });
});

describe('models', () => {
  it('build for every enemy (and its elemental variants) and summon, within the triangle budget', () => {
    const specs = [...contractEnemies().map((e) => modelSpec(info(e))), ...contractEnemies().map((e) => modelSpec({ ...info(e, 2), element: (e.element + 3) % 8 })), ...contractSummons().map((m) => summonSpec(m.typeId))];
    for (const s of specs) {
      const m = modelFor(s);
      expect(m.joints.length, s.variant).toBe(JOINT_COUNT[s.rig]);
      expect(m.parts.length, s.variant).toBeGreaterThan(0);
      for (const p of m.parts) {
        expect(p.joint).toBeLessThan(m.joints.length);
        for (const k of ['position', 'normal', 'color', 'glow']) expect(p.geo.getAttribute(k), `${s.variant} ${k}`).toBeTruthy();
        const pos = p.geo.getAttribute('position').array as Float32Array;
        for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i]), s.variant).toBe(true);
      }
      // low-poly: a full rig stays cheap (bosses a little more)
      expect(m.tris, s.variant).toBeLessThan(s.boss ? 4000 : 3000);
      expect(m.tris, s.variant).toBeGreaterThan(60);
      expect(m.height, s.variant).toBeGreaterThan(0.3);
      expect(m.height, s.variant).toBeLessThan(3.5);
      expect(m.midTris).toBe(m.tris);
    }
  });

  it('are shared per variant (the cache)', () => {
    const e = contractEnemies().find((x) => x.key === 'boar')!;
    expect(modelFor(modelSpec(info(e)))).toBe(modelFor(modelSpec(info(e))));
  });

  it('slimes are jelly with an opaque face; humanoids carry their weapons', () => {
    const slime = modelFor(modelSpec(info(contractEnemies().find((x) => x.key === 'slime')!)));
    expect(slime.parts.some((p) => p.mat === 'jelly')).toBe(true);
    expect(slime.parts.some((p) => p.mat === 'opaque')).toBe(true);
    expect(slime.midMat).toBe('jelly');
    for (const k of ['cutthroat', 'archer', 'brute', 'warden', 'hunt_master']) expect(modelSpec(info(contractEnemies().find((x) => x.key === k)!)).weapon, k).not.toBeNull();
  });
});

const input = (o: Partial<AnimInput> = {}): AnimInput => ({ speed: 0, yaw: 0, y: 0, healthPct: 100, winding: false, ...o });
const opts = () => ({ refSpeed: 4, stride: 1.5, deathMs: 1000, fallback: attackAnimByKey('bite') });

describe('animation state machine', () => {
  it('maps attacks to readable kinds', () => {
    expect(attackAnimByKey('slime_hop').kind).toBe('leap');
    expect(attackAnimByKey('arrow_shot').kind).toBe('shoot');
    expect(attackAnimByKey('boar_charge').kind).toBe('charge');
    expect(attackAnimByKey('stinger').kind).toBe('sting');
    expect(attackAnimByKey('hunt_spear').kind).toBe('throw');
    expect(attackKindFor({ key: 'x', shape: 'circle', arc: 0, charge: false })).toBe('nova');
    for (const a of COMBAT.enemyAttacks) expect(attackAnim(a.id).key).toBe(a.key);
  });

  it('idle -> move -> idle with speed; the gait advances with distance', () => {
    const a = new EnemyAnimator(opts());
    for (let i = 0; i < 30; i++) a.update(input({ speed: 4 }), 1 / 60);
    expect(a.state).toBe('move');
    expect(a.gait).toBeGreaterThan(0);
    const g = a.gait;
    for (let i = 0; i < 60; i++) a.update(input({ speed: 0 }), 1 / 60);
    expect(a.state).toBe('idle');
    expect(a.gait - g).toBeLessThan(0.3);
  });

  it('a telegraph winds up for its wind-up, strikes for its active frames, recovers', () => {
    const a = new EnemyAnimator(opts());
    a.update(input(), 1 / 60);
    const gore = attackAnimByKey('gore');
    a.telegraph(gore, 400, 100);
    const seen: string[] = [];
    for (let t = 0; t < 1500; t += 10) {
      a.update(input({ winding: t < 400 }), 0.01);
      if (seen[seen.length - 1] !== a.state) seen.push(a.state);
      if (t === 200) {
        expect(a.windup).toBeGreaterThan(0.4);
        expect(a.attackWeight).toBeGreaterThan(0.5);
      }
    }
    expect(seen).toEqual(['windup', 'strike', 'recover', 'idle']);
  });

  it('the casting bit alone starts a wind-up of the default attack; a telegraph then takes over', () => {
    const a = new EnemyAnimator(opts());
    a.update(input({ winding: true }), 0.016);
    a.update(input({ winding: true }), 0.05);
    expect(a.state).toBe('windup');
    expect(a.attack.key).toBe('bite');
    a.telegraph(attackAnimByKey('pounce'));
    expect(a.attack.key).toBe('pounce');
    expect(a.stateMs).toBeGreaterThan(0);
  });

  it('an interrupted wind-up (the bit drops early) staggers', () => {
    const a = new EnemyAnimator(opts());
    a.telegraph(attackAnimByKey('smash'));
    a.update(input({ winding: true }), 0.05);
    a.update(input({ winding: false }), 0.05);
    expect(a.state).toBe('stagger');
    for (let i = 0; i < 20; i++) a.update(input(), 0.05);
    expect(a.state).toBe('idle');
  });

  it('hits flash (in real time, through hitstop) and flinch', () => {
    const a = new EnemyAnimator(opts());
    a.update(input(), 0.016);
    a.hit();
    a.update(input(), 0.016, true); // hitstop: the pose freezes, the flash runs
    expect(a.flash).toBeGreaterThan(0.5);
    a.update(input(), 0.08);
    expect(a.flinch).toBeGreaterThan(0.3);
    for (let i = 0; i < 30; i++) a.update(input(), 0.02);
    expect(a.flash).toBe(0);
    expect(a.flinch).toBe(0);
  });

  it('freeze holds the pose; health 0 or Event 201 dies, dissolving at the end', () => {
    const a = new EnemyAnimator(opts());
    a.update(input({ speed: 3 }), 0.1);
    a.hold(0.3);
    const t = a.time;
    a.update(input({ speed: 3 }), 0.1);
    expect(a.time).toBe(t);
    for (let i = 0; i < 5; i++) a.update(input(), 0.1);
    expect(a.time).toBeGreaterThan(t);
    a.update(input({ healthPct: 0 }), 0.016);
    expect(a.state).toBe('dying');
    for (let i = 0; i < 12; i++) a.update(input({ healthPct: 0 }), 0.1);
    expect(a.death).toBe(1);
    expect(a.dissolve).toBe(1);
    const b = new EnemyAnimator(opts());
    b.update(input(), 0.016);
    b.die();
    expect(b.state).toBe('dying');
    b.telegraph(attackAnimByKey('gore'));
    expect(b.state).toBe('dying');
  });
});

describe('poses', () => {
  it('stay finite for every rig, attack kind and state', () => {
    const out = new Float32Array(MAX_JOINTS * POSE_STRIDE);
    for (const e of contractEnemies()) {
      const spec = modelSpec(info(e));
      for (const kind of kindsByRig()[spec.rig]) {
        const a = new EnemyAnimator(opts());
        a.telegraph({ key: 'k', kind, windupMs: 400, activeMs: 150, recoveryMs: 500 });
        for (let t = 0; t < 1400; t += 50) {
          a.update(input({ speed: t < 300 ? 3 : 0, healthPct: t > 1200 ? 0 : 100 }), 0.05);
          if (t === 600) a.hit(true);
          writePose(spec.rig, { a, spec, look: 0.4, lookPitch: 0.1, phase: 1.3, side: 1, drop: 0.5 }, out);
          for (let i = 0; i < JOINT_COUNT[spec.rig] * POSE_STRIDE; i++) expect(Number.isFinite(out[i]), `${e.key} ${kind} ${a.state}`).toBe(true);
        }
      }
    }
  });

  it('the wind-up pose differs from idle (the tell is visible)', () => {
    const spec = modelSpec(info(contractEnemies().find((e) => e.key === 'cutthroat')!));
    const idle = new Float32Array(MAX_JOINTS * POSE_STRIDE);
    const wind = new Float32Array(MAX_JOINTS * POSE_STRIDE);
    const a = new EnemyAnimator(opts());
    a.update(input(), 0.016);
    writePose('biped', { a, spec, look: 0, lookPitch: 0, phase: 0, side: 1, drop: 0.5 }, idle);
    a.telegraph(attackAnimByKey('slash'));
    for (let i = 0; i < 6; i++) a.update(input({ winding: true }), 0.05);
    writePose('biped', { a, spec, look: 0, lookPitch: 0, phase: 0, side: 1, drop: 0.5 }, wind);
    let diff = 0;
    for (let i = 0; i < idle.length; i++) diff += Math.abs(idle[i] - wind[i]);
    expect(diff).toBeGreaterThan(1.5);
  });

  it('the Hush and its Hollow Bells have their own models and poses (playtest 2 immersion pass)', () => {
    const hush = modelSpec(info(contractEnemies().find((e) => e.key === 'the_hush')!, 7));
    const bell = modelSpec(info(contractEnemies().find((e) => e.key === 'hollow_bell')!));
    expect([hush.style, hush.rig, hush.boss]).toEqual(['the_hush', 'floater', true]);
    expect([bell.style, bell.rig, bell.deathFx]).toEqual(['hollow_bell', 'floater', 'shatter']);
    expect(modelFor(hush).variant).not.toBe(modelFor(modelSpec(info(contractEnemies().find((e) => e.key === 'archon')!, 7))).variant);
    // the bell swings back through its wind-up and spreads its rings on the toll; the Hush draws its hands up before its toll
    for (const [spec, key] of [
      [bell, 'bell_toll'],
      [hush, 'hush_toll'],
      [hush, 'hush_rend'],
    ] as const) {
      const idle = new Float32Array(MAX_JOINTS * POSE_STRIDE);
      const wind = new Float32Array(MAX_JOINTS * POSE_STRIDE);
      const a = new EnemyAnimator(opts());
      a.update(input(), 0.016);
      writePose('floater', { a, spec, look: 0, lookPitch: 0, phase: 0, side: 1, drop: 0.8 }, idle);
      a.telegraph(attackAnimByKey(key));
      for (let i = 0; i < 8; i++) a.update(input({ winding: true }), 0.05);
      writePose('floater', { a, spec, look: 0, lookPitch: 0, phase: 0, side: 1, drop: 0.8 }, wind);
      let diff = 0;
      for (let i = 0; i < idle.length; i++) {
        expect(Number.isFinite(wind[i]), key).toBe(true);
        diff += Math.abs(idle[i] - wind[i]);
      }
      expect(diff, key).toBeGreaterThan(0.4);
    }
  });
});

function view(id: number, key: string, x: number, z: number, o: Partial<RemoteView> = {}): RemoteView {
  const def = COMBAT.enemies.find((e) => e.key === key)!;
  return { id, x, y: 0, z, yaw: 0, pitch: 0, speed: 0, kind: 2, name: '', level: 1, healthPct: 100, activity: 0, partyId: 0, typeId: def.id, ring: 'near', delayMs: 0, mode: 'interp', ...o } as RemoteView;
}

describe('renderer', () => {
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  cam.position.set(0, 2, 10);
  cam.lookAt(0, 1, 0);
  cam.updateMatrixWorld();

  it('batches a crowd of one kind into a few draws, with LOD by distance', () => {
    const r = new EnemyRenderer();
    const views: RemoteView[] = [];
    for (let i = 0; i < 200; i++) views.push(view(1000 + i, 'slime', (i % 20) * 3 - 30, -Math.floor(i / 20) * 12));
    r.update(views, cam, 1 / 60, 0);
    r.update(views, cam, 1 / 60, 16);
    const s = r.stats();
    expect(s.enemies).toBe(200);
    expect(s.full + s.mid + s.far).toBe(s.drawn);
    expect(s.full).toBeGreaterThan(0);
    expect(s.mid + s.far).toBeGreaterThan(0);
    expect(s.full).toBeLessThanOrEqual(80);
    // slime: 2 part draws (jelly + face/core), 1 mid, 1 far (+ bars)
    expect(s.drawCalls).toBeLessThan(10);
    r.dispose();
  });

  it('follows telegraphs, hits and deaths by entity id, and drops vanished enemies', () => {
    const r = new EnemyRenderer();
    const v = view(7, 'wolf', 0, 0);
    r.update([v], cam, 1 / 60, 0);
    r.telegraph(7, COMBAT.enemyAttacks.find((a) => a.key === 'bite')!.id, 300, 100);
    expect(r.animator(7)!.state).toBe('windup');
    expect(r.hit(7)).toBe(true);
    expect(r.hit(99)).toBe(false);
    r.die(7);
    expect(r.animator(7)!.state).toBe('dying');
    for (let i = 0; i < 30; i++) r.update([], cam, 0.05, 500 + i * 50);
    expect(r.animator(7)).toBeNull();
    const w = view(8, 'boar', 0, 0);
    r.update([w], cam, 1 / 60, 0);
    r.update([], cam, 1 / 60, 16); // out of interest while alive: gone at once
    expect(r.animator(8)).toBeNull();
    r.dispose();
  });
});
