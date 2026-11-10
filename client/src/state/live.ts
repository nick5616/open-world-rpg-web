// Per-frame live values, written imperatively by the render loop and read by
// the debug HUD on its own rAF. Deliberately not a zustand store: a store
// update per frame would re-render React 60-144 times a second, and the HUD
// exists to diagnose frame-time problems, so it must not cause them
// (same reasoning as wizard-wars FrameStats / localOrientation).

export type MoveMode = 'idle' | 'walk' | 'sprint' | 'air' | 'fly' | 'slide' | 'climb' | 'glide' | 'swim';

export const localPlayer = {
  /** Feet position, meters (latest simulated step, not the interpolated render pose). */
  pos: { x: 0, y: 0, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  grounded: true,
  airJumps: 0,
  /** CR 021: dash steps left after the latest step (0 = no dash; held dashes keep it up). */
  dash: 0,
  mode: 'idle' as MoveMode,
  /** Movement steps simulated so far (= InputFrame seq). */
  seq: 0,
  /** WP10 stamina wheel, in points (the step keeps fine units). */
  stamina: 100,
  staminaMax: 100,
  exhausted: false,
  drowned: false,
  /** Rain as the last movement step saw it (weather stub). */
  raining: false,
  /**
   * Playtest 2: the combat aim. First person it is the view (yaw, pitch);
   * third person it is converged from the eye onto what the crosshair (the
   * camera's ray) is on, so shots and casts land under the crosshair.
   */
  aimYaw: 0,
  aimPitch: 0,
  /** CR 027: riding the spirit steed (MoveFlag.mounted), its gait (sim/ride.ts GAIT) and spurs left in the wheel. */
  mounted: false,
  gait: 0,
};

/** Playtest 2: local actions with no other hook, counted for the own third-person avatar. */
export const localActions = {
  /** Pickaxe swings at a vein (world/caves/caveManager.ts). */
  mineSwings: 0,
};

/**
 * Playtest 2 third person: what the camera is doing this frame. `eye` is the
 * player's own eye (drawn), where interactions, mining and casts act from;
 * in first person the camera sits there.
 */
export const view = {
  third: false,
  /** Drawn feet position (the interpolated render pose the camera follows). */
  feet: { x: 0, y: 0, z: 0 },
  eye: { x: 0, y: 0, z: 0 },
  /** Third-person boom length after collision (m); 0 in first person. */
  boom: 0,
  /** Hide the own body: first person, or a boom so short the camera is in the head. */
  hideBody: true,
  /** Playtest 2 photo mode (ui/photo): a free camera; your body shows, the first-person arms don't. */
  photo: false,
  /** Playtest 2 fishing: a rod is held in first person (the weapon view model hides). */
  fpProp: false,
  /** Playtest 2 emotes: a first-person hand gesture is up (the weapon view model steps aside). */
  fpGesture: false,
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
  /** WP06: one-line sync summary (tick, remotes, interp delay, corrections, extrapolations). */
  sync: null as string | null,
};

/**
 * Seconds into the in-game day (0 = midnight, DAY_LENGTH_S long). Advanced by
 * the sky unless time is frozen. Local only for now; WP06 drives it from the
 * server clock (spec 8: day and weather are functions of world time).
 */
export const worldClock = {
  // Start mid-morning so a fresh solo session isn't dark.
  timeOfDayS: 0.4 * 3600,
  /**
   * WP15: online, the world clock (zone server time + the world's offset,
   * client/src/systems/clock.ts) drives the sky; null = advance locally.
   */
  source: null as (() => number) | null,
};
