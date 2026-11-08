// Sign-in step of the screen flow: WP04's AccountScreen (accounts, local
// profiles, characters, director ticket) mounted as-is. Its ReadySession goes
// to the net store and the play screen connects with it (WP06). "Continue
// offline" keeps the placeholder world reachable without any server.

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
    <div style={{ height: '100%', overflow: 'auto' }}>
      {/* WP18: the account service's database sleeps with the game VM. */}
      <WakeGate>
        <AccountScreen onReady={onReady} />
      </WakeGate>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', padding: '12px 0 24px' }}>
        <button onClick={() => setScreen('title')}>Back</button>
        <button
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
