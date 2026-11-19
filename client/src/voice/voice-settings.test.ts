// Playtest 2 voice settings: saved prefs, the open-mic gate, getStats
// parsing and formatting, device fallback, voice key validation, guidance,
// diagnostics JSON, and the talk controller's mute / toggle hooks.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, loadPrefs, peerPref, PREFS_KEY, useVoiceStore, withPeer } from './store';
import { dbToGain, dbToMeter, DEFAULT_VAD, measure, VadGate } from './vad';
import { fmtCodec, fmtDb, fmtKbps, fmtMs, fmtPct, fmtTransport, levelToDb, parseAudioStats, quality, withRates, type StatLike } from './stats';
import { audioConstraints, micProblem, pickDevice } from './devices';
import { DEFAULT_MUTE_KEY, DEFAULT_PTT_KEY, keyEventCode, mouseEventCode, sanitizeVoiceKey, validateVoiceKey, voiceKeyLabel } from './keys';
import { BINDINGS } from '../input/bindings';
import { voiceGuidance } from './guidance';
import { clearVoiceErrors, diagnosticsJson, recordVoiceError, voiceErrors, type VoiceDiagnostics } from './diag';
import { TalkController, type Mic } from './talk';

describe('saved voice settings', () => {
  it('defaults: push to talk on V (hold), mute on 0, processing on, gate -50 dBFS / 20 ms / 450 ms', () => {
    const p = loadPrefs(null);
    expect(p).toEqual(DEFAULT_PREFS);
    expect(p).toMatchObject({ talkMode: 'ptt', pttMode: 'hold', pttKey: 'KeyV', muteKey: 'Digit0', micMuted: false, inputGainDb: 0, echoCancellation: true, noiseSuppression: true, autoGainControl: true, vadThresholdDb: -50, vadAttackMs: 20, vadReleaseMs: 450, inputDevice: null, outputDevice: null });
  });

  it('validates every field of a stored blob (bad values fall back, numbers clamp)', () => {
    const p = loadPrefs(
      JSON.stringify({
        talkMode: 'vad',
        pttMode: 'toggle',
        micMuted: true,
        inputGainDb: 99,
        echoCancellation: false,
        noiseSuppression: 'no',
        autoGainControl: false,
        vadThresholdDb: -200,
        vadAttackMs: 'slow',
        vadReleaseMs: 5000,
        loopbackDelayMs: 750,
        inputDevice: { id: 'abc', label: 'USB Mic' },
        outputDevice: { id: '', label: 'nothing' },
        peers: { c1: { name: 'Ann', volume: 3, muted: true }, c2: 'junk', c3: { volume: 0.5 } },
      }),
    );
    expect(p.talkMode).toBe('vad');
    expect(p.pttMode).toBe('toggle');
    expect(p.micMuted).toBe(true);
    expect(p.inputGainDb).toBe(20);
    expect(p.echoCancellation).toBe(false);
    expect(p.noiseSuppression).toBe(true);
    expect(p.autoGainControl).toBe(false);
    expect(p.vadThresholdDb).toBe(-80);
    expect(p.vadAttackMs).toBe(DEFAULT_VAD.attackMs);
    expect(p.vadReleaseMs).toBe(3000);
    expect(p.loopbackDelayMs).toBe(750);
    expect(p.inputDevice).toEqual({ id: 'abc', label: 'USB Mic' });
    expect(p.outputDevice).toBeNull();
    expect(p.peers).toEqual({ c1: { name: 'Ann', volume: 2, muted: true }, c3: { name: 'c3', volume: 0.5, muted: false } });
    expect(loadPrefs('[1,2]').talkMode).toBe('ptt');
    expect(loadPrefs('null')).toEqual(DEFAULT_PREFS);
  });

  it('a stored voice key that clashes (or duplicates the other) falls back to the default', () => {
    expect(loadPrefs(JSON.stringify({ pttKey: 'KeyE' })).pttKey).toBe(DEFAULT_PTT_KEY); // E talks to people
    expect(loadPrefs(JSON.stringify({ pttKey: 'Mouse4', muteKey: 'Semicolon' }))).toMatchObject({ pttKey: 'Mouse4', muteKey: 'Semicolon' });
    const same = loadPrefs(JSON.stringify({ pttKey: 'Comma', muteKey: 'Comma' }));
    expect(same).toMatchObject({ pttKey: DEFAULT_PTT_KEY, muteKey: 'Comma' });
    expect(loadPrefs(JSON.stringify({ muteKey: 'Minus' })).muteKey).toBe(DEFAULT_MUTE_KEY); // CR 039: - casts spell slot 5
    const swapped = loadPrefs(JSON.stringify({ pttKey: 'Digit0', muteKey: 'Digit0' }));
    expect(swapped.pttKey).not.toBe(swapped.muteKey);
  });

  describe('persistence', () => {
    const mem = new Map<string, string>();
    beforeEach(() => {
      mem.clear();
      (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    });

    it('setPrefs saves only the prefs, and they load back', () => {
      const st = useVoiceStore.getState();
      st.setPrefs({ inputGainDb: 6, pttMode: 'toggle', vadThresholdDb: -42, inputDevice: { id: 'd1', label: 'Headset' } });
      st.set({ status: 'connected', notice: 'not saved' });
      const raw = mem.get(PREFS_KEY)!;
      expect(raw).toBeTruthy();
      const blob = JSON.parse(raw);
      expect(blob.status).toBeUndefined();
      expect(blob.notice).toBeUndefined();
      expect(blob.settingsOpen).toBeUndefined();
      expect(loadPrefs(raw)).toMatchObject({ inputGainDb: 6, pttMode: 'toggle', vadThresholdDb: -42, inputDevice: { id: 'd1', label: 'Headset' } });
    });

    it('Defaults resets the microphone settings but keeps per-player volumes', () => {
      const st = useVoiceStore.getState();
      st.setPrefs({ inputGainDb: 9, micMuted: true, peers: { c1: { name: 'Ann', volume: 0.4, muted: false } } });
      st.resetPrefs();
      const s = useVoiceStore.getState();
      expect(s.inputGainDb).toBe(0);
      expect(s.micMuted).toBe(false);
      expect(s.peers.c1.volume).toBe(0.4);
      expect(loadPrefs(mem.get(PREFS_KEY)!).peers.c1.volume).toBe(0.4);
    });
  });

  it('per-player volume is saved by character id and replaces the WP11 by-name entry', () => {
    const legacy = { peers: {}, volumes: { Ann: 1.5 }, muted: { Bob: true } as Record<string, boolean> };
    expect(peerPref(legacy, 'c1', 'Ann')).toEqual({ name: 'Ann', volume: 1.5, muted: false });
    expect(peerPref(legacy, 'c2', 'Bob')).toEqual({ name: 'Bob', volume: 1, muted: true });
    const next = withPeer(legacy, 'c1', 'Ann', { muted: true });
    expect(next.peers.c1).toEqual({ name: 'Ann', volume: 1.5, muted: true });
    expect(next.volumes.Ann).toBeUndefined();
    // A rename keeps the setting (it follows the id).
    expect(peerPref(next, 'c1', 'Annabel').volume).toBe(1.5);
    // Back to normal: no entry kept.
    const reset = withPeer(next, 'c1', 'Ann', { volume: 1, muted: false });
    expect(reset.peers.c1).toBeUndefined();
    expect(withPeer(legacy, 'c3', 'Cy', { volume: 7 }).peers.c3.volume).toBe(2);
  });
});

describe('levels and the open-mic gate', () => {
  const sine = (amp: number, n = 1024) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * i) / 64));

  it('measures RMS and peak in dBFS, and clipping', () => {
    const half = measure(sine(0.5));
    expect(half.rmsDb).toBeCloseTo(-9.03, 1);
    expect(half.peakDb).toBeCloseTo(-6.02, 1);
    expect(half.clipped).toBe(false);
    expect(measure(new Float32Array(512))).toEqual({ rmsDb: -100, peakDb: -100, clipped: false });
    expect(measure(sine(1)).clipped).toBe(true);
    expect(dbToMeter(-30)).toBeCloseTo(0.5);
    expect(dbToMeter(-90)).toBe(0);
    expect(dbToMeter(6)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.995, 2);
    expect(dbToGain(-20)).toBeCloseTo(0.1);
  });

  it('opens after `attackMs` above the threshold, not on a click', () => {
    const g = new VadGate({ thresholdDb: -50, attackMs: 40, releaseMs: 400 });
    expect(g.update(-30, 0)).toBe(false);
    expect(g.update(-60, 16)).toBe(false); // a 16 ms click
    expect(g.update(-30, 33)).toBe(false);
    expect(g.update(-30, 50)).toBe(false);
    expect(g.update(-30, 73)).toBe(true); // 40 ms above
  });

  it('holds open through pauses shorter than `releaseMs`, closes after', () => {
    const g = new VadGate({ thresholdDb: -50, attackMs: 0, releaseMs: 400 });
    expect(g.update(-40, 0)).toBe(true);
    expect(g.update(-70, 100)).toBe(true);
    expect(g.update(-40, 300)).toBe(true); // a word gap
    expect(g.update(-70, 500)).toBe(true);
    expect(g.update(-70, 699)).toBe(true);
    expect(g.update(-70, 700)).toBe(false);
  });

  it('follows a new threshold at once; exactly the threshold counts as above', () => {
    const g = new VadGate({ thresholdDb: -50, attackMs: 0, releaseMs: 100 });
    expect(g.update(-55, 0)).toBe(false);
    g.configure({ thresholdDb: -60, attackMs: 0, releaseMs: 100 });
    expect(g.update(-55, 10)).toBe(true);
    g.reset();
    expect(g.open).toBe(false);
    g.configure({ thresholdDb: -45, attackMs: 0, releaseMs: 100 });
    expect(g.update(-45, 0)).toBe(true);
  });
});

describe('WebRTC stats', () => {
  const outReport = (t: number, bytes: number, packets: number, lost: number): StatLike[] => [
    { id: 'OT1', type: 'outbound-rtp', kind: 'audio', timestamp: t, bytesSent: bytes, packetsSent: packets, codecId: 'C1', mediaSourceId: 'S1' },
    { id: 'C1', type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10;useinbandfec=1;usedtx=1' },
    { id: 'RI1', type: 'remote-inbound-rtp', kind: 'audio', localId: 'OT1', packetsLost: lost, jitter: 0.004, roundTripTime: 0.042 },
    { id: 'S1', type: 'media-source', kind: 'audio', audioLevel: 0.1 },
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP1' },
    { id: 'CP1', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1', currentRoundTripTime: 0.05, availableOutgoingBitrate: 300000 },
    { id: 'L1', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
  ];

  it('reads the sender: codec, loss, jitter, round trip, level, path', () => {
    const s = parseAudioStats(outReport(1000, 10000, 100, 2), 'out')!;
    expect(s.codec).toBe('opus');
    expect(s.clockRate).toBe(48000);
    expect(s.jitterMs).toBeCloseTo(4);
    expect(s.rttMs).toBeCloseTo(50); // the ICE pair's round trip first
    // RTCP's only when there is no pair, and only when plausible
    const noPair = outReport(1000, 10000, 100, 2).filter((x) => !['transport', 'candidate-pair'].includes(x.type));
    expect(parseAudioStats(noPair, 'out')!.rttMs).toBeCloseTo(42);
    const bogus = noPair.map((x) => (x.type === 'remote-inbound-rtp' ? { ...x, roundTripTime: 10.5 } : x));
    expect(parseAudioStats(bogus, 'out')!.rttMs).toBeNull();
    expect(s.audioLevel).toBe(0.1);
    expect(s.packetsLost).toBe(2);
    expect(s.transport).toMatchObject({ localType: 'srflx', remoteType: 'host', protocol: 'udp', availableOutKbps: 300 });
    expect(fmtCodec(s)).toBe('opus 48 kHz (2 ch), FEC + DTX');
    expect(fmtTransport(s.transport)).toBe('UDP via NAT');
  });

  it('bitrate and loss over the interval between readings', () => {
    const a = parseAudioStats(outReport(1000, 10000, 100, 2), 'out')!;
    const b = parseAudioStats(outReport(2000, 14000, 150, 4), 'out')!;
    const r = withRates(b, a);
    expect(r.bitrateKbps).toBeCloseTo(32); // 4000 bytes in 1 s
    expect(r.lossPct).toBeCloseTo((100 * 2) / 52);
    // first reading: totals
    expect(withRates(a, null).lossPct).toBeCloseTo((100 * 2) / 102);
    expect(withRates(a, null).bitrateKbps).toBeNull();
  });

  it('reads a receiver from a map-like RTCStatsReport (forEach), with concealment and jitter buffer', () => {
    const entries: StatLike[] = [
      { id: 'IT1', type: 'inbound-rtp', kind: 'audio', timestamp: 5000, bytesReceived: 9000, packetsReceived: 90, packetsLost: 10, jitter: 0.02, audioLevel: 0.05, concealedSamples: 480, totalSamplesReceived: 48000, jitterBufferDelay: 6, jitterBufferEmittedCount: 100, codecId: 'C2' },
      { id: 'C2', type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 1 },
      { id: 'CP', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.12 },
      { id: 'L', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' },
      { id: 'R', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
    ];
    const report = new Map(entries.map((e) => [e.id, e]));
    const s = parseAudioStats(report, 'in')!;
    expect(s.packetsLost).toBe(10);
    expect(s.jitterMs).toBeCloseTo(20);
    expect(s.concealedPct).toBeCloseTo(1);
    expect(s.jitterBufferMs).toBeCloseTo(60);
    expect(s.rttMs).toBeCloseTo(120);
    expect(fmtCodec(s)).toBe('opus 48 kHz mono');
    expect(fmtTransport(s.transport)).toBe('TURN relay (tcp)');
    expect(withRates(s, null).lossPct).toBeCloseTo(10);
    expect(parseAudioStats([{ id: 'x', type: 'inbound-rtp', kind: 'video' }], 'in')).toBeNull();
  });

  it('formats numbers for people', () => {
    expect(fmtKbps(31.94)).toBe('31.9 kbps');
    expect(fmtKbps(512.4)).toBe('512 kbps');
    expect(fmtKbps(null)).toBe('–');
    expect(fmtMs(4.25)).toBe('4.3 ms');
    expect(fmtMs(142.6)).toBe('143 ms');
    expect(fmtPct(0.5)).toBe('0.5 %');
    expect(fmtPct(12.4)).toBe('12 %');
    expect(fmtDb(-100)).toBe('-∞ dBFS');
    expect(fmtDb(-23.44)).toBe('-23.4 dBFS');
    expect(levelToDb(0.1)).toBeCloseTo(-20);
    expect(levelToDb(0)).toBe(-100);
    expect(fmtTransport({ localType: 'host', remoteType: 'host', protocol: 'tcp', relayProtocol: null, rttMs: 3, availableOutKbps: null })).toBe('TCP direct');
    expect(quality({ lossPct: 0.5, rttMs: 40, jitterMs: 3 })).toBe('good');
    expect(quality({ lossPct: 4, rttMs: 40, jitterMs: 3 })).toBe('fair');
    expect(quality({ lossPct: 0, rttMs: 600, jitterMs: 3 })).toBe('poor');
    expect(quality(null)).toBe('unknown');
  });
});

describe('device choice and fallback', () => {
  const list = [
    { deviceId: 'default', label: 'Default - Headset (USB)' },
    { deviceId: 'communications', label: 'Communications - Headset (USB)' },
    { deviceId: 'h1', label: 'Headset (USB)' },
    { deviceId: 'w1', label: 'Webcam Mic' },
  ];

  it('the saved device, the same name under a new id, else the default (and back when it returns)', () => {
    expect(pickDevice(list, null)).toMatchObject({ deviceId: 'default', status: 'default' });
    expect(pickDevice(list, { id: 'w1', label: 'Webcam Mic' })).toMatchObject({ deviceId: 'w1', status: 'chosen' });
    expect(pickDevice(list, { id: 'old-id', label: 'Webcam Mic' })).toMatchObject({ deviceId: 'w1', status: 'matched-label' });
    // Unplugged: the default stands in...
    const unplugged = list.filter((d) => d.deviceId !== 'w1');
    expect(pickDevice(unplugged, { id: 'w1', label: 'Webcam Mic' })).toMatchObject({ deviceId: 'default', status: 'fallback' });
    // ...and the choice comes back with the device.
    expect(pickDevice(list, { id: 'w1', label: 'Webcam Mic' }).status).toBe('chosen');
    // No "default" entry (Firefox): the first device.
    expect(pickDevice([{ deviceId: 'a', label: '' }], { id: 'gone', label: '' })).toMatchObject({ deviceId: 'a', status: 'fallback' });
    expect(pickDevice([], { id: 'w1', label: 'x' })).toMatchObject({ deviceId: '', status: 'none' });
    // Labels are empty before permission: never "match" an empty label.
    expect(pickDevice([{ deviceId: 'default', label: '' }, { deviceId: 'z', label: '' }], { id: 'w1', label: '' }).status).toBe('fallback');
  });

  it('names the problem behind a getUserMedia failure', () => {
    expect(micProblem({ name: 'NotAllowedError', message: 'Permission denied' })).toBe('denied');
    expect(micProblem({ name: 'NotFoundError', message: 'Requested device not found' })).toBe('no-device');
    expect(micProblem({ name: 'NotReadableError', message: 'Could not start audio source' })).toBe('busy');
    expect(micProblem({ name: 'OverconstrainedError', message: '' })).toBe('constraints');
    expect(micProblem({ name: 'TypeError', message: 'navigator.mediaDevices is undefined' })).toBe('insecure');
    expect(micProblem(new Error('weird'))).toBe('other');
  });

  it('builds capture constraints from the settings', () => {
    expect(audioConstraints({ deviceId: 'h1', echoCancellation: false, noiseSuppression: true, autoGainControl: false })).toEqual({ deviceId: { exact: 'h1' }, echoCancellation: false, noiseSuppression: true, autoGainControl: false, channelCount: 1 });
    expect(audioConstraints({ deviceId: 'default', echoCancellation: true, noiseSuppression: true, autoGainControl: true }).deviceId).toBeUndefined();
  });
});

describe('voice keys', () => {
  it('the defaults are free in the bindings table', () => {
    expect(validateVoiceKey(DEFAULT_PTT_KEY, 'ptt', DEFAULT_MUTE_KEY)).toEqual({ ok: true });
    expect(validateVoiceKey(DEFAULT_MUTE_KEY, 'mute', DEFAULT_PTT_KEY)).toEqual({ ok: true });
    // and declared there, as the voice's own
    expect(BINDINGS.filter((b) => b.file === 'voice/keys.ts').map((b) => b.code).sort()).toEqual(['Digit0', 'KeyV']);
  });

  it("refuses a key another feature uses, the other voice key, and reserved keys", () => {
    const e = validateVoiceKey('KeyE', 'ptt', DEFAULT_MUTE_KEY);
    expect(e.ok).toBe(false);
    expect(!e.ok && e.reason).toMatch(/already does/);
    expect(validateVoiceKey('KeyW', 'ptt', DEFAULT_MUTE_KEY).ok).toBe(false); // movement
    expect(validateVoiceKey('Digit1', 'mute', DEFAULT_PTT_KEY).ok).toBe(false); // spell slot
    expect(validateVoiceKey('KeyK', 'mute', DEFAULT_PTT_KEY).ok).toBe(false); // sound settings
    const dup = validateVoiceKey('KeyV', 'mute', 'KeyV');
    expect(!dup.ok && dup.reason).toMatch(/push to talk/);
    for (const k of ['Escape', 'Enter', 'Tab', 'Space', 'ShiftLeft', 'ControlLeft', 'AltLeft', 'ArrowUp', 'Mouse0', 'Mouse2', 'MetaLeft']) expect(validateVoiceKey(k, 'ptt', DEFAULT_MUTE_KEY).ok, k).toBe(false);
  });

  it('accepts free keys and mouse side buttons', () => {
    for (const k of ['Comma', 'Semicolon', 'Mouse3', 'Mouse4', 'CapsLock', 'F6', 'Numpad0']) expect(validateVoiceKey(k, 'ptt', DEFAULT_MUTE_KEY), k).toEqual({ ok: true });
    const slot = validateVoiceKey('BracketLeft', 'ptt', DEFAULT_MUTE_KEY); // CR 039: the spell slot keys
    expect(!slot.ok && slot.reason).toMatch(/spell slot 6/);
    expect(voiceKeyLabel('Mouse3')).toBe('Mouse back');
    expect(voiceKeyLabel('KeyV')).toBe('V');
    expect(voiceKeyLabel('Digit0')).toBe('0');
    expect(sanitizeVoiceKey('KeyQ', 'ptt', 'Digit0')).toBe(DEFAULT_PTT_KEY);
    expect(sanitizeVoiceKey(42, 'mute', 'KeyV')).toBe(DEFAULT_MUTE_KEY);
  });

  it('reads key and mouse events: not while typing, not with Ctrl, but a release always counts', () => {
    const ev = (o: Partial<Omit<KeyboardEvent, 'target'>> & { target?: unknown }) => ({ code: 'KeyV', key: 'v', ctrlKey: false, metaKey: false, altKey: false, target: null, ...o }) as unknown as KeyboardEvent;
    expect(keyEventCode(ev({}), true)).toBe('KeyV');
    expect(keyEventCode(ev({ target: { tagName: 'INPUT' } }), true)).toBe('');
    expect(keyEventCode(ev({ target: { tagName: 'INPUT' } }), false)).toBe('KeyV');
    expect(keyEventCode(ev({ ctrlKey: true }), true)).toBe('');
    expect(keyEventCode(ev({ ctrlKey: true }), false)).toBe('KeyV');
    expect(keyEventCode(ev({ code: 'Digit7', key: '/' }), true)).toBe(''); // the chat shortcut
    expect(mouseEventCode({ button: 3 } as MouseEvent)).toBe('Mouse3');
    expect(mouseEventCode({ button: 0 } as MouseEvent)).toBe('');
  });
});

function diag(over: Partial<VoiceDiagnostics> = {}, mic: Partial<VoiceDiagnostics['mic']> = {}): VoiceDiagnostics {
  return {
    at: 0,
    status: 'connected',
    statusText: '',
    room: { state: 'connected', url: 'wss://voice.example/livekit', region: null, serverVersion: '1.8.0', identity: 'c1', reconnects: 0, connectAttempts: 1, connectFailures: 0, connectedForS: 30 },
    token: { canPublish: true, canSubscribe: true, room: 'world-1', identity: 'c1', expiresInS: 3000 },
    listenOnly: false,
    listenOnlyReason: null,
    mic: { permission: 'granted', state: 'ready', muted: false, transmitting: false, talkMode: 'ptt', pttMode: 'hold', pttKey: 'KeyV', muteKey: 'Digit0', deviceLabel: 'Headset', devicePick: 'chosen', inputCount: 2, settings: null, inputGainDb: 0, boostActive: true, levelDb: -40, lastProblem: null, ...mic },
    output: { deviceLabel: 'Speakers', selectable: true, outputCount: 1 },
    audio: { contextState: 'running', sampleRate: 48000, baseLatencyMs: 10, outputLatencyMs: 20 },
    publisher: null,
    speakers: [],
    errors: [],
    browser: 'test',
    ...over,
  };
}

describe('guidance', () => {
  const ids = (d: VoiceDiagnostics) => voiceGuidance(d).map((t) => t.id);

  it('nothing to say when all is well', () => {
    expect(ids(diag())).toEqual([]);
  });

  it('permission denied, no device, busy, unplugged', () => {
    expect(ids(diag({}, { permission: 'denied', state: 'denied' }))).toContain('denied');
    expect(voiceGuidance(diag({}, { permission: 'denied' }))[0].text).toMatch(/address bar/);
    expect(ids(diag({}, { lastProblem: 'no-device', inputCount: 0 }))).toContain('no-device');
    expect(ids(diag({}, { lastProblem: 'busy' }))).toContain('busy');
    expect(ids(diag({}, { devicePick: 'fallback' }))).toContain('unplugged');
  });

  it('listen-only says why; a muted mic says how to unmute', () => {
    const lo = voiceGuidance(diag({ listenOnly: true, listenOnlyReason: 'A moderator muted you' }));
    expect(lo.find((t) => t.id === 'listen-only')?.text).toBe('A moderator muted you');
    expect(voiceGuidance(diag({}, { muted: true })).find((t) => t.id === 'muted')?.text).toMatch(/\(0 or the Mute button\)/);
  });

  it('server unreachable vs UDP blocked; TURN relay and TCP fallback explained', () => {
    expect(ids(diag({ status: 'error', statusText: 'websocket error; retrying in 4 s' }))).toContain('unreachable');
    const udp = voiceGuidance(diag({ status: 'error', statusText: 'could not establish pc connection; retrying in 2 s' }));
    expect(udp[0].id).toBe('udp');
    expect(udp[0].text).toMatch(/UDP .*7882/);
    const t = { localType: 'relay', remoteType: 'host', protocol: 'udp', relayProtocol: 'tcp', rttMs: 80, availableOutKbps: null };
    const pub = { ...parseAudioStats([{ id: 'o', type: 'outbound-rtp', kind: 'audio' }], 'out')!, bitrateKbps: 30, lossPct: 0, transport: t };
    expect(ids(diag({ publisher: pub }))).toContain('relay');
    expect(ids(diag({ publisher: { ...pub, transport: { ...t, localType: 'host', protocol: 'tcp' } } }))).toContain('tcp');
    expect(ids(diag({ publisher: { ...pub, lossPct: 12, rttMs: 450 } }))).toEqual(expect.arrayContaining(['loss', 'rtt']));
  });

  it('voice off or switched off on the server, suspended audio, silent mic', () => {
    expect(ids(diag({ status: 'off' }))).toContain('off');
    expect(ids(diag({ status: 'unavailable', statusText: 'voice is not available' }))).toContain('unavailable');
    expect(ids(diag({ audio: { contextState: 'suspended', sampleRate: 48000, baseLatencyMs: null, outputLatencyMs: null } }))).toContain('suspended');
    expect(ids(diag({}, { levelDb: -100 }))).toContain('silent');
  });
});

describe('diagnostics JSON', () => {
  it('ISO times, no query string on the URL, no token', () => {
    const d = diag({ at: Date.UTC(2026, 10, 10), room: { ...diag().room, url: 'wss://voice.example/rtc?access_token=SECRET' }, errors: [{ at: Date.UTC(2026, 10, 10), where: 'voice connect', message: 'x' }] });
    const j = diagnosticsJson(d);
    expect(j).not.toMatch(/SECRET/);
    const o = JSON.parse(j);
    expect(o.at).toBe('2026-11-10T00:00:00.000Z');
    expect(o.errors[0].at).toBe('2026-11-10T00:00:00.000Z');
    expect(o.room.url).toBe('wss://voice.example/rtc');
  });

  it('keeps the last dozen errors, without repeating one within 2 s', () => {
    clearVoiceErrors();
    recordVoiceError('microphone', Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    recordVoiceError('microphone', Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    expect(voiceErrors()).toHaveLength(1);
    expect(voiceErrors()[0].message).toBe('NotAllowedError: Permission denied');
    for (let i = 0; i < 20; i++) recordVoiceError('voice connect', `fail ${i}`);
    expect(voiceErrors()).toHaveLength(12);
    expect(voiceErrors().at(-1)!.message).toBe('fail 19');
  });
});

describe('talk controller hooks for the settings', () => {
  class Fake implements Mic {
    live = false;
    acquired = 0;
    acquire() {
      this.acquired++;
      return Promise.resolve();
    }
    setLive(l: boolean) {
      this.live = l;
      return Promise.resolve();
    }
  }

  it('muting stops a live microphone at once; unmuting in open-mic mode starts it', async () => {
    const mic = new Fake();
    let muted = false;
    const t = new TalkController(mic, () => {}, () => !muted, 'ptt');
    t.press();
    await t.settled();
    await t.settled();
    expect(mic.live).toBe(true);
    muted = true;
    t.refresh();
    await t.settled();
    expect(mic.live).toBe(false);
    expect(t.isHeld).toBe(false);
    const vad = new Fake();
    let m2 = true;
    const v = new TalkController(vad, () => {}, () => !m2, 'ptt');
    v.setMode('vad');
    await v.settled();
    expect(vad.acquired).toBe(0); // muted: never asks
    m2 = false;
    v.refresh();
    await v.settled();
    expect(vad.acquired).toBe(1);
  });

  it('isHeld lets a toggle key latch and unlatch', async () => {
    const mic = new Fake();
    const t = new TalkController(mic, () => {}, () => true, 'ptt');
    t.press();
    expect(t.isHeld).toBe(true);
    await t.settled();
    await t.settled();
    expect(mic.live).toBe(true);
    t.release();
    await t.settled();
    expect(mic.live).toBe(false);
    expect(t.retryMic()).toBe(true);
  });
});
