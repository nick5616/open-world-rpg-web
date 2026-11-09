// Debug panel (spec 14 dev tools): teleport to coordinates, fly, freeze time,
// time of day, cell borders, quality. Opening it releases pointer lock so the
// mouse works, and the controller ignores movement keys while it is open.

import { useState, type CSSProperties } from 'react';
import { DAY_LENGTH_S } from '@lodestone/contracts';
import { parseTeleport, useDebugStore } from '../stores/debugStore';
import { useAppStore } from '../stores/appStore';
import { useQualityStore, type QualitySetting } from '../stores/qualityStore';
import { localPlayer, worldClock } from '../state/live';
import { WorldDebugSection } from '../world/debug/WorldDebugSection';
import { CameraSettings } from './ViewHud';

const box: CSSProperties = { position: 'fixed', top: 10, right: 10, zIndex: 30, width: 280, font: '13px system-ui, sans-serif', color: '#e9ecef', background: 'rgba(12,15,24,0.92)', border: '1px solid #343a40', borderRadius: 6, padding: 12 };
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' };

export function DebugPanel() {
  const { fly, freezeTime, showCells, setFly, setFreezeTime, setShowCells, teleport } = useDebugStore();
  const setOpen = useAppStore((s) => s.setDebugPanelOpen);
  const setScreen = useAppStore((s) => s.setScreen);
  const setting = useQualityStore((s) => s.setting);
  const setSetting = useQualityStore((s) => s.setSetting);
  const [tp, setTp] = useState('');
  const [tpErr, setTpErr] = useState(false);
  const [hour, setHour] = useState(() => Math.round((worldClock.timeOfDayS / DAY_LENGTH_S) * 24 * 4) / 4);

  const doTeleport = () => {
    const t = parseTeleport(tp);
    setTpErr(!t);
    if (t) teleport(t);
  };

  return (
    <div style={box} data-testid="debug-panel">
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Debug</div>
      <div style={{ opacity: 0.7, fontSize: 12 }}>
        at {localPlayer.pos.x.toFixed(1)}, {localPlayer.pos.y.toFixed(1)}, {localPlayer.pos.z.toFixed(1)}
      </div>
      <div style={row}>
        <input
          aria-label="teleport"
          placeholder="x z  or  x y z"
          value={tp}
          onChange={(e) => setTp(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doTeleport()}
          style={{ flex: 1, background: '#1b1f2a', color: 'inherit', border: `1px solid ${tpErr ? '#ff6b6b' : '#495057'}`, borderRadius: 4, padding: '4px 6px' }}
        />
        <button onClick={doTeleport}>Teleport</button>
      </div>
      <label style={row}>
        <input type="checkbox" checked={fly} onChange={(e) => setFly(e.target.checked)} /> Fly (V) · space up, ctrl/C down
      </label>
      <label style={row}>
        <input type="checkbox" checked={showCells} onChange={(e) => setShowCells(e.target.checked)} /> Cell / chunk / region borders (F4)
      </label>
      <label style={row}>
        <input type="checkbox" checked={freezeTime} onChange={(e) => setFreezeTime(e.target.checked)} /> Freeze time
      </label>
      <label style={row}>
        Time
        <input
          type="range"
          min={0}
          max={24}
          step={0.25}
          value={hour}
          onChange={(e) => {
            const h = Number(e.target.value);
            setHour(h);
            worldClock.timeOfDayS = ((h % 24) / 24) * DAY_LENGTH_S;
          }}
          style={{ flex: 1 }}
        />
        <span style={{ width: 40 }}>{String(Math.floor(hour)).padStart(2, '0')}:{String(Math.round((hour % 1) * 60)).padStart(2, '0')}</span>
      </label>
      <label style={row}>
        Quality
        <select value={setting} onChange={(e) => setSetting(e.target.value as QualitySetting)}>
          {['auto', 'low', 'medium', 'high'].map((q) => (
            <option key={q} value={q}>{q}</option>
          ))}
        </select>
      </label>
      <div style={row}>
        <CameraSettings compact />
      </div>
      <WorldDebugSection />
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <button onClick={() => setScreen('title')}>Back to title</button>
        <button onClick={() => setOpen(false)}>Close (`)</button>
      </div>
    </div>
  );
}
