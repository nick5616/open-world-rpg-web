// The engine's one seam for the composer aids (vibe explorer, dev builds):
// engine.ts asks the hook to adjust the director's inputs (a forced state)
// and, after the director decided, whether the composer's own deck plays
// instead of the game's music (a forced track, a loaded file mapped to this
// vibe). Nothing registers in a normal session, so this costs nothing there.
// Deliberately dependency-free: the engine is a lazy chunk and must not pull
// the composer (dev UI code) in.

import type { MusicDecision, MusicInputs } from '../music/director';

export interface ComposerHook {
  inputs(i: MusicInputs): MusicInputs;
  /** True: the composer's deck carries the music now (the game's player goes quiet). */
  tick(engine: unknown, d: MusicDecision, i: MusicInputs, nowMs: number): boolean;
}

export const composerHook: { current: ComposerHook | null } = { current: null };
