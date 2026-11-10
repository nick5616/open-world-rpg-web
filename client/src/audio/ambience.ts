// Synthesized ambience beds (no assets): wind, rain, rain on the roof,
// thunder, night insects, underwater hush, cave drips. They are continuous
// textures where a sample loop would either repeat audibly or cost
// megabytes, so they are built from noise in the graph and steered by a
// handful of gains:
//
//   wind     brown-ish noise -> wandering band-pass; louder up high, in
//            storms, and with your speed while gliding or falling
//   rain     white noise through a high/low-pass pair plus random droplets,
//            at the rain intensity (acoustics.ts RainIntensity)
//   roof     rain drumming on the roof over your head (synth.ts roofRain),
//            rising as the open-air rain is shut out
//   thunder  rare distant rumbles while it pours (acoustics.ts thunderFor)
//   insects  4.6 kHz chirps in pulse trains, at night on the surface
//   water    low-passed rumble while swimming / submerged
//   drips    falling sine blips in caves, mostly reverb
//
// Wind, open-air rain, thunder and insects share one "weather" submix that
// the shelter (porch, walls, cave depth) fades and low-passes as a whole:
//
//   wind ───┐
//   rain ───┼─> weather low-pass ─> weather gain ─┐
//   thunder ┤                                     ├─> out (ambience bus)
//   insects ┘          roof rain ─> roof gain ────┤
//                      water, drips ──────────────┘
//
// Fires and rivers are positional now (loops.ts), not beds.
// 3d-portfolio-website's roomSoundscape.ts crossfades per room; here the
// "room" is a continuous mix of these targets (setTargets), smoothed with
// setTargetAtTime so nothing clicks.

import { thunderFor } from './acoustics';
import { noiseBuffer, renderLoop } from './synth';

export interface AmbienceTargets {
  /** 0..1 */
  wind: number;
  /** Wind band centre brightness 0..1 (speed). */
  windSpeed: number;
  /** Open-air rain 0..1 (intensity). */
  rain: number;
  /** Rain on the roof over you 0..1. */
  roofRain: number;
  insects: number;
  water: number;
  /** Cave water drips (deep underground), through the cave reverb. */
  drips: number;
  /** The weather submix (wind, rain, thunder, insects) through the shelter. */
  weatherGain: number;
  weatherLowpassHz: number;
  /** Playtest 2 weather (CR 030): a storm's low roll 0..1, gusting 0..1, blowing sand 0..1. */
  storm?: number;
  gust?: number;
  sand?: number;
  /** Thunder comes from real strikes (the weather runtime), not the random rumbles of a downpour. */
  syncedThunder?: boolean;
}

const ZERO: AmbienceTargets = { wind: 0, windSpeed: 0, rain: 0, roofRain: 0, insects: 0, water: 0, drips: 0, weatherGain: 1, weatherLowpassHz: 16000 };

export class Ambience {
  private wind: GainNode;
  private windBand: BiquadFilterNode;
  private rain: GainNode;
  private roof: GainNode;
  private insects: GainNode;
  private water: GainNode;
  private weatherLp: BiquadFilterNode;
  private weather: GainNode;
  private storm: GainNode;
  private sand: GainNode;
  private gustAt = 0;
  private sources: AudioScheduledSourceNode[] = [];
  private dropAt = 0;
  private chirpAt = 0;
  private thunderAt = 0;
  private targets: AmbienceTargets = { ...ZERO };
  private white: AudioBuffer | null = null; // WP19b: null until synthesized (noiseBuffer)
  private brown: AudioBuffer | null = null;
  private disposed = false;
  private dripAt = 0;
  /** Thunder rumbles started (debug). */
  thunders = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
    /** The reverb send (drips only make sense wet). */
    private readonly wet: AudioNode | null = null,
  ) {
    // WP19b: the noise is synthesized in slices (noiseBuffer); each bed's
    // loop joins its (silent, gain 0 at first) chain once its buffer is
    // ready, a few hundred ms after the engine starts.
    const brown = noiseBuffer(ctx, 6, true);
    const white = noiseBuffer(ctx, 4, false);
    void white.then((b) => (this.white = b));
    void brown.then((b) => (this.brown = b));
    const loop = (buf: Promise<AudioBuffer | null>) => {
      const head = ctx.createGain();
      void buf.then((b) => {
        if (this.disposed || !b) return;
        const s = ctx.createBufferSource();
        s.buffer = b;
        s.loop = true;
        s.start(ctx.currentTime, Math.random() * b.duration);
        this.sources.push(s);
        s.connect(head);
      });
      return head;
    };
    // The weather submix.
    this.weatherLp = ctx.createBiquadFilter();
    this.weatherLp.type = 'lowpass';
    this.weatherLp.frequency.value = 16000;
    this.weatherLp.Q.value = 0.5;
    this.weather = ctx.createGain();
    this.weatherLp.connect(this.weather).connect(out);
    // wind
    this.windBand = ctx.createBiquadFilter();
    this.windBand.type = 'bandpass';
    this.windBand.frequency.value = 500;
    this.windBand.Q.value = 0.9;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    loop(brown).connect(this.windBand).connect(this.wind).connect(this.weatherLp);
    // A slow LFO wanders the band so the wind gusts.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(this.windBand.frequency);
    lfo.start();
    this.sources.push(lfo);
    // rain (open air)
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    this.rain = ctx.createGain();
    this.rain.gain.value = 0;
    loop(white).connect(hp).connect(lp).connect(this.rain).connect(this.weatherLp);
    // CR 030: a storm's low roll (brown noise under 140 Hz, swelling) and
    // blowing sand (a hiss in the 2-5 kHz band), both in the weather submix.
    const sl = ctx.createBiquadFilter();
    sl.type = 'lowpass';
    sl.frequency.value = 140;
    this.storm = ctx.createGain();
    this.storm.gain.value = 0;
    loop(brown).connect(sl).connect(this.storm).connect(this.weatherLp);
    const sb = ctx.createBiquadFilter();
    sb.type = 'bandpass';
    sb.frequency.value = 3200;
    sb.Q.value = 0.7;
    this.sand = ctx.createGain();
    this.sand.gain.value = 0;
    loop(white).connect(sb).connect(this.sand).connect(this.weatherLp);
    // rain on the roof (rendered texture), outside the weather submix: it is
    // the sound of the shelter itself.
    this.roof = ctx.createGain();
    this.roof.gain.value = 0;
    loop(renderLoop(ctx, 'roofRain')).connect(this.roof).connect(out);
    // insects + water
    this.insects = ctx.createGain();
    this.insects.gain.value = 0;
    this.insects.connect(this.weatherLp);
    const wl = ctx.createBiquadFilter();
    wl.type = 'lowpass';
    wl.frequency.value = 380;
    this.water = ctx.createGain();
    this.water.gain.value = 0;
    loop(brown).connect(wl).connect(this.water).connect(out);
  }

  setTargets(t: AmbienceTargets): void {
    const now = this.ctx.currentTime;
    const tc = 0.6;
    this.targets = t;
    this.wind.gain.setTargetAtTime(t.wind * 0.55, now, tc);
    this.windBand.Q.setTargetAtTime(0.9 + t.windSpeed * 1.5, now, tc);
    this.windBand.frequency.setTargetAtTime(380 + t.windSpeed * 900, now, 0.3);
    this.rain.gain.setTargetAtTime(t.rain * 0.22, now, 0.8);
    this.roof.gain.setTargetAtTime(t.roofRain * 0.5, now, 0.35);
    this.insects.gain.setTargetAtTime(t.insects * 0.05, now, 2);
    this.water.gain.setTargetAtTime(t.water * 0.7, now, 0.2);
    this.storm.gain.setTargetAtTime((t.storm ?? 0) * 0.35, now, 1.2);
    this.sand.gain.setTargetAtTime((t.sand ?? 0) * 0.16, now, 0.8);
    // Shelter: quick enough to follow a doorway (~0.3 s), slow enough not to zipper.
    this.weather.gain.setTargetAtTime(t.weatherGain, now, 0.25);
    this.weatherLp.frequency.setTargetAtTime(Math.max(120, t.weatherLowpassHz), now, 0.25);
  }

  /** Random events of the beds (call every frame or so). */
  tick(nowMs: number): void {
    const t = this.targets;
    if (t.rain > 0.1 && nowMs > this.dropAt) {
      this.drop(t.rain);
      this.dropAt = nowMs + 30 + Math.random() * (120 / t.rain);
    }
    if (t.insects > 0.05 && nowMs > this.chirpAt) {
      this.chirp();
      this.chirpAt = nowMs + 380 + Math.random() * 2400;
    }
    if (t.drips > 0.5 && nowMs > this.dripAt) {
      this.drip();
      this.dripAt = nowMs + 1500 + Math.random() * 5000;
    }
    // Thunder while it pours: a strike somewhere 0.6-5 km away every
    // 25-80 s; its rumble arrives (and is as loud and dark) as far as it is.
    // CR 030: in a gale the wind comes in gusts (a swell over a second or two).
    if ((t.gust ?? 0) > 0.2 && nowMs > this.gustAt) {
      const g = t.gust ?? 0;
      const now = this.ctx.currentTime;
      const peak = Math.min(1, t.wind + 0.35 * g) * 0.55;
      this.wind.gain.setTargetAtTime(peak, now, 0.35);
      this.wind.gain.setTargetAtTime(t.wind * 0.55, now + 0.9 + Math.random() * 1.2, 0.8);
      this.gustAt = nowMs + 2500 + Math.random() * (6000 / g);
    }
    if (t.rain > 0.6 && !t.syncedThunder) {
      if (!this.thunderAt) this.thunderAt = nowMs + 8000 + Math.random() * 30000;
      else if (nowMs > this.thunderAt) {
        this.thunder(600 + Math.random() * 4400);
        this.thunderAt = nowMs + 25000 + Math.random() * 55000;
      }
    } else this.thunderAt = 0;
  }

  /** A thunder rumble from a strike `distanceM` away (into the weather submix: muffled indoors, faded in caves). */
  thunder(distanceM: number): void {
    const ctx = this.ctx;
    if (!this.brown) return;
    const th = thunderFor(distanceM);
    const t = ctx.currentTime + th.delayS;
    const s = ctx.createBufferSource();
    s.buffer = this.brown;
    s.loop = true; // a long, slowed rumble outlasts the 6 s noise buffer
    s.playbackRate.value = 0.6 + Math.random() * 0.25;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = th.lowpassHz;
    f.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(th.gain, t + th.attackS);
    // A second roll a moment later, then the long decay.
    g.gain.linearRampToValueAtTime(th.gain * 0.55, t + th.attackS + 0.6);
    g.gain.linearRampToValueAtTime(th.gain * 0.8, t + th.attackS + 1.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + th.attackS + 1.1 + th.decayS);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 1.2 - 0.6;
    s.connect(f).connect(g).connect(p).connect(this.weatherLp);
    const dur = th.attackS + 1.2 + th.decayS;
    s.start(t, Math.random() * this.brown.duration);
    s.stop(t + dur);
    this.thunders++;
    // CR 030: a strike close by cracks before it rolls (a white-noise snap).
    if (distanceM < 450 && this.white) {
      const c = ctx.createBufferSource();
      c.buffer = this.white;
      const cf = ctx.createBiquadFilter();
      cf.type = 'highpass';
      cf.frequency.value = 900;
      const cg = ctx.createGain();
      const loud = Math.min(1, 1.2 - distanceM / 450) * 0.8;
      cg.gain.setValueAtTime(0, t);
      cg.gain.linearRampToValueAtTime(loud, t + 0.005);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      c.connect(cf).connect(cg).connect(this.weatherLp);
      c.start(t, Math.random() * (this.white.duration - 0.5));
      c.stop(t + 0.4);
    }
  }

  /** A water drop in a cave (from WP09's caveAudio.ts): a falling sine blip, mostly reverb. */
  private drip(): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(1600 + Math.random() * 900, t);
    o.frequency.exponentialRampToValueAtTime(500, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 1.6 - 0.8;
    o.connect(g).connect(p);
    p.connect(this.out);
    if (this.wet) p.connect(this.wet);
    o.start(t);
    o.stop(t + 0.12);
  }

  private burst(seconds: number, filterType: BiquadFilterType, freq: number, q: number, peak: number, out: AudioNode, pan = 0): void {
    const ctx = this.ctx;
    if (!this.white) return; // still being synthesized (first few hundred ms)
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    s.connect(f).connect(g).connect(p).connect(out);
    s.start(t, Math.random() * 3, seconds + 0.02);
  }

  private drop(level: number): void {
    this.burst(0.01 + Math.random() * 0.02, 'bandpass', 2500 + Math.random() * 5000, 4, 0.05 + 0.1 * level * Math.random(), this.rain, Math.random() * 2 - 1);
  }

  private chirp(): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.value = 4400 + Math.random() * 600;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pulses = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < pulses; i++) {
      g.gain.setValueAtTime(0, t + i * 0.055);
      g.gain.linearRampToValueAtTime(0.5, t + i * 0.055 + 0.008);
      g.gain.linearRampToValueAtTime(0, t + i * 0.055 + 0.03);
    }
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 1.8 - 0.9;
    o.connect(g).connect(p).connect(this.insects);
    o.start(t);
    o.stop(t + pulses * 0.055 + 0.05);
  }

  /** Current targets (debug). */
  get current(): Readonly<AmbienceTargets> {
    return this.targets;
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* stopped */
      }
    }
  }
}
