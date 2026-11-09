// Crossed swords for the PvP HUD (the nameplate draws the same paths on its
// canvas: plate.ts).

import { SWORD_PATHS } from './plate';

/** Crossed swords, `size` px. */
export function SwordsIcon({ size = 16, color = '#ff5d5d' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="PvP" style={{ flex: 'none', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' }}>
      <g fill={color} stroke="rgba(0,0,0,0.55)" strokeWidth="0.6" strokeLinejoin="round">
        {SWORD_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
        <g transform="translate(24 0) scale(-1 1)">
          {SWORD_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </g>
    </svg>
  );
}
