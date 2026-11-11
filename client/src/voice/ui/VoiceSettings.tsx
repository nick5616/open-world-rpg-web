// Playtest 2 voice settings: the Voice panel (the HUD's Voice button, the
// Sound panel's "Voice settings", the Esc menu's Voice row). Four tabs:
//
//   Microphone   device, speakers, input boost, push to talk (key, hold /
//                toggle) or open mic (threshold on a live meter, open-after,
//                hold-open), mute (key), browser processing, incoming volume
//   Test         mic test: live RMS / peak dBFS meter with a clip light, hear
//                yourself (optional delay), record 5 s and play it back
//   Players      everyone you can hear right now: level, volume, mute (saved
//                by character id); saved players who are not nearby
//   Diagnostics  connection, token grant, permission, devices, codec,
//                bitrate, loss, jitter, round trip, transport, speakers,
//                recent errors, guidance; Copy diagnostics, Reconnect voice
//
// Everything is saved (store.ts, localStorage) and applies at once
// (runtime.ts follows the store). Esc closes it (input/panelStack.ts).

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { showPanel, hidePanel, trackPanel } from '../../input/panelStack';
import { useAudioSettings } from '../../audio/settings';
import { getAudioContext } from '../../audio/context';
import { INPUT_GAIN_LIMITS, LOOPBACK_LIMITS, peerPref, useVoiceStore, withPeer, type SettingsTab, type VoicePrefs } from '../store';
import { reconnectVoice, retryVoiceMic, setTalkMode, voiceDiagnostics, voiceMicTap } from '../runtime';
import { applySink, deviceName, listDevices, onDeviceChange, outputSelectable, pickDevice, type DeviceLists } from '../devices';
import { DEFAULT_MUTE_KEY, DEFAULT_PTT_KEY, mouseEventCode, ROLE_LABEL, validateVoiceKey, voiceKeyLabel, type VoiceKeyRole } from '../keys';
import { VAD_LIMITS } from '../vad';
import { copyText, diagnosticsJson, type VoiceDiagnostics } from '../diag';
import { voiceGuidance, type Tip } from '../guidance';
import { fmtCodec, fmtDb, fmtKbps, fmtMs, fmtPct, fmtTransport, levelToDb, quality } from '../stats';
import { LevelMeter } from './LevelMeter';
import { playRecording, recordAndPlay, RECORD_MS, startMicTest, stopMicTest, useMicTest } from './micTestStore';
import { voiceLevels } from '../levels';

// Esc closes it when it is the top panel.
trackPanel(useVoiceStore, (s) => s.settingsOpen, 'voice', () => closeVoiceSettings());

export function openVoiceSettings(tab?: SettingsTab): void {
  const s = useVoiceStore.getState();
  s.set({ settingsOpen: true, ...(tab ? { settingsTab: tab } : {}) });
  // Free the mouse so the sliders work.
  if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

export function closeVoiceSettings(): void {
  useVoiceStore.getState().set({ settingsOpen: false });
}

const glass: CSSProperties = {
  background: 'rgba(10,13,20,0.92)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 10,
  color: '#e9ecef',
  font: '13px system-ui, "Segoe UI", sans-serif',
  boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
};
const BTN: CSSProperties = { padding: '4px 10px', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 5, background: 'rgba(255,255,255,0.06)', color: '#e9ecef', font: '12.5px system-ui, sans-serif', cursor: 'pointer' };
const ON: CSSProperties = { ...BTN, background: '#2b4f7a', borderColor: '#4dabf7' };
const SECTION: CSSProperties = { color: '#ffd166', font: '600 11.5px system-ui, sans-serif', letterSpacing: 0.5, textTransform: 'uppercase', margin: '14px 0 6px' };
const ROW: CSSProperties = { display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: 10, margin: '6px 0' };
const SELECT: CSSProperties = { width: '100%', padding: '4px 6px', background: 'rgba(255,255,255,0.06)', color: '#e9ecef', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 5, font: '12.5px system-ui, sans-serif' };
const HINT: CSSProperties = { fontSize: 11.5, opacity: 0.6, lineHeight: 1.35 };
export const KEYCAP: CSSProperties = { display: 'inline-block', minWidth: 16, padding: '0 6px', border: '1px solid rgba(255,255,255,0.4)', borderBottomWidth: 2, borderRadius: 4, background: 'rgba(255,255,255,0.07)', font: '600 11.5px/19px system-ui, sans-serif', textAlign: 'center', whiteSpace: 'nowrap' };

const set = (p: Partial<VoicePrefs>) => useVoiceStore.getState().setPrefs(p);

function useDevices(): DeviceLists & { refresh: () => void } {
  const [lists, setLists] = useState<DeviceLists>({ inputs: [], outputs: [] });
  const refresh = useCallback(() => void listDevices().then(setLists), []);
  const test = useMicTest((s) => s.test);
  const mic = useVoiceStore((s) => s.mic);
  useEffect(() => {
    refresh();
    return onDeviceChange(refresh);
  }, [refresh, test, mic]); // labels appear once a capture has permission
  return { ...lists, refresh };
}

/** The diagnostics snapshot, refreshed once a second while the panel is open. */
function useDiagnostics(): VoiceDiagnostics | null {
  const [d, setD] = useState<VoiceDiagnostics | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      void voiceDiagnostics().then((x) => {
        if (alive) setD(x);
      });
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return d;
}

/** The analyser the meters read: a running mic test, else the voice microphone. */
function meterSource(): AnalyserNode | null {
  return useMicTest.getState().test?.analyser ?? voiceMicTap().analyser;
}

function Slider({ label, value, min, max, step = 1, fmt, onChange, testId, hint }: { label: string; value: number; min: number; max: number; step?: number; fmt: (v: number) => string; onChange: (v: number) => void; testId?: string; hint?: string }) {
  return (
    <label style={ROW}>
      <span>
        {label}
        {hint && <span style={{ ...HINT, display: 'block' }}>{hint}</span>}
      </span>
      <span style={{ display: 'grid', gridTemplateColumns: '1fr 70px', alignItems: 'center', gap: 8 }}>
        <input data-testid={testId} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>{fmt(value)}</span>
      </span>
    </label>
  );
}

function Check({ label, checked, onChange, testId, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId?: string; hint?: string }) {
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '5px 0', cursor: 'pointer' }}>
      <input data-testid={testId} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>
        {label}
        {hint && <span style={{ ...HINT, display: 'block' }}>{hint}</span>}
      </span>
    </label>
  );
}

/** A voice key with a Change button: the next key (or mouse side button) becomes the binding, if no other feature uses it. */
function KeyField({ role }: { role: VoiceKeyRole }) {
  const s = useVoiceStore();
  const code = role === 'ptt' ? s.pttKey : s.muteKey;
  const other = role === 'ptt' ? s.muteKey : s.pttKey;
  const [capturing, setCapturing] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!capturing) return;
    const id = `voice-key-${role}`;
    // Esc cancels (the Esc menu's listener pops this off the panel stack first).
    showPanel(id, () => setCapturing(false));
    const take = (c: string) => {
      const v = validateVoiceKey(c, role, other);
      if (!v.ok) return setErr(v.reason);
      setErr('');
      set(role === 'ptt' ? { pttKey: c } : { muteKey: c });
      setCapturing(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keydown' && !e.repeat) take(e.code);
    };
    const onMouse = (e: MouseEvent) => {
      const c = mouseEventCode(e);
      if (!c) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      take(c);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    return () => {
      hidePanel(id);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
    };
  }, [capturing, role, other]);
  const def = role === 'ptt' ? DEFAULT_PTT_KEY : DEFAULT_MUTE_KEY;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span data-testid={`voice-key-${role}`} style={{ ...KEYCAP, minWidth: 30, background: capturing ? '#2b4f7a' : KEYCAP.background }}>
          {capturing ? 'press a key…' : voiceKeyLabel(code)}
        </span>
        <button data-testid={`voice-key-${role}-change`} tabIndex={-1} style={BTN} onClick={() => (setErr(''), setCapturing(!capturing))}>
          {capturing ? 'Cancel' : 'Change'}
        </button>
        {code !== def && !capturing && (
          <button tabIndex={-1} style={BTN} onClick={() => set(role === 'ptt' ? { pttKey: def } : { muteKey: def })}>
            Reset ({voiceKeyLabel(def)})
          </button>
        )}
      </div>
      {capturing && <div style={HINT}>Press the key (or a mouse side button) to {ROLE_LABEL[role]}. Esc cancels.</div>}
      {err && (
        <div data-testid={`voice-key-${role}-error`} style={{ fontSize: 11.5, color: '#ff8787', marginTop: 3 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function Tips({ tips, max }: { tips: Tip[]; max?: number }) {
  const shown = max ? tips.slice(0, max) : tips;
  if (!shown.length) return null;
  const color = { error: '#ff6b6b', warn: '#ffd43b', info: '#74c0fc' } as const;
  return (
    <div data-testid="voice-guidance" style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0' }}>
      {shown.map((t) => (
        <div key={t.id} data-testid={`voice-tip-${t.id}`} style={{ borderLeft: `3px solid ${color[t.level]}`, background: 'rgba(255,255,255,0.04)', padding: '6px 9px', borderRadius: 4 }}>
          <div style={{ fontWeight: 600, color: color[t.level] }}>{t.title}</div>
          <div style={{ ...HINT, opacity: 0.8 }}>{t.text}</div>
        </div>
      ))}
    </div>
  );
}

function MicTab({ diag }: { diag: VoiceDiagnostics | null }) {
  const s = useVoiceStore();
  const dev = useDevices();
  const test = useMicTest((t) => t.test);
  const starting = useMicTest((t) => t.starting);
  const inPick = pickDevice(dev.inputs, s.inputDevice);
  const outPick = pickDevice(dev.outputs, s.outputDevice);
  const noLabels = dev.inputs.length > 0 && dev.inputs.every((d) => !d.label);
  const haveMeter = !!test || !!voiceMicTap().analyser;
  const tips = diag ? voiceGuidance(diag).filter((t) => t.level !== 'info') : [];
  const restartsNote = 'Applies at once (the microphone restarts).';
  const voiceBus = useAudioSettings((a) => a.volumes.voice);
  return (
    <div>
      <Tips tips={tips} max={2} />
      <div style={SECTION}>Devices</div>
      <label style={ROW}>
        <span>Microphone</span>
        <select
          data-testid="voice-input-device"
          style={SELECT}
          value={s.inputDevice?.id && dev.inputs.some((d) => d.deviceId === s.inputDevice!.id) ? s.inputDevice.id : inPick.deviceId}
          onChange={(e) => {
            const d = dev.inputs.find((x) => x.deviceId === e.target.value);
            set({ inputDevice: !d || d.deviceId === 'default' ? null : { id: d.deviceId, label: d.label } });
          }}
        >
          {dev.inputs.length === 0 && <option value="">No microphone found</option>}
          {dev.inputs.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {deviceName(d, i, 'input')}
            </option>
          ))}
        </select>
      </label>
      {inPick.status === 'fallback' && <div style={{ ...HINT, color: '#ffd43b', opacity: 1 }}>{s.inputDevice?.label || 'Your microphone'} is unplugged: using {inPick.label || 'the default'} until it is back.</div>}
      {noLabels && <div style={HINT}>Device names appear once the browser may use the microphone (press Start meter or your talk key).</div>}
      <label style={ROW}>
        <span>Speakers</span>
        {outputSelectable() ? (
          <select
            data-testid="voice-output-device"
            style={SELECT}
            value={s.outputDevice?.id && dev.outputs.some((d) => d.deviceId === s.outputDevice!.id) ? s.outputDevice.id : outPick.deviceId}
            onChange={(e) => {
              const d = dev.outputs.find((x) => x.deviceId === e.target.value);
              const pref = !d || d.deviceId === 'default' ? null : { id: d.deviceId, label: d.label };
              set({ outputDevice: pref });
              void applySink(getAudioContext(), pref); // the game's sound follows even without a voice session
            }}
          >
            {dev.outputs.length === 0 && <option value="">System default</option>}
            {dev.outputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {deviceName(d, i, 'output')}
              </option>
            ))}
          </select>
        ) : (
          <span style={HINT}>This browser plays sound on the system default output (choose it in your system settings).</span>
        )}
      </label>
      {outputSelectable() && <div style={HINT}>Game sound and voice share this output.</div>}

      <div style={SECTION}>Input level</div>
      <LevelMeter source={meterSource} vad={s.talkMode === 'vad'} idleText={starting ? 'Asking for the microphone…' : 'Press Start meter to see your level'} />
      <div style={{ display: 'flex', gap: 8, margin: '6px 0' }}>
        {!haveMeter && (
          <button data-testid="voice-meter-start" tabIndex={-1} style={BTN} onClick={() => void startMicTest()}>
            Start meter
          </button>
        )}
        {test && (
          <button tabIndex={-1} style={BTN} onClick={stopMicTest}>
            Stop meter
          </button>
        )}
        {(s.mic === 'denied' || diag?.mic.lastProblem) && (
          <button data-testid="voice-retry-mic" tabIndex={-1} style={BTN} onClick={() => (retryVoiceMic(), void startMicTest())}>
            Retry microphone
          </button>
        )}
      </div>
      <Slider label="Input boost" testId="voice-input-gain" value={s.inputGainDb} min={INPUT_GAIN_LIMITS[0]} max={INPUT_GAIN_LIMITS[1]} step={1} fmt={(v) => `${v > 0 ? '+' : ''}${v} dB`} onChange={(v) => set({ inputGainDb: v })} hint="before sending" />

      <div style={SECTION}>Talking</div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0' }}>
        <input type="radio" data-testid="voice-mode-ptt" checked={s.talkMode === 'ptt'} onChange={() => setTalkMode('ptt')} /> Push to talk
      </label>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0' }}>
        <input type="radio" data-testid="voice-mode-vad" checked={s.talkMode === 'vad'} onChange={() => setTalkMode('vad')} /> Open mic (voice activation)
      </label>
      {s.talkMode === 'ptt' ? (
        <>
          <div style={ROW}>
            <span>Talk key</span>
            <KeyField role="ptt" />
          </div>
          <div style={ROW}>
            <span>Key works as</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button data-testid="voice-ptt-hold" tabIndex={-1} style={s.pttMode === 'hold' ? ON : BTN} onClick={() => set({ pttMode: 'hold' })}>
                Hold to talk
              </button>
              <button data-testid="voice-ptt-toggle" tabIndex={-1} style={s.pttMode === 'toggle' ? ON : BTN} onClick={() => set({ pttMode: 'toggle' })}>
                Toggle (tap on / off)
              </button>
            </span>
          </div>
        </>
      ) : (
        <>
          <Slider label="Threshold" testId="voice-vad-threshold" value={s.vadThresholdDb} min={VAD_LIMITS.thresholdDb[0]} max={VAD_LIMITS.thresholdDb[1]} fmt={(v) => `${v} dBFS`} onChange={(v) => set({ vadThresholdDb: v })} hint="the blue line: drag it on the meter" />
          <Slider label="Open after" testId="voice-vad-attack" value={s.vadAttackMs} min={VAD_LIMITS.attackMs[0]} max={VAD_LIMITS.attackMs[1]} step={10} fmt={(v) => `${v} ms`} onChange={(v) => set({ vadAttackMs: v })} hint="ignores clicks and bumps" />
          <Slider label="Hold open" testId="voice-vad-release" value={s.vadReleaseMs} min={VAD_LIMITS.releaseMs[0]} max={VAD_LIMITS.releaseMs[1]} step={50} fmt={(v) => `${v} ms`} onChange={(v) => set({ vadReleaseMs: v })} hint="keeps pauses between words" />
        </>
      )}
      <div style={ROW}>
        <span>Microphone</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button data-testid="voice-mic-mute" tabIndex={-1} style={s.micMuted ? { ...ON, background: '#7a2b2b', borderColor: '#ff6b6b' } : BTN} onClick={() => set({ micMuted: !s.micMuted })}>
            {s.micMuted ? 'Muted: click to unmute' : 'Mute microphone'}
          </button>
        </span>
      </div>
      <div style={ROW}>
        <span>Mute key</span>
        <KeyField role="mute" />
      </div>

      <div style={SECTION}>Browser processing</div>
      <Check label="Echo cancellation" testId="voice-ec" checked={s.echoCancellation} onChange={(v) => set({ echoCancellation: v })} hint="stops others hearing themselves through your speakers" />
      <Check label="Noise suppression" testId="voice-ns" checked={s.noiseSuppression} onChange={(v) => set({ noiseSuppression: v })} hint="fans, keyboards, traffic" />
      <Check label="Automatic gain" testId="voice-agc" checked={s.autoGainControl} onChange={(v) => set({ autoGainControl: v })} hint="evens out loud and quiet; turn off to set the level yourself with the boost" />
      <div style={HINT}>{restartsNote}</div>

      <div style={SECTION}>Hearing</div>
      <Slider label="Incoming voices" testId="voice-master" value={Math.round(s.masterVolume * 100)} min={0} max={200} step={5} fmt={(v) => `${v} %`} onChange={(v) => set({ masterVolume: v / 100 })} />
      <div style={HINT}>
        Also Sound (K) &gt; Voice chat: {Math.round(voiceBus * 100)} %. Per-player volume: the Players tab.
      </div>
    </div>
  );
}

function TestTab() {
  const s = useVoiceStore();
  const t = useMicTest();
  const sec = Math.ceil(t.recordLeftMs / 1000);
  const problem = t.problem;
  const problemText: Record<string, string> = {
    denied: 'The browser blocked the microphone: allow it in the address bar (lock icon) and try again.',
    'no-device': 'No microphone found: plug one in.',
    busy: 'The microphone is busy (another app) or failed to start.',
    constraints: 'The chosen microphone is not available: pick another.',
    insecure: 'Microphones need an https:// page.',
    other: t.error,
  };
  return (
    <div>
      <div style={HINT}>Your own microphone with the settings from the Microphone tab. Nothing here is sent to anyone.</div>
      <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
        {t.test ? (
          <button data-testid="voice-test-stop" tabIndex={-1} style={ON} onClick={stopMicTest}>
            Stop mic test
          </button>
        ) : (
          <button data-testid="voice-test-start" tabIndex={-1} style={BTN} disabled={t.starting} onClick={() => void startMicTest()}>
            {t.starting ? 'Asking for the microphone…' : 'Test mic'}
          </button>
        )}
      </div>
      {problem && <div style={{ color: '#ff8787', fontSize: 12, margin: '4px 0' }}>{problemText[problem] || t.error}</div>}
      <LevelMeter source={() => useMicTest.getState().test?.analyser ?? null} vad={s.talkMode === 'vad'} idleText="Press Test mic" testId="voice-test-meter" height={24} />
      <div style={SECTION}>Hear yourself</div>
      <Check
        label="Play my microphone back to me"
        testId="voice-loopback"
        checked={t.loopback}
        onChange={(v) => {
          t.set({ loopback: v });
          const go = (x: typeof t.test) => x?.setLoopback(v, s.loopbackDelayMs);
          if (t.test) go(t.test);
          else if (v) void startMicTest().then(go);
        }}
        hint="use headphones, or your speakers feed back into the microphone"
      />
      <Slider label="Delay" testId="voice-loopback-delay" value={s.loopbackDelayMs} min={LOOPBACK_LIMITS[0]} max={LOOPBACK_LIMITS[1]} step={50} fmt={(v) => (v ? `${v} ms` : 'none')} onChange={(v) => set({ loopbackDelayMs: v })} hint="a delay makes it easier to listen to yourself" />
      <div style={SECTION}>Record and play back</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button data-testid="voice-record" tabIndex={-1} style={t.phase === 'recording' ? ON : BTN} disabled={t.phase === 'recording' || t.phase === 'playing'} onClick={() => void recordAndPlay()}>
          {t.phase === 'recording' ? `Recording… ${sec} s` : `Record ${RECORD_MS / 1000} s`}
        </button>
        {t.recording && (
          <button data-testid="voice-playback" tabIndex={-1} style={BTN} disabled={t.phase === 'playing' || t.phase === 'recording'} onClick={() => void playRecording()}>
            {t.phase === 'playing' ? 'Playing…' : 'Play again'}
          </button>
        )}
        <span data-testid="voice-record-phase" data-phase={t.phase} style={HINT}>
          {t.phase === 'recording' ? 'Say something!' : t.phase === 'playing' ? 'This is how you sound to others (before the network).' : t.recording ? `${(t.recording.size / 1024).toFixed(0)} KB recorded` : ''}
        </span>
      </div>
    </div>
  );
}

function PeerBar({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? voiceLevels.bind(name, ref.current) : undefined), [name]);
  return (
    <div ref={ref} className="lodestone-voice-level" style={{ width: 50, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: 'calc(var(--lvl, 0) * 100%)', background: 'var(--lvl-color, #74c0fc)' }} />
    </div>
  );
}

function PlayersTab({ diag }: { diag: VoiceDiagnostics | null }) {
  const s = useVoiceStore();
  const near = s.speakers;
  const nearIds = new Set(near.map((p) => p.id));
  const saved = Object.entries(s.peers).filter(([id]) => !nearIds.has(id));
  const legacy = [...new Set([...Object.keys(s.volumes), ...Object.keys(s.muted)])].filter((n) => !near.some((p) => p.name === n));
  const change = (id: string, name: string, c: { volume?: number; muted?: boolean }) => set(withPeer(s, id, name, c));
  const dist = (id: string) => diag?.speakers.find((x) => x.id === id)?.distance;
  return (
    <div>
      <div style={HINT}>Everyone you can hear right now (nearby, or your party on the radio). Volume and mute are yours only, saved on this device per player.</div>
      {near.length === 0 && (
        <div data-testid="voice-players-empty" style={{ margin: '14px 0', opacity: 0.7 }}>
          Nobody in earshot. Players appear here as they come within about 40 m.
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        {near.map((p) => {
          const pref = peerPref(s, p.id, p.name);
          const d = dist(p.id);
          return (
            <div key={p.id} data-testid={`voice-peer-${p.name}`} style={{ display: 'grid', gridTemplateColumns: '1fr 50px 1.2fr 46px 60px', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
                <span style={{ ...HINT, marginLeft: 6 }}>{p.mode === 'radio' ? 'radio' : d !== null && d !== undefined ? `${Math.round(d)} m` : ''}</span>
              </span>
              <PeerBar name={p.name} />
              <input type="range" aria-label={`${p.name} volume`} data-testid={`voice-peer-volume-${p.name}`} min={0} max={200} step={5} value={Math.round(pref.volume * 100)} onChange={(e) => change(p.id, p.name, { volume: Number(e.target.value) / 100 })} />
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>{Math.round(pref.volume * 100)} %</span>
              <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" data-testid={`voice-peer-mute-${p.name}`} checked={pref.muted} onChange={(e) => change(p.id, p.name, { muted: e.target.checked })} /> mute
              </label>
            </div>
          );
        })}
      </div>
      {(saved.length > 0 || legacy.length > 0) && (
        <>
          <div style={SECTION}>Saved, not nearby</div>
          {saved.map(([id, p]) => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
              <span style={{ flex: 1 }}>{p.name}</span>
              <span style={HINT}>
                {p.muted ? 'muted' : ''} {Math.round(p.volume * 100)} %
              </span>
              <button tabIndex={-1} style={BTN} onClick={() => change(id, p.name, { volume: 1, muted: false })}>
                Reset
              </button>
            </div>
          ))}
          {legacy.map((n) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
              <span style={{ flex: 1 }}>{n}</span>
              <span style={HINT}>
                {s.muted[n] ? 'muted' : ''} {Math.round((s.volumes[n] ?? 1) * 100)} %
              </span>
              <button tabIndex={-1} style={BTN} onClick={() => change(`name:${n}`, n, { volume: 1, muted: false })}>
                Reset
              </button>
            </div>
          ))}
        </>
      )}
      <div style={{ ...HINT, marginTop: 10 }}>/mute Name in chat stops someone everywhere (chat and voice, server-side); this mute is voice only, on this device.</div>
    </div>
  );
}

function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '2px 10px', fontSize: 12.5 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span style={{ opacity: 0.6 }}>{k}</span>
          <span data-testid={`diag-${k.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} style={{ fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}

const yes = (v: boolean | null | undefined) => (v === undefined || v === null ? '–' : v ? 'yes' : 'no');
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

function DiagTab({ diag }: { diag: VoiceDiagnostics | null }) {
  const [copied, setCopied] = useState('');
  if (!diag) return <div style={{ opacity: 0.7 }}>Collecting…</div>;
  const d = diag;
  const pub = d.publisher;
  const q = quality(pub);
  const mic = d.mic;
  const st = mic.settings;
  const statusWord: Record<string, string> = { off: 'not running', connecting: 'connecting', connected: 'connected', reconnecting: 'reconnecting', unavailable: 'unavailable on this server', error: 'offline (retrying)' };
  return (
    <div data-testid="voice-diagnostics">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 8px' }}>
        <button
          data-testid="voice-diag-copy"
          tabIndex={-1}
          style={BTN}
          onClick={() =>
            void copyText(diagnosticsJson(d)).then((ok) => {
              setCopied(ok ? 'Copied to the clipboard' : 'Could not copy (the browser refused)');
              setTimeout(() => setCopied(''), 2500);
            })
          }
        >
          Copy diagnostics
        </button>
        <button data-testid="voice-diag-reconnect" tabIndex={-1} style={BTN} disabled={d.status === 'off'} onClick={() => reconnectVoice()}>
          Reconnect voice
        </button>
        <span data-testid="voice-diag-copied" style={HINT}>
          {copied}
        </span>
        <span style={{ marginLeft: 'auto', ...HINT }}>updates every second</span>
      </div>
      <Tips tips={voiceGuidance(d)} />
      <div style={SECTION}>Connection</div>
      <KV
        rows={[
          ['Voice', `${statusWord[d.status] ?? d.status}${d.statusText && d.status !== 'connected' ? `: ${d.statusText}` : ''}`],
          ['Room state', d.room.state ?? '–'],
          ['Server', d.room.url ? d.room.url.replace(/[?#].*$/, '') : '–'],
          ['Region', d.room.region ?? '– (single server)'],
          ['Server version', d.room.serverVersion ?? '–'],
          ['Connected for', d.room.connectedForS !== null ? `${d.room.connectedForS} s` : '–'],
          ['Reconnects', String(d.room.reconnects)],
          ['Attempts / failures', `${d.room.connectAttempts} / ${d.room.connectFailures}`],
          ['Quality', q],
        ]}
      />
      <div style={SECTION}>Permissions</div>
      <KV
        rows={[
          ['May talk (token)', d.token ? yes(d.token.canPublish !== false) : '–'],
          ['May listen (token)', d.token ? yes(d.token.canSubscribe !== false) : '–'],
          ['Listen-only', d.listenOnly ? `yes: ${d.listenOnlyReason ?? ''}` : 'no'],
          ['Voice room', d.token?.room ?? '–'],
          ['Identity', d.room.identity ?? d.token?.identity ?? '–'],
          ['Pass expires in', d.token?.expiresInS !== null && d.token?.expiresInS !== undefined ? `${Math.round(d.token.expiresInS / 60)} min` : '–'],
          ['Mic permission', mic.permission],
        ]}
      />
      <div style={SECTION}>Microphone</div>
      <KV
        rows={[
          ['State', `${mic.state}${mic.muted ? ', muted' : ''}${mic.transmitting ? ', sending' : ''}`],
          ['Talk mode', mic.talkMode === 'ptt' ? `push to talk (${voiceKeyLabel(mic.pttKey)}, ${mic.pttMode})` : 'open mic'],
          ['Device', `${mic.deviceLabel || 'system default'}${mic.devicePick === 'fallback' ? ' (stand-in: yours is unplugged)' : mic.devicePick === 'matched-label' ? ' (found by name)' : ''}`],
          ['Microphones found', String(mic.inputCount)],
          ['Sample rate', st?.sampleRate ? `${st.sampleRate} Hz` : d.audio.sampleRate ? `${d.audio.sampleRate} Hz (audio context)` : '–'],
          ['Channels', st?.channelCount ? String(st.channelCount) : '–'],
          ['Echo / noise / gain', st ? `${yes(st.echoCancellation)} / ${yes(st.noiseSuppression)} / ${yes(st.autoGainControl)}` : '–'],
          ['Capture latency', st?.latencyMs !== undefined ? fmtMs(st.latencyMs) : '–'],
          ['Input boost', `${mic.inputGainDb > 0 ? '+' : ''}${mic.inputGainDb} dB${mic.state === 'ready' && !mic.boostActive ? ' (not applied: the browser refused the processor)' : ''}`],
          ['Level here', fmtDb(mic.levelDb)],
        ]}
      />
      <div style={SECTION}>Sending</div>
      <KV
        rows={[
          ['Codec', fmtCodec(pub)],
          ['Bitrate', fmtKbps(pub?.bitrateKbps)],
          ['Packet loss', pub ? `${fmtPct(pub.lossPct)} (${pub.packetsLost} lost of ${pub.packets})` : '–'],
          ['Jitter', fmtMs(pub?.jitterMs)],
          ['Round trip', fmtMs(pub?.rttMs ?? pub?.transport?.rttMs)],
          ['Path', fmtTransport(pub?.transport ?? d.speakers.find((x) => x.stats?.transport)?.stats?.transport)],
          ['Level sent', pub?.audioLevel !== null && pub?.audioLevel !== undefined ? fmtDb(levelToDb(pub.audioLevel)) : '–'],
        ]}
      />
      <div style={SECTION}>Output</div>
      <KV
        rows={[
          ['Speakers', d.output.deviceLabel || 'system default'],
          ['Audio context', d.audio.contextState ? `${d.audio.contextState}, ${d.audio.sampleRate} Hz` : 'not started (no sound yet)'],
          ['Output latency', fmtMs(d.audio.outputLatencyMs ?? d.audio.baseLatencyMs)],
        ]}
      />
      <div style={SECTION}>Hearing ({d.speakers.length} in earshot)</div>
      {d.speakers.length === 0 ? (
        <div style={HINT}>Nobody subscribed right now.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table data-testid="voice-diag-speakers" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr style={{ opacity: 0.6, textAlign: 'left' }}>
                {['Player', 'How', 'Dist', 'Level', 'Codec', 'Bitrate', 'Loss', 'Jitter', 'Concealed'].map((h) => (
                  <th key={h} style={{ fontWeight: 400, padding: '2px 6px 2px 0' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.speakers.map((sp) => (
                <tr key={sp.id} data-testid={`diag-speaker-${sp.name}`}>
                  <td style={{ padding: '2px 6px 2px 0' }}>
                    {sp.name}
                    {sp.muted ? ' (muted)' : ''}
                  </td>
                  <td>{sp.mode}</td>
                  <td>{sp.distance !== null ? `${Math.round(sp.distance)} m` : '–'}</td>
                  <td>{sp.levelDb !== null ? `${sp.levelDb.toFixed(0)} dB` : '–'}</td>
                  <td>{sp.stats?.codec ?? '–'}</td>
                  <td>{fmtKbps(sp.stats?.bitrateKbps)}</td>
                  <td>{fmtPct(sp.stats?.lossPct)}</td>
                  <td>{fmtMs(sp.stats?.jitterMs)}</td>
                  <td>{fmtPct(sp.stats?.concealedPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={SECTION}>Recent errors</div>
      {d.errors.length === 0 ? (
        <div style={HINT}>None.</div>
      ) : (
        <div data-testid="voice-diag-errors" style={{ fontSize: 12 }}>
          {[...d.errors].reverse().map((e, i) => (
            <div key={i} style={{ padding: '2px 0' }}>
              <span style={{ opacity: 0.55 }}>{ago(e.at)}</span> <span style={{ opacity: 0.8 }}>{e.where}:</span> {e.message}
            </div>
          ))}
        </div>
      )}
      <div style={{ ...HINT, marginTop: 10 }}>Copy diagnostics copies all of this as JSON (no passwords, tokens or addresses) to paste into a bug report.</div>
    </div>
  );
}

const TABS: [SettingsTab, string][] = [
  ['mic', 'Microphone'],
  ['test', 'Test'],
  ['players', 'Players'],
  ['diag', 'Diagnostics'],
];

function statusChip(s: ReturnType<typeof useVoiceStore.getState>): { text: string; color: string } {
  if (s.status === 'off') return { text: 'voice off', color: '#868e96' };
  if (s.status === 'connected') {
    if (s.listenOnly) return { text: 'listen-only', color: '#ffd43b' };
    if (s.micMuted) return { text: 'mic muted', color: '#ff8787' };
    return { text: s.transmitting ? 'sending' : 'connected', color: '#51cf66' };
  }
  if (s.status === 'connecting' || s.status === 'reconnecting') return { text: s.status, color: '#74c0fc' };
  return { text: s.status === 'unavailable' ? 'unavailable' : 'offline', color: '#ff6b6b' };
}

export function VoiceSettings() {
  const s = useVoiceStore();
  if (!s.settingsOpen) return null;
  return <Panel />;
}

function Panel() {
  const s = useVoiceStore();
  const diag = useDiagnostics();
  const chip = statusChip(s);
  useEffect(() => {
    if (!s.notice) return;
    const id = setTimeout(() => useVoiceStore.getState().set({ notice: '' }), 6000);
    return () => clearTimeout(id);
  }, [s.notice]);
  return (
    <div
      data-testid="voice-settings"
      data-ui-panel
      onContextMenu={(e) => e.preventDefault()}
      style={{ ...glass, position: 'fixed', right: 12, top: 46, zIndex: 32, width: 'min(560px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 110px)', display: 'flex', flexDirection: 'column', pointerEvents: 'auto' }}
    >
      <style>{'.lodestone-voice-level[data-speaking="1"]{--lvl-color:#51cf66}'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px 0' }}>
        <strong style={{ font: '18px Georgia, serif' }}>Voice</strong>
        <span data-testid="voice-settings-status" style={{ fontSize: 11.5, padding: '1px 7px', borderRadius: 10, border: `1px solid ${chip.color}`, color: chip.color }}>
          {chip.text}
        </span>
        <span style={{ marginLeft: 'auto', ...HINT }}>Esc closes</span>
        <button data-testid="voice-settings-close" tabIndex={-1} style={{ ...BTN, padding: '2px 8px' }} onClick={closeVoiceSettings} aria-label="Close">
          ×
        </button>
      </div>
      <div role="tablist" style={{ display: 'flex', gap: 4, padding: '10px 14px 0', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={s.settingsTab === id}
            data-testid={`voice-tab-${id}`}
            tabIndex={-1}
            onClick={() => s.set({ settingsTab: id })}
            style={{ ...BTN, borderRadius: '6px 6px 0 0', borderBottom: 'none', background: s.settingsTab === id ? 'rgba(77,171,247,0.18)' : 'transparent', color: s.settingsTab === id ? '#fff' : 'rgba(233,236,239,0.75)' }}
          >
            {label}
            {id === 'players' && s.speakers.length > 0 ? ` (${s.speakers.length})` : ''}
          </button>
        ))}
      </div>
      {s.notice && (
        <div data-testid="voice-notice" style={{ margin: '8px 14px 0', padding: '5px 9px', borderRadius: 4, background: 'rgba(255,212,59,0.12)', color: '#ffe066', fontSize: 12 }}>
          {s.notice}
        </div>
      )}
      <div style={{ padding: '4px 14px 12px', overflowY: 'auto' }}>
        {s.settingsTab === 'mic' && <MicTab diag={diag} />}
        {s.settingsTab === 'test' && <TestTab />}
        {s.settingsTab === 'players' && <PlayersTab diag={diag} />}
        {s.settingsTab === 'diag' && <DiagTab diag={diag} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px 10px', borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: 11.5, opacity: 0.75 }}>
        <span>
          Talk: <span style={KEYCAP}>{voiceKeyLabel(s.pttKey)}</span> · Mute: <span style={KEYCAP}>{voiceKeyLabel(s.muteKey)}</span> · saved on this device
        </span>
        <button data-silent tabIndex={-1} style={{ ...BTN, marginLeft: 'auto', fontSize: 11 }} onClick={() => useVoiceStore.getState().resetPrefs()} title="Microphone, keys and open-mic settings back to defaults (player volumes stay)">
          Defaults
        </button>
      </div>
    </div>
  );
}
