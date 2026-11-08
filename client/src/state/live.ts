// Per-frame live values, written imperatively by the render loop and read by
// the debug HUD on its own rAF. Deliberately not a zustand store: a store
// update per frame would re-render React 60-144 times a second, and the HUD
// exists to diagnose frame-time problems, so it must not cause them
// (same reasoning as wizard-wars FrameStats / localOrientation).

export type MoveMode = 'idle' | 'walk' | 'sprint' | 'air' | 'fly';

export const localPlayer = {
  /** Feet position, meters (latest simulated step, not the interpolated render pose). */
  pos: { x: 0, y: 0, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  grounded: true,
  airJumps: 0,
  mode: 'idle' as MoveMode,
  /** Movement steps simulated so far (= InputFrame seq). */
  seq: 0,
};

/**
 * Slots the networking and world packages fill (spec 13: the HUD shows fps,
 * transport, RTT, bandwidth and chunk queue). Null renders as "--".
 *  - WP06 (zone connection): transport ('webtransport' | 'websocket'), rttMs, downKbps, upKbps
 *  - WP05 (chunk streaming): chunkQueue (chunks waiting for generation/upload), chunksLoaded
 */
export const netStats = {
  transport: null as string | null,
  rttMs: null as number | null,
  downKbps: null as number | null,
  upKbps: null as number | null,
  chunkQueue: null as number | null,
  chunksLoaded: null as number | null,
};

/**
 * Seconds into the in-game day (0 = midnight, DAY_LENGTH_S long). Advanced by
 * the sky unless time is frozen. Local only for now; WP06 drives it from the
 * server clock (spec 8: day and weather are functions of world time).
 */
export const worldClock = {
  // Start mid-morning so a fresh solo session isn't dark.
  timeOfDayS: 0.4 * 3600,
};
