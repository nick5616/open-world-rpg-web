// The 2D half of night (WP15): a clock chip (time, moon phase, rain), the
// night/dawn/lord notices, the town defense panel with the ward garden's
// health, and a hint when a demon shrugs off an ordinary weapon.

import { useEffect, useState } from 'react';
import { MOON_NAMES } from './clock';
import { useNightHud } from './night';

const MOON_GLYPHS = ['\u{1F311}', '\u{1F312}', '\u{1F313}', '\u{1F314}', '\u{1F315}', '\u{1F316}', '\u{1F317}', '\u{1F318}'];

function hhmm(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const TONE: Record<string, string> = { night: '#b9a8ff', dawn: '#ffd27a', danger: '#ff7a5a', info: '#e9ecef' };

export function NightHud() {
  const s = useNightHud();
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (!s.online) return null;
  const now = performance.now();
  const d = s.defense;
  return (
    <div data-testid="night-hud" style={{ position: 'fixed', top: 56, left: '50%', transform: 'translateX(-50%)', zIndex: 12, pointerEvents: 'none', font: '13px system-ui, sans-serif', color: '#e9ecef', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div data-testid="night-clock" style={{ background: 'rgba(10,12,20,0.55)', padding: '3px 10px', borderRadius: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>{s.night ? MOON_GLYPHS[s.moon] : '☀️'}</span>
        <span>{hhmm(s.hour)}</span>
        {s.night && <span style={{ opacity: 0.75 }}>{MOON_NAMES[s.moon]}</span>}
        {s.raining && <span title="rain">{'\u{1F327}️'}</span>}
        {s.burning > 0 && <span style={{ color: '#ffa040' }}>{'\u{1F525}'} {s.burning}</span>}
      </div>
      {d && (
        <div data-testid="night-defense" style={{ background: 'rgba(30,8,8,0.7)', padding: '6px 12px', borderRadius: 8, minWidth: 260, textAlign: 'center' }}>
          <div style={{ fontWeight: 600, color: '#ffb09a' }}>
            Defend {d.name || 'the town'} {d.phase === 'warning' ? '— the ward falters' : d.phase === 'wave' ? `— wave ${d.wave}/${d.waves}` : d.result === 1 ? '— held' : '— lost'}
          </div>
          <div style={{ marginTop: 4, height: 7, background: '#2a1a1a', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(0, (d.ward / d.wardMax) * 100)}%`, height: '100%', background: 'linear-gradient(90deg,#7ed957,#c9f27a)' }} />
          </div>
          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>ward garden {Math.round(d.ward)} / {d.wardMax}{d.demons ? ` · ${d.demons} demons` : ''}</div>
        </div>
      )}
      {now - s.shrugged < 2500 && <div style={{ color: '#ffb09a', textShadow: '0 1px 2px #000' }}>The demon regenerates: only sunsteel or Light can kill it.</div>}
      {s.notices
        .filter((n) => n.until > now)
        .map((n) => (
          <div key={n.id} style={{ color: TONE[n.tone], textShadow: '0 1px 3px #000', fontSize: 15 }}>
            {n.text}
          </div>
        ))}
    </div>
  );
}
