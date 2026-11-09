// window.__lodestoneProgression: debug handle for headless scripts
// (dev/shots.mjs) and the console. Debug builds only (like the map and
// inventory handles). event() feeds a zone Event through the same reducer
// the session uses, so solo screenshots show exactly what online play does.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { encodeArea, encodeStats, PEV, STATS_REASON } from './events';
import { statsAt, xpForLevel } from './gains';
import { applyProgressionEvent, setPanelOpen, useProgression } from './store';

function ev(kind: number, value: number, targetId: number, data: Uint8Array, x = 0, z = 0): ZoneEvent {
  return { type: 'Event', kind, entityId: 1, targetId, value, x, y: 0, z, data };
}

/** A character_stats Event for `level` (as the zone would send it). */
export function statsEvent(level: number, prevLevel: number, reason: number, attuned = 0, spent = 0, sites: number[] = []): ZoneEvent {
  const s = statsAt(level, attuned);
  const set = new Uint8Array(sites.length ? (Math.max(...sites) >> 3) + 1 : 0);
  for (const i of sites) set[i >> 3] |= 1 << (i & 7);
  const xp = xpForLevel(level) + 37;
  return ev(PEV.characterStats, level, reason, encodeStats({
    reason, level, prevLevel, xp: BigInt(xp), xpInto: 37, xpNext: 60 + 40 * level,
    healthMax: s.health, manaMax: s.mana, staminaMax: s.stamina, damagePct: s.damagePct,
    skillFree: s.skillPoints - spent, skillTotal: s.skillPoints, attunedCount: attuned, attuned: set,
  }));
}

export function installProgressionDebug(): () => void {
  const handle = {
    state: () => {
      const s = useProgression.getState();
      return { stats: s.stats && { ...s.stats, xp: Number(s.stats.xp), attuned: Array.from(s.stats.attuned) }, area: s.area, fanfare: s.fanfare, notices: s.notices.map((n) => ({ kind: n.kind, title: n.title })), panelOpen: s.panelOpen, online: !!s.actions };
    },
    /** Feed one Event (kind, value, targetId, bytes, x, z) through the reducer. */
    event: (kind: number, value: number, targetId: number, data: number[] = [], x = 0, z = 0) => applyProgressionEvent(ev(kind, value, targetId, Uint8Array.from(data), x, z)),
    /** Solo mocks: stats at a level, a level-up from prev, an area. */
    stats: (level: number, attuned = 0, sites: number[] = []) => applyProgressionEvent(statsEvent(level, level, STATS_REASON.sync, attuned, 0, sites)),
    levelUp: (prev: number, level: number) => applyProgressionEvent(statsEvent(level, prev, STATS_REASON.levelUp)),
    area: (level: number, tier: number, flags = 0, by = '') => applyProgressionEvent(ev(PEV.area, level, 0, encodeArea(tier, flags, 256, flags & 2 ? level : 0, by))),
    attuned: (site: number, region: number, name: string) => applyProgressionEvent(ev(PEV.towerAttuned, region, site, new TextEncoder().encode(name))),
    open: (v = true) => setPanelOpen(v),
  };
  (window as unknown as { __lodestoneProgression?: typeof handle }).__lodestoneProgression = handle;
  return () => {
    delete (window as unknown as { __lodestoneProgression?: typeof handle }).__lodestoneProgression;
  };
}
