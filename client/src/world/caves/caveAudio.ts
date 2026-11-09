// Cave audio (WP09, spec 7: "Audio switches to a reverb bus sized by the
// current chamber's radius from the graph"). This used to be a small
// self-contained WebAudio graph with synthesized sounds, waiting for the
// game's audio pipeline; it is now a thin bridge into that pipeline
// (client/src/audio): the chamber radius and depth feed the engine's cave
// reverb, the music director (caves play "void realm") and the drip
// ambience; pickaxe hits, vein breaks and pickups play the mining cues.
// CaveManager's calls are unchanged.

import { audioWorld, emitSound } from '../../audio/bridge';
import { getAudioContext, unlockAudio } from '../../audio/context';

export class CaveAudio {
  /** Called from a user gesture (a swing, a click): makes sure sound can start. */
  unlock(): void {
    unlockAudio();
  }

  get ready(): boolean {
    return getAudioContext() !== null;
  }

  /** Reverb tail for a space of this radius (m). */
  setChamberRadius(r: number): void {
    audioWorld.chamberRadius = r;
  }

  /** 0 on the surface, 1 deep underground (eased by the caller). */
  setUnderground(u: number, now: number): void {
    audioWorld.underground = u;
    void now;
  }

  /** Pickaxe on stone (gems ring higher). */
  hit(gem: boolean): void {
    emitSound('mine_hit', { gem });
  }

  /** The vein gives way. */
  crumble(): void {
    emitSound('vein_break');
  }

  /** Item picked up. */
  chime(): void {
    emitSound('pickup');
  }
}
