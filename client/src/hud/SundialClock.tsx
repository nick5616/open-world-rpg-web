// The HUD's sundial clock (playtest 5, CR 054: "add a sundial style clock"):
// a small half-dial under the compass, left of the clock chip (systems/NightHud.tsx, which keeps the numbers). A sun (a moon at night) travels the
// arc from the left (dawn, 06:00) over the top (12:30) to the right (dusk,
// 19:00); the hour ticks are the dial's, a thin shadow ray runs from the
// gnomon to the glyph, and a word under it says the time of day ("Mid-morning").
// It is as quiet as the compass and follows the immersive HUD rules
// (hud/immersive.ts dialOpacity): soft at rest, bright for a few seconds when
// the hour turns or Tab is held.

import { useEffect, useRef, useState } from 'react';
import { DAY_LENGTH_S } from '@lodestone/contracts';
import { worldClock } from '../state/live';
import { arcAt, clockText, DIAL_FROM, DIAL_TO } from '../world/buildings/sundial';
import { dialOpacity, hudActivity, useHudSettings } from './immersive';

const CX = 48;
const CY = 44;
const R = 38;

/** The word for an hour: Dawn, Morning, Noon, Afternoon, Dusk, Evening, Night, Small hours. */
export function periodWord(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 5 && h < 7) return 'Dawn';
  if (h >= 7 && h < 11) return 'Morning';
  if (h >= 11 && h < 13) return 'Midday';
  if (h >= 13 && h < 17) return 'Afternoon';
  if (h >= 17 && h < 19) return 'Dusk';
  if (h >= 19 && h < 23) return 'Evening';
  if (h >= 23 || h < 2) return 'Midnight';
  return 'Small hours';
}

/** The glyph's position on the arc (SVG user units) for an hour. */
export function glyphAt(hour: number): { x: number; y: number; sun: boolean } {
  const a = arcAt(hour);
  const ang = Math.PI * (1 - a.t);
  return { x: CX + Math.cos(ang) * R, y: CY - Math.sin(ang) * R, sun: a.sun };
}

const tick = (h: number) => {
  const ang = Math.PI * (1 - (h - DIAL_FROM) / (DIAL_TO - DIAL_FROM));
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const major = h % 6 === 0;
  return { x1: CX + c * (R - (major ? 6 : 3.5)), y1: CY - s * (R - (major ? 6 : 3.5)), x2: CX + c * (R + 1.5), y2: CY - s * (R + 1.5), major, h };
};
const TICKS = [6, 8, 10, 12, 14, 16, 18].map(tick);

export function SundialClock() {
  const immersive = useHudSettings((s) => s.immersive);
  const [hour, setHour] = useState(() => worldClock.timeOfDayS / (DAY_LENGTH_S / 24));
  const [op, setOp] = useState(1);
  const lastHour = useRef(Math.floor(hour));
  const hourAt = useRef(-1e9);
  useEffect(() => {
    const iv = setInterval(() => {
      const h = worldClock.timeOfDayS / (DAY_LENGTH_S / 24);
      const hi = Math.floor(h);
      const now = performance.now();
      if (hi !== lastHour.current) {
        lastHour.current = hi;
        hourAt.current = now;
      }
      setHour(h);
      setOp(dialOpacity({ immersive, now, hourAt: hourAt.current, tabHeld: hudActivity.tabHeld }));
    }, 500);
    return () => clearInterval(iv);
  }, [immersive]);

  const g = glyphAt(hour);
  const night = !g.sun;
  const arc = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
  return (
    <div data-testid="sundial-clock" data-hour={hour.toFixed(2)} title={clockText(hour)} style={{ position: 'fixed', top: 54, right: 'calc(50% + 170px)', width: 96, height: 62, pointerEvents: 'none', zIndex: 12, opacity: op, transition: 'opacity 0.8s' }}>
      <svg width="96" height="62" viewBox="0 0 96 62" style={{ overflow: 'visible' }}>
        <defs>
          <radialGradient id="sdGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor={night ? '#cfe0ff' : '#ffe9a8'} stopOpacity="0.9" />
            <stop offset="1" stopColor={night ? '#cfe0ff' : '#ffd36a'} stopOpacity="0" />
          </radialGradient>
        </defs>
        <path d={`${arc} L ${CX} ${CY} Z`} fill="rgba(10,12,18,0.42)" />
        <path d={arc} fill="none" stroke={night ? 'rgba(160,185,255,0.55)' : 'rgba(255,226,150,0.85)'} strokeWidth="1.6" strokeLinecap="round" />
        <line x1={CX - R - 4} y1={CY} x2={CX + R + 4} y2={CY} stroke="rgba(255,255,255,0.45)" strokeWidth="1" />
        {TICKS.map((t) => (
          <line key={t.h} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke="rgba(255,255,255,0.8)" strokeWidth={t.major ? 1.8 : 1} strokeLinecap="round" />
        ))}
        {/* the gnomon and its shadow ray to the glyph */}
        <line x1={CX} y1={CY} x2={g.x} y2={g.y} stroke={night ? 'rgba(160,185,255,0.35)' : 'rgba(255,226,150,0.45)'} strokeWidth="1" strokeDasharray="2 2" />
        <polygon points={`${CX - 3.5},${CY} ${CX + 3.5},${CY} ${CX},${CY - 9}`} fill="#d2a24c" stroke="#0b0d12" strokeWidth="0.8" />
        {night ? (
          <g transform={`translate(${g.x} ${g.y})`}>
            <circle r="9" fill="url(#sdGlow)" />
            <path d="M -2 -6 A 6 6 0 1 0 5 3 A 5 5 0 1 1 -2 -6 Z" fill="#e8eeff" stroke="#0b0d12" strokeWidth="0.7" />
          </g>
        ) : (
          <g transform={`translate(${g.x} ${g.y})`}>
            <circle r="10" fill="url(#sdGlow)" />
            <circle r="4.2" fill="#ffd24a" stroke="#0b0d12" strokeWidth="0.8" />
            {[0, 1, 2, 3, 4, 5, 6, 7].map((k) => (
              <line key={k} x1={Math.cos((k * Math.PI) / 4) * 5.8} y1={Math.sin((k * Math.PI) / 4) * 5.8} x2={Math.cos((k * Math.PI) / 4) * 8} y2={Math.sin((k * Math.PI) / 4) * 8} stroke="#ffd24a" strokeWidth="1.2" strokeLinecap="round" />
            ))}
          </g>
        )}
        <text x={CX} y={CY + 13} textAnchor="middle" fontSize="10" fontWeight="600" fill="#f1f3f5" style={{ font: '600 10px system-ui, sans-serif', textShadow: '0 1px 2px #000' }}>
          {periodWord(hour)}
        </text>
      </svg>
    </div>
  );
}
