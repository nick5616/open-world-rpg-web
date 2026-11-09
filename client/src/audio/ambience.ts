// Synthesized ambience beds (no assets): wind, rain, fire crackle, night
// insects, underwater hush. They are continuous textures where a sample
// loop would either repeat audibly or cost megabytes, so they are built
// from noise in the graph and steered by a handful of gains:
//
//   wind     brown-ish noise -> wandering band-pass; louder up high, in
//            storms, and with your speed while gliding or falling
//   rain     white noise through a high/low-pass pair plus random droplets
//   fire     band-passed rumble + random crackle pops, by burning cells near
//   insects  4.6 kHz chirps in pulse trains, at night on the surface
//   water    low-passed rumble while swimming / submerged
//
// 3d-portfolio-website's roomSoundscape.ts crossfades per room; here the
// "room" is a continuous mix of these targets (setTargets), smoothed with
// setTargetAtTime so nothing clicks.

export interface AmbienceTargets {
  /** 0..1 */
  wind: number;
  /** Wind band centre brightness 0..1 (speed). */
  windSpeed: number;
  rain: number;
  fire: number;
  insects: number;
  water: number;
  /** Cave water drips (deep underground), through the cave reverb. */
  drips: number;
}

/**
 * Yields to the event loop (WP19b: buffers of ~1 M samples synthesized in one
 * go were a 70-90 ms main-thread long task on the first key press, when the
 * engine unlocks; in slices of SYNTH_SLICE samples each piece is ~1 ms).
 */
export const SYNTH_SLICE = 32768;
export const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

async function noiseBuffer(ctx: AudioContext, seconds: number, brown: boolean): Promise<AudioBuffer> {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      if (i % SYNTH_SLICE === SYNTH_SLICE - 1) await yieldToLoop();
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    // Seamless loop: crossfade the tail into the head.
    const fade = Math.min(len >> 3, ctx.sampleRate >> 2);
    for (let i = 0; i < fade; i++) {
      const a = i / fade;
      d[i] = d[i] * a + d[len - fade + i] * (1 - a);
    }
  }
  return b;
}

export class Ambience {
  private wind: GainNode;
  private windBand: BiquadFilterNode;
  private rain: GainNode;
  private fire: GainNode;
  private insects: GainNode;
  private water: GainNode;
  private sources: AudioScheduledSourceNode[] = [];
  private crackleAt = 0;
  private dropAt = 0;
  private chirpAt = 0;
  private targets: AmbienceTargets = { wind: 0, windSpeed: 0, rain: 0, fire: 0, insects: 0, water: 0, drips: 0 };
  private white: AudioBuffer | null = null; // WP19b: null until synthesized (noiseBuffer)
  private disposed = false;
  private dripAt = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
    /** The cave reverb send (drips only make sense wet). */
    private readonly wet: AudioNode | null = null,
  ) {
    // WP19b: the noise is synthesized in slices (noiseBuffer); each bed's
    // loop joins its (silent, gain 0 at first) chain once its buffer is
    // ready, a few hundred ms after the engine starts.
    const brown = noiseBuffer(ctx, 6, true);
    const white = noiseBuffer(ctx, 4, false);
    void white.then((b) => (this.white = b));
    const loop = (buf: Promise<AudioBuffer>) => {
      const head = ctx.createGain();
      void buf.then((b) => {
        if (this.disposed) return;
        const s = ctx.createBufferSource();
        s.buffer = b;
        s.loop = true;
        s.start(ctx.currentTime, Math.random() * b.duration);
        this.sources.push(s);
        s.connect(head);
      });
      return head;
    };
    // wind
    this.windBand = ctx.createBiquadFilter();
    this.windBand.type = 'bandpass';
    this.windBand.frequency.value = 500;
    this.windBand.Q.value = 0.9;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    loop(brown).connect(this.windBand).connect(this.wind).connect(out);
    // A slow LFO wanders the band so the wind gusts.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(this.windBand.frequency);
    lfo.start();
    this.sources.push(lfo);
    // rain
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    this.rain = ctx.createGain();
    this.rain.gain.value = 0;
    loop(white).connect(hp).connect(lp).connect(this.rain).connect(out);
    // fire: rumble bed + pops (in tick)
    const fb = ctx.createBiquadFilter();
    fb.type = 'bandpass';
    fb.frequency.value = 260;
    fb.Q.value = 0.7;
    this.fire = ctx.createGain();
    this.fire.gain.value = 0;
    const fireBed = ctx.createGain();
    fireBed.gain.value = 0.6;
    loop(brown).connect(fb).connect(fireBed).connect(this.fire).connect(out);
    // insects + water
    this.insects = ctx.createGain();
    this.insects.gain.value = 0;
    this.insects.connect(out);
    const wl = ctx.createBiquadFilter();
    wl.type = 'lowpass';
    wl.frequency.value = 380;
    this.water = ctx.createGain();
    this.water.gain.value = 0;
    loop(brown).connect(wl).connect(this.water).connect(out);
  }

  setTargets(t: AmbienceTargets): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const tc = 0.6;
    this.targets = t;
    this.wind.gain.setTargetAtTime(t.wind * 0.55, now, tc);
    this.windBand.Q.setTargetAtTime(0.9 + t.windSpeed * 1.5, now, tc);
    this.windBand.frequency.setTargetAtTime(380 + t.windSpeed * 900, now, 0.3);
    this.rain.gain.setTargetAtTime(t.rain * 0.22, now, 1.2);
    this.fire.gain.setTargetAtTime(t.fire * 0.5, now, 0.8);
    this.insects.gain.setTargetAtTime(t.insects * 0.05, now, 2);
    this.water.gain.setTargetAtTime(t.water * 0.7, now, 0.2);
  }

  /** Random events of the beds (call every frame or so). */
  tick(nowMs: number): void {
    const t = this.targets;
    if (t.fire > 0.05 && nowMs > this.crackleAt) {
      this.crackle(t.fire);
      this.crackleAt = nowMs + 40 + Math.random() * (260 / t.fire);
    }
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

  private crackle(level: number): void {
    this.burst(0.012 + Math.random() * 0.03, 'bandpass', 1500 + Math.random() * 3500, 1.5, 0.3 + Math.random() * 0.5 * level, this.fire, Math.random() * 1.6 - 0.8);
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
