// The spell FX entry point for gameplay code (the combat runtime, the
// zone Events): every call forwards to the mounted engine and is a no-op
// while none is mounted (headless tests, the title screen). Type-only
// import of the engine, so importing this pulls no three.js into the
// runtime's tests.

import type { SpellFxEngine } from './engine';

let engine: SpellFxEngine | null = null;

/** SpellFxLayer mounts/unmounts the engine. */
export function setSpellFxEngine(e: SpellFxEngine | null): void {
  engine = e;
}

/** The mounted engine or null (debug handle, bench, tests). */
export function spellFxEngine(): SpellFxEngine | null {
  return engine;
}

type Args<K extends keyof SpellFxEngine> = SpellFxEngine[K] extends (...a: infer A) => unknown ? A : never;

function call<K extends keyof SpellFxEngine>(k: K, ...a: Args<K>): void {
  const e = engine;
  if (!e) return;
  try {
    (e[k] as (...x: Args<K>) => unknown)(...a);
  } catch (err) {
    // A visual must never break combat.
    console.warn(`[spell-fx] ${String(k)} failed`, err);
  }
}

/**
 * spellFx.castStart(spell, 'self', aim, yaw) ... see engine.ts for each
 * method. projectile() returns a handle (0 when no engine).
 */
export const spellFx = {
  castStart: (...a: Args<'castStart'>) => call('castStart', ...a),
  projectile: (...a: Args<'projectile'>): number => {
    if (!engine) return 0;
    try {
      return engine.projectile(...a);
    } catch (err) {
      console.warn('[spell-fx] projectile failed', err);
      return 0;
    }
  },
  projectileEnd: (...a: Args<'projectileEnd'>) => call('projectileEnd', ...a),
  projectileHit: (...a: Args<'projectileHit'>) => call('projectileHit', ...a),
  hit: (...a: Args<'hit'>) => call('hit', ...a),
  beam: (...a: Args<'beam'>) => call('beam', ...a),
  chain: (...a: Args<'chain'>) => call('chain', ...a),
  area: (...a: Args<'area'>) => call('area', ...a),
  rune: (...a: Args<'rune'>) => call('rune', ...a),
  targetHit: (...a: Args<'targetHit'>) => call('targetHit', ...a),
  form: (...a: Args<'form'>) => call('form', ...a),
  slam: (...a: Args<'slam'>) => call('slam', ...a),
  status: (...a: Args<'status'>) => call('status', ...a),
  shieldPoints: (...a: Args<'shieldPoints'>) => call('shieldPoints', ...a),
  remoteCast: (...a: Args<'remoteCast'>) => call('remoteCast', ...a),
  enemyProjectile: (...a: Args<'enemyProjectile'>) => call('enemyProjectile', ...a),
};
