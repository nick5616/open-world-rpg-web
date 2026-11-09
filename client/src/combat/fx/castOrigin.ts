// Where spells visibly leave a caster (playtest 2: "it is confusing where the
// spells are coming from"). One rule everywhere, first person, your own
// third-person body and other players:
//
//   staff, wand     out of the weapon's tip (the hand holding it raises it)
//   sword, spear,   out of the open off hand, which rises into view
//   bow, none
//
// First person, FirstPersonWeapon publishes the real tip / hand position
// (fpOrigin). Bodies use castOrigin() below, which matches the avatar's cast
// poses (avatarAnim 'cast' / 'castStaff').

import type { WeaponKind } from '../weapons/look';

export type V3 = { x: number; y: number; z: number };

export const castHooks = {
  /** performance.now() of your own newest spell cast (the first-person off hand rises). */
  selfCastAt: -1e9,
  /** Its colour (the hand glow). */
  selfCastColor: '#ffffff',
  /** Your weapon kind now. */
  selfWeapon: null as WeaponKind | null,
  /** First person: world position your casts leave from now (false: not available). */
  fpOrigin: null as ((out: { x: number; y: number; z: number }) => boolean) | null,
  /** Another player's weapon kind (RemotePlayers' avatars). */
  weaponOf: null as ((id: number) => WeaponKind | null) | null,
};

/** Casts from the weapon itself? */
export function castsFromWeapon(kind: WeaponKind | null | undefined): boolean {
  return kind === 'staff' || kind === 'wand';
}

/**
 * A body's cast point from its feet (x, y, z), facing yaw (0 = -Z), aim pitch:
 * the staff/wand tip held out toward the aim, or the raised off hand.
 */
export function castOrigin(x: number, y: number, z: number, yaw: number, pitch: number, kind: WeaponKind | null | undefined, out: V3): V3 {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  // right of the body: (-fz, fx)
  const p = Math.max(-0.9, Math.min(0.9, pitch));
  let side: number;
  let fwd: number;
  let up: number;
  if (kind === 'staff') {
    side = 0.32;
    fwd = 0.55 + 0.75 * Math.cos(p);
    up = 1.45 + 0.75 * Math.sin(p) + 0.35;
  } else if (kind === 'wand') {
    side = 0.3;
    fwd = 0.6 + 0.3 * Math.cos(p);
    up = 1.42 + 0.3 * Math.sin(p);
  } else {
    side = -0.28; // the left (off) hand
    fwd = 0.62 * Math.cos(p) + 0.05;
    up = 1.42 + 0.5 * Math.sin(p);
  }
  out.x = x + fx * fwd - fz * side;
  out.y = y + up;
  out.z = z + fz * fwd + fx * side;
  return out;
}

if (typeof window !== 'undefined') (window as unknown as { __lodestoneCast?: typeof castHooks }).__lodestoneCast = castHooks; // headless checks
