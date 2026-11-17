// Playtest 4 (CR 052): guidance and feedback in the world instead of in the
// HUD. One mount in WorldCanvas next to the towns layer:
//   WispLayer         the guiding wisp (key . and by itself on a new quest step)
//   SignpostLayer     readable signposts at forks and town exits
//   BoardPapersLayer  papers pinned on the bounty boards
//   LandmarkLayer     smoke, light pillars, lanterns, glows, birds, glints
//   LevelGlow         the glow around you when you level up
// See client/src/world/README.md "Diegetic layer".

import { useEffect } from 'react';
import { DEBUG } from '../config';
import type { WorldRuntime } from './core/runtime';
import { installDiegeticDebug } from './diegeticDebug';
import { WispLayer } from './guide/WispLayer';
import { SignpostLayer } from './signposts/SignpostLayer';
import { BoardPapersLayer } from './signposts/BoardPapersLayer';
import { LandmarkLayer } from './landmarks/LandmarkLayer';
import { LevelGlow } from './feedback/LevelGlow';

/** `?nodiegetic`: the A/B of the bench (world/bench/*.mjs): the world without these layers. */
const OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nodiegetic');

export function DiegeticLayer({ runtime }: { runtime: WorldRuntime }) {
  useEffect(() => (DEBUG ? installDiegeticDebug() : undefined), []);
  if (OFF) return null;
  return (
    <>
      <WispLayer runtime={runtime} />
      <SignpostLayer runtime={runtime} />
      <BoardPapersLayer runtime={runtime} />
      <LandmarkLayer runtime={runtime} />
      <LevelGlow />
    </>
  );
}
