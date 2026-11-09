// Seamless loop textures rendered once, off the main thread, through an
// OfflineAudioContext (no assets, a few hundred KB of PCM each): the fire
// every hearth, torch and campfire plays (rumble, hiss, crackles and pops),
// a river's flow, a lake shore's lapping, and rain drumming on a roof. A
// sample loop would repeat audibly or cost megabytes; noise through filters
// with randomly scheduled events does not. The noise sources are filled in
// slices (noiseBuffer below, WP19b: no main-thread long task); the
// render runs on the audio thread; the seam is crossfaded afterwards.

/**
 * Yields to the event loop (WP19b: buffers of ~1 M samples synthesized in one
 * go were a 70-90 ms main-thread long task on the first key press, when the
 * engine unlocks; in slices of SYNTH_SLICE samples each piece is ~1 ms).
 */
export const SYNTH_SLICE = 32768;
export const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

export async function noiseBuffer(ctx: BaseAudioContext, seconds: number, brown: boolean, channels = 2): Promise<AudioBuffer> {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
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

export type LoopFamily = 'fire' | 'flow' | 'lap' | 'roofRain';

/** Render rate: everything here lives below 12 kHz. */
const RATE = 32000;

type Offline = OfflineAudioContext;

function offlineCtor(): (new (channels: number, length: number, rate: number) => Offline) | null {
  const g = globalThis as unknown as { OfflineAudioContext?: new (c: number, l: number, r: number) => Offline; webkitOfflineAudioContext?: new (c: number, l: number, r: number) => Offline };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

function src(ctx: Offline, buf: AudioBuffer, loop = true, offset = 0): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = loop;
  s.start(0, offset);
  return s;
}

function filter(ctx: Offline, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** A short filtered noise burst at time t (crackles, pops, drops). */
function burst(ctx: Offline, white: AudioBuffer, out: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, peak: number): void {
  const s = ctx.createBufferSource();
  s.buffer = white;
  const f = filter(ctx, type, freq, q);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.0015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random() * (white.duration - dur - 0.01), dur + 0.01);
}

/** Poisson event times over [0, seconds) at `perS` per second. */
function events(seconds: number, perS: number): number[] {
  const out: number[] = [];
  for (let t = -Math.log(1 - Math.random()) / perS; t < seconds - 0.2; t += -Math.log(1 - Math.random()) / perS) out.push(t);
  return out;
}

async function build(family: LoopFamily, ctx: Offline, seconds: number): Promise<void> {
  const brown = await noiseBuffer(ctx, 4, true, 1);
  const white = await noiseBuffer(ctx, 3, false, 1);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  switch (family) {
    case 'fire': {
      // Rumble (the body of the flames), a soft hiss, crackles and a few pops.
      const rumble = ctx.createGain();
      rumble.gain.value = 0.55;
      src(ctx, brown).connect(filter(ctx, 'bandpass', 240, 0.6)).connect(rumble).connect(out);
      const hiss = ctx.createGain();
      hiss.gain.value = 0.035;
      src(ctx, white, true, 0.7).connect(filter(ctx, 'highpass', 2600)).connect(hiss).connect(out);
      for (const t of events(seconds, 14)) burst(ctx, white, out, t, 0.008 + Math.random() * 0.025, 'bandpass', 1400 + Math.random() * 4200, 1.4, 0.15 + Math.random() * 0.45);
      for (const t of events(seconds, 0.9)) burst(ctx, white, out, t, 0.03 + Math.random() * 0.04, 'bandpass', 600 + Math.random() * 900, 2, 0.5 + Math.random() * 0.4);
      break;
    }
    case 'flow': {
      // A river: broadband rush (band-passed noise) over a low rumble, with
      // a slow swell; plus bright little gurgles.
      const rush = ctx.createGain();
      rush.gain.value = 0.32;
      src(ctx, white).connect(filter(ctx, 'bandpass', 1100, 0.45)).connect(rush).connect(out);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 2 / seconds;
      const depth = ctx.createGain();
      depth.gain.value = 0.08;
      lfo.connect(depth).connect(rush.gain);
      lfo.start(0);
      const low = ctx.createGain();
      low.gain.value = 0.45;
      src(ctx, brown, true, 1.1).connect(filter(ctx, 'lowpass', 420)).connect(low).connect(out);
      for (const t of events(seconds, 9)) burst(ctx, white, out, t, 0.02 + Math.random() * 0.04, 'bandpass', 700 + Math.random() * 1800, 6, 0.06 + Math.random() * 0.08);
      break;
    }
    case 'lap': {
      // A shore: low swells (two waves per loop) with a wash of spray on each.
      const swell = ctx.createGain();
      swell.gain.value = 0;
      src(ctx, brown).connect(filter(ctx, 'lowpass', 520)).connect(swell).connect(out);
      const wash = ctx.createGain();
      wash.gain.value = 0;
      src(ctx, white, true, 0.4).connect(filter(ctx, 'bandpass', 1800, 0.6)).connect(wash).connect(out);
      const waves = 2;
      const period = seconds / waves;
      for (let k = 0; k < waves; k++) {
        const t0 = k * period;
        swell.gain.setValueAtTime(0.18, t0);
        swell.gain.linearRampToValueAtTime(0.75, t0 + period * 0.45);
        swell.gain.linearRampToValueAtTime(0.18, t0 + period);
        wash.gain.setValueAtTime(0.01, t0);
        wash.gain.linearRampToValueAtTime(0.01, t0 + period * 0.4);
        wash.gain.linearRampToValueAtTime(0.16, t0 + period * 0.55);
        wash.gain.linearRampToValueAtTime(0.01, t0 + period * 0.95);
      }
      break;
    }
    case 'roofRain': {
      // Rain on a roof: dense dull taps (wood, thatch) over a low drumming
      // bed, and the odd drip off the eaves.
      const bed = ctx.createGain();
      bed.gain.value = 0.3;
      src(ctx, brown).connect(filter(ctx, 'bandpass', 520, 0.8)).connect(bed).connect(out);
      for (const t of events(seconds, 90)) burst(ctx, white, out, t, 0.006 + Math.random() * 0.012, 'bandpass', 380 + Math.random() * 900, 3, 0.04 + Math.random() * 0.1);
      for (const t of events(seconds, 1.2)) burst(ctx, white, out, t, 0.02, 'bandpass', 1800 + Math.random() * 1500, 8, 0.12);
      break;
    }
  }
}

/** Crossfade the last `fadeS` into the head so the loop has no seam; drop that tail. */
async function seamless(b: AudioBuffer, fadeS: number, make: (len: number) => AudioBuffer): Promise<AudioBuffer> {
  const fade = Math.floor(fadeS * b.sampleRate);
  const len = b.length - fade;
  const outBuf = make(len);
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    const o = outBuf.getChannelData(ch);
    o.set(d.subarray(0, len));
    for (let i = 0; i < fade; i++) {
      if (i % SYNTH_SLICE === SYNTH_SLICE - 1) await yieldToLoop();
      const a = i / fade;
      o[i] = d[i] * a + d[len + i] * (1 - a);
    }
  }
  return outBuf;
}

/** Render one loop texture into a buffer of `ctx` (null where offline rendering is unavailable). */
export async function renderLoop(ctx: BaseAudioContext, family: LoopFamily, seconds = family === 'lap' ? 9 : 6): Promise<AudioBuffer | null> {
  const Ctor = offlineCtor();
  if (!Ctor) return null;
  try {
    const fade = 0.5;
    const off = new Ctor(1, Math.floor((seconds + fade) * RATE), RATE);
    await build(family, off, seconds + fade);
    const rendered = await off.startRendering();
    return await seamless(rendered, fade, (len) => ctx.createBuffer(1, len, RATE));
  } catch {
    return null;
  }
}
