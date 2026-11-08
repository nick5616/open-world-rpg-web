// WP00 placeholder shell: proves the client builds against @lodestone/contracts
// and shows which local services answer /healthz. WP02 replaces this.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PROTOCOL_VERSION, TICK_RATE_HZ } from '@lodestone/contracts';

const SERVICES: Record<string, string | undefined> = {
  director: import.meta.env.VITE_DIRECTOR_URL as string | undefined,
  account: import.meta.env.VITE_ACCOUNT_URL as string | undefined,
};

function App() {
  const [health, setHealth] = useState<Record<string, string>>({});
  useEffect(() => {
    for (const [name, url] of Object.entries(SERVICES)) {
      if (!url) continue;
      fetch(`${url}/healthz`)
        .then((r) => r.json())
        .then((j: { ok: boolean }) => setHealth((h) => ({ ...h, [name]: j.ok ? 'ok' : 'down' })))
        .catch(() => setHealth((h) => ({ ...h, [name]: 'down' })));
    }
  }, []);
  return (
    <div style={{ padding: 24 }}>
      <h1>Lodestone</h1>
      <p>protocol v{PROTOCOL_VERSION} · {TICK_RATE_HZ} Hz</p>
      <ul>{Object.entries(health).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
