// The game-facing side of the audio system: a few plain functions any module
// can call (combat, caves, UI) without pulling in the engine. The engine
// (a lazy chunk, loaded after the first playable frame) registers itself
// here; until then calls are no-ops, which is what a game without sound yet
// should do anyway (wizard-wars AudioManager's fail-silent rule).
//
//   emitSound('level_up', { level: 7 })        // a named trigger (triggers.ts)
//   audioWorld.underground = 0.8              // world state the director reads

import type { TriggerName, TriggerPayload } from './triggers';
import type { LoopEmitter } from './loopPool';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * World state written by the systems that know it (caves, towns) and read
 * by the music director and the ambience every few frames. Plain object,
 * no store: it changes every frame.
 */
export const audioWorld = {
  /** 0 on the surface .. 1 deep underground (CaveManager, eased). */
  underground: 0,
  /** Current cave chamber radius (m), for the reverb tail. */
  chamberRadius: 8,
  /** Horizontal distance to the nearest cave opening (m; CaveManager), for how much surface weather leaks in. */
  caveMouthM: Infinity,
  /** Inside a settlement's radius (set by the engine's town probe). */
  inTown: false,
  /** Enemies engaged with the player recently (engine-computed). */
  combatUntil: 0,
  /** CR 028: an instrument sounded near the listener until then (performance ms; ui/music/audio.ts): the music ducks. */
  instrumentUntil: 0,
  /** CR 038: the vertical layer the listener is in: 0 surface, 1 sky, 2 the Underground, 3 the Depths (VerticalManager). */
  layer: 0,
  /** CR 038, eased 0..1: high in the sky over an archipelago (wind), in a vast cavern (hum, lapping water), in the Depths (rumble, lava). */
  sky: 0,
  cavern: 0,
  depths: 0,
  /** CR 038: the cavern chamber kind (0 crystal, 1 cenote, 2 river, 3 fungal, 4 inferno, 5 ashen), -1 none. */
  chamberKind: -1,
};

/** CR 038: layer names for HUD lines, the vibe explorer's tags and composer mappings. */
export const LAYER_TAGS = ['surface', 'sky', 'underground', 'depths'] as const;

/**
 * Positional loop sources outside the towns buffer, asked for the emitters
 * near the listener every engine update (CR 025: burning camp campfires,
 * ui/camps/CampLayer.tsx registers one).
 */
export const loopSources = new Set<(x: number, z: number) => LoopEmitter[]>();

type Sink = (name: TriggerName, payload: TriggerPayload) => void;
let sink: Sink | null = null;

/** Engine side: route triggers to the cue player. */
export function setTriggerSink(s: Sink | null): void {
  sink = s;
}

/** Fire a named sound trigger (see triggers.ts for the names and what they play). */
export function emitSound(name: TriggerName, payload: TriggerPayload = {}): void {
  if (!sink) return;
  try {
    sink(name, payload);
  } catch {
    /* sound must never break gameplay */
  }
}
