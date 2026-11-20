// Voice HUD (bottom right): the push-to-talk indicator, who you can hear
// right now with a live level bar each, and the Voice button that opens the
// voice settings (ui/VoiceSettings.tsx: microphone, mic test, players,
// diagnostics; also in the Esc menu and the Sound panel). Levels are written
// to the DOM by levels.ts (CSS --lvl, data-speaking), so talking never
// re-renders this component.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { SELF, voiceLevels } from '../levels';
import { useVoiceStore, type SpeakerInfo } from '../store';
import { voiceKeyLabel } from '../keys';
import { registerMenuEntry } from '../../ui/menu/store';
import { CORNER_BOTTOM_RIGHT } from '../../hud/layout'; // playtest 1: shared bottom layout (right corner clears the hosting badge)
import { closeVoiceSettings, openVoiceSettings, VoiceSettings } from './VoiceSettings';

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

function micLabel(s: ReturnType<typeof useVoiceStore.getState>): string {
  if (s.status === 'off') return '';
  if (s.status === 'unavailable') return 'Voice unavailable';
  if (s.status === 'connecting') return 'Voice connecting…';
  if (s.status === 'reconnecting') return 'Voice reconnecting…';
  if (s.status === 'error') return 'Voice offline';
  if (s.listenOnly) return 'Listen-only';
  if (s.micMuted) return `Mic muted (${voiceKeyLabel(s.muteKey)})`;
  if (s.mic === 'requesting') return 'Allow the microphone…';
  if (s.mic === 'denied') return 'Microphone blocked';
  if (s.transmitting) return s.talkMode === 'ptt' ? 'Talking' : 'Open mic: talking';
  if (s.talkMode === 'vad') return 'Open mic';
  const key = voiceKeyLabel(s.pttKey);
  return s.pttMode === 'toggle' ? `Press ${key} to talk` : `Hold ${key} to talk`;
}

/**
 * The short line under the voice buttons while voice is not connected
 * (playtest 6 polish: the corner showed the raw LiveKit error, "could not
 * establish signal connection: Failed to fetch; retrying in 30 s", for as
 * long as voice was down). The raw reason stays in the tooltip and in the
 * voice settings' diagnostics.
 */
export function hudStatusLine(status: string, statusText: string): string {
  if (!statusText || status === 'connected' || status === 'off') return '';
  if (status === 'error') return "Can't reach voice chat; trying again. Voice button: details";
  return statusText;
}

/** How long the status line stays after voice goes down (ms); the label keeps saying "Voice offline". */
export const STATUS_LINE_MS = 10000;

export function VoiceHud() {
  const s = useVoiceStore();
  // The status line shows for a while each time voice goes down, not for good.
  // Retries flip error -> connecting -> error; the line shows once per outage (until voice connects again).
  const [lineUntil, setLineUntil] = useState(0);
  const announced = useRef(false);
  const down = s.status === 'error' || s.status === 'unavailable';
  useEffect(() => {
    if (s.status === 'connected') announced.current = false;
  }, [s.status]);
  useEffect(() => {
    if (!down || announced.current) return;
    announced.current = true;
    setLineUntil(Date.now() + STATUS_LINE_MS);
  }, [down]);
  useEffect(() => {
    if (!lineUntil) return;
    const id = setTimeout(() => setLineUntil(0), Math.max(0, lineUntil - Date.now()));
    return () => clearTimeout(id);
  }, [lineUntil]);
  const statusLine = hudStatusLine(s.status, s.statusText);
  const showLine = statusLine !== '' && (!down || lineUntil > 0);
  // The Esc menu's Voice row (works offline too: devices and the mic test).
  useEffect(() => registerMenuEntry({ id: 'voice', label: 'Voice', order: 11, open: () => openVoiceSettings() }), []);
  // A runtime notice (mic muted, device unplugged) fades after a few seconds while the settings are closed.
  useEffect(() => {
    if (!s.notice || s.settingsOpen) return;
    const id = setTimeout(() => useVoiceStore.getState().set({ notice: '' }), 4000);
    return () => clearTimeout(id);
  }, [s.notice, s.settingsOpen]);
  const label = micLabel(s);
  return (
    <>
      <VoiceSettings />
      {s.status !== 'off' && (
        <div style={{ position: 'fixed', right: 12, bottom: CORNER_BOTTOM_RIGHT, zIndex: 30, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <style>{'.lodestone-voice-level[data-speaking="1"]{--lvl-color:#51cf66}'}</style>
          {s.speakers.length > 0 && (
            <div data-testid="voice-speakers" style={{ ...glass, padding: '6px 10px', width: 200 }}>
              {s.speakers.map((sp) => (
                <SpeakerRow key={sp.id} s={sp} />
              ))}
            </div>
          )}
          {s.notice && !s.settingsOpen && (
            <div data-testid="voice-hud-notice" style={{ ...glass, padding: '3px 8px', fontSize: 11.5, color: '#ffe066', maxWidth: 260 }}>
              {s.notice}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div
              data-testid="voice-ptt"
              data-transmitting={s.transmitting ? '1' : '0'}
              data-muted={s.micMuted ? '1' : '0'}
              title={s.statusText || label}
              style={{ ...glass, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, borderColor: s.transmitting ? 'rgba(81,207,102,0.9)' : s.micMuted ? 'rgba(255,107,107,0.7)' : 'rgba(255,255,255,0.08)' }}
            >
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.transmitting ? '#51cf66' : s.micMuted ? '#ff6b6b' : s.listenOnly || s.mic === 'denied' ? '#868e96' : '#495057' }} />
              <span>{label}</span>
              {!s.listenOnly && !s.micMuted && s.mic === 'ready' && <LevelBar levelKey={SELF} testId="voice-self-level" width={40} />}
            </div>
            <button
              data-testid="voice-settings-toggle"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (s.settingsOpen ? closeVoiceSettings() : openVoiceSettings())}
              style={{ ...glass, padding: '6px 9px', cursor: 'pointer' }}
              title="Voice settings: microphone, mic test, players, diagnostics"
            >
              Voice
            </button>
          </div>
          {showLine && (
            <div data-testid="voice-hud-status" title={s.statusText} style={{ ...glass, padding: '3px 8px', fontSize: 11, opacity: 0.8, maxWidth: 260 }}>
              {statusLine}
            </div>
          )}
        </div>
      )}
    </>
  );
}
