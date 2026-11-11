// Seamless loop textures rendered once, off the main thread, through an
// OfflineAudioContext (no assets; 0.8-1.2 MB of PCM each): the fire
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

export type LoopFamily = 'fire' | 'flow' | 'lap' | 'roofRain' | HumFamily;

/**
 * Playtest 2 ground loot: the hum of an item lying on the ground (ui/
 * inventory/ground/hum.ts picks one by item type; the rarity sets its
 * pitch, level and reach). Tonal, 4 s loops whose every frequency is a
 * multiple of 1/4 Hz, so the seam crossfade is phase-clean.
 */
export type HumFamily = 'humPlain' | 'humMetal' | 'humChime' | 'humWhisper' | 'humHolo';
export const HUM_FAMILIES: readonly HumFamily[] = ['humPlain', 'humMetal', 'humChime', 'humWhisper', 'humHolo'];

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

/** A sine partial at `freq` and `level`, its amplitude breathing at `lfoHz` by `depth` (0..1). */
function partial(ctx: Offline, out: AudioNode, freq: number, level: number, lfoHz = 0, depth = 0, type: OscillatorType = 'sine'): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = level * (1 - depth / 2);
  if (lfoHz > 0 && depth > 0) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = lfoHz;
    const d = ctx.createGain();
    d.gain.value = (level * depth) / 2;
    lfo.connect(d).connect(g.gain);
    lfo.start(0);
  }
  o.connect(g).connect(out);
  o.start(0);
}

/** A struck partial set (a ting or a chime) at time t: each partial decays on its own. */
function strike(ctx: Offline, out: AudioNode, t: number, freqs: readonly number[], peak: number, decay: number): void {
  freqs.forEach((f, i) => {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const g = ctx.createGain();
    const p = peak / (1 + i * 0.8);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(p, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay / (1 + i * 0.6));
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + decay + 0.05);
  });
}

function buildHum(family: HumFamily, ctx: Offline, out: AudioNode, white: AudioBuffer, seconds: number): void {
  const q = (hz: number) => Math.round(hz * 4) / 4; // a whole number of cycles per 4 s loop
  switch (family) {
    case 'humPlain': {
      // A warm drone: fundamental, octave and fifth, slowly breathing, a breath of air on top.
      partial(ctx, out, q(110), 0.42, 0.5, 0.35);
      partial(ctx, out, q(220), 0.2, 0.75, 0.5);
      partial(ctx, out, q(330), 0.08, 0.25, 0.6);
      const air = ctx.createGain();
      air.gain.value = 0.025;
      src(ctx, white).connect(filter(ctx, 'bandpass', 1800, 2)).connect(air).connect(out);
      break;
    }
    case 'humMetal': {
      // A blade singing: inharmonic bar partials (1, 2.76, 5.40) beating slowly
      // against detuned twins, and a soft ting now and then.
      const f = 196;
      for (const [r, l] of [
        [1, 0.3],
        [2.76, 0.16],
        [5.4, 0.07],
      ] as const) {
        partial(ctx, out, q(f * r), l, 0.25, 0.4);
        partial(ctx, out, q(f * r) + 0.75, l * 0.7, 0.5, 0.3);
      }
      for (let t = 0.6; t < seconds - 0.6; t += 1.9) strike(ctx, out, t, [q(f * 2.76 * 2), q(f * 5.4 * 2)], 0.12, 1.6);
      break;
    }
    case 'humChime': {
      // A gem: a faint glassy pad and soft chimes on a pentatonic.
      partial(ctx, out, q(523.25), 0.07, 0.5, 0.6);
      partial(ctx, out, q(784), 0.05, 0.75, 0.6);
      const notes = [1046.5, 1174.7, 1568, 1318.5];
      notes.forEach((n, i) => strike(ctx, out, 0.3 + i * 0.95, [q(n), q(n * 2.01), q(n * 3.03)], 0.2, 1.8));
      break;
    }
    case 'humWhisper': {
      // A tome: breathy noise through two drifting formants, a low murmur under it.
      for (const [hz, lfo] of [
        [700, 0.25],
        [1500, 0.5],
      ] as const) {
        const g = ctx.createGain();
        g.gain.value = 0.0;
        const bp = filter(ctx, 'bandpass', hz, 5);
        const sweep = ctx.createOscillator();
        sweep.frequency.value = lfo;
        const sd = ctx.createGain();
        sd.gain.value = hz * 0.35;
        sweep.connect(sd).connect(bp.frequency);
        sweep.start(0);
        const amp = ctx.createOscillator();
        amp.frequency.value = lfo * 3;
        const ad = ctx.createGain();
        ad.gain.value = 0.11;
        amp.connect(ad).connect(g.gain);
        amp.start(0);
        src(ctx, white, true, hz / 1000).connect(bp).connect(g).connect(out);
      }
      partial(ctx, out, q(98), 0.12, 0.25, 0.7);
      break;
    }
    case 'humHolo': {
      // Bitchin': a shimmering major chord with a slow sparkle arpeggio.
      for (const [hz, l] of [
        [261.5, 0.12],
        [329.75, 0.1],
        [392, 0.1],
        [523.25, 0.07],
      ] as const) {
        partial(ctx, out, q(hz), l, 0.5, 0.5, 'triangle');
        partial(ctx, out, q(hz) + 0.5, l * 0.6, 0.75, 0.5, 'triangle');
      }
      const arp = [1046.5, 1318.5, 1568, 2093];
      for (let i = 0; i < 8; i++) strike(ctx, out, 0.2 + i * 0.47, [q(arp[i % 4])], 0.08, 0.9);
      break;
    }
  }
}

async function build(family: LoopFamily, ctx: Offline, seconds: number): Promise<void> {
  const brown = await noiseBuffer(ctx, 4, true, 1);
  const white = await noiseBuffer(ctx, 3, false, 1);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  if ((HUM_FAMILIES as readonly string[]).includes(family)) {
    buildHum(family as HumFamily, ctx, out, white, seconds);
    return;
  }
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
export async function renderLoop(ctx: BaseAudioContext, family: LoopFamily, seconds = family === 'lap' ? 9 : family.startsWith('hum') ? 4 : 6): Promise<AudioBuffer | null> {
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
