// Shared look for the social overlay: dark glass over the 3D scene, legible
// on bright sky and dark caves alike.
import type { CSSProperties } from 'react';
import type { Channel } from '@lodestone/contracts';

export const glass: CSSProperties = {
  background: 'rgba(10,13,20,0.78)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
  color: '#e8eaee',
  font: '13px/1.4 system-ui, sans-serif',
  backdropFilter: 'blur(6px)',
};

export const button: CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: '#e8eaee',
  borderRadius: 6,
  padding: '3px 8px',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

/** One colour per channel, so a glance tells you who can read a line. */
export const channelColor: Record<Channel, string> = {
  global: '#f2c879',
  zone: '#8fd3ff',
  local: '#f1f3f5',
  party: '#8ce99a',
  whisper: '#e599f7',
  system: '#ffd8a8',
};

export const tabLabel: Record<string, string> = {
  local: 'Local',
  zone: 'Zone',
  global: 'Global',
  party: 'Party',
  system: 'System',
};

/** Stable colour per name (the-circle hashNameToColor idea). */
export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 72%)`;
}
