// Detail level of the towns art (playtest 3 "towns art" pass), the one switch
// every drawing function reads. It follows the quality tier the session
// started with (the buildings worker builds meshes once per streamed
// settlement, so a tier change applies to settlements built afterwards):
//
//   0  low     the playtest-2 look: flat windows, painted trim, no dressing
//   1  medium  window frames and shutters, door surrounds, stone skirts,
//              half-timber beams, roof tints, interior skirting and beams,
//              wall lanterns, yard dressing (barrels, crates, woodpiles)
//   2  high    + flower boxes, open shutters, rafter tails, carts, wash lines,
//              chandeliers, curtains, wainscot, richer props, 512 px textures
//
// Module state, not a parameter: the kit is a pile of pure functions called
// from the worker and from vitest, and threading one more argument through
// all of them would touch every signature. Tests run at 2 (the default).

import type { QualityTier } from '../../stores/qualityStore';

export type Detail = 0 | 1 | 2;

let level: Detail = 2;

export const detail = (): Detail => level;
export const setDetail = (d: Detail): void => {
  level = d;
};

/** Quality tier -> detail level. Playtest 5 (CR 057): Low shares Medium's art (frames, shutters, skirts, half-timber, courses, grime: it is baked geometry, a one-off build per settlement, not per-frame cost); high/ultra add the dressing and 512 px textures. Level 0 stays for tests and the creator. */
export const detailOfTier = (tier: QualityTier): Detail => (tier === 'high' || tier === 'ultra' ? 2 : 1);

/** Texture size by detail (the array is 33 layers: 256 px = 8.6 MB, 512 px = 34 MB before mips). */
export const textureSizeOf = (d: Detail): number => (d >= 2 ? 512 : 256);
