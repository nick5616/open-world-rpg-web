// Typed client for the creator's Go endpoint (tools/creator/server). Vite
// proxies /v1 to it in dev, so the page and the API share an origin.
import type { WorldSpec } from '@lodestone/contracts';
import type { Change } from './spec/normalize';

export interface CreatorConfig {
  llm: boolean;
  model: string;
  genVersion: string;
  wasmSha256: string;
  specVersion: number;
  auth: boolean;
}

export interface World {
  id: string;
  name: string;
  seed: string;
  spec: WorldSpec;
  genVersion: string;
  atlasHash: string;
  official: boolean;
  createdAt: string;
}

export interface MintResponse {
  world: World;
  existed: boolean;
  source: string;
  changes: Change[];
  atlas: { bytes: number; sites: number; buildMs: number };
}

export interface VibeResponse {
  spec: WorldSpec;
  changes: Change[];
  cached: boolean;
  attempts: number;
  model: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

let token = '';
/** Bearer token for servers started with LODESTONE_CREATOR_TOKEN. */
export function setToken(t: string) {
  token = t;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(0, 'unreachable', `creator server unreachable: ${String(e)}`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(json.error ?? 'error'), String(json.message ?? res.statusText), (json.details as string[]) ?? []);
  return json as T;
}

export const api = {
  config: () => call<CreatorConfig>('GET', '/v1/config'),
  worlds: () => call<{ worlds: World[] }>('GET', '/v1/worlds?limit=20'),
  mintSeed: (seed: string) => call<MintResponse>('POST', '/v1/mint', { seed }),
  mintSpec: (spec: WorldSpec, source: string) => call<MintResponse>('POST', '/v1/mint', { spec, source }),
  vibe: (prompt: string, seed: string) => call<VibeResponse>('POST', '/v1/vibe', { prompt, seed }),
};
