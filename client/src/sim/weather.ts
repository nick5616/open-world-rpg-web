// Weather stub (WP10) until the night/chemistry package (WP15) owns weather.
// Spec 8: "Day, night and weather are functions of world time and the seed,
// so they need no sync beyond the clock." Movement only needs one bit, "is
// it raining" (rain halves climb speed and makes climbers slip), so this is
// the smallest deterministic function of (seed, world time) both sides can
// call identically: world time is cut into WEATHER_STUB_WINDOW_S windows and
// each window rains when a 32-bit hash of (seed, window) lands in the first
// WEATHER_STUB_RAIN_PCT percent. The Go twin is server/pkg/weather; the
// shared test vectors in weather.test.ts / weather_test.go pin both.
//
// World time is the zone's server clock in seconds (Snapshot.serverTime / 1000,
// Unix epoch), which the client tracks with ClockSync. Client and server can
// disagree for a few ms around a window boundary; prediction then replays one
// correction while climbing, at most once per window (10 minutes).

import { WEATHER_STUB_RAIN_PCT, WEATHER_STUB_WINDOW_S } from '@lodestone/contracts';

/** World time in seconds from the protocol's server clock (Unix ms). */
export function worldTimeS(serverTimeMs: number): number {
  return serverTimeMs / 1000;
}

/** murmur3 fmix32 over (seed lo, seed hi, window), all u32 arithmetic. */
export function weatherHash(seed: bigint, window: number): number {
  const s = BigInt.asUintN(64, seed);
  const lo = Number(s & 0xffffffffn) >>> 0;
  const hi = Number(s >> 32n) >>> 0;
  let h = (lo ^ Math.imul(hi, 0x9e3779b1) ^ Math.imul(window >>> 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Is it raining in this world at this world time? */
export function isRaining(seed: bigint, worldTime: number): boolean {
  const window = Math.floor(worldTime / WEATHER_STUB_WINDOW_S);
  return weatherHash(seed, window) % 100 < WEATHER_STUB_RAIN_PCT;
}
