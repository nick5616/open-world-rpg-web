// Where the client's movement StepEnv comes from (WP10). Online, NetPlay
// builds it from the zone's seed and the clock-synced server time (the same
// inputs the zone uses); offline it uses the local clock and the default
// seed. Dev overrides from the URL, mirrored on the zone by env vars:
//   ?updraft=x,z,radius,top,lift[;...]   (zone: LODESTONE_ZONE_DEBUG_UPDRAFTS)
//   ?rain=1 | ?rain=0                     (zone: LODESTONE_ZONE_DEBUG_RAIN=1|0)
//   ?weather=<state>                      (zone: LODESTONE_ZONE_DEBUG_WEATHER, CR 030)
// A mismatch between the two only costs prediction corrections, never safety:
// the zone simulates with its own env.

import type { MoveField, StepEnv, UpdraftField } from './movement';
import { shelteredField, towerShelters } from './shelter';
import { parseUpdrafts, UpdraftColumns } from './updraft';
import { isRaining } from './weather';
// WP15: world time includes the world's clock offset; fire feeds the updrafts.
import { chemStep, worldClockState, worldTime } from '../systems/clock';
// CR 030: the weather where the player stands (snow, rain, the gale under the glider).
import { weatherField } from '../systems/weather/runtime';
import { chemRuntime } from '../systems/chem/ground';

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

/**
 * The env for a world seed at a server time (ms), with the dev overrides
 * applied. With dynamic weather (CR 030) it carries the shared weather field
 * of that chemistry step (the overrides force its state); without (an
 * atlas-less zone), WP10's global rain.
 */
export function envAt(seed: bigint, serverTimeMs: number): StepEnv {
  const t = worldTime(serverTimeMs);
  const f = weatherField(seed, chemStep(t));
  if (f) return { raining: false, updraft: chemUpdraft(), weather: sheltered(f) };
  const forced = rainOverride() ?? worldClockState.rain;
  return { raining: forced ?? isRaining(seed, t), updraft: chemUpdraft() };
}

let verticalUpdraft: UpdraftField | null = null;

/**
 * CR 038: the vertical world's static wind columns (sky lifts, wind columns,
 * geysers, currents: worldgen VerticalUpdrafts over the descriptor's
 * updrafts), max'ed into every step's updraft like the zone does
 * (server/zone/internal/game/night.go withVerticalUpdraft). Set when the
 * world loads (`new VerticalWind(descriptor)`, ./verticalWind.ts: it also
 * makes gliding in the sky over an archipelago free), null to clear.
 */
export function setVerticalUpdrafts(field: UpdraftField | null): void {
  verticalUpdraft = field;
}

// Playtest 2 co-op: the crystal towers stay dry to climb (sim/shelter.ts), as the zone does.
let shelterCache: { f: MoveField; ds: readonly unknown[]; out: MoveField } | null = null;
function sheltered(f: MoveField): MoveField {
  const ds = towerShelters();
  if (shelterCache && shelterCache.f === f && shelterCache.ds === ds) return shelterCache.out;
  shelterCache = { f, ds, out: shelteredField(f, ds) };
  return shelterCache.out;
}

/** WP15: fire's updrafts (the live chemistry view) plus the debug columns, plus CR 038's wind columns. */
function chemUpdraft(): UpdraftField | null {
  const dbg = debugUpdraft();
  const view = chemRuntime.view;
  const v = verticalUpdraft;
  const parts = [view, dbg, v].filter((f): f is UpdraftField => !!f);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return {
    liftAt: (x, y, z) => parts.reduce((m, f) => Math.max(m, f.liftAt(x, y, z)), 0),
    freeGlideAt: (x, y, z) => parts.some((f) => f.freeGlideAt?.(x, y, z) ?? false),
  };
}

/** Offline (solo) env: local clock, default seed. */
export function offlineEnv(): StepEnv {
  return envAt(OFFLINE_SEED, Date.now());
}
