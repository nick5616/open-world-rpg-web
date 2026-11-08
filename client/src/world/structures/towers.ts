// Tower geometry (WP12). TS twin of server/pkg/structures/tower.go: same
// constants, same sample points, same order of operations, so the client's
// towers stand exactly where the zone's do (golden-tested in overlay.test.ts).

import type { AtlasData, Site } from '@lodestone/worldgen';
import type { GroundQuery } from '../../sim/ground';
import { RadialStructure, StructureOverlay } from './overlay';

/** tan(80 deg) as a literal (never Math.tan here: host math differs by an ulp). */
export const TOWER_WALL_SLOPE = 5.671281819617709;
export const TOWER_TOP_RADIUS = 4.0;
export const TOWER_UPPER_DROP = 13.0;
export const TOWER_LEDGE_WIDTH = 1.4;
export const TOWER_HEIGHT = 28.0;
const TOWER_SKIRT = 3.0;

const S2 = 0.7071067811865476;
const C8 = 0.9238795325112867; // cos 22.5 deg
const S8 = 0.3826834323650898; // sin 22.5 deg
const DIRS8: [number, number][] = [[1, 0], [S2, S2], [0, 1], [-S2, S2], [-1, 0], [-S2, -S2], [0, -1], [S2, -S2]];
const DIRS16: [number, number][] = [
  [1, 0], [C8, S8], [S2, S2], [S8, C8],
  [0, 1], [-S8, C8], [-S2, S2], [-C8, S8],
  [-1, 0], [-C8, -S8], [-S2, -S2], [-S8, -C8],
  [0, -1], [S8, -C8], [S2, -S2], [C8, -S8],
];

export function towerProfile(): { r: number[]; drop: number[] } {
  const r1 = TOWER_TOP_RADIUS + TOWER_UPPER_DROP / TOWER_WALL_SLOPE;
  return { r: [TOWER_TOP_RADIUS, r1, r1 + TOWER_LEDGE_WIDTH], drop: [0, TOWER_UPPER_DROP, TOWER_UPPER_DROP] };
}

/** The tower standing at (cx, cz) on the plain terrain `base` (Go: structures.NewTower). */
export function newTower(base: GroundQuery, cx: number, cz: number): RadialStructure {
  const { r, drop } = towerProfile();
  const rl = r[r.length - 1];
  let hi = base.heightAt(cx, cz);
  for (const d of DIRS8) {
    const h = base.heightAt(cx + d[0] * rl, cz + d[1] * rl);
    if (h > hi) hi = h;
  }
  let lo = base.heightAt(cx, cz);
  const ro = rl + 6;
  for (const d of DIRS16) {
    const h = base.heightAt(cx + d[0] * ro, cz + d[1] * ro);
    if (h < lo) lo = h;
  }
  const top = hi + TOWER_HEIGHT;
  const bottom = lo - TOWER_SKIRT;
  const maxR = rl + (top - TOWER_UPPER_DROP - bottom) / TOWER_WALL_SLOPE;
  return new RadialStructure(cx, cz, top, r, drop, TOWER_WALL_SLOPE, maxR);
}

/** Height where the tower's lower wall ends (renderers extend the mesh down to it). */
export function towerBottom(t: RadialStructure): number {
  return t.topY - t.dropAt(t.maxR);
}

export interface TowerSet {
  overlay: StructureOverlay;
  /** Overlay index -> atlas site. */
  sites: Site[];
  towers: RadialStructure[];
}

/** One tower per atlas tower site, in site-table order (Go: structures.Towers). */
export function towersFromAtlas(atlas: Pick<AtlasData, 'sites'>, base: GroundQuery, overlay = new StructureOverlay()): TowerSet {
  const sites: Site[] = [];
  const towers: RadialStructure[] = [];
  for (const s of atlas.sites) {
    if (s.category === 'poi' && s.kind === 'tower') {
      const t = newTower(base, s.x, s.z);
      overlay.add(t);
      sites.push(s);
      towers.push(t);
    }
  }
  return { overlay, sites, towers };
}
