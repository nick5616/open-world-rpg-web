// Party frame (spec 10): members with online state and region, leader
// controls, and pending invites. Health bars arrive with the zone snapshot's
// party ring (WP06); this frame leaves room for them (`healthOf` prop).
import { sendSocial } from '../session';
import { useSocialStore } from '../store';
import { button, channelColor, glass, nameColor } from './style';

export interface PartyFrameProps {
  /** 0..1 health for a party member, once the zone's party ring provides it. */
  healthOf?: (characterId: string) => number | undefined;
}

export function PartyFrame({ healthOf }: PartyFrameProps) {
  const party = useSocialStore((s) => s.party);
  const invites = useSocialStore((s) => s.invites);
  const me = useSocialStore((s) => s.me);
  const dismissInvite = useSocialStore((s) => s.dismissInvite);
  if (!party && invites.length === 0) return null;
  const lead = party?.leaderId === me?.characterId;
  return (
    // Stacked just above the chat panel (12 px margin + 340 px panel + gap)
    // so neither covers the other and the crosshair stays clear.
    <div style={{ position: 'fixed', left: 12, bottom: 362, zIndex: 25, display: 'flex', flexDirection: 'column', gap: 6, width: 210 }}>
      {invites.map((inv) => (
        <div key={inv.partyId} data-testid="party-invite" style={{ ...glass, padding: 8 }}>
          <div style={{ marginBottom: 6 }}>
            <b style={{ color: nameColor(inv.fromName) }}>{inv.fromName}</b> invites you to a party
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button data-testid="party-accept" style={button} onClick={() => sendSocial({ type: 'party_respond', partyId: inv.partyId, accept: true })}>
              Accept
            </button>
            <button
              style={button}
              onClick={() => {
                sendSocial({ type: 'party_respond', partyId: inv.partyId, accept: false });
                dismissInvite(inv.partyId);
              }}
            >
              Decline
            </button>
          </div>
        </div>
      ))}
      {party && (
        <div data-testid="party-frame" style={{ ...glass, padding: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, color: channelColor.party, fontWeight: 600 }}>
            Party
            <button data-testid="party-leave" style={{ ...button, marginLeft: 'auto' }} onClick={() => sendSocial({ type: 'party_leave' })}>
              Leave
            </button>
          </div>
          {party.members.map((m) => {
            const hp = healthOf?.(m.characterId);
            const self = m.characterId === me?.characterId;
            return (
              <div key={m.characterId} data-testid="party-member" style={{ padding: '3px 0', opacity: m.online ? 1 : 0.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span title={m.online ? 'online' : 'offline'} style={{ width: 7, height: 7, borderRadius: 4, background: m.online ? '#51cf66' : '#868e96' }} />
                  <span style={{ color: nameColor(m.name), fontWeight: 600 }}>{m.name}</span>
                  {m.characterId === party.leaderId && <span title="leader">★</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.7 }}>{m.online ? (m.region ?? '') : 'offline'}</span>
                </div>
                {hp !== undefined && (
                  <div style={{ height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, marginTop: 2 }}>
                    <div style={{ width: `${Math.round(hp * 100)}%`, height: '100%', background: '#e03131', borderRadius: 2 }} />
                  </div>
                )}
                {lead && !self && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                    <button style={{ ...button, fontSize: 10, padding: '1px 5px' }} onClick={() => sendSocial({ type: 'party_promote', name: m.name })}>
                      Lead
                    </button>
                    <button style={{ ...button, fontSize: 10, padding: '1px 5px' }} onClick={() => sendSocial({ type: 'party_kick', name: m.name })}>
                      Kick
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
