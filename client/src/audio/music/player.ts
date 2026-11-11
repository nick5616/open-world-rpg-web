// Music playback for the director's decisions.
//
// Long tracks (three minutes of future land) are STREAMED through media
// elements into the graph (MediaElementAudioSourceNode): decoding them
// whole would cost ~65 MB of PCM each. Two decks alternate so every change
// is a crossfade, and a track crossfades into the next (or into itself)
// END_CROSSFADE_S before it ends, so nothing ever stops dead.
//
// Timed events use "time crunch", whose parts are short and must line up to
// the sample, so they are decoded into buffers and run as three
// phase-locked sources (intro once; loop and "5 sec left" looping from the
// same instant): switching phase is just moving gain between them.

import { assetUrl } from '../assets';
import type { MusicDecision, MusicState, TimedPhase } from './director';
import { END_CROSSFADE_S, STATE_MUSIC, TIMED_MUSIC } from './tracks';

interface Deck {
  el: HTMLAudioElement;
  filter: BiquadFilterNode;
  gain: GainNode;
  track: string | null;
  /** Already handed off to the other deck near its end. */
  handedOff: boolean;
}

interface Timed {
  intro: AudioBufferSourceNode | null;
  loop: AudioBufferSourceNode;
  final: AudioBufferSourceNode;
  gains: Record<TimedPhase, GainNode>;
  out: GainNode;
  phase: TimedPhase | null;
}

export interface MusicPlayerStatus {
  state: MusicState;
  track: string | null;
  timedPhase: TimedPhase | null;
  /** Deck positions (s), for the debug hook. */
  positions: number[];
  /** The carrying deck's position and the track's length (s; the vibe explorer's readout). */
  position: number;
  duration: number | null;
}

export class MusicPlayer {
  private decks: Deck[] = [];
  private active = -1;
  private state: MusicState = 'silence';
  private timed: Timed | null = null;
  /** The seamless buffer loop (combat), when playing. */
  private loop: { src: AudioBufferSourceNode; gain: GainNode; track: string } | null = null;
  private timedLoading: Promise<void> | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private rotation = 0;
  /** Length of the timed intro once decoded (the director needs it). */
  introSeconds = 28.7;

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
  ) {}

  private deck(i: number): Deck {
    let d = this.decks[i];
    if (d) return d;
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    const src = this.ctx.createMediaElementSource(el);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 20000;
    filter.Q.value = 0.5;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.out);
    d = { el, filter, gain, track: null, handedOff: false };
    this.decks[i] = d;
    return d;
  }

  /** Apply a director decision (call a few times a second). */
  apply(d: MusicDecision): void {
    this.rotation = d.rotation;
    if (d.state !== this.state) {
      const prev = this.state;
      this.state = d.state;
      if (prev === 'timed') this.stopTimed(2);
      if (d.state === 'silence') {
        this.fadeAllDecks(1.5);
        this.stopLoop(1.5);
      } else if (d.state === 'timed') {
        this.fadeAllDecks(1.2);
        this.stopLoop(1.2);
        void this.startTimed(d.timedPhase ?? 'loop');
      } else this.playState(d.state, prev);
    }
    if (d.state === 'timed' && d.timedPhase) this.setTimedPhase(d.timedPhase);
    this.tickDecks();
  }

  private pick(state: Exclude<MusicState, 'silence' | 'timed'>, offset = 0): string {
    const t = STATE_MUSIC[state].tracks;
    return t[(this.rotation + offset) % t.length];
  }

  private playState(state: Exclude<MusicState, 'silence' | 'timed'>, prev: MusicState): void {
    const sm = STATE_MUSIC[state];
    if (sm.seamless) {
      this.fadeAllDecks(sm.fadeIn);
      void this.startLoop(this.pick(state), sm.gain, sm.fadeIn);
      return;
    }
    this.stopLoop(sm.fadeIn);
    const cur = this.active >= 0 ? this.decks[this.active] : null;
    // Same tracks family (town <-> day, cave <-> void): keep the track
    // playing and just re-voice it (gain and filter), no restart.
    if (cur && cur.track && sm.tracks.includes(cur.track) && prev !== 'silence') {
      this.voice(cur, state, sm.fadeIn);
      return;
    }
    this.crossfadeTo(this.pick(state), state, sm.fadeIn);
  }

  private voice(d: Deck, state: Exclude<MusicState, 'silence' | 'timed'>, fade: number): void {
    const sm = STATE_MUSIC[state];
    const t = this.ctx.currentTime;
    d.gain.gain.cancelScheduledValues(t);
    d.gain.gain.setValueAtTime(d.gain.gain.value, t);
    d.gain.gain.linearRampToValueAtTime(sm.gain, t + fade);
    d.filter.frequency.cancelScheduledValues(t);
    d.filter.frequency.setValueAtTime(d.filter.frequency.value, t);
    d.filter.frequency.exponentialRampToValueAtTime(sm.lowpassHz, t + fade);
  }

  private crossfadeTo(track: string, state: Exclude<MusicState, 'silence' | 'timed'>, fade: number): void {
    const url = assetUrl(track);
    // The quieter deck (the one not carrying the music now).
    const next = this.active >= 0 ? 1 - this.active : (this.decks[0]?.gain.gain.value ?? 0) <= (this.decks[1]?.gain.gain.value ?? 0) ? 0 : 1;
    const d = this.deck(next);
    const t = this.ctx.currentTime;
    // Fade out whatever else plays.
    for (let i = 0; i < this.decks.length; i++) if (i !== next) this.fadeDeck(this.decks[i], fade);
    this.active = next;
    if (!url) return;
    d.track = track;
    d.handedOff = false;
    if (!d.el.src.endsWith(url)) d.el.src = url;
    try {
      d.el.currentTime = 0;
    } catch {
      /* not seekable yet */
    }
    d.filter.frequency.cancelScheduledValues(t);
    d.filter.frequency.setValueAtTime(STATE_MUSIC[state].lowpassHz, t);
    d.gain.gain.cancelScheduledValues(t);
    d.gain.gain.setValueAtTime(0, t);
    d.gain.gain.linearRampToValueAtTime(STATE_MUSIC[state].gain, t + fade);
    d.el.play().catch(() => {});
  }

  private fadeDeck(d: Deck | undefined, fade: number): void {
    if (!d) return;
    const t = this.ctx.currentTime;
    d.gain.gain.cancelScheduledValues(t);
    d.gain.gain.setValueAtTime(d.gain.gain.value, t);
    d.gain.gain.linearRampToValueAtTime(0, t + fade);
    const el = d.el;
    const track = d.track;
    setTimeout(() => {
      // Still silent and not re-used: stop streaming.
      if (d.track === track && d.gain.gain.value < 0.001) el.pause();
    }, fade * 1000 + 200);
  }

  private fadeAllDecks(fade: number): void {
    for (const d of this.decks) this.fadeDeck(d, fade);
    this.active = -1;
  }

  private async startLoop(track: string, gain: number, fade: number): Promise<void> {
    if (this.loop?.track === track) {
      const g = this.loop.gain.gain;
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(gain, t + fade);
      return;
    }
    const want = this.state;
    const b = await this.buffer(track);
    if (!b || this.state !== want) return;
    this.stopLoop(fade);
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    src.loopEnd = b.duration;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + fade);
    src.connect(g).connect(this.out);
    src.start(t);
    this.loop = { src, gain: g, track };
  }

  private stopLoop(fade: number): void {
    const l = this.loop;
    if (!l) return;
    this.loop = null;
    const t = this.ctx.currentTime;
    l.gain.gain.cancelScheduledValues(t);
    l.gain.gain.setValueAtTime(l.gain.gain.value, t);
    l.gain.gain.linearRampToValueAtTime(0, t + fade);
    try {
      l.src.stop(t + fade + 0.05);
    } catch {
      /* stopped */
    }
  }

  /** Near a track's end: crossfade into the next (day rotates, others repeat). */
  private tickDecks(): void {
    if (this.active < 0 || this.state === 'silence' || this.state === 'timed') return;
    const d = this.decks[this.active];
    if (!d || d.handedOff || !Number.isFinite(d.el.duration) || d.el.duration <= 0) return;
    if (d.el.ended || d.el.currentTime >= d.el.duration - END_CROSSFADE_S) {
      d.handedOff = true;
      const st = this.state as Exclude<MusicState, 'silence' | 'timed'>;
      this.rotation++;
      this.crossfadeTo(this.pick(st), st, END_CROSSFADE_S);
    }
  }

  private async buffer(name: string): Promise<AudioBuffer | null> {
    const hit = this.buffers.get(name);
    if (hit) return hit;
    const url = assetUrl(name);
    if (!url) return null;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const b = await this.ctx.decodeAudioData(await r.arrayBuffer());
      this.buffers.set(name, b);
      return b;
    } catch {
      return null;
    }
  }

  /** Fetch and decode "time crunch" ahead of need (a defense warning is a few seconds early). */
  prefetchTimed(): Promise<void> {
    if (!this.timedLoading) {
      this.timedLoading = Promise.all([this.buffer(TIMED_MUSIC.intro), this.buffer(TIMED_MUSIC.loop), this.buffer(TIMED_MUSIC.final)]).then(([intro]) => {
        if (intro) this.introSeconds = intro.duration;
      });
    }
    return this.timedLoading;
  }

  private async startTimed(phase: TimedPhase): Promise<void> {
    await this.prefetchTimed();
    if (this.state !== 'timed' || this.timed) return;
    const intro = this.buffers.get(TIMED_MUSIC.intro) ?? null;
    const loop = this.buffers.get(TIMED_MUSIC.loop);
    const final = this.buffers.get(TIMED_MUSIC.final);
    if (!loop || !final) return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = TIMED_MUSIC.gain;
    out.connect(this.out);
    const mk = (b: AudioBuffer, loopIt: boolean) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.loop = loopIt;
      if (loopIt) {
        s.loopStart = 0;
        s.loopEnd = b.duration;
      }
      return s;
    };
    const gains = { intro: ctx.createGain(), loop: ctx.createGain(), final: ctx.createGain() };
    for (const g of Object.values(gains)) {
      g.gain.value = 0;
      g.connect(out);
    }
    const t0 = ctx.currentTime + 0.05;
    const tm: Timed = { intro: null, loop: mk(loop, true), final: mk(final, true), gains, out, phase: null };
    // The loop and the final layer run phase-locked from t0; the intro (two
    // loop lengths long) plays once on top, so intro -> loop is seamless.
    tm.loop.connect(gains.loop);
    tm.final.connect(gains.final);
    tm.loop.start(t0);
    tm.final.start(t0);
    if (intro && phase === 'intro') {
      tm.intro = mk(intro, false);
      tm.intro.connect(gains.intro);
      tm.intro.start(t0);
    }
    this.timed = tm;
    this.setTimedPhase(phase);
  }

  private setTimedPhase(phase: TimedPhase): void {
    const tm = this.timed;
    if (!tm || tm.phase === phase) return;
    if (phase === 'intro' && !tm.intro) phase = 'loop';
    tm.phase = phase;
    const t = this.ctx.currentTime;
    const fade = phase === 'final' ? 0.15 : 0.4;
    for (const p of ['intro', 'loop', 'final'] as const) {
      const g = tm.gains[p].gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(p === phase ? 1 : 0, t + fade);
    }
  }

  private stopTimed(fade: number): void {
    const tm = this.timed;
    if (!tm) return;
    this.timed = null;
    const t = this.ctx.currentTime;
    tm.out.gain.cancelScheduledValues(t);
    tm.out.gain.setValueAtTime(tm.out.gain.value, t);
    tm.out.gain.linearRampToValueAtTime(0, t + fade);
    for (const s of [tm.intro, tm.loop, tm.final]) {
      try {
        s?.stop(t + fade + 0.05);
      } catch {
        /* already stopped */
      }
    }
  }

  status(): MusicPlayerStatus {
    const d = this.active >= 0 ? this.decks[this.active] : null;
    const track = this.state === 'timed' ? TIMED_MUSIC.loop : this.loop ? this.loop.track : (d?.track ?? null);
    const position = this.timed ? 0 : this.loop ? this.ctx.currentTime % (this.loop.src.buffer?.duration || 1) : (d?.el.currentTime ?? 0);
    const duration = this.loop ? (this.loop.src.buffer?.duration ?? null) : d && Number.isFinite(d.el.duration) ? d.el.duration : null;
    return { state: this.state, track, timedPhase: this.timed?.phase ?? null, positions: this.decks.map((x) => x.el.currentTime), position, duration };
  }

  dispose(): void {
    this.stopTimed(0.1);
    this.stopLoop(0.1);
    for (const d of this.decks) {
      d.el.pause();
      d.el.removeAttribute('src');
    }
  }
}
