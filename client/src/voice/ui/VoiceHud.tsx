// Voice HUD (bottom right): the push-to-talk indicator, who you can hear
// right now with a live level bar each, and the voice settings (talk mode,
// volumes, per-player mute). Levels are written to the DOM by levels.ts
// (CSS --lvl, data-speaking), so talking never re-renders this component.

import { useEffect, useRef, type CSSProperties } from 'react';
import { SELF, voiceLevels } from '../levels';
import { applyVoicePrefs, setTalkMode } from '../runtime';
import { useVoiceStore, type SpeakerInfo } from '../store';
import { CORNER_BOTTOM } from '../../hud/layout'; // playtest 1: shared bottom layout

const glass: CSSProperties = {
  background: 'rgba(10,13,20,0.72)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: '#e9ecef',
  font: '13px system-ui, "Segoe UI", sans-serif',
  backdropFilter: 'blur(4px)',
};

/** A level bar whose fill follows --lvl (0-1); green while data-speaking="1". */
function LevelBar({ levelKey, testId, width = 64 }: { levelKey: string; testId?: string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? voiceLevels.bind(levelKey, ref.current) : undefined), [levelKey]);
  return (
    <div ref={ref} data-testid={testId} className="lodestone-voice-level" style={{ width, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: 'calc(var(--lvl, 0) * 100%)', background: 'var(--lvl-color, #74c0fc)', transition: 'width 60ms linear' }} />
    </div>
  );
}

function SpeakerRow({ s }: { s: SpeakerInfo }) {
  return (
    <div data-testid={`voice-speaker-${s.name}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
      {s.mode === 'radio' && <span style={{ fontSize: 11, opacity: 0.7, border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4, padding: '0 4px' }}>radio</span>}
      <LevelBar levelKey={s.name} testId={`voice-level-${s.name}`} />
    </div>
  );
}

function Settings() {
  const st = useVoiceStore();
  const names = [...new Set([...st.speakers.map((s) => s.name), ...Object.keys(st.volumes), ...Object.keys(st.muted)])].sort();
  const setVolume = (name: string, v: number) => {
    st.setPrefs({ volumes: { ...st.volumes, [name]: v } });
    applyVoicePrefs();
  };
  const setMuted = (name: string, m: boolean) => {
    const muted = { ...st.muted };
    if (m) muted[name] = true;
    else delete muted[name];
    st.setPrefs({ muted });
    applyVoicePrefs();
  };
  return (
    <div data-testid="voice-settings" style={{ ...glass, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, width: 260 }}>
      <strong style={{ fontSize: 13 }}>Voice</strong>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="radio" checked={st.talkMode === 'ptt'} onChange={() => setTalkMode('ptt')} /> Push to talk (hold V)
      </label>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="radio" data-testid="voice-mode-vad" checked={st.talkMode === 'vad'} onChange={() => setTalkMode('vad')} /> Voice activation (open mic)
      </label>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        Volume
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={st.masterVolume}
          onChange={(e) => {
            st.setPrefs({ masterVolume: Number(e.target.value) });
            applyVoicePrefs();
          }}
          style={{ flex: 1 }}
        />
      </label>
      {names.length > 0 && <div style={{ fontSize: 12, opacity: 0.7 }}>Players</div>}
      {names.map((n) => (
        <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n}</span>
          <input type="range" min={0} max={2} step={0.05} value={st.volumes[n] ?? 1} onChange={(e) => setVolume(n, Number(e.target.value))} style={{ flex: 1 }} aria-label={`${n} volume`} />
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={st.muted[n] === true} onChange={(e) => setMuted(n, e.target.checked)} /> mute
          </label>
        </div>
      ))}
      <div style={{ fontSize: 11, opacity: 0.6 }}>/mute Name stops someone everywhere (chat and voice); this mute is voice only, on this device.</div>
    </div>
  );
}

function micLabel(s: ReturnType<typeof useVoiceStore.getState>): string {
  if (s.status === 'off') return '';
  if (s.status === 'unavailable') return 'Voice unavailable';
  if (s.status === 'connecting') return 'Voice connecting…';
  if (s.status === 'reconnecting') return 'Voice reconnecting…';
  if (s.status === 'error') return 'Voice offline';
  if (s.listenOnly) return 'Listen-only';
  if (s.mic === 'requesting') return 'Allow the microphone…';
  if (s.mic === 'denied') return 'Microphone blocked';
  if (s.transmitting) return s.talkMode === 'ptt' ? 'Talking' : 'Open mic: talking';
  return s.talkMode === 'ptt' ? 'Hold V to talk' : 'Open mic';
}

export function VoiceHud() {
  const s = useVoiceStore();
  if (s.status === 'off') return null;
  const label = micLabel(s);
  return (
    <div style={{ position: 'fixed', right: 12, bottom: CORNER_BOTTOM, zIndex: 30, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <style>{'.lodestone-voice-level[data-speaking="1"]{--lvl-color:#51cf66}'}</style>
      {s.settingsOpen && <Settings />}
      {s.speakers.length > 0 && (
        <div data-testid="voice-speakers" style={{ ...glass, padding: '6px 10px', width: 200 }}>
          {s.speakers.map((sp) => (
            <SpeakerRow key={sp.id} s={sp} />
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div
          data-testid="voice-ptt"
          data-transmitting={s.transmitting ? '1' : '0'}
          title={s.statusText || label}
          style={{ ...glass, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, borderColor: s.transmitting ? 'rgba(81,207,102,0.9)' : 'rgba(255,255,255,0.08)' }}
        >
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.transmitting ? '#51cf66' : s.listenOnly || s.mic === 'denied' ? '#868e96' : '#495057' }} />
          <span>{label}</span>
          {!s.listenOnly && s.mic === 'ready' && <LevelBar levelKey={SELF} testId="voice-self-level" width={40} />}
        </div>
        <button data-testid="voice-settings-toggle" onClick={() => s.set({ settingsOpen: !s.settingsOpen })} style={{ ...glass, padding: '6px 9px', cursor: 'pointer' }} title="Voice settings">
          Voice
        </button>
      </div>
      {s.statusText && s.status !== 'connected' && <div style={{ ...glass, padding: '3px 8px', fontSize: 11, opacity: 0.8, maxWidth: 260 }}>{s.statusText}</div>}
    </div>
  );
}
