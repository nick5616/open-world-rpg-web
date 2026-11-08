// Everything social drawn over the play screen: chat, party frame, friends.
// Renders nothing until startSocial() has been called, so mounting it in the
// play screen is harmless in solo mode or before the play flow connects.
import { useEffect, useState } from 'react';
import { useSocialStore } from '../store';
import { ChatPanel, type ChatPanelProps } from './ChatPanel';
import { FriendsPanel } from './FriendsPanel';
import { PartyFrame, type PartyFrameProps } from './PartyFrame';
import { button, glass } from './style';

export type SocialOverlayProps = ChatPanelProps & PartyFrameProps;

export function SocialOverlay(props: SocialOverlayProps) {
  const status = useSocialStore((s) => s.status);
  const incoming = useSocialStore((s) => s.friends.filter((f) => f.state === 'pending_in').length);
  const [friendsOpen, setFriendsOpen] = useState(false);
  // O toggles the friends list (when not typing), as in most MMOs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'KeyO') setFriendsOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (status === 'idle') return null;
  return (
    <>
      <ChatPanel extraNames={props.extraNames} />
      <PartyFrame healthOf={props.healthOf} />
      <button
        data-testid="friends-toggle"
        onClick={() => setFriendsOpen((v) => !v)}
        style={{ ...glass, ...button, position: 'fixed', right: 12, top: 20, zIndex: 30, padding: '5px 10px' }}
      >
        Friends (O){incoming > 0 ? ` · ${incoming} request${incoming > 1 ? 's' : ''}` : ''}
      </button>
      {friendsOpen && <FriendsPanel onClose={() => setFriendsOpen(false)} />}
    </>
  );
}
