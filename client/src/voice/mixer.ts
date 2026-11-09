// The proximity-voice audio graph (spec 10 "Proximity voice" 3): one
// AudioContext for every voice (the-circle audio.ts rule), and per speaker
//
//   source ─┬─ analyser                                   (speaking indicator, pre-gain)
//           └─ gain (volume, mute) ─ low-pass (occlusion) ─┬─ spatial gain ─ PannerNode HRTF ─┐
//                                                          └─ radio gain ─ band-pass ─ drive ─┼─ master ─ destination
//                                                             (cave reverb send: WP09)        │
//                                                                                              └─ (L/R meters, debug)
//
// One published track per speaker covers both cases: within earshot the
// spatial branch is open, a party member beyond earshot crossfades to the
// radio branch (spec 10 "Proximity voice" 2). The mixer is fed positions
// every frame by the runtime; it never decides who is subscribed.

import { VOICE_MAX_DISTANCE_M, VOICE_REF_DISTANCE_M } from '@lodestone/contracts';
import { voiceLevels } from './levels';
import { voiceDestination } from '../audio/context';
import { inverseDistanceGain, listenerAxes, OCCLUSION_MUFFLED_HZ, OCCLUSION_OPEN_HZ, relativeToListener, type Vec3, type VoiceMode } from './spatial';

/** What the runtime tells the mixer about one speaker each frame. */
export interface SpeakerFrame {
  mode: VoiceMode;
  /** Head position (spatial mode). */
  pos: Vec3 | null;
  occluded: boolean;
}

interface Chain {
  id: string;
  name: string;
  el: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  gain: GainNode;
  lowpass: BiquadFilterNode;
  spatialGain: GainNode;
  panner: PannerNode;
  radioGain: GainNode;
  radioIn: BiquadFilterNode;
  frame: SpeakerFrame;
  distance: number | null;
}

// Parameter smoothing: positions follow within a frame or two (no zipper
// noise from per-frame jumps), the radio crossfade and occlusion take
// ~100-150 ms so they read as a change in the world, not a click.
const POS_TC = 0.02;
const MODE_TC = 0.1;
const OCCL_TC = 0.15;
// Occluded voices also lose a little level (-4 dB) on top of the low-pass.
const OCCLUDED_GAIN = 0.63;

export interface MixerDebug {
  name: string;
  id: string;
  mode: VoiceMode;
  pos: Vec3 | null;
  distance: number | null;
  rel: { right: number; up: number; forward: number } | null;
  /** The inverse-distance gain the panner applies at this distance (spatial mode). */
  distanceGain: number;
  volume: number;
  muted: boolean;
  occluded: boolean;
  lowpassHz: number;
  spatialGain: number;
  radioGain: number;
  /** Speaker's own level 0-1 (pre-gain analyser). */
  level: number;
}

export class VoiceMixer {
  readonly ctx: AudioContext;
  private master: GainNode;
  private chains = new Map<string, Chain>();
  private splitter: ChannelSplitterNode;
  private meters: [AnalyserNode, AnalyserNode];
  private meterBuf = new Float32Array(1024);
  private listener = { pos: { x: 0, y: 0, z: 0 } as Vec3, yaw: 0, pitch: 0 };
  /** Per-player volume (0-2) and mute, by character name. */
  private volumes = new Map<string, number>();
  private mutes = new Set<string>();
  private masterVolume = 1;

  /** False when the game's shared context was passed in (client/src/audio): never close it. */
  private readonly ownsCtx: boolean;

  constructor(ctx?: AudioContext) {
    this.ownsCtx = !ctx;
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    // Through the game mixer's voice bus when sharing its context (volume slider, master mute).
    this.master.connect(voiceDestination(this.ctx));
    // Output meters (left/right RMS of everything we play): the two-browser
    // test reads them to prove fade and pan from what actually comes out.
    this.splitter = this.ctx.createChannelSplitter(2);
    this.master.connect(this.splitter);
    const l = this.ctx.createAnalyser();
    const r = this.ctx.createAnalyser();
    l.fftSize = r.fftSize = 1024;
    this.splitter.connect(l, 0);
    this.splitter.connect(r, 1);
    this.meters = [l, r];
  }

  /** Browsers start contexts suspended until a user gesture (V is one). */
  resume(): void {
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  has(id: string): boolean {
    return this.chains.has(id);
  }

  /** Start playing a subscribed speaker's track. */
  add(id: string, name: string, track: MediaStreamTrack): void {
    this.remove(id);
    const ctx = this.ctx;
    const stream = new MediaStream([track]);
    // Chrome only pulls remote WebRTC audio into Web Audio while the stream
    // is also attached to a media element; it stays muted (the graph plays it).
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const gain = ctx.createGain();
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = OCCLUSION_OPEN_HZ;
    lowpass.Q.value = 0.5;
    source.connect(gain).connect(lowpass);

    const spatialGain = ctx.createGain();
    const panner = new PannerNode(ctx, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: VOICE_REF_DISTANCE_M,
      maxDistance: VOICE_MAX_DISTANCE_M,
      rolloffFactor: 1,
      coneInnerAngle: 360,
      coneOuterAngle: 360,
    });
    lowpass.connect(spatialGain).connect(panner).connect(this.master);

    // Party radio: a telephone band (300 Hz - 3 kHz) with a little drive, so
    // a far party member is clearly "on the radio", not someone nearby.
    const radioGain = ctx.createGain();
    radioGain.gain.value = 0;
    const radioIn = ctx.createBiquadFilter();
    radioIn.type = 'highpass';
    radioIn.frequency.value = 300;
    const radioLow = ctx.createBiquadFilter();
    radioLow.type = 'lowpass';
    radioLow.frequency.value = 3000;
    const drive = ctx.createWaveShaper();
    drive.curve = driveCurve(2.5);
    const radioOut = ctx.createGain();
    radioOut.gain.value = 0.7;
    lowpass.connect(radioGain).connect(radioIn).connect(radioLow).connect(drive).connect(radioOut).connect(this.master);

    const c: Chain = { id, name, el, source, analyser, gain, lowpass, spatialGain, panner, radioGain, radioIn, frame: { mode: 'spatial', pos: null, occluded: false }, distance: null };
    this.chains.set(id, c);
    this.applyVolume(c);
    voiceLevels.attach(name, analyser);
  }

  remove(id: string): void {
    const c = this.chains.get(id);
    if (!c) return;
    this.chains.delete(id);
    voiceLevels.detach(c.name);
    try {
      c.source.disconnect();
      c.gain.disconnect();
      c.lowpass.disconnect();
      c.spatialGain.disconnect();
      c.panner.disconnect();
      c.radioGain.disconnect();
    } catch {
      // already disconnected
    }
    c.el.srcObject = null;
  }

  ids(): string[] {
    return [...this.chains.keys()];
  }

  setListener(feetHead: Vec3, yaw: number, pitch: number): void {
    this.listener = { pos: feetHead, yaw, pitch };
    const L = this.ctx.listener;
    const t = this.ctx.currentTime;
    const { forward, up } = listenerAxes(yaw, pitch);
    if (L.positionX) {
      L.positionX.setTargetAtTime(feetHead.x, t, POS_TC);
      L.positionY.setTargetAtTime(feetHead.y, t, POS_TC);
      L.positionZ.setTargetAtTime(feetHead.z, t, POS_TC);
      L.forwardX.setTargetAtTime(forward.x, t, POS_TC);
      L.forwardY.setTargetAtTime(forward.y, t, POS_TC);
      L.forwardZ.setTargetAtTime(forward.z, t, POS_TC);
      L.upX.setTargetAtTime(up.x, t, POS_TC);
      L.upY.setTargetAtTime(up.y, t, POS_TC);
      L.upZ.setTargetAtTime(up.z, t, POS_TC);
    } else {
      // Firefox before AudioParam listeners.
      L.setPosition(feetHead.x, feetHead.y, feetHead.z);
      L.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /** Position, mode and occlusion for one speaker (call every frame). */
  update(id: string, f: SpeakerFrame): void {
    const c = this.chains.get(id);
    if (!c) return;
    const t = this.ctx.currentTime;
    const prev = c.frame;
    c.frame = f;
    let pos = f.pos;
    if (f.mode === 'flat' || f.mode === 'radio' || !pos) {
      // Flat and radio voices sit on the listener at the reference distance
      // ahead: no pan, no distance loss (the radio branch carries them).
      const { forward } = listenerAxes(this.listener.yaw, this.listener.pitch);
      const lp = this.listener.pos;
      pos = { x: lp.x + forward.x * VOICE_REF_DISTANCE_M, y: lp.y + forward.y * VOICE_REF_DISTANCE_M, z: lp.z + forward.z * VOICE_REF_DISTANCE_M };
    }
    const p = c.panner;
    if (p.positionX) {
      p.positionX.setTargetAtTime(pos.x, t, POS_TC);
      p.positionY.setTargetAtTime(pos.y, t, POS_TC);
      p.positionZ.setTargetAtTime(pos.z, t, POS_TC);
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    const lp = this.listener.pos;
    c.distance = f.pos ? Math.hypot(f.pos.x - lp.x, f.pos.y - lp.y, f.pos.z - lp.z) : null;
    if (prev.mode !== f.mode) {
      // (A new chain starts spatial: spatial gain 1, radio gain 0.)
      c.spatialGain.gain.setTargetAtTime(f.mode === 'radio' ? 0 : 1, t, MODE_TC);
      c.radioGain.gain.setTargetAtTime(f.mode === 'radio' ? 1 : 0, t, MODE_TC);
    }
    if (prev.occluded !== f.occluded) {
      c.lowpass.frequency.setTargetAtTime(f.occluded ? OCCLUSION_MUFFLED_HZ : OCCLUSION_OPEN_HZ, t, OCCL_TC);
      this.applyVolume(c);
    }
  }

  setVolume(name: string, v: number): void {
    this.volumes.set(name, v);
    for (const c of this.chains.values()) if (c.name === name) this.applyVolume(c);
  }

  setMuted(name: string, muted: boolean): void {
    if (muted) this.mutes.add(name);
    else this.mutes.delete(name);
    for (const c of this.chains.values()) if (c.name === name) this.applyVolume(c);
  }

  setMasterVolume(v: number): void {
    this.masterVolume = v;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  private applyVolume(c: Chain): void {
    const v = this.mutes.has(c.name) ? 0 : (this.volumes.get(c.name) ?? 1) * (c.frame.occluded ? OCCLUDED_GAIN : 1);
    c.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  /** RMS of what we output, left and right, in dBFS. */
  outputLevels(): { leftDb: number; rightDb: number } {
    const db = (a: AnalyserNode) => {
      a.getFloatTimeDomainData(this.meterBuf);
      let s = 0;
      for (let i = 0; i < this.meterBuf.length; i++) s += this.meterBuf[i] * this.meterBuf[i];
      const rms = Math.sqrt(s / this.meterBuf.length);
      return rms > 0 ? 20 * Math.log10(rms) : -120;
    };
    return { leftDb: db(this.meters[0]), rightDb: db(this.meters[1]) };
  }

  debug(): MixerDebug[] {
    const out: MixerDebug[] = [];
    const L = this.listener;
    for (const c of this.chains.values()) {
      const f = c.frame;
      out.push({
        name: c.name,
        id: c.id,
        mode: f.mode,
        pos: f.pos,
        distance: c.distance,
        rel: f.pos ? relativeToListener(L.pos, L.yaw, L.pitch, f.pos) : null,
        distanceGain: f.mode === 'spatial' && c.distance !== null ? inverseDistanceGain(c.distance) : 1,
        volume: c.gain.gain.value,
        muted: this.mutes.has(c.name),
        occluded: f.occluded,
        lowpassHz: Math.round(c.lowpass.frequency.value),
        spatialGain: c.spatialGain.gain.value,
        radioGain: c.radioGain.gain.value,
        level: voiceLevels.level(c.name),
      });
    }
    return out;
  }

  get volume(): number {
    return this.masterVolume;
  }

  close(): void {
    for (const id of [...this.chains.keys()]) this.remove(id);
    if (this.ownsCtx) this.ctx.close().catch(() => {});
    else this.master.disconnect();
  }
}

/** Soft-clip curve (tanh) for the radio's drive stage. */
function driveCurve(k: number): Float32Array {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}
