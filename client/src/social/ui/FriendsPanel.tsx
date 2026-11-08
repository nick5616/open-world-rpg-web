// Friends list (spec 10): online status and region, whisper / invite /
// remove, incoming requests to accept or decline, and an add box.
import { useState } from 'react';
import { sendSocial } from '../session';
import { useSocialStore } from '../store';
import { button, glass, nameColor } from './style';

export function FriendsPanel({ onClose }: { onClose: () => void }) {
  const friends = useSocialStore((s) => s.friends);
  const openWhisper = useSocialStore((s) => s.openWhisper);
  const isLocal = useSocialStore((s) => s.me?.isLocalProfile ?? false);
  const [add, setAdd] = useState('');
  const accepted = friends.filter((f) => f.state === 'accepted');
  const incoming = friends.filter((f) => f.state === 'pending_in');
  const outgoing = friends.filter((f) => f.state === 'pending_out');
  const small = { ...button, fontSize: 10, padding: '1px 5px' };
  return (
    <div data-testid="friends-panel" style={{ ...glass, position: 'fixed', right: 12, top: 60, width: 260, maxHeight: '70vh', overflowY: 'auto', zIndex: 30, padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, fontWeight: 600 }}>
        Friends <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 6 }}>{accepted.filter((f) => f.online).length} online</span>
        <button style={{ ...button, marginLeft: 'auto' }} onClick={onClose}>
          ×
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (add.trim()) sendSocial({ type: 'friend_request', name: add.trim() });
          setAdd('');
        }}
        style={{ display: 'flex', gap: 4, marginBottom: 8 }}
      >
        <input
          data-testid="friend-add"
          value={add}
          onChange={(e) => setAdd(e.target.value)}
          placeholder="Add friend by name"
          style={{ flex: 1, minWidth: 0, padding: '3px 6px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.3)', color: '#fff', font: 'inherit' }}
        />
        <button style={button} type="submit">
          Add
        </button>
      </form>
      {incoming.map((f) => (
        <div key={f.characterId} data-testid="friend-incoming" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 0' }}>
          <span style={{ color: nameColor(f.name), fontWeight: 600 }}>{f.name}</span>
          <span style={{ fontSize: 11, opacity: 0.7 }}>wants to be friends</span>
          <button style={{ ...small, marginLeft: 'auto' }} onClick={() => sendSocial({ type: 'friend_respond', name: f.name, accept: true })}>
            Accept
          </button>
          <button style={small} onClick={() => sendSocial({ type: 'friend_respond', name: f.name, accept: false })}>
            ×
          </button>
        </div>
      ))}
      {accepted.length === 0 && incoming.length === 0 && <div style={{ opacity: 0.6, padding: '4px 0' }}>No friends yet.</div>}
      {accepted.map((f) => (
        <div key={f.characterId} data-testid="friend-row" style={{ padding: '4px 0', borderTop: '1px solid rgba(255,255,255,0.05)', opacity: f.online ? 1 : 0.55 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: f.online ? '#51cf66' : '#868e96' }} />
            <span style={{ color: nameColor(f.name), fontWeight: 600 }}>{f.name}</span>
            <span data-testid="friend-status" style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.75 }}>
              {f.online ? `online · ${f.region || '?'}` : 'offline'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
            <button style={small} onClick={() => openWhisper(f.name)}>
              Whisper
            </button>
            <button style={small} disabled={!f.online} onClick={() => sendSocial({ type: 'party_invite', name: f.name })}>
              Invite
            </button>
            {/* Travel to a friend needs waypoints (spec 10, gameplay packages). */}
            <button style={{ ...small, marginLeft: 'auto' }} onClick={() => sendSocial({ type: 'friend_remove', name: f.name })}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {outgoing.length > 0 && <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6 }}>Sent requests</div>}
      {outgoing.map((f) => (
        <div key={f.characterId} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0', opacity: 0.8 }}>
          <span>{f.name}</span>
          <button style={{ ...small, marginLeft: 'auto' }} onClick={() => sendSocial({ type: 'friend_remove', name: f.name })}>
            Cancel
          </button>
        </div>
      ))}
      {isLocal && <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6 }}>Local profile: whispers only to friends and party; no global chat.</div>}
    </div>
  );
}
