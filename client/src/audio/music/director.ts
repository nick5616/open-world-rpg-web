// The music director's state machine: pure, no Web Audio, unit-tested
// (director.test.ts). The engine samples the world a few times a second
// into MusicInputs; the director answers which musical state should be
// playing and which track of that state, and the player (player.ts)
// crossfades to it.
//
// Priority (highest first): timed event > void moment > cave > combat >
// night > town (by day) > day. Hysteresis and dwell times keep it from flapping at
// a cave mouth, a town wall or the edge of a fight.

import { DAWN_HOUR, DUSK_HOUR } from '@lodestone/contracts';

export type MusicState = 'silence' | 'day' | 'night' | 'cave' | 'town' | 'combat' | 'timed' | 'void';

/** A timed objective (town defense countdown/waves, boss enrage...). */
export interface TimedInput {
  /** Stable key: a new key restarts the intro. */
  key: string;
  /** Seconds until the deadline, when there is one (defense warning). */
  secondsLeft: number | null;
  /** Force the "5 sec left" layer (ward nearly broken, boss enraged). */
  urgent: boolean;
  /** Play the intro first (a fresh countdown); false joins straight into the loop. */
  intro: boolean;
}

export interface MusicInputs {
  /** In the world (play screen, first frame drawn). */
  playing: boolean;
  /** In-game hour 0-24. */
  hour: number;
  /** 0 surface .. 1 deep underground. */
  underground: number;
  inTown: boolean;
  /** Fighting (recent hits either way, telegraphs aimed at us, a boss bar). */
  combat: boolean;
  /** Void magic moment (a Void domain, a void lord, the void realm). */
  voidMoment: boolean;
  timed: TimedInput | null;
  /**
   * Playtest 2 immersion pass: the Heartfall (CR 035). 'intro': the Hush's
   * entrance silences the music (it is the silence); 'fight': the void realm;
   * 'won': back to the day at once (the dawn). The endless night comes in as
   * `timed` (its countdown).
   */
  finale?: 'intro' | 'fight' | 'won' | null;
}

export type TimedPhase = 'intro' | 'loop' | 'final';

export interface MusicDecision {
  state: MusicState;
  /** True on the update the state changed. */
  changed: boolean;
  /** Only for state 'timed'. */
  timedPhase: TimedPhase | null;
  /** Rotation counter for states with several tracks (day). */
  rotation: number;
}

export const CAVE_ENTER = 0.55;
export const CAVE_EXIT = 0.35;
/** Seconds a low-priority state must hold before the music follows it. */
export const DWELL_S = 4;
export const FINAL_SECONDS = 5;

const PRIORITY: Record<MusicState, number> = { silence: 0, day: 1, town: 2, night: 3, combat: 4, cave: 5, void: 6, timed: 7 };

export function isNightHour(hour: number): boolean {
  return hour >= DUSK_HOUR || hour < DAWN_HOUR;
}

export class MusicDirector {
  state: MusicState = 'silence';
  rotation = 0;
  private caveLatched = false;
  private candidate: MusicState = 'silence';
  private candidateSince = 0;
  private timedKey: string | null = null;
  private timedStartS = 0;
  private introDone = false;
  /** Length of the timed intro (s); set by the player once it knows the asset. */
  introSeconds = 28.7;

  /** The state the world asks for right now (before dwell). */
  wanted(i: MusicInputs): MusicState {
    if (!i.playing) return 'silence';
    if (i.finale === 'intro') return 'silence';
    if (i.timed) return 'timed';
    if (i.finale === 'fight') return 'void';
    if (i.finale === 'won') return 'day';
    if (i.voidMoment) return 'void';
    if (this.caveLatched ? i.underground > CAVE_EXIT : i.underground >= CAVE_ENTER) return 'cave';
    if (i.combat) return 'combat';
    // Night is night in town too (the town voicing is a daytime thing).
    if (isNightHour(i.hour)) return 'night';
    return i.inTown ? 'town' : 'day';
  }

  update(i: MusicInputs, nowS: number): MusicDecision {
    this.caveLatched = this.caveLatched ? i.underground > CAVE_EXIT : i.underground >= CAVE_ENTER;
    const want = this.wanted(i);
    if (want !== this.candidate) {
      this.candidate = want;
      this.candidateSince = nowS;
    }
    // Rising priority (a fight starts, a countdown begins, you step into a
    // cave) follows at once; falling back waits out the dwell time.
    const immediate = this.state === 'silence' || want === 'silence' || PRIORITY[want] > PRIORITY[this.state] || i.finale === 'won';
    let changed = false;
    if (want !== this.state && (immediate || nowS - this.candidateSince >= DWELL_S)) {
      // Day comes back as the other day track each time (rotation).
      if (want === 'day') this.rotation++;
      this.state = want;
      changed = true;
    }
    let timedPhase: TimedPhase | null = null;
    if (this.state === 'timed' && i.timed) {
      if (i.timed.key !== this.timedKey) {
        this.timedKey = i.timed.key;
        this.timedStartS = nowS;
        this.introDone = !i.timed.intro;
      }
      // intro -> loop -> final, and final <-> loop; never back to the intro.
      if (i.timed.urgent || (i.timed.secondsLeft !== null && i.timed.secondsLeft <= FINAL_SECONDS)) timedPhase = 'final';
      else if (!this.introDone && nowS - this.timedStartS < this.introSeconds) timedPhase = 'intro';
      else timedPhase = 'loop';
      if (timedPhase !== 'intro') this.introDone = true;
    } else if (this.state !== 'timed') {
      this.timedKey = null;
    }
    return { state: this.state, changed, timedPhase, rotation: this.rotation };
  }

  /** The day track ended: move to the next one in the rotation. */
  advanceRotation(): number {
    return ++this.rotation;
  }
}
