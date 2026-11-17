// Sign-in step of the screen flow: WP04's AccountScreen (accounts, local
// profiles, characters, director ticket) mounted as-is, over the gem cavern
// (pt3 title + creation, CR 047). Its ReadySession goes to the net store and
// the play screen connects with it (WP06). "Continue offline" keeps the
// placeholder world reachable without any server.

import type { CSSProperties } from 'react';
import { AccountScreen } from '../account';
import type { ReadySession } from '../account/types';
import { useNetStore } from '../net/netStore';
import { useAppStore } from '../stores/appStore';
import { WakeGate } from '../wake/WakeGate';

export function AccountSlot() {
  const setScreen = useAppStore((s) => s.setScreen);
  const setReady = useNetStore((s) => s.setReady);
  const onReady = (s: ReadySession) => {
    setReady(s);
    setScreen('play');
  };
  return (
    <div style={{ height: '100%', position: 'relative', overflow: 'hidden' }}>
      {/* WP18: the account service's database sleeps with the game VM. */}
      <WakeGate>
        <AccountScreen onReady={onReady} />
      </WakeGate>
      <div style={corner}>
        <button style={small} onClick={() => setScreen('title')}>
          Back
        </button>
        <button
          style={small}
          data-testid="continue-offline"
          onClick={() => {
            setReady(null);
            setScreen('play');
          }}
        >
          Continue offline
        </button>
      </div>
    </div>
  );
}

// Bottom-left under the list on desktop, bottom on phones; never over the stage.
const corner: CSSProperties = { position: 'fixed', left: 18, bottom: 14, zIndex: 5, display: 'flex', gap: 8 };
const small: CSSProperties = { background: 'rgba(10,10,30,.72)', color: '#c9cffc', border: '1px solid rgba(150,150,230,.35)', borderRadius: 3, padding: '6px 12px', cursor: 'pointer', fontSize: 12, letterSpacing: '.06em' };
