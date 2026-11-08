// Screen flow: title -> account (WP04 mounts here) -> play.
import { lazy, Suspense, useEffect } from 'react';
import { useAppStore } from './stores/appStore';
import { TitleScreen } from './screens/TitleScreen';
import { AccountSlot } from './screens/AccountSlot';
import { AUTOPLAY, SOLO } from './config';

const PlayScreen = lazy(() => import('./screens/PlayScreen'));

function Loading() {
  return <div style={{ height: '100%', display: 'grid', placeItems: 'center', opacity: 0.6 }}>Loading world...</div>;
}

export function App() {
  const screen = useAppStore((s) => s.screen);

  useEffect(() => {
    if (AUTOPLAY) useAppStore.getState().setScreen(SOLO ? 'play' : 'account');
  }, []);

  if (screen === 'title') return <TitleScreen />;
  if (screen === 'account') return <AccountSlot />;
  return (
    <Suspense fallback={<Loading />}>
      <PlayScreen />
    </Suspense>
  );
}
