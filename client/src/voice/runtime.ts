// The browser's proximity-voice session (spec 10, WP11): LiveKit with
// auto-subscribe off (the server decides who hears whom from the zone's
// earshot sets), the spatial mixer fed from interpolated remote positions
// every frame, push-to-talk on V, and the speaking bit for the zone.
//
//   startVoice() once the social socket is up  ->  voice_token  ->  Room.connect
//   TrackSubscribed / TrackUnsubscribed        ->  mixer.add / remove
//   rAF: localPlayer + drawnRemotes.views      ->  listener, panner positions, radio vs spatial
//   4 Hz per speaker                           ->  terrain occlusion low-pass
//   V down/up                                  ->  TalkController -> mic publish (first push) / unmute / mute

import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { InputFlag } from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';
import { localPlayer } from '../state/live';
import { drawnRemotes } from '../net/netStore';
import { voiceDebugHook } from './debugHook';
import { SELF, voiceLevels } from './levels';
import { VoiceMixer } from './mixer';
import { chooseMode, headOf, terrainBetween, type Vec3 } from './spatial';
import { useVoiceStore, type SpeakerInfo, type TalkMode } from './store';
import { TalkController } from './talk';

export interface VoiceToken {
  url: string;
  token: string;
}

export interface StartVoiceOptions {
  /** Ask the social service for a LiveKit token (voice_token). */
  requestToken: () => Promise<VoiceToken>;
  /** Local profiles (and moderator-muted players) hear but never transmit. */
  listenOnly: () => boolean;
  /** Character ids of my party members (radio when beyond earshot). */
  partyIds: () => string[];
  ground: GroundQuery;
  /** Test hook: capture options for the mic (headless runs disable processing). */
  rawMic?: boolean;
}

const OCCLUSION_EVERY_MS = 250; // 4 Hz per speaker (spec 10)
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

class VoiceRuntime {
  private room: Room | null = null;
  mixer: VoiceMixer | null = null;
  talk: TalkController;
  private names = new Map<string, string>(); // identity -> name
  private occl = new Map<string, { at: number; occluded: boolean }>();
  private raf = 0;
  private stopped = false;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private selfMeter: { track: MediaStreamTrack; source: MediaStreamAudioSourceNode; analyser: AnalyserNode } | null = null;
  private lastSpeakersAt = 0;
  private lastGateAt = 0;
  private keyDown = (e: KeyboardEvent) => this.onKey(e, true);
  private keyUp = (e: KeyboardEvent) => this.onKey(e, false);
  private blur = () => this.talk.release();

  constructor(private readonly opts: StartVoiceOptions) {
    this.talk = this.makeTalk();
  }

  private makeTalk(): TalkController {
    return new TalkController(
      { acquire: () => this.acquireMic(), setLive: (live) => this.setMicLive(live) },
      (s) => useVoiceStore.getState().set({ mic: s.mic, transmitting: s.transmitting }),
      () => !this.opts.listenOnly() && this.room !== null,
      useVoiceStore.getState().talkMode,
    );
  }

  start(): void {
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.blur);
    useVoiceStore.getState().set({ status: 'connecting', statusText: 'Connecting voice…', listenOnly: this.opts.listenOnly() });
    void this.connect();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.blur);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    cancelAnimationFrame(this.raf);
    void this.room?.disconnect();
    this.room = null;
    this.dropSelfMeter();
    this.mixer?.close();
    this.mixer = null;
    useVoiceStore.getState().set({ status: 'off', statusText: '', transmitting: false, speakers: [], mic: 'idle' });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let tok: VoiceToken;
    try {
      tok = await this.opts.requestToken();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not available/i.test(msg)) {
        // The server has voice switched off: don't keep asking.
        useVoiceStore.getState().set({ status: 'unavailable', statusText: msg });
        return;
      }
      this.scheduleRetry(msg);
      return;
    }
    if (this.stopped) return;
    if (!this.mixer) this.mixer = new VoiceMixer();
    this.applyPrefs();
    const room = new Room({
      // Audio only: no simulcast/dynacast decisions to make, and the server
      // (not the client) chooses subscriptions.
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: this.opts.rawMic
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      publishDefaults: { dtx: true, red: true },
    });
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => this.onSubscribed(track, p))
      .on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => this.onUnsubscribed(p.identity))
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => this.onUnsubscribed(p.identity))
      .on(RoomEvent.Reconnecting, () => useVoiceStore.getState().set({ status: 'reconnecting', statusText: 'Voice reconnecting…' }))
      .on(RoomEvent.Reconnected, () => useVoiceStore.getState().set({ status: 'connected', statusText: '' }))
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room || this.stopped) return;
        this.room = null;
        for (const id of this.mixer?.ids() ?? []) this.onUnsubscribed(id);
        this.dropSelfMeter();
        useVoiceStore.getState().set({ transmitting: false, mic: 'idle' });
        this.talk = this.makeTalk(); // the old room's mic publication is gone
        this.scheduleRetry('Voice disconnected');
      });
    try {
      // autoSubscribe off: subscriptions come only from the server's
      // earshot reconcile (spec 10 "Proximity voice" 1).
      await room.connect(tok.url, tok.token, { autoSubscribe: false });
    } catch (e) {
      this.scheduleRetry(e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.stopped) {
      void room.disconnect();
      return;
    }
    this.room = room;
    this.retryMs = RETRY_MIN_MS;
    useVoiceStore.getState().set({ status: 'connected', statusText: '', listenOnly: this.opts.listenOnly() });
    if (useVoiceStore.getState().talkMode === 'vad') this.talk.setMode('vad');
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped) return;
    useVoiceStore.getState().set({ status: 'error', statusText: `${reason}; retrying in ${Math.round(this.retryMs / 1000)} s` });
    this.retryTimer = setTimeout(() => void this.connect(), this.retryMs);
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
  }

  private onSubscribed(track: RemoteTrack, p: RemoteParticipant): void {
    if (track.kind !== Track.Kind.Audio || !this.mixer) return;
    this.names.set(p.identity, p.name || p.identity);
    this.mixer.add(p.identity, p.name || p.identity, track.mediaStreamTrack);
    this.applyPrefs();
    this.publishSpeakers(true);
  }

  private onUnsubscribed(identity: string): void {
    this.mixer?.remove(identity);
    this.occl.delete(identity);
    this.publishSpeakers(true);
  }

  private async acquireMic(): Promise<void> {
    const room = this.room;
    if (!room) throw new Error('voice not connected');
    // Publishes the microphone (the browser asks for permission now, at the
    // first push, never earlier) and mutes it at once; the controller
    // unmutes while the key is held.
    const pub = await room.localParticipant.setMicrophoneEnabled(true);
    await room.localParticipant.setMicrophoneEnabled(false);
    const mst = pub?.track?.mediaStreamTrack;
    if (mst && this.mixer) {
      // Meter a clone: LiveKit's mute disables the published track, and the
      // speaking bit / voice activation must still hear the room.
      this.dropSelfMeter();
      const track = mst.clone();
      track.enabled = true;
      const source = this.mixer.ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.mixer.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      voiceLevels.attach(SELF, analyser);
      this.selfMeter = { track, source, analyser };
    }
  }

  private async setMicLive(live: boolean): Promise<void> {
    if (!this.room) throw new Error('voice not connected');
    await this.room.localParticipant.setMicrophoneEnabled(live);
  }

  private dropSelfMeter(): void {
    if (!this.selfMeter) return;
    voiceLevels.detach(SELF);
    this.selfMeter.source.disconnect();
    this.selfMeter.track.stop();
    this.selfMeter = null;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.code !== 'KeyV' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // typing in chat
    if (down) {
      if (e.repeat) return;
      this.mixer?.resume(); // a key press is the user gesture browsers want
      if (useVoiceStore.getState().talkMode !== 'ptt') return;
      if (!this.talk.press() && this.opts.listenOnly()) {
        useVoiceStore.getState().set({ statusText: 'Listen-only: local profiles can hear voice but not talk.' });
      }
    } else if (useVoiceStore.getState().talkMode === 'ptt') {
      this.talk.release();
    }
  }

  setTalkMode(mode: TalkMode): void {
    useVoiceStore.getState().setPrefs({ talkMode: mode });
    this.mixer?.resume();
    this.talk.setMode(mode);
  }

  applyPrefs(): void {
    const m = this.mixer;
    if (!m) return;
    const s = useVoiceStore.getState();
    m.setMasterVolume(s.masterVolume);
    for (const name of new Set([...this.names.values(), ...Object.keys(s.volumes), ...Object.keys(s.muted)])) {
      m.setVolume(name, s.volumes[name] ?? 1);
      m.setMuted(name, s.muted[name] === true);
    }
  }

  /** The speaking bit for the zone (InputFlag.speaking): transmitting and actually audible. */
  inputFlags(): number {
    const s = useVoiceStore.getState();
    return s.transmitting && voiceLevels.isSpeaking(SELF) ? InputFlag.speaking : 0;
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    const m = this.mixer;
    if (!m) return;
    const now = performance.now();
    const me = headOf(localPlayer.pos);
    m.setListener(me, localPlayer.yaw, localPlayer.pitch);
    const views = new Map<string, Vec3>();
    for (const v of drawnRemotes.views) if (v.name) views.set(v.name, headOf(v));
    const party = new Set(this.opts.partyIds());
    for (const id of m.ids()) {
      const name = this.names.get(id) ?? id;
      const pos = views.get(name) ?? null;
      const dist = pos ? Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z) : null;
      const mode = chooseMode(dist, party.has(id));
      let o = this.occl.get(id);
      if (!o || now - o.at >= OCCLUSION_EVERY_MS) {
        o = { at: now, occluded: mode === 'spatial' && pos !== null && terrainBetween(this.opts.ground, me, pos) };
        this.occl.set(id, o);
      }
      m.update(id, { mode, pos, occluded: o.occluded });
    }
    // Voice activation: the gate follows the local level meter (with the
    // meter's own hangover), checked at 20 Hz.
    if (now - this.lastGateAt > 50) {
      this.lastGateAt = now;
      this.talk.setGate(voiceLevels.isSpeaking(SELF));
    }
    if (now - this.lastSpeakersAt > 250) this.publishSpeakers(false);
  };

  private publishSpeakers(force: boolean): void {
    this.lastSpeakersAt = performance.now();
    const list: SpeakerInfo[] = (this.mixer?.debug() ?? []).map((d) => ({ id: d.id, name: d.name, mode: d.mode }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    const cur = useVoiceStore.getState().speakers;
    const same = cur.length === list.length && cur.every((s, i) => s.id === list[i].id && s.mode === list[i].mode);
    if (force || !same) useVoiceStore.getState().set({ speakers: list });
  }

  debug() {
    const s = useVoiceStore.getState();
    return {
      status: s.status,
      mic: s.mic,
      transmitting: s.transmitting,
      talkMode: s.talkMode,
      listenOnly: s.listenOnly,
      selfLevel: voiceLevels.level(SELF),
      selfSpeaking: voiceLevels.isSpeaking(SELF),
      speakingFlag: this.inputFlags() !== 0,
      listener: { ...headOf(localPlayer.pos), yaw: localPlayer.yaw, pitch: localPlayer.pitch },
      speakers: this.mixer?.debug() ?? [],
      output: this.mixer?.outputLevels() ?? null,
      contextState: this.mixer?.ctx.state ?? null,
      t: Date.now(),
    };
  }
}

let runtime: VoiceRuntime | null = null;

/** Start proximity voice (idempotent: a second call replaces the first). */
export function startVoice(opts: StartVoiceOptions): void {
  stopVoice();
  runtime = new VoiceRuntime(opts);
  runtime.start();
}

export function stopVoice(): void {
  runtime?.stop();
  runtime = null;
}

/** OR this into every movement input frame's flags (InputFlag.speaking). */
export function voiceInputFlags(): number {
  return runtime?.inputFlags() ?? 0;
}

export function setTalkMode(mode: TalkMode): void {
  if (runtime) runtime.setTalkMode(mode);
  else useVoiceStore.getState().setPrefs({ talkMode: mode });
}

/** Re-apply volumes/mutes after the settings panel changed them. */
export function applyVoicePrefs(): void {
  runtime?.applyPrefs();
}

/** window.__lodestone.voiceDebug(): mixer, positions, gains, output levels. */
export function voiceDebug() {
  return runtime?.debug() ?? null;
}
voiceDebugHook.fn = voiceDebug;
