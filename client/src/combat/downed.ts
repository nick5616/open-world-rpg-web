// Playtest 2 (new player onboarding, CR 024): what the downed screen and
// the respawn say. Dying keeps everything (spec 8); the screen names what
// downed you, where you come back and how soon, and after the respawn
// enemies leave you alone for PLAYER_RESPAWN_GRACE_S (or until you land a
// hit). Pure except respawnSiteName (downed.test.ts); DownedOverlay.tsx
// draws it.

import { PLAYER_RESPAWN_GRACE_S } from '@lodestone/contracts';
import { enemyInfo } from './events';
import { useExploration } from '../ui/map/store';
import { useMapWorld } from '../ui/map/world';

const PLAYER = 1;

export interface Downed {
  /** performance.now() of the respawn. */
  until: number;
  /** "a Dewdrop Slime", "Corin" (a player), "" unknown. */
  by: string;
  /** "Draedmore Crossing" (your last waypoint), "" none touched yet. */
  respawnAt: string;
}

/** "a"/"an" + name. */
function article(name: string): string {
  return /^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`;
}

/** Who downed you, from Event 203's targetId and what is drawn. */
export function killerName(targetId: number, drawn: readonly { id: number; kind: number; name?: string; typeId?: number }[]): string {
  if (!targetId) return '';
  const v = drawn.find((x) => x.id === targetId);
  if (!v) return '';
  if (v.kind === PLAYER) return v.name || 'another player';
  const info = enemyInfo(v);
  return info.key === '?' ? '' : article(info.name);
}

/** The downed screen's lines. */
export function downedLines(d: Downed, now: number): { title: string; by: string; when: string; keep: string } {
  const s = Math.max(0, Math.ceil((d.until - now) / 1000));
  const where = d.respawnAt ? `at ${d.respawnAt}` : 'where you first arrived';
  return {
    title: 'Downed',
    by: d.by ? `by ${d.by}` : '',
    when: s > 0 ? `Back on your feet ${where} in ${s} s` : `Back on your feet ${where}…`,
    keep: 'You keep everything you carry. Touch a waypoint to come back there next time.',
  };
}

/** Milliseconds of respawn grace (enemies ignore you). */
export const GRACE_MS = PLAYER_RESPAWN_GRACE_S * 1000;

export function graceLine(graceUntil: number, now: number): string | null {
  const s = Math.ceil((graceUntil - now) / 1000);
  if (s <= 0) return null;
  return `Enemies leave you alone for ${s} s, or until you strike`;
}

/** The name of the waypoint you respawn at ("" = none touched: the world spawn). */
export function siteName(index: number, sites: readonly { name: string | null; category: string; link: number }[] | undefined): string {
  if (index < 0 || !sites) return '';
  const own = sites[index]?.name?.trim();
  if (own) return own;
  // A town's waypoint has no name of its own: the settlement links to it.
  const town = sites.find((s) => s.category === 'settlement' && s.link === index && s.name?.trim());
  return town ? `the ${town.name!.trim()} waypoint` : 'your last waypoint';
}

/** Where the zone will put you (RespawnPoint: the last waypoint touched; else the name Event 608 gave it). */
export function respawnSiteName(): string {
  const ex = useExploration.getState();
  return siteName(ex.progress.lastWaypoint, useMapWorld.getState().data?.sites) || ex.respawnName;
}
