// Playtest 2 voice settings: the mic test. Its own microphone capture with
// the saved device, boost and browser processing (independent of the voice
// server, so it works offline and before the first push to talk):
//
//   mic ─ source ─ gain (boost) ─┬─ analyser                         (level meter)
//                                ├─ delay ─ loop gain ─ voice bus     (hear yourself, optional delay)
//                                └─ MediaStreamDestination ─ MediaRecorder (record and play back)
//
// The loopback goes through the game's voice bus (Sound > Voice chat volume).

import { getAudioContext, voiceDestination } from '../audio/context';
import { audioConstraints, micProblem, type MicProblem } from './devices';
import { recordVoiceError } from './diag';
import { dbToGain } from './vad';

export interface MicTestOptions {
  deviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  gainDb: number;
}

export class MicTestError extends Error {
  constructor(
    readonly problem: MicProblem,
    cause: unknown,
  ) {
    super((cause as Error)?.message ?? String(cause));
  }
}

export class MicTest {
  readonly analyser: AnalyserNode;
  private gain: GainNode;
  private delay: DelayNode;
  private loopGain: GainNode;
  private recDest: MediaStreamAudioDestinationNode;
  private source: MediaStreamAudioSourceNode;
  private recorder: MediaRecorder | null = null;
  private playback: HTMLAudioElement | null = null;
  private stopped = false;

  private constructor(
    readonly ctx: AudioContext,
    private readonly ownsCtx: boolean,
    readonly stream: MediaStream,
    gainDb: number,
  ) {
    this.source = ctx.createMediaStreamSource(stream);
    this.gain = ctx.createGain();
    this.gain.gain.value = dbToGain(gainDb);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.delay = ctx.createDelay(2.5);
    this.loopGain = ctx.createGain();
    this.loopGain.gain.value = 0;
    this.recDest = ctx.createMediaStreamDestination();
    this.source.connect(this.gain);
    this.gain.connect(this.analyser);
    this.gain.connect(this.delay).connect(this.loopGain).connect(voiceDestination(ctx));
    this.gain.connect(this.recDest);
  }

  /** Opens the microphone (the browser may ask for permission now). Throws MicTestError. */
  static async start(o: MicTestOptions): Promise<MicTest> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(o) });
    } catch (e) {
      recordVoiceError('mic test', e);
      throw new MicTestError(micProblem(e), e);
    }
    const shared = getAudioContext();
    const ctx = shared ?? new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    return new MicTest(ctx, !shared, stream, o.gainDb);
  }

  get track(): MediaStreamTrack | undefined {
    return this.stream.getAudioTracks()[0];
  }

  setGainDb(db: number): void {
    this.gain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.03);
  }

  /** Hear yourself (headphones!) after `delayMs`. */
  setLoopback(on: boolean, delayMs: number): void {
    const t = this.ctx.currentTime;
    this.delay.delayTime.setTargetAtTime(Math.max(0, Math.min(2.4, delayMs / 1000)), t, 0.02);
    this.loopGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.02);
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  /** Records `ms` of what the microphone sends (after the boost). */
  record(ms: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (typeof MediaRecorder === 'undefined') return reject(new Error('this browser cannot record audio'));
      const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
      const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t));
      const rec = new MediaRecorder(this.recDest.stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onerror = (e) => reject((e as unknown as { error?: Error }).error ?? new Error('recording failed'));
      rec.onstop = () => {
        this.recorder = null;
        resolve(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' }));
      };
      this.recorder = rec;
      rec.start();
      setTimeout(() => rec.state === 'recording' && rec.stop(), ms);
    });
  }

  /** Plays a recording on the chosen speakers; resolves when it ends. */
  play(blob: Blob, sinkId: string, volume = 1): Promise<void> {
    this.stopPlayback();
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    el.volume = Math.max(0, Math.min(1, volume));
    this.playback = el;
    const setSink = (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    return (sinkId && setSink ? setSink.call(el, sinkId).catch(() => {}) : Promise.resolve()).then(
      () =>
        new Promise<void>((resolve) => {
          const done = () => {
            URL.revokeObjectURL(url);
            if (this.playback === el) this.playback = null;
            resolve();
          };
          el.onended = done;
          el.onerror = done;
          el.play().catch(done);
        }),
    );
  }

  stopPlayback(): void {
    if (!this.playback) return;
    this.playback.pause();
    this.playback.onended?.(new Event('ended'));
    this.playback = null;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stopPlayback();
    try {
      this.source.disconnect();
      this.gain.disconnect();
      this.loopGain.disconnect();
    } catch {
      /* already */
    }
    for (const t of this.stream.getTracks()) t.stop();
    if (this.ownsCtx) void this.ctx.close().catch(() => {});
  }
}
