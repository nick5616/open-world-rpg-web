// Dev page for the account module (client/account-dev.html, port 5174):
// mounts AccountScreen alone and prints the ReadySession it hands over, so
// the account flow can be exercised and screenshotted without the game shell.
// Also exposes window.__wp04 for the headless acceptance script.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountScreen } from '../AccountScreen';
import { LodestoneApi, defaultUrls } from '../api';
import { clearCaches, openLodestoneDb } from '../idb';
import { SaveStore } from '../saveStore';
import type { ReadySession } from '../types';

declare global {
  interface Window {
    __wp04: { api: LodestoneApi; SaveStore: typeof SaveStore; openLodestoneDb: typeof openLodestoneDb; clearCaches: typeof clearCaches; lastReady?: ReadySession };
  }
}
window.__wp04 = { api: new LodestoneApi(defaultUrls()), SaveStore, openLodestoneDb, clearCaches };

function Dev() {
  const [ready, setReady] = useState<ReadySession | null>(null);
  return (
    <>
      <AccountScreen
        onReady={(s) => {
          window.__wp04.lastReady = s;
          setReady(s);
        }}
      />
      {ready && (
        <pre data-testid="ready-session" style={{ margin: '0 auto', width: 440, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, color: '#9fe6a0' }}>
          {JSON.stringify({ ...ready, refreshTickets: undefined, save: ready.save ? { counter: ready.save.counter } : undefined }, null, 2)}
        </pre>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dev />
  </StrictMode>,
);
