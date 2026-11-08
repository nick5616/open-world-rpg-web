// Where the client's movement StepEnv comes from (WP10). Online, NetPlay
// builds it from the zone's seed and the clock-synced server time (the same
// inputs the zone uses); offline it uses the local clock and the default
// seed. Dev overrides from the URL, mirrored on the zone by env vars:
//   ?updraft=x,z,radius,top,lift[;...]   (zone: LODESTONE_ZONE_DEBUG_UPDRAFTS)
//   ?rain=1 | ?rain=0                     (zone: LODESTONE_ZONE_DEBUG_RAIN=1|0)
// A mismatch between the two only costs prediction corrections, never safety:
// the zone simulates with its own env.

import type { StepEnv, UpdraftField } from './movement';
import { parseUpdrafts, UpdraftColumns } from './updraft';
import { isRaining, worldTimeS } from './weather';

/** Seed used offline (solo builds have no world row): WP04's official world seed. */
export const OFFLINE_SEED = 20261108n;

function param(name: string): string | null {
  try {
    return typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

let cachedUpdraft: UpdraftField | null | undefined;

/** Debug updraft columns from ?updraft=..., or null. */
export function debugUpdraft(): UpdraftField | null {
  if (cachedUpdraft === undefined) {
    const cols = parseUpdrafts(param('updraft'));
    cachedUpdraft = cols.length ? new UpdraftColumns(cols) : null;
  }
  return cachedUpdraft;
}

/** Replace the debug updraft (dev handle, tests). */
export function setDebugUpdraft(u: UpdraftField | null): void {
  cachedUpdraft = u;
}

/** ?rain=1 forces rain, ?rain=0 forces dry, otherwise the weather stub decides. */
export function rainOverride(): boolean | null {
  const r = param('rain');
  return r === '1' ? true : r === '0' ? false : null;
}

/** The env for a world seed at a server time (ms), with the dev overrides applied. */
export function envAt(seed: bigint, serverTimeMs: number): StepEnv {
  const forced = rainOverride();
  return { raining: forced ?? isRaining(seed, worldTimeS(serverTimeMs)), updraft: debugUpdraft() };
}

/** Offline (solo) env: local clock, default seed. */
export function offlineEnv(): StepEnv {
  return envAt(OFFLINE_SEED, Date.now());
}
