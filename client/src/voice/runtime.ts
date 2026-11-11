// The browser's proximity-voice session (spec 10, WP11): LiveKit with
// auto-subscribe off (the server decides who hears whom from the zone's
// earshot sets), the spatial mixer fed from interpolated remote positions
// every frame, push-to-talk, and the speaking bit for the zone.
//
//   startVoice() once the social socket is up  ->  voice_token  ->  Room.connect
//   TrackSubscribed / TrackUnsubscribed        ->  mixer.add / remove
//   rAF: localPlayer + drawnRemotes.views      ->  listener, panner positions, radio vs spatial
//   4 Hz per speaker                           ->  terrain occlusion low-pass
//   talk key down/up                           ->  TalkController -> mic publish (first push) / unmute / mute
//
// Playtest 2 voice settings (ui/VoiceSettings.tsx): every saved setting
// applies live through one store subscription: the microphone (device,
// echo cancellation, noise suppression, auto gain: restartTrack), the input
// boost (MicChain, a LiveKit audio processor), the open-mic gate (VadGate:
// threshold, open-after, hold-open), mic mute, the voice keys (rebindable,
// hold or toggle; mouse side buttons too), speakers (setSinkId), per-player
// volume by character id. Devices plugged in or out are followed (the
// default stands in while the chosen microphone is unplugged, and it
// switches back when it returns). diagnostics() feeds the settings' page.

import { ConnectionState, Room, RoomEvent, Track, type AudioCaptureOptions, type LocalAudioTrack, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { InputFlag } from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';
import { localPlayer } from '../state/live';
import { drawnRemotes } from '../net/netStore';
import { voiceDebugHook } from './debugHook';
import { SELF, voiceLevels } from './levels';
import { VoiceMixer } from './mixer';
import { getAudioContext, onAudioReady } from '../audio/context';
import { chooseMode, headOf, terrainBetween, type Vec3 } from './spatial';
import { peerPref, useVoiceStore, type SpeakerInfo, type TalkMode, type VoicePrefs } from './store';
import { TalkController } from './talk';
import { keyEventCode, mouseEventCode, voiceKeyLabel } from './keys';
import { MicChain } from './micChain';
import { measure, VadGate } from './vad';
import { applySink, listDevices, micPermission, micProblem, onDeviceChange, outputSelectable, pickDevice, type MicProblem, type Pick } from './devices';
import { recordVoiceError, voiceErrors, type SpeakerDiag, type TokenInfo, type VoiceDiagnostics } from './diag';
import { parseAudioStats, withRates, type AudioStats } from './stats';
import { tokenClaims } from './token';

export interface VoiceToken {
  url: string;
  token: string;
  /** The token's grant (token.ts tokenCanPublish); undefined = may publish. */
  canPublish?: boolean;
}

export interface StartVoiceOptions {
  /** Ask the social service for a LiveKit token (voice_token). */
  requestToken: () => Promise<VoiceToken>;
  /** Extra client-side listen-only rule (default none); the token's grant decides otherwise. */
  listenOnly?: () => boolean;
  /** Character ids of my party members (radio when beyond earshot). */
  partyIds: () => string[];
  ground: GroundQuery;
  /** Test hook: capture options for the mic (headless runs disable processing). */
  rawMic?: boolean;
}

const OCCLUSION_EVERY_MS = 250; // 4 Hz per speaker (spec 10)
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

const vadOf = (s: VoicePrefs) => ({ thresholdDb: s.vadThresholdDb, attackMs: s.vadAttackMs, releaseMs: s.vadReleaseMs });

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
  private chain: MicChain | null = null;
  private micTrack: LocalAudioTrack | null = null;
  private gate: VadGate;
  private levelBuf = new Float32Array(1024);
  private selfDb: number | null = null;
  private lastSpeakersAt = 0;
  private keyDown = (e: KeyboardEvent) => this.onKey(e, true);
  private keyUp = (e: KeyboardEvent) => this.onKey(e, false);
  private mouseDown = (e: MouseEvent) => this.onMouse(e, true);
  private mouseUp = (e: MouseEvent) => this.onMouse(e, false);
  private blur = () => this.talk.release();
  private unsubs: (() => void)[] = [];
  /** The current token's grant: a moderator mute makes it listen-only. */
  private tokenPublish = true;
  private tokenInfo: TokenInfo | null = null;
  private url: string | null = null;
  // Diagnostics counters.
  private reconnects = 0;
  private connectAttempts = 0;
  private connectFailures = 0;
  private connectedAt: number | null = null;
  private micPick: Pick = { deviceId: '', label: '', status: 'default' };
  private inputCount = 0;
  private outputCount = 0;
  private outputLabel = '';
  private lastMicProblem: MicProblem | null = null;
  private prevStats = new Map<string, AudioStats>();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private listenOnly(): boolean {
    return !this.tokenPublish || this.opts.listenOnly?.() === true;
  }

  constructor(private readonly opts: StartVoiceOptions) {
    this.talk = this.makeTalk();
    this.gate = new VadGate(vadOf(useVoiceStore.getState()));
  }

  private makeTalk(): TalkController {
    return new TalkController(
      { acquire: () => this.acquireMic(), setLive: (live) => this.setMicLive(live) },
      (s) => useVoiceStore.getState().set({ mic: s.mic, transmitting: s.transmitting }),
      () => !this.listenOnly() && this.room !== null && !useVoiceStore.getState().micMuted,
      useVoiceStore.getState().talkMode,
    );
  }

  start(): void {
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('mousedown', this.mouseDown);
    window.addEventListener('mouseup', this.mouseUp);
    window.addEventListener('blur', this.blur);
    this.unsubs.push(useVoiceStore.subscribe((s, prev) => this.onPrefs(s, prev)));
    this.unsubs.push(onDeviceChange(() => void this.onDevicesChanged()));
    // The game's AudioContext may appear later (first gesture): route it to the saved speakers too.
    this.unsubs.push(onAudioReady((ctx) => void applySink(ctx, useVoiceStore.getState().outputDevice)));
    void this.refreshDeviceCounts();
    useVoiceStore.getState().set({ status: 'connecting', statusText: 'Connecting voice…', listenOnly: this.listenOnly() });
    void this.connect();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('mousedown', this.mouseDown);
    window.removeEventListener('mouseup', this.mouseUp);
    window.removeEventListener('blur', this.blur);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    cancelAnimationFrame(this.raf);
    void this.room?.disconnect();
    this.room = null;
    this.dropMic();
    this.mixer?.close();
    this.mixer = null;
    useVoiceStore.getState().set({ status: 'off', statusText: '', transmitting: false, speakers: [], mic: 'idle' });
  }

  private captureOptions(deviceId: string): AudioCaptureOptions {
    const s = useVoiceStore.getState();
    const raw = this.opts.rawMic === true;
    return {
      deviceId: deviceId && deviceId !== 'default' ? deviceId : undefined,
      echoCancellation: raw ? false : s.echoCancellation,
      noiseSuppression: raw ? false : s.noiseSuppression,
      autoGainControl: raw ? false : s.autoGainControl,
      channelCount: 1,
    };
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.connectAttempts++;
    let tok: VoiceToken;
    try {
      tok = await this.opts.requestToken();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordVoiceError('voice token', e);
      if (/not available/i.test(msg)) {
        // The server has voice switched off: don't keep asking.
        useVoiceStore.getState().set({ status: 'unavailable', statusText: msg });
        return;
      }
      this.connectFailures++;
      this.scheduleRetry(msg);
      return;
    }
    if (this.stopped) return;
    this.tokenPublish = tok.canPublish !== false;
    const claims = tokenClaims(tok.token);
    this.tokenInfo = claims
      ? { canPublish: claims.canPublish ?? null, canSubscribe: claims.canSubscribe ?? null, room: claims.room ?? null, identity: claims.identity ?? null, expiresInS: claims.exp ? Math.round(claims.exp - Date.now() / 1000) : null }
      : null;
    this.url = tok.url;
    // One AudioContext for the whole game (client/src/audio/context.ts) when a gesture already made it.
    if (!this.mixer) {
      this.mixer = new VoiceMixer(getAudioContext() ?? undefined);
      void this.applyOutput();
    }
    this.applyPrefs();
    const { inputs } = await listDevices();
    this.micPick = pickDevice(inputs, useVoiceStore.getState().inputDevice);
    const room = new Room({
      // Audio only: no simulcast/dynacast decisions to make, and the server
      // (not the client) chooses subscriptions.
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: this.captureOptions(this.micPick.deviceId),
      publishDefaults: { dtx: true, red: true },
    });
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => this.onSubscribed(track, p))
      .on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => this.onUnsubscribed(p.identity))
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => this.onUnsubscribed(p.identity))
      .on(RoomEvent.Reconnecting, () => {
        this.reconnects++;
        useVoiceStore.getState().set({ status: 'reconnecting', statusText: 'Voice reconnecting…' });
      })
      .on(RoomEvent.Reconnected, () => useVoiceStore.getState().set({ status: 'connected', statusText: '' }))
      .on(RoomEvent.MediaDevicesError, (e: Error) => {
        this.lastMicProblem = micProblem(e);
        recordVoiceError('microphone', e);
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room || this.stopped) return;
        this.dropRoom();
        this.reconnects++;
        this.scheduleRetry('Voice disconnected');
      });
    try {
      // autoSubscribe off: subscriptions come only from the server's
      // earshot reconcile (spec 10 "Proximity voice" 1).
      await room.connect(tok.url, tok.token, { autoSubscribe: false });
    } catch (e) {
      recordVoiceError('voice connect', e);
      this.connectFailures++;
      this.scheduleRetry(e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.stopped) {
      void room.disconnect();
      return;
    }
    this.room = room;
    this.connectedAt = Date.now();
    this.retryMs = RETRY_MIN_MS;
    useVoiceStore.getState().set({ status: 'connected', statusText: '', listenOnly: this.listenOnly() });
    if (useVoiceStore.getState().talkMode === 'vad') this.talk.setMode('vad');
  }

  /** The room is gone (disconnected or replaced): forget its speakers and microphone. */
  private dropRoom(): void {
    this.room = null;
    this.connectedAt = null;
    for (const id of this.mixer?.ids() ?? []) this.onUnsubscribed(id);
    this.dropMic();
    useVoiceStore.getState().set({ transmitting: false, mic: 'idle' });
    this.talk = this.makeTalk(); // the old room's mic publication is gone
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    useVoiceStore.getState().set({ status: 'error', statusText: `${reason}; retrying in ${Math.round(this.retryMs / 1000)} s` });
    this.retryTimer = setTimeout(() => void this.connect(), this.retryMs);
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
  }

  /** "Reconnect voice": drop the room and connect again now (also after the server said voice is unavailable). */
  async reconnect(): Promise<void> {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryMs = RETRY_MIN_MS;
    const old = this.room;
    if (old) {
      this.dropRoom();
      await old.disconnect().catch(() => {});
    }
    useVoiceStore.getState().set({ status: 'connecting', statusText: 'Connecting voice…' });
    await this.connect();
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
    this.prevStats.delete(`in:${identity}`);
    this.publishSpeakers(true);
  }

  private async acquireMic(): Promise<void> {
    const room = this.room;
    if (!room) throw new Error('voice not connected');
    const { inputs } = await listDevices();
    this.micPick = pickDevice(inputs, useVoiceStore.getState().inputDevice);
    // Publishes the microphone (the browser asks for permission now, at the
    // first push, never earlier) and mutes it at once; the controller
    // unmutes while the key is held.
    let pub;
    try {
      pub = await room.localParticipant.setMicrophoneEnabled(true, this.captureOptions(this.micPick.deviceId));
      await room.localParticipant.setMicrophoneEnabled(false);
    } catch (e) {
      this.lastMicProblem = micProblem(e);
      recordVoiceError('microphone', e);
      throw e;
    }
    this.lastMicProblem = null;
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track || !this.mixer) return;
    this.dropMic();
    this.micTrack = track;
    const chain = new MicChain(this.mixer.ctx, useVoiceStore.getState().inputGainDb);
    try {
      // The input boost rides in the send path (LiveKit audio processor).
      track.setAudioContext(this.mixer.ctx);
      await track.setProcessor(chain);
    } catch (e) {
      recordVoiceError('input boost', e);
      chain.meterOnly(track.mediaStreamTrack);
    }
    this.chain = chain;
    voiceLevels.attach(SELF, chain.analyser);
    // Labels exist now (permission granted): remember the chosen device's name for matching after a replug.
    void this.refreshDeviceCounts(true);
  }

  private async setMicLive(live: boolean): Promise<void> {
    if (!this.room) throw new Error('voice not connected');
    await this.room.localParticipant.setMicrophoneEnabled(live);
  }

  private dropMic(): void {
    if (this.chain) {
      voiceLevels.detach(SELF);
      this.chain.close();
      this.chain = null;
    }
    this.micTrack = null;
    this.selfDb = null;
  }

  /** Re-acquires the microphone with the saved device and processing (debounced: a slider drag is one restart). */
  private scheduleMicRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.restartMic(), 150);
  }

  private async restartMic(): Promise<void> {
    const track = this.micTrack;
    if (!track || !this.room) return;
    const { inputs } = await listDevices();
    const before = this.micPick;
    this.micPick = pickDevice(inputs, useVoiceStore.getState().inputDevice);
    const opts = this.captureOptions(this.micPick.deviceId);
    this.room.options.audioCaptureDefaults = opts;
    try {
      await track.restartTrack(opts);
      this.lastMicProblem = null;
    } catch (e) {
      this.lastMicProblem = micProblem(e);
      recordVoiceError('microphone restart', e);
      this.micPick = before;
    }
  }

  private async onDevicesChanged(): Promise<void> {
    const { inputs, outputs } = await listDevices();
    this.inputCount = inputs.length;
    this.outputCount = outputs.length;
    const s = useVoiceStore.getState();
    const next = pickDevice(inputs, s.inputDevice);
    const prev = this.micPick;
    const rawEnded = this.chain?.raw?.readyState === 'ended';
    if (this.micTrack && (next.deviceId !== prev.deviceId || rawEnded)) {
      if (next.status === 'fallback') s.set({ notice: `${s.inputDevice?.label || 'Your microphone'} was unplugged: using ${next.label || 'the system default'}.` });
      else if (prev.status === 'fallback' && (next.status === 'chosen' || next.status === 'matched-label')) s.set({ notice: `${next.label} is back: switched to it.` });
      else if (next.status === 'none') s.set({ notice: 'No microphone is plugged in.' });
      this.scheduleMicRestart();
    } else {
      this.micPick = next;
    }
    void this.applyOutput();
  }

  private async refreshDeviceCounts(rememberLabel = false): Promise<void> {
    const { inputs, outputs } = await listDevices();
    this.inputCount = inputs.length;
    this.outputCount = outputs.length;
    const s = useVoiceStore.getState();
    const pick = pickDevice(inputs, s.inputDevice);
    if (rememberLabel && s.inputDevice && pick.status === 'chosen' && pick.label && pick.label !== s.inputDevice.label) s.setPrefs({ inputDevice: { id: s.inputDevice.id, label: pick.label } });
  }

  private async applyOutput(): Promise<void> {
    const pref = useVoiceStore.getState().outputDevice;
    const pick = await applySink(this.mixer?.ctx, pref);
    const shared = getAudioContext();
    if (shared && shared !== this.mixer?.ctx) await applySink(shared, pref);
    this.outputLabel = pick?.label ?? '';
  }

  /** Every saved-setting change applies at once. */
  private onPrefs(s: VoicePrefs, prev: VoicePrefs): void {
    if (s.micMuted !== prev.micMuted) this.talk.refresh();
    if (s.inputGainDb !== prev.inputGainDb) this.chain?.setGainDb(s.inputGainDb);
    if (s.inputDevice?.id !== prev.inputDevice?.id || s.echoCancellation !== prev.echoCancellation || s.noiseSuppression !== prev.noiseSuppression || s.autoGainControl !== prev.autoGainControl) this.scheduleMicRestart();
    if (s.vadThresholdDb !== prev.vadThresholdDb || s.vadAttackMs !== prev.vadAttackMs || s.vadReleaseMs !== prev.vadReleaseMs) this.gate.configure(vadOf(s));
    if (s.outputDevice?.id !== prev.outputDevice?.id) void this.applyOutput();
    if (s.masterVolume !== prev.masterVolume || s.peers !== prev.peers || s.volumes !== prev.volumes || s.muted !== prev.muted) this.applyPrefs();
    if (s.pttMode !== prev.pttMode || s.pttKey !== prev.pttKey) this.talk.release();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const code = keyEventCode(e, down);
    if (code) this.onVoiceKey(code, down, e.repeat);
  }

  private onMouse(e: MouseEvent, down: boolean): void {
    const code = mouseEventCode(e);
    if (!code) return;
    const s = useVoiceStore.getState();
    if (code !== s.pttKey && code !== s.muteKey) return;
    e.preventDefault(); // a bound side button must not navigate back / forward
    this.onVoiceKey(code, down, false);
  }

  private onVoiceKey(code: string, down: boolean, repeat: boolean): void {
    const s = useVoiceStore.getState();
    if (code === s.muteKey) {
      if (down && !repeat) {
        s.setPrefs({ micMuted: !s.micMuted });
        s.set({ notice: !s.micMuted ? `Microphone muted (${voiceKeyLabel(s.muteKey)} unmutes)` : 'Microphone on' });
      }
      return;
    }
    if (code !== s.pttKey) return;
    if (down) {
      if (repeat) return;
      this.mixer?.resume(); // a key press is the user gesture browsers want
      if (s.talkMode !== 'ptt') return;
      if (s.micMuted) {
        s.set({ notice: `Your microphone is muted: press ${voiceKeyLabel(s.muteKey)} to unmute.` });
        return;
      }
      if (s.pttMode === 'toggle' && this.talk.isHeld) {
        this.talk.release();
        return;
      }
      if (!this.talk.press() && this.listenOnly()) {
        s.set({ statusText: 'Listen-only: a moderator muted you, so you can hear voice but not talk.' });
      }
    } else if (s.talkMode === 'ptt' && s.pttMode === 'hold') {
      this.talk.release();
    }
  }

  setTalkMode(mode: TalkMode): void {
    useVoiceStore.getState().setPrefs({ talkMode: mode });
    this.mixer?.resume();
    this.talk.setMode(mode);
  }

  /** The settings' Retry microphone button. */
  retryMic(): void {
    this.mixer?.resume();
    this.talk.retryMic();
  }

  applyPrefs(): void {
    const m = this.mixer;
    if (!m) return;
    const s = useVoiceStore.getState();
    m.setMasterVolume(s.masterVolume);
    for (const id of m.ids()) {
      const p = peerPref(s, id, this.names.get(id) ?? id);
      m.setPeer(id, p.volume, p.muted);
    }
  }

  /** The speaking bit for the zone (InputFlag.speaking): transmitting and actually audible. */
  inputFlags(): number {
    const s = useVoiceStore.getState();
    return s.transmitting && voiceLevels.isSpeaking(SELF) ? InputFlag.speaking : 0;
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    // Open mic: the gate follows the boosted input level (threshold, open-after, hold-open).
    if (this.chain) {
      const buf = this.levelBuf.subarray(0, this.chain.analyser.fftSize);
      this.chain.analyser.getFloatTimeDomainData(buf);
      const lv = measure(buf);
      this.selfDb = lv.rmsDb;
      this.talk.setGate(this.gate.update(lv.rmsDb, now));
    }
    const m = this.mixer;
    if (!m) return;
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

  /** The microphone's analyser (post-boost), for the settings' meter; null before the first push. */
  micAnalyser(): AnalyserNode | null {
    return this.chain?.analyser ?? null;
  }

  /** The open-mic gate's state (the settings' meter shows it). */
  gateOpen(): boolean {
    return this.gate.open;
  }

  private listenOnlyReason(): string | null {
    if (!this.tokenPublish) return 'A moderator muted you: your voice pass lets you hear nearby players but not talk. It lifts when the mute ends (at the next voice reconnect).';
    if (this.opts.listenOnly?.()) return 'This kind of profile can listen but not talk on this server (sign in to talk).';
    return null;
  }

  private async stats(key: string, track: { getRTCStatsReport(): Promise<RTCStatsReport | undefined> } | undefined, dir: 'out' | 'in') {
    if (!track) return null;
    try {
      const rep = await track.getRTCStatsReport();
      const cur = rep ? parseAudioStats(rep as unknown as { forEach: (cb: (v: { id: string; type: string }) => void) => void }, dir) : null;
      if (!cur) return null;
      const r = withRates(cur, this.prevStats.get(key) ?? null);
      this.prevStats.set(key, cur);
      return r;
    } catch {
      return null;
    }
  }

  async diagnostics(): Promise<VoiceDiagnostics> {
    const d = await baseDiagnostics();
    const s = useVoiceStore.getState();
    const room = this.room;
    const m = this.mixer;
    d.room = {
      state: room?.state ?? (this.connectedAt ? ConnectionState.Disconnected : null),
      url: this.url,
      region: room?.serverInfo?.region || null,
      serverVersion: room?.serverInfo?.version || null,
      identity: room?.localParticipant.identity ?? this.tokenInfo?.identity ?? null,
      reconnects: this.reconnects,
      connectAttempts: this.connectAttempts,
      connectFailures: this.connectFailures,
      connectedForS: this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : null,
    };
    d.token = this.tokenInfo;
    d.listenOnly = this.listenOnly();
    d.listenOnlyReason = this.listenOnlyReason();
    const raw = this.chain?.raw;
    const st = raw?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    d.mic.deviceLabel = raw?.label || this.micPick.label;
    d.mic.devicePick = this.micPick.status;
    d.mic.inputCount = this.inputCount || d.mic.inputCount;
    d.mic.settings = st
      ? { deviceId: st.deviceId, sampleRate: st.sampleRate, channelCount: st.channelCount, echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression, autoGainControl: st.autoGainControl, latencyMs: typeof st.latency === 'number' ? st.latency * 1000 : undefined }
      : null;
    d.mic.boostActive = this.chain?.sending ?? false;
    d.mic.levelDb = this.selfDb;
    d.mic.lastProblem = this.lastMicProblem ?? d.mic.lastProblem;
    if (this.outputLabel) d.output.deviceLabel = this.outputLabel;
    if (m) d.audio = { contextState: m.ctx.state, sampleRate: m.ctx.sampleRate, baseLatencyMs: m.ctx.baseLatency ? m.ctx.baseLatency * 1000 : null, outputLatencyMs: m.ctx.outputLatency ? m.ctx.outputLatency * 1000 : null };
    d.publisher = room ? await this.stats('out', room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined, 'out') : null;
    const speakers: SpeakerDiag[] = [];
    for (const md of m?.debug() ?? []) {
      const p = room?.remoteParticipants.get(md.id);
      const track = p ? [...p.audioTrackPublications.values()].find((pub) => pub.track)?.track : undefined;
      const pref = peerPref(s, md.id, md.name);
      speakers.push({ id: md.id, name: md.name, mode: md.mode, distance: md.distance, levelDb: m!.levelDb(md.id), volume: pref.volume, muted: pref.muted, stats: await this.stats(`in:${md.id}`, track, 'in') });
    }
    d.speakers = speakers.sort((a, b) => a.name.localeCompare(b.name));
    return d;
  }

  debug() {
    const s = useVoiceStore.getState();
    return {
      status: s.status,
      mic: s.mic,
      transmitting: s.transmitting,
      talkMode: s.talkMode,
      listenOnly: s.listenOnly,
      micMuted: s.micMuted,
      selfLevel: voiceLevels.level(SELF),
      selfSpeaking: voiceLevels.isSpeaking(SELF),
      selfDb: this.selfDb,
      gateOpen: this.gate.open,
      speakingFlag: this.inputFlags() !== 0,
      listener: { ...headOf(localPlayer.pos), yaw: localPlayer.yaw, pitch: localPlayer.pitch },
      speakers: this.mixer?.debug() ?? [],
      output: this.mixer?.outputLevels() ?? null,
      contextState: this.mixer?.ctx.state ?? null,
      t: Date.now(),
    };
  }
}

/** What diagnostics can say without a voice session (offline, solo, before start). */
async function baseDiagnostics(): Promise<VoiceDiagnostics> {
  const s = useVoiceStore.getState();
  const [perm, devs] = await Promise.all([micPermission(), listDevices()]);
  const inPick = pickDevice(devs.inputs, s.inputDevice);
  const outPick = pickDevice(devs.outputs, s.outputDevice);
  const ctx = getAudioContext();
  return {
    at: Date.now(),
    status: s.status,
    statusText: s.statusText,
    room: { state: null, url: null, region: null, serverVersion: null, identity: null, reconnects: 0, connectAttempts: 0, connectFailures: 0, connectedForS: null },
    token: null,
    listenOnly: s.listenOnly,
    listenOnlyReason: null,
    mic: {
      permission: perm,
      state: s.mic,
      muted: s.micMuted,
      transmitting: s.transmitting,
      talkMode: s.talkMode,
      pttMode: s.pttMode,
      pttKey: s.pttKey,
      muteKey: s.muteKey,
      deviceLabel: inPick.label,
      devicePick: inPick.status,
      inputCount: devs.inputs.length,
      settings: null,
      inputGainDb: s.inputGainDb,
      boostActive: false,
      levelDb: null,
      lastProblem: null,
    },
    output: { deviceLabel: outPick.label || (outputSelectable() ? 'System default' : 'System default (this browser cannot choose)'), selectable: outputSelectable(), outputCount: devs.outputs.length },
    audio: ctx ? { contextState: ctx.state, sampleRate: ctx.sampleRate, baseLatencyMs: ctx.baseLatency ? ctx.baseLatency * 1000 : null, outputLatencyMs: ctx.outputLatency ? ctx.outputLatency * 1000 : null } : { contextState: null, sampleRate: null, baseLatencyMs: null, outputLatencyMs: null },
    publisher: null,
    speakers: [],
    errors: voiceErrors(),
    browser: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
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

/** Re-apply volumes/mutes after the settings panel changed them (the store subscription does this too). */
export function applyVoicePrefs(): void {
  runtime?.applyPrefs();
}

/** The diagnostics snapshot (works without a voice session too). */
export function voiceDiagnostics(): Promise<VoiceDiagnostics> {
  return runtime ? runtime.diagnostics() : baseDiagnostics();
}

/** "Reconnect voice". False when voice is not running here. */
export function reconnectVoice(): boolean {
  if (!runtime) return false;
  void runtime.reconnect();
  return true;
}

/** "Retry microphone" (after a denied prompt or a missing device). */
export function retryVoiceMic(): void {
  runtime?.retryMic();
}

/** The live microphone analyser (post-boost) and the open-mic gate, for the settings' meter. */
export function voiceMicTap(): { analyser: AnalyserNode | null; gateOpen: boolean } {
  return { analyser: runtime?.micAnalyser() ?? null, gateOpen: runtime?.gateOpen() ?? false };
}

/** window.__lodestone.voiceDebug(): mixer, positions, gains, output levels. */
export function voiceDebug() {
  return runtime?.debug() ?? null;
}
voiceDebugHook.fn = voiceDebug;
