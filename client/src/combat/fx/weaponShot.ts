// Playtest 2 "shared basic attacks": what a weapon's own shot looks like
// (Nicole: "make basic weapon attacks like wand attack viewable to everyone
// like the spell coming out of it"). Before, every weapon shot (the wand's
// bolt, the staff's bolt, the bow's arrow) was the same 10 cm steel needle,
// for you and for everyone else: a wand bolt read as nothing at all next to
// a spell. Now a wand / staff bolt is a small magic bolt out of the weapon's
// tip (an orb core, halo, trail and impact in the socketed gem's element, a
// soft arcane blue without one), the staff's a little bigger, and an arrow
// is a needle with a steel (or gem) trail.
//
// ONE mapping for both sides: your shot (runtime.launch) and another
// player's (engine.remoteMove from Event 214, which already names the move
// and so the weapon) draw from weaponShotVisual(weapon, gem), so what you see
// of your bolt is what everyone else sees of it. Nothing new on the wire.

import { moveById } from '../timeline';
import { ELEMENT_FAMILY, PALETTES, type Family, type SpellVisual } from './spellVisual';

export type ShotWeapon = 'wand' | 'staff' | 'bow' | 'other';

/** The weapon a move belongs to (weapon moves only; spells and forms: null). */
export function weaponOfMove(moveId: number): ShotWeapon | null {
  const m = moveById.get(moveId);
  if (!m) return null;
  return m.weapon === 'wand' || m.weapon === 'staff' || m.weapon === 'bow' ? m.weapon : 'other';
}

/** The element family a weapon's shot takes: its gem's, else arcane blue for magic weapons and steel for the rest. */
export function weaponShotFamily(weapon: ShotWeapon, gem: number): Family {
  if (gem >= 0 && gem < ELEMENT_FAMILY.length && ELEMENT_FAMILY[gem] !== 'steel') return ELEMENT_FAMILY[gem];
  return weapon === 'wand' || weapon === 'staff' ? 'crystal' : 'steel';
}

const cache = new Map<string, SpellVisual>();

/** The visual of a weapon's shot (cached: the same object for every shot of that weapon and gem). */
export function weaponShotVisual(weapon: ShotWeapon, gem: number): SpellVisual {
  const family = weaponShotFamily(weapon, gem);
  const key = `weapon:${weapon}:${family}`;
  let v = cache.get(key);
  if (!v) {
    const magic = weapon === 'wand' || weapon === 'staff';
    v = {
      key,
      family,
      palette: PALETTES[family],
      // a magic bolt is an orb with a halo; an arrow a needle (its trail carries the element)
      look: magic ? 'orb' : 'needle',
      spike: 'stone',
      sigil: 5,
      weight: 'minor', // no pooled light per shot: basic attacks stay quiet next to spells
      setPiece: '',
    };
    cache.set(key, v);
  }
  return v;
}

/** The core radius a weapon shot is drawn with (m): a magic bolt reads at range, an arrow stays thin. */
export function weaponShotRadius(weapon: ShotWeapon, radius: number): number {
  return weapon === 'staff' ? Math.max(radius, 0.42) : weapon === 'wand' ? Math.max(radius, 0.34) : radius;
}
