// Wire types for the account service and director. The source of truth is
// server/account/README.md and server/director/README.md; keep these in step.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A signed local-profile save (server/pkg/localsave.Blob). Treat as opaque: any edit breaks the signature. */
export interface SaveBlob {
  format: 'lodestone-save';
  v: number;
  profileId: string;
  characterId: string;
  worldId: string;
  counter: number;
  issuedAt: number;
  /** Character state as JSON text, signed byte for byte. */
  state: string;
  sig: string;
}

export interface Account {
  id: string;
  provider: string;
  status: string;
  createdAt: string;
}

export interface LocalProfileInfo {
  id: string;
  createdAt: string;
  upgradedAccountId?: string;
}

export interface SessionResponse {
  session: string;
  expiresAt: number;
  kind: 'account' | 'local';
  account?: Account;
  profile?: LocalProfileInfo;
  name?: string;
}

export interface AuthConfig {
  devAuth: boolean;
  firebase: { projectId: string } | null;
  localProfiles: boolean;
  providers: string[];
}

export interface World {
  id: string;
  name: string;
  seed: string;
  spec: unknown;
  genVersion: string;
  atlasHash: string;
  official: boolean;
}

export interface Character {
  id: string;
  worldId: string;
  name: string;
  level: number;
  xp: number;
  position: Vec3;
  local: boolean;
  accountId?: string;
  profileId?: string;
  createdAt: string;
}

export interface CreateCharacterResponse {
  character: Character;
  save?: SaveBlob;
}

export interface ConnectResponse {
  ticket: string;
  socialTicket: string;
  expiresAt: number;
  zone: { zoneId: string; endpoint: string; wtEndpoint?: string };
  socialEndpoint: string;
  worldId: string;
  region: { x: number; z: number };
  character: Character;
  isLocalProfile: boolean;
}

/** Handed to the game by AccountScreen's onReady: everything needed to connect. */
export interface ReadySession {
  /** Zone connect ticket (audience zone:<zoneId>), valid 60 s. */
  ticket: string;
  /** Social service ticket (audience social), valid 60 s. */
  socialTicket: string;
  ticketExpiresAt: number;
  zoneId: string;
  zoneEndpoint: string;
  zoneWtEndpoint?: string;
  socialEndpoint: string;
  worldId: string;
  character: Character;
  isLocalProfile: boolean;
  /** Session token (12 h) for asking the director for fresh tickets. */
  session: string;
  /** Local profiles: the newest save blob, which the zone verifies on connect. */
  save?: SaveBlob;
  /** Ask the director again (zone handoff, reconnect after the 60 s ticket expired). */
  refreshTickets: () => Promise<ConnectResponse>;
}
