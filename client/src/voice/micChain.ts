// Playtest 2 voice settings: the microphone's send path. A LiveKit audio
// processor (LocalAudioTrack.setProcessor) puts the input boost between the
// microphone and the sender:
//
//   raw mic ─ source ─ gain (boost) ─ MediaStreamDestination ─> processedTrack (what LiveKit sends)
//   raw mic clone ─ source ─ gain (same boost) ─ analyser      (meter, open-mic gate, speaking bit)
//
// The meter listens to a clone because LiveKit's mute disables the raw
// track, and the open-mic gate must still hear the room while muted. A
// device switch (restartTrack) calls restart() with the new raw track: the
// sources are rebuilt, the destination (and so the sent track) stays.

import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { dbToGain } from './vad';

export class MicChain implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'lodestone-mic-boost';
  processedTrack?: MediaStreamTrack;
  readonly analyser: AnalyserNode;
  /** The microphone track as captured (its settings: device, sample rate, processing). */
  raw: MediaStreamTrack | null = null;
  /** False when only the meter runs (the processor was refused): the boost is not sent. */
  sending = false;
  private gain: GainNode;
  private meterGain: GainNode;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private sendSrc: MediaStreamAudioSourceNode | null = null;
  private meterSrc: MediaStreamAudioSourceNode | null = null;
  private meterTrack: MediaStreamTrack | null = null;

  constructor(
    readonly ctx: AudioContext,
    gainDb: number,
  ) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.gain = ctx.createGain();
    this.meterGain = ctx.createGain();
    this.gain.gain.value = this.meterGain.gain.value = dbToGain(gainDb);
    this.meterGain.connect(this.analyser);
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = 1;
    this.gain.connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
    this.sending = true;
    this.attach(opts.track);
  }

  async restart(opts: { track: MediaStreamTrack }): Promise<void> {
    this.attach(opts.track);
  }

  async destroy(): Promise<void> {
    this.detach();
    try {
      this.gain.disconnect();
    } catch {
      /* not connected */
    }
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.dest = null;
    this.sending = false;
  }

  /** Meter only (the processor was refused): the boost then shows on the meter but is not sent. */
  meterOnly(raw: MediaStreamTrack): void {
    this.sending = false;
    this.attach(raw, false);
  }

  /** (Re)connects the sources to a new raw track. */
  private attach(raw: MediaStreamTrack, send = true): void {
    this.detach();
    this.raw = raw;
    if (send && this.dest) {
      this.sendSrc = this.ctx.createMediaStreamSource(new MediaStream([raw]));
      this.sendSrc.connect(this.gain);
    }
    const clone = raw.clone();
    clone.enabled = true;
    this.meterTrack = clone;
    this.meterSrc = this.ctx.createMediaStreamSource(new MediaStream([clone]));
    this.meterSrc.connect(this.meterGain);
  }

  private detach(): void {
    try {
      this.sendSrc?.disconnect();
      this.meterSrc?.disconnect();
    } catch {
      /* already */
    }
    this.meterTrack?.stop();
    this.sendSrc = this.meterSrc = null;
    this.meterTrack = null;
  }

  /**
   * Lets go of the meter's clone before the microphone is re-acquired: a
   * live clone keeps the capture source open, and Chrome then hands the new
   * capture the old processing (noise suppression stayed on). restart()
   * builds a new clone; reattach() restores it if the restart failed.
   */
  releaseClone(): void {
    try {
      this.meterSrc?.disconnect();
    } catch {
      /* already */
    }
    this.meterTrack?.stop();
    this.meterSrc = null;
    this.meterTrack = null;
  }

  reattach(): void {
    if (this.meterTrack || !this.raw || this.raw.readyState === 'ended') return;
    this.attach(this.raw, this.sending);
  }

  setGainDb(db: number): void {
    const g = dbToGain(db);
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(g, t, 0.03);
    this.meterGain.gain.setTargetAtTime(g, t, 0.03);
  }

  /** Stops everything (the meter-only case has no LiveKit destroy call). */
  close(): void {
    void this.destroy();
    try {
      this.meterGain.disconnect();
    } catch {
      /* already */
    }
  }
}
