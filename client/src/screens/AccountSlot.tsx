// Mount point for sign-in. WP04 is building a self-contained account screen
// in client/src/account/ (Firebase sign-in, local profiles, character
// select). Integration is one change here: render that screen and call
// `onDone` when it has a character (and, with WP06, a connect ticket).
// Until then this placeholder lets non-solo builds continue offline.

import { useAppStore } from '../stores/appStore';

export function AccountSlot() {
  const setScreen = useAppStore((s) => s.setScreen);
  const onDone = () => setScreen('play');
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <h2 style={{ margin: 0, fontWeight: 400 }}>Sign in</h2>
      <p style={{ margin: 0, opacity: 0.6, maxWidth: 420, textAlign: 'center' }}>Accounts and characters arrive with WP04. For now you can walk the placeholder world offline.</p>
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={() => setScreen('title')}>Back</button>
        <button data-testid="continue-offline" onClick={onDone}>Continue offline</button>
      </div>
    </div>
  );
}
