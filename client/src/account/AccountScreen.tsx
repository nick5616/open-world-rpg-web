// The first screen (spec 11): keep your character with an account (Google
// via Firebase, or the dev provider locally) or with a local profile in this
// browser; pick or create a character; get connect tickets from the director.
// Self-contained: WP02 mounts it and receives everything via onReady.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { ApiError, LodestoneApi, defaultUrls, type ApiUrls } from './api';
import { buildExport, downloadExport, parseExport } from './exportFile';
import { firebaseConfigFromEnv, signInWithGoogle } from './firebase';
import { SaveStore, type LocalProfile } from './saveStore';
import type { AuthConfig, Character, ConnectResponse, ReadySession, SaveBlob, World } from './types';

export interface AccountScreenProps {
  onReady: (session: ReadySession) => void;
  /** Override service URLs (defaults: VITE_ACCOUNT_URL / VITE_DIRECTOR_URL). */
  urls?: ApiUrls;
}

type Mode =
  | { kind: 'account'; session: string; name: string; accountId: string }
  | { kind: 'local'; session: string; profile: LocalProfile };

type Phase = 'boot' | 'choose' | 'characters' | 'upgrade' | 'connecting' | 'waking' | 'ready';

/** A local character's real level lives in its save blob; the server row only reserves the name. */
function levelOf(c: Character, save: SaveBlob | undefined): number {
  if (!c.local || !save) return c.level;
  try {
    return (JSON.parse(save.state) as { level?: number }).level ?? c.level;
  } catch {
    return c.level;
  }
}

function message(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function AccountScreen({ onReady, urls }: AccountScreenProps) {
  const api = useMemo(() => new LodestoneApi(urls ?? defaultUrls()), [urls]);
  const fbConfig = useMemo(() => firebaseConfigFromEnv(), []);
  const [store, setStore] = useState<SaveStore | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [worldId, setWorldId] = useState('');
  const [mode, setMode] = useState<Mode | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [saves, setSaves] = useState<Record<string, SaveBlob>>({});
  const [phase, setPhase] = useState<Phase>('boot');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [existingProfile, setExistingProfile] = useState<LocalProfile | undefined>();
  const cancelWake = useRef(false);

  useEffect(() => {
    let live = true;
    Promise.all([api.authConfig(), api.worlds(), SaveStore.open()])
      .then(async ([cfg, ws, st]) => {
        if (!live) return;
        setConfig(cfg);
        setWorlds(ws);
        setWorldId(ws.find((w) => w.official)?.id ?? ws[0]?.id ?? '');
        setStore(st);
        setExistingProfile(await st.getProfile());
        setPhase('choose');
      })
      .catch((e) => setError(`Cannot reach the account service: ${message(e)}`));
    return () => {
      live = false;
      cancelWake.current = true;
    };
  }, [api]);

  const refresh = useCallback(
    async (m: Mode, world: string) => {
      const cs = await api.characters(m.session, world);
      setCharacters(cs);
      if (m.kind === 'local' && store) {
        const stored = await store.listSaves(m.profile.profileId);
        setSaves(Object.fromEntries(stored.map((s) => [s.characterId, s.blob])));
      } else {
        setSaves({});
      }
    },
    [api, store],
  );

  const enter = useCallback(
    async (m: Mode) => {
      setMode(m);
      await refresh(m, worldId);
      setPhase('characters');
    },
    [refresh, worldId],
  );

  /** Runs an action, showing errors in the panel instead of throwing. */
  const guard = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError('');
    setStatus(label);
    // Clear only our own progress label: an action may finish by setting a
    // result message ("Upgraded: …") that must stay visible.
    const clear = () => setStatus((s) => (s === label ? '' : s));
    try {
      await fn();
      clear();
    } catch (e) {
      clear();
      setError(message(e));
    }
  }, []);

  // ---- account sign-in (also used to pick the target of an upgrade) ----

  const afterAccountSignIn = useCallback(
    async (s: { session: string; name?: string; account?: { id: string } }) => {
      const acct: Mode = { kind: 'account', session: s.session, name: s.name ?? '', accountId: s.account?.id ?? '' };
      if (phase === 'upgrade' && mode?.kind === 'local' && store) {
        const local = mode;
        const stored = await store.listSaves(local.profile.profileId);
        const res = await api.upgrade(acct.session, local.session, stored.map((x) => x.blob));
        await store.markUpgraded(res.accountId);
        setExistingProfile(await store.getProfile());
        await enter(acct);
        setStatus(`Upgraded: ${res.characters.length} character(s) now live on your account.`);
        return;
      }
      await enter(acct);
    },
    [api, enter, mode, phase, store],
  );

  const onDevSignIn = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const username = String(new FormData(e.currentTarget).get('username') ?? '');
    void guard('Signing in…', async () => afterAccountSignIn(await api.devSignIn(username)));
  };

  const onGoogle = () =>
    void guard('Signing in with Google…', async () => {
      if (!fbConfig) throw new Error('Firebase is not configured');
      await afterAccountSignIn(await api.firebaseSignIn(await signInWithGoogle(fbConfig)));
    });

  // ---- local profile ----

  const onLocal = () =>
    void guard('Opening local profile…', async () => {
      if (!store) return;
      const p = await store.ensureProfile();
      try {
        const s = await api.localSession(p.profileId, p.profileSecret);
        await enter({ kind: 'local', session: s.session, profile: p });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'profile_upgraded') {
          await store.markUpgraded('');
          throw new Error('This browser’s local profile was upgraded to an account. Sign in with that account.');
        }
        throw e;
      }
    });

  const onImport = (file: File | undefined) =>
    void guard('Importing profile…', async () => {
      if (!file || !store) return;
      const exp = parseExport(await file.text());
      const cur = await store.getProfile();
      if (cur && !cur.upgradedTo && cur.profileId !== exp.profile.profileId && (await store.listSaves(cur.profileId)).length > 0) {
        if (!window.confirm('Importing replaces the local profile in this browser. Export it first if you want to keep it. Continue?')) return;
      }
      const s = await api.localSession(exp.profile.profileId, exp.profile.profileSecret);
      // Every blob is checked by the server; an edited or outdated file is
      // refused rather than written over good saves.
      for (const blob of exp.saves) await api.verifySave(s.session, blob);
      await store.putProfile({ profileId: exp.profile.profileId, profileSecret: exp.profile.profileSecret, createdAt: exp.profile.createdAt });
      for (const blob of exp.saves) await store.putSave(blob);
      const p = (await store.getProfile())!;
      setExistingProfile(p);
      await enter({ kind: 'local', session: s.session, profile: p });
      setStatus(`Imported ${exp.saves.length} save(s).`);
    });

  const onExport = () =>
    void guard('Exporting…', async () => {
      if (mode?.kind !== 'local' || !store) return;
      const stored = await store.listSaves(mode.profile.profileId);
      downloadExport(buildExport(mode.profile, stored.map((s) => s.blob)));
    });

  // ---- characters ----

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get('name') ?? '');
    void guard('Creating character…', async () => {
      if (!mode) return;
      const res = await api.createCharacter(mode.session, worldId, name);
      // Local profiles get their first signed save right away (counter 1).
      if (res.save && store) await store.putSave(res.save);
      form.reset();
      await refresh(mode, worldId);
    });
  };

  const connectOnce = useCallback(
    async (m: Mode, c: Character): Promise<{ resp: ConnectResponse; save?: SaveBlob }> => {
      let save: SaveBlob | undefined;
      if (m.kind === 'local' && store) {
        save = (await store.getSave(c.id))?.blob;
        if (!save) throw new Error('No save for this character in this browser. Import your profile file to play it.');
      }
      return { resp: await api.connect(m.session, c.id, save), save };
    },
    [api, store],
  );

  const onPlay = (c: Character) =>
    void guard('', async () => {
      if (!mode) return;
      const m = mode;
      setPhase('connecting');
      cancelWake.current = false;
      for (;;) {
        try {
          const { resp, save } = await connectOnce(m, c);
          setPhase('ready');
          onReady({
            ticket: resp.ticket,
            socialTicket: resp.socialTicket,
            ticketExpiresAt: resp.expiresAt,
            zoneId: resp.zone.zoneId,
            zoneEndpoint: resp.zone.endpoint,
            zoneWtEndpoint: resp.zone.wtEndpoint,
            socialEndpoint: resp.socialEndpoint,
            worldId: resp.worldId,
            character: resp.character,
            isLocalProfile: resp.isLocalProfile,
            session: m.session,
            save,
            refreshTickets: async () => (await connectOnce(m, c)).resp,
          });
          return;
        } catch (e) {
          // Spec 13: the world may be asleep; keep asking until a zone is up.
          if (e instanceof ApiError && e.code === 'waking_world' && !cancelWake.current) {
            setPhase('waking');
            await new Promise((r) => setTimeout(r, (e.retryAfterS ?? 5) * 1000));
            if (cancelWake.current) {
              setPhase('characters');
              return;
            }
            continue;
          }
          setPhase('characters');
          throw e;
        }
      }
    });

  const onWorld = (id: string) => {
    setWorldId(id);
    if (mode) void guard('', () => refresh(mode, id));
  };

  const signOut = () => {
    setMode(null);
    setCharacters([]);
    setPhase('choose');
  };

  // ---- render ----

  const showGoogle = !!fbConfig && !!config?.firebase;
  const signInOptions = (
    <>
      {showGoogle && (
        <button style={btn} data-testid="auth-google" onClick={onGoogle}>
          Sign in with Google
        </button>
      )}
      {config?.devAuth && (
        <form onSubmit={onDevSignIn} style={row}>
          <input style={input} name="username" placeholder="dev username" data-testid="auth-dev-username" autoComplete="off" />
          <button style={btn} type="submit" data-testid="auth-dev-submit">
            Dev sign-in
          </button>
        </form>
      )}
      {!showGoogle && !config?.devAuth && <p style={muted}>No account sign-in is configured on this server.</p>}
    </>
  );

  return (
    <div style={wrap}>
      <div style={panel} data-testid="account-screen" data-phase={phase}>
        <h1 style={{ margin: '0 0 4px' }}>Lodestone</h1>
        {worlds.length > 1 && (
          <select style={input} value={worldId} onChange={(e) => onWorld(e.target.value)} data-testid="world-select">
            {worlds.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.official ? ' (official)' : ''}
              </option>
            ))}
          </select>
        )}
        {worlds.length === 1 && <p style={muted}>World: {worlds[0].name}</p>}

        {phase === 'boot' && !error && <p style={muted}>Loading…</p>}

        {phase === 'choose' && (
          <>
            <h3 style={h3}>Keep your character with an account</h3>
            <p style={muted}>Plays on any device. Full social features.</p>
            {signInOptions}
            <h3 style={h3}>…or with a local profile</h3>
            <p style={muted}>Saved in this browser only. Export it to keep it safe. Proximity voice, no global chat.</p>
            <div style={row}>
              <button style={btn} data-testid="auth-local" onClick={onLocal}>
                {existingProfile && !existingProfile.upgradedTo ? 'Continue local profile' : 'Play with a local profile'}
              </button>
              <label style={{ ...btn, display: 'inline-block' }}>
                Import profile file
                <input type="file" accept="application/json,.json" style={{ display: 'none' }} data-testid="import-file" onChange={(e) => onImport(e.target.files?.[0])} />
              </label>
            </div>
          </>
        )}

        {(phase === 'characters' || phase === 'connecting' || phase === 'waking' || phase === 'ready') && mode && (
          <>
            <p style={muted} data-testid="signed-in-as">
              {mode.kind === 'account' ? `Account: ${mode.name || mode.accountId}` : `Local profile ${mode.profile.profileId.slice(0, 8)}`}{' '}
              <button style={link} onClick={signOut}>
                switch
              </button>
            </p>
            <ul style={{ listStyle: 'none', padding: 0 }} data-testid="character-list">
              {characters.map((c) => (
                <li key={c.id} style={charRow}>
                  <span>
                    <b>{c.name}</b> <span style={muted}>lv {levelOf(c, saves[c.id])}</span>
                    {c.local && <span style={muted}> · save #{saves[c.id]?.counter ?? 'missing'}</span>}
                  </span>
                  <button style={btn} data-testid={`play-${c.name}`} disabled={phase !== 'characters'} onClick={() => onPlay(c)}>
                    Play
                  </button>
                </li>
              ))}
              {characters.length === 0 && <li style={muted}>No characters in this world yet.</li>}
            </ul>
            <form onSubmit={onCreate} style={row}>
              <input style={input} name="name" placeholder="character name" data-testid="char-name" autoComplete="off" />
              <button style={btn} type="submit" data-testid="char-create">
                Create
              </button>
            </form>
            {mode.kind === 'local' && (
              <div style={row}>
                <button style={btn} data-testid="export" onClick={onExport}>
                  Export profile
                </button>
                <button style={btn} data-testid="upgrade" onClick={() => setPhase('upgrade')} disabled={phase !== 'characters'}>
                  Upgrade to an account
                </button>
              </div>
            )}
            {phase === 'waking' && (
              <p data-testid="waking">
                Waking the world… <button style={link} onClick={() => (cancelWake.current = true)}>cancel</button>
              </p>
            )}
            {phase === 'connecting' && <p style={muted}>Asking the director for a zone…</p>}
            {phase === 'ready' && <p data-testid="ready">Ticket received. Entering the world…</p>}
          </>
        )}

        {phase === 'upgrade' && (
          <>
            <h3 style={h3}>Upgrade to an account</h3>
            <p style={muted}>Sign in to the account that should own this profile’s characters. Their saves move to the server in one step.</p>
            {signInOptions}
            <button style={link} onClick={() => setPhase('characters')}>
              back
            </button>
          </>
        )}

        {status && <p style={muted} data-testid="status">{status}</p>}
        {error && (
          <p style={{ color: '#ff8a80' }} data-testid="error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

const wrap: CSSProperties = { display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 32, minHeight: '100%', boxSizing: 'border-box' };
const panel: CSSProperties = { width: 440, background: '#141b24', border: '1px solid #26313f', borderRadius: 10, padding: 24, fontSize: 14 };
const row: CSSProperties = { display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' };
const btn: CSSProperties = { background: '#2b5d8a', color: '#fff', border: 0, borderRadius: 6, padding: '7px 12px', cursor: 'pointer', fontSize: 14 };
const link: CSSProperties = { background: 'none', border: 0, color: '#8ab4f8', cursor: 'pointer', padding: 0, fontSize: 13 };
const input: CSSProperties = { flex: 1, minWidth: 0, background: '#0b0f14', color: '#e6e6e6', border: '1px solid #33404f', borderRadius: 6, padding: '7px 10px', fontSize: 14 };
const muted: CSSProperties = { color: '#93a1b0', margin: '4px 0' };
const h3: CSSProperties = { margin: '18px 0 4px', fontSize: 15 };
const charRow: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #222c38' };
