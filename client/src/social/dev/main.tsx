// Dev page for the social module (client/social-dev.html, port 5175): signs
// in with dev auth (or a fresh local profile), gets real tickets from the
// director, connects the social socket and mounts the SocialOverlay over a
// plain backdrop, so chat can be exercised and screenshotted without the
// game (and without touching the play screen WP06 is wiring).
//
//   /social-dev.html?user=wp08alice&name=Alice
//   &local=1            local profile instead of dev account
//   &x=500&z=500        override the presented position (default: character position)
//   &zone=zone-x        override the presented zone (default: the zone the director picked)
//   &account=http://localhost:8091&director=http://localhost:8090
//
// window.__wp08 exposes the store and helpers for the headless e2e script.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LodestoneApi, defaultUrls } from '../../account/api';
import type { ConnectResponse } from '../../account/types';
import { allSpeechBubbles, onBubblesChanged } from '../bubbles';
import { sendSocial, startSocial, submitChatInput } from '../session';
import { useSocialStore } from '../store';
import { SocialOverlay } from '../ui/SocialOverlay';

const q = new URLSearchParams(location.search);
const urls = defaultUrls();
const api = new LodestoneApi({ account: q.get('account') ?? urls.account, director: q.get('director') ?? urls.director });

declare global {
  interface Window {
    __wp08: {
      store: typeof useSocialStore;
      submit: typeof submitChatInput;
      send: typeof sendSocial;
      bubbles: typeof allSpeechBubbles;
      setPosition: (x: number, z: number) => void;
      connect?: ConnectResponse;
      error?: string;
    };
  }
}

const pos = { x: 0, z: 0 };
window.__wp08 = {
  store: useSocialStore,
  submit: submitChatInput,
  send: sendSocial,
  bubbles: allSpeechBubbles,
  setPosition: (x, z) => {
    pos.x = x;
    pos.z = z;
  },
};

function randomSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// StrictMode runs effects twice in dev; sign in once.
let booting: Promise<ConnectResponse> | null = null;
function boot(): Promise<ConnectResponse> {
  booting ??= bootOnce();
  return booting;
}

async function bootOnce(): Promise<ConnectResponse> {
  const name = q.get('name') ?? 'Wanderer';
  let token: string;
  if (q.get('local') === '1') {
    token = (await api.localSession(crypto.randomUUID(), randomSecret())).session;
  } else {
    token = (await api.devSignIn(q.get('user') ?? name.toLowerCase())).session;
  }
  const world = (await api.worlds()).find((w) => w.official);
  if (!world) throw new Error('no official world');
  let ch = (await api.characters(token, world.id)).find((c) => c.name.toLowerCase() === name.toLowerCase());
  let save;
  if (!ch) {
    const created = await api.createCharacter(token, world.id, name);
    ch = created.character;
    save = created.save;
  }
  // The world may still be waking (503); retry like the account screen does.
  for (let i = 0; ; i++) {
    try {
      return await api.connect(token, ch.id, save).then((r) => {
        const characterId = ch!.id;
        // Position before the socket starts, so the first presence frame is right.
        pos.x = Number(q.get('x') ?? r.character.position.x);
        pos.z = Number(q.get('z') ?? r.character.position.z);
        startSocial({
          endpoint: q.get('social') ?? r.socialEndpoint,
          ticket: r.socialTicket,
          refreshTicket: () => api.socialTicket(token, characterId).then((t) => t.socialTicket),
          zoneId: () => q.get('zone') ?? r.zone.zoneId,
          position: () => pos,
        });
        return r;
      });
    } catch (e) {
      if (i > 20) throw e;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}

function BubbleList() {
  const [list, setList] = useState(allSpeechBubbles());
  useEffect(() => {
    const t = setInterval(() => setList(allSpeechBubbles()), 500);
    const off = onBubblesChanged(() => setList(allSpeechBubbles()));
    return () => {
      clearInterval(t);
      off();
    };
  }, []);
  if (list.length === 0) return null;
  return (
    <div data-testid="bubbles" style={{ position: 'fixed', top: '30%', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 12 }}>
      {list.map((b) => (
        <div key={b.name} style={{ textAlign: 'center' }}>
          <div style={{ background: 'white', color: '#111', borderRadius: 12, padding: '6px 10px', maxWidth: 220, boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>{b.text}</div>
          <div style={{ fontSize: 12, marginTop: 4, opacity: 0.8 }}>{b.name}</div>
        </div>
      ))}
    </div>
  );
}

function Dev() {
  const [info, setInfo] = useState<ConnectResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const me = useSocialStore((s) => s.me);
  const status = useSocialStore((s) => s.status);
  useEffect(() => {
    boot()
      .then((r) => {
        window.__wp08.connect = r;
        setInfo(r);
      })
      .catch((e: unknown) => {
        window.__wp08.error = String(e);
        setErr(String(e));
      });
  }, []);
  return (
    <>
      <div style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', fontSize: 13, opacity: 0.85, textAlign: 'center' }} data-testid="dev-status">
        {err
          ? `error: ${err}`
          : info
            ? `${me?.name ?? info.character.name}${info.isLocalProfile ? ' (local profile)' : ''} · zone ${q.get('zone') ?? info.zone.zoneId} · region ${info.region.x},${info.region.z} · social ${status}`
            : 'signing in…'}
      </div>
      <BubbleList />
      <SocialOverlay />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dev />
  </StrictMode>,
);
