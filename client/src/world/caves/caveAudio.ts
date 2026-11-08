// Minimal cave audio (WP09, spec 7: "Audio switches to a reverb bus sized
// by the current chamber's radius from the graph"). The client has no audio
// pipeline yet (wizard-wars' AudioManager/soundManifest port is a later
// package), so this is a tiny self-contained WebAudio graph:
//
//   sources -> dry gain ------------------------------> master
//           -> wet send -> convolver (cave IR) -> wet -> master
//
// The impulse response is synthesized (decaying filtered noise) with a
// length that grows with the chamber radius: a 5 m tunnel rings ~0.6 s, a
// 12 m chamber ~1.8 s. Underground the wet send fades in; on the surface it
// is silent. Sounds are synthesized too (pickaxe tick, break crunch, pickup
// chime, water drips) so no assets are needed.
//
// adapted from wizard-wars client/src/audio/AudioManager.ts (one context,
// created lazily on first user gesture; a missing AudioContext is a silent
// no-op, never an error).

export class CaveAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private send!: GainNode;
  private wet!: GainNode;
  private conv!: ConvolverNode;
  private irRadius = 0;
  private underground = 0;
  private dripAt = 0;

  /** Must be called from a user gesture at least once (browsers' autoplay rule). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(ctx.destination);
      this.dry = ctx.createGain();
      this.dry.connect(this.master);
      this.send = ctx.createGain();
      this.send.gain.value = 0;
      this.conv = ctx.createConvolver();
      this.wet = ctx.createGain();
      this.wet.gain.value = 0.9;
      this.send.connect(this.conv);
      this.conv.connect(this.wet);
      this.wet.connect(this.master);
      this.setChamberRadius(8);
    } catch {
      this.ctx = null;
    }
  }

  get ready(): boolean {
    return this.ctx !== null;
  }

  /** Reverb tail for a space of this radius (m). Rebuilt only on a noticeable change. */
  setChamberRadius(r: number): void {
    if (!this.ctx) return;
    const rr = Math.max(2, Math.min(16, r));
    if (Math.abs(rr - this.irRadius) < 1.5) return;
    this.irRadius = rr;
    const ctx = this.ctx;
    const seconds = 0.35 + rr * 0.12;
    const len = Math.floor(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Darker as it decays (stone absorbs highs): one-pole low-pass on noise.
        lp += (Math.random() * 2 - 1 - lp) * (0.55 - 0.45 * t);
        d[i] = lp * Math.pow(1 - t, 2.2 + 6 / rr);
      }
    }
    this.conv.buffer = ir;
  }

  /** 0 on the surface, 1 deep underground (eased by the caller). */
  setUnderground(u: number, now: number): void {
    this.underground = u;
    if (!this.ctx) return;
    this.send.gain.setTargetAtTime(u * 0.85, this.ctx.currentTime, 0.25);
    this.dry.gain.setTargetAtTime(1 - u * 0.35, this.ctx.currentTime, 0.25);
    if (u > 0.6 && now > this.dripAt) {
      this.drip();
      this.dripAt = now + 1500 + Math.random() * 5000;
    }
  }

  private out(): AudioNode[] {
    return [this.dry, this.send];
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private noiseBurst(seconds: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource();
    s.buffer = b;
    return s;
  }

  /** Pickaxe on stone (gems ring higher). */
  hit(gem: boolean): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = this.noiseBurst(0.08);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = gem ? 3200 : 1800;
    bp.Q.value = 3;
    const g = ctx.createGain();
    this.env(g, t, 0.9, 0.002, 0.09);
    n.connect(bp).connect(g);
    const o = ctx.createOscillator();
    o.frequency.value = gem ? 2400 + Math.random() * 400 : 900 + Math.random() * 200;
    const og = ctx.createGain();
    this.env(og, t, gem ? 0.25 : 0.12, 0.001, gem ? 0.35 : 0.12);
    o.connect(og);
    for (const d of this.out()) {
      g.connect(d);
      og.connect(d);
    }
    n.start(t);
    o.start(t);
    o.stop(t + 0.5);
  }

  /** The vein gives way. */
  crumble(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = this.noiseBurst(0.6);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2500, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.6);
    const g = ctx.createGain();
    this.env(g, t, 1, 0.005, 0.6);
    n.connect(lp).connect(g);
    for (const d of this.out()) g.connect(d);
    n.start(t);
  }

  /** Item picked up: two-note chime. */
  chime(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      this.env(g, t + i * 0.09, 0.2, 0.005, 0.5);
      o.connect(g);
      for (const d of this.out()) g.connect(d);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.6);
    });
  }

  private drip(): void {
    if (!this.ctx || this.underground < 0.5) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1600 + Math.random() * 900, t);
    o.frequency.exponentialRampToValueAtTime(500, t + 0.07);
    const g = ctx.createGain();
    this.env(g, t, 0.05, 0.002, 0.09);
    o.connect(g);
    g.connect(this.send);
    o.start(t);
    o.stop(t + 0.12);
  }
}
