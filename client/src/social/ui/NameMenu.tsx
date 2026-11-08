// Click a player's name anywhere in the social UI for whisper / invite /
// friend / mute / block / report (spec 10: "right-click a player or friend").
import { useEffect } from 'react';
import type { Channel } from '@lodestone/contracts';
import { sendSocial } from '../session';
import { useSocialStore } from '../store';
import { button, glass } from './style';

export interface NameMenuTarget {
  name: string;
  x: number;
  y: number;
  /** Channel to report from. */
  channel: Channel;
}

export function NameMenu({ target, onClose }: { target: NameMenuTarget; onClose: () => void }) {
  const relations = useSocialStore((s) => s.relations);
  const friends = useSocialStore((s) => s.friends);
  const openWhisper = useSocialStore((s) => s.openWhisper);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  const n = target.name;
  const lower = n.toLowerCase();
  const muted = relations.muted.some((m) => m.toLowerCase() === lower);
  const blocked = relations.blocked.some((m) => m.toLowerCase() === lower);
  const friend = friends.some((f) => f.name.toLowerCase() === lower);
  const items: [string, () => void][] = [
    ['Whisper', () => openWhisper(n)],
    ['Invite to party', () => sendSocial({ type: 'party_invite', name: n })],
    friend ? ['Remove friend', () => sendSocial({ type: 'friend_remove', name: n })] : ['Add friend', () => sendSocial({ type: 'friend_request', name: n })],
    muted ? ['Unmute', () => sendSocial({ type: 'unmute', name: n })] : ['Mute', () => sendSocial({ type: 'mute', name: n })],
    blocked ? ['Unblock', () => sendSocial({ type: 'unblock', name: n })] : ['Block', () => sendSocial({ type: 'block', name: n })],
    ['Report', () => sendSocial({ type: 'report', name: n, channel: target.channel })],
  ];
  return (
    <div
      data-testid="name-menu"
      onClick={(e) => e.stopPropagation()}
      style={{ ...glass, position: 'fixed', left: target.x, top: target.y, zIndex: 60, padding: 6, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 140 }}
    >
      <div style={{ fontWeight: 600, padding: '2px 6px 4px' }}>{n}</div>
      {items.map(([label, fn]) => (
        <button
          key={label}
          style={{ ...button, textAlign: 'left' }}
          onClick={() => {
            fn();
            onClose();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
