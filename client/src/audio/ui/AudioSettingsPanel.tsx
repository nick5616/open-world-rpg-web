// Sound settings: a slider per bus and a mute, persisted in localStorage
// (settings.ts). K toggles it (and frees the mouse so the sliders work);
// the small speaker button does the same.

import type { CSSProperties } from 'react';
import { BUSES, useAudioSettings, type BusName } from '../settings';

const glass: CSSProperties = {
  background: 'rgba(10,13,20,0.78)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  color: '#e9ecef',
  font: '13px system-ui, sans-serif',
};

const LABELS: Record<BusName, string> = {
  master: 'Master',
  music: 'Music',
  sfx: 'Effects',
  ambience: 'Ambience',
  ui: 'Interface',
  voice: 'Voice chat',
};

export function SoundButton() {
  const muted = useAudioSettings((s) => s.muted);
  const open = useAudioSettings((s) => s.panelOpen);
  const setOpen = useAudioSettings((s) => s.setPanelOpen);
  return (
    <button
      data-testid="sound-toggle"
      title="Sound settings (K)"
      onClick={() => setOpen(!open)}
      style={{ ...glass, position: 'fixed', right: 12, top: 12, zIndex: 31, padding: '5px 9px', cursor: 'pointer', opacity: 0.8 }}
    >
      {muted ? 'Sound off' : 'Sound'}
    </button>
  );
}

export function AudioSettingsPanel() {
  const s = useAudioSettings();
  if (!s.panelOpen) return null;
  return (
    <div data-testid="sound-settings" style={{ ...glass, position: 'fixed', right: 12, top: 46, zIndex: 31, padding: '10px 14px', width: 240 }} onKeyDown={(e) => e.code === 'Escape' && s.setPanelOpen(false)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>Sound</strong>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input data-testid="sound-mute" type="checkbox" checked={s.muted} onChange={(e) => s.setMuted(e.target.checked)} />
          Mute all
        </label>
      </div>
      {BUSES.map((b) => (
        <label key={b} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 34px', alignItems: 'center', gap: 6, margin: '4px 0', opacity: s.muted && b !== 'master' ? 0.5 : 1 }}>
          <span>{LABELS[b]}</span>
          <input data-testid={`sound-${b}`} type="range" min={0} max={100} value={Math.round(s.volumes[b] * 100)} onChange={(e) => s.setVolume(b, Number(e.target.value) / 100)} />
          <span style={{ textAlign: 'right', opacity: 0.7 }}>{Math.round(s.volumes[b] * 100)}</span>
        </label>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, opacity: 0.7 }}>
        <span>K to close</span>
        <button data-silent onClick={() => s.reset()} style={{ ...glass, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>
          Defaults
        </button>
      </div>
    </div>
  );
}
