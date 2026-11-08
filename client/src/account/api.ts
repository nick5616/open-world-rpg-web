// HTTP client for the account service (8091) and director (8090). Endpoints
// are documented in server/account/README.md and server/director/README.md.
import type {
  AuthConfig,
  Character,
  ConnectResponse,
  CreateCharacterResponse,
  SaveBlob,
  SessionResponse,
  Vec3,
  World,
} from './types';

/** A non-2xx response. `code` is the server's machine-readable error (e.g. "name_taken", "waking_world"). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiUrls {
  account: string;
  director: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Default URLs from Vite env (set by `npm run dev`), falling back to local ports. */
export function defaultUrls(): ApiUrls {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    account: env.VITE_ACCOUNT_URL ?? 'http://localhost:8091',
    director: env.VITE_DIRECTOR_URL ?? 'http://localhost:8090',
  };
}

export class LodestoneApi {
  constructor(
    readonly urls: ApiUrls,
    // Bound so callers can pass window.fetch without losing `this` (Illegal invocation).
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {}

  private async call<T>(base: string, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    } catch (e) {
      throw new ApiError(0, 'network', `cannot reach ${base}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const j = (json ?? {}) as { error?: string; message?: string; retryAfterS?: number };
      throw new ApiError(res.status, j.error ?? 'http_' + res.status, j.message ?? (text || res.statusText), j.retryAfterS);
    }
    return json as T;
  }

  // ---- account service ----
  authConfig() {
    return this.call<AuthConfig>(this.urls.account, 'GET', '/v1/auth/config');
  }
  devSignIn(username: string) {
    return this.call<SessionResponse>(this.urls.account, 'POST', '/v1/auth/dev', { body: { username } });
  }
  firebaseSignIn(idToken: string) {
    return this.call<SessionResponse>(this.urls.account, 'POST', '/v1/auth/firebase', { body: { idToken } });
  }
  localSession(profileId: string, profileSecret: string) {
    return this.call<SessionResponse>(this.urls.account, 'POST', '/v1/local/session', { body: { profileId, profileSecret } });
  }
  worlds() {
    return this.call<{ worlds: World[] }>(this.urls.account, 'GET', '/v1/worlds').then((r) => r.worlds);
  }
  characters(token: string, worldId?: string) {
    const q = worldId ? `?worldId=${encodeURIComponent(worldId)}` : '';
    return this.call<{ characters: Character[] }>(this.urls.account, 'GET', '/v1/characters' + q, { token }).then((r) => r.characters);
  }
  createCharacter(token: string, worldId: string, name: string, appearance?: Record<string, unknown>) {
    return this.call<CreateCharacterResponse>(this.urls.account, 'POST', '/v1/characters', { token, body: { worldId, name, appearance } });
  }
  verifySave(token: string, save: SaveBlob) {
    return this.call<{ ok: true; counter: number; characterId: string; name: string; level: number }>(this.urls.account, 'POST', '/v1/local/saves/verify', { token, body: { save } });
  }
  upgrade(accountToken: string, localSession: string, saves: SaveBlob[]) {
    return this.call<{ accountId: string; characters: Character[] }>(this.urls.account, 'POST', '/v1/local/upgrade', { token: accountToken, body: { localSession, saves } });
  }
  /** Dev only: stands in for a zone save point and returns the next blob. */
  devResave(token: string, save: SaveBlob, set: { level?: number; xp?: number; position?: Vec3 } = {}) {
    return this.call<{ save: SaveBlob }>(this.urls.account, 'POST', '/v1/dev/local/resave', { token, body: { save, set } }).then((r) => r.save);
  }

  // ---- director ----
  connect(token: string, characterId: string, save?: SaveBlob) {
    return this.call<ConnectResponse>(this.urls.director, 'POST', '/v1/connect', { token, body: { characterId, save } });
  }
  socialTicket(token: string, characterId: string) {
    return this.call<{ socialTicket: string; expiresAt: number; socialEndpoint: string }>(this.urls.director, 'POST', '/v1/social-ticket', { token, body: { characterId } });
  }
  worldStatus(worldId: string) {
    return this.call<{ worldId: string; awake: boolean; zones: number; players: number }>(this.urls.director, 'GET', `/v1/worlds/${worldId}/status`);
  }
}
