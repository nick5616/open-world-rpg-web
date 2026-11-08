// Wake-on-demand, client half (spec 13 "wake the world on demand", WP18).
//
// The game VM (zone, social, Postgres, Redis) is stopped while nobody plays.
// Before sign-in, which needs the account service's database on that VM,
// the client asks the director (always reachable, Cloud Run) to wake it and
// shows a short "waking the world" screen until the director says awake.
// With no provider configured the director answers awake at once, so local
// development never sees the screen. An older director without /v1/wake
// (404/405) is treated as awake too.

export interface WakeReport {
  /** "awake" | "starting" | "booting" | "stopping" | "unknown" | "unreachable" */
  state: string;
  awake: boolean;
  provider: string;
  retryAfterS?: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function wakeOnce(directorUrl: string, fetchImpl: FetchLike): Promise<WakeReport> {
  let res: Response;
  try {
    res = await fetchImpl(`${directorUrl}/v1/wake`, { method: 'POST' });
  } catch {
    return { state: 'unreachable', awake: false, provider: 'unknown', retryAfterS: 3 };
  }
  if (res.status === 404 || res.status === 405) return { state: 'awake', awake: true, provider: 'none' };
  if (!res.ok) return { state: 'unknown', awake: false, provider: 'unknown', retryAfterS: 3 };
  try {
    const j = (await res.json()) as Partial<WakeReport>;
    return { state: j.state ?? 'unknown', awake: j.awake === true, provider: j.provider ?? 'unknown', retryAfterS: j.retryAfterS };
  } catch {
    return { state: 'unknown', awake: false, provider: 'unknown', retryAfterS: 3 };
  }
}

export interface WaitOptions {
  directorUrl: string;
  fetchImpl: FetchLike;
  onReport?: (r: WakeReport, elapsedMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stop polling (component unmounted). */
  signal?: { aborted: boolean };
}

/** Poll /v1/wake until awake (or aborted). Resolves with the last report. */
export async function waitAwake(o: WaitOptions): Promise<WakeReport> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const t0 = now();
  for (;;) {
    const r = await wakeOnce(o.directorUrl, o.fetchImpl);
    o.onReport?.(r, now() - t0);
    if (r.awake || o.signal?.aborted) return r;
    // Clamp: never hammer the director, never leave a player staring for long.
    await sleep(Math.min(5, Math.max(1, r.retryAfterS ?? 3)) * 1000);
    if (o.signal?.aborted) return r;
  }
}

/** What the waking screen says for a state. */
export function wakeMessage(state: string): string {
  switch (state) {
    case 'starting':
      return 'Starting the world server…';
    case 'booting':
      return 'The world is stretching: services are starting…';
    case 'stopping':
      return 'The world just fell asleep; waking it back up…';
    case 'unreachable':
      return 'Cannot reach the director yet; retrying…';
    case 'awake':
      return 'Awake!';
    default:
      return 'Waking the world…';
  }
}
