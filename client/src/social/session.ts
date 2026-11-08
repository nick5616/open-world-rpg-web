// One social session per signed-in player: the socket, the store wiring,
// presence reporting and the command line. Whoever holds the ReadySession
// (the play flow, WP06) calls startSocial once; the UI only reads the store.

import { CHUNK_SIZE_M, REGION_CHUNKS, WORLD_REGIONS } from '@lodestone/contracts';
import { HELP_LINES, parseInput, regionOf } from './commands';
import { showBubble } from './bubbles';
import { SocialSocket } from './socket';
import { useSocialStore } from './store';
import type { C2S, S2C } from './types';

export interface StartSocialOptions {
  /** ReadySession.socialEndpoint */
  endpoint: string;
  /** ReadySession.socialTicket */
  ticket: string;
  /** Fresh social ticket for reconnects, e.g. () => api.socialTicket(session, characterId).then(r => r.socialTicket) */
  refreshTicket?: () => Promise<string>;
  /** Zone server the player is connected to (ReadySession.zoneId); rides in presence. */
  zoneId: () => string;
  /** Feet position in world meters, or null before spawn. Read at 2 Hz. */
  position: () => { x: number; z: number } | null;
  WebSocketImpl?: typeof WebSocket;
}

const REGION_M = CHUNK_SIZE_M * REGION_CHUNKS;
// Presence at 2 Hz while moving keeps local-chat range (30 m) honest to
// within a few meters at sprint speed; idle players resend every 5 s so the
// server never acts on a stale region for long.
const PRESENCE_MS = 500;
const PRESENCE_IDLE_MS = 5000;

let socket: SocialSocket | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;

// WP11: other packages (voice) listen for replies to their own requests
// (voice_token) without going through the chat store.
const listeners = new Set<(msg: S2C) => void>();

/** Listen to every server frame; returns an unsubscribe function. */
export function onSocialMessage(fn: (msg: S2C) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function onMessage(msg: S2C) {
  for (const fn of listeners) fn(msg);
  const store = useSocialStore.getState();
  store.apply(msg);
  if (msg.type === 'chat' && msg.message.channel === 'local' && msg.message.fromName) {
    showBubble(msg.message.fromName, msg.message.text, { x: msg.message.x, z: msg.message.z });
  }
}

/** Connect the social socket and start reporting presence. Idempotent: a second call replaces the first session. */
export function startSocial(opts: StartSocialOptions): void {
  stopSocial();
  useSocialStore.getState().reset();
  socket = new SocialSocket({
    endpoint: opts.endpoint,
    ticket: opts.ticket,
    refreshTicket: opts.refreshTicket,
    WebSocketImpl: opts.WebSocketImpl,
    onMessage,
    onStatus: (status, reason) => useSocialStore.getState().setStatus(status, reason),
  });
  socket.start();
  let last: { x: number; z: number; zone: string; at: number } | null = null;
  presenceTimer = setInterval(() => {
    const p = opts.position();
    if (!p || !socket) return;
    const zone = opts.zoneId();
    const t = Date.now();
    const moved = !last || Math.hypot(p.x - last.x, p.z - last.z) > 0.5 || zone !== last.zone;
    if (!moved && last && t - last.at < PRESENCE_IDLE_MS) return;
    last = { x: p.x, z: p.z, zone, at: t };
    socket.send({ type: 'presence', region: regionOf(p.x, p.z, REGION_M, WORLD_REGIONS), x: p.x, z: p.z, zoneId: zone });
  }, PRESENCE_MS);
}

export function stopSocial(): void {
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
  socket?.stop();
  socket = null;
}

/** Send a raw protocol message (UI buttons: invite, accept, block...). */
export function sendSocial(msg: C2S): void {
  if (!socket) {
    useSocialStore.getState().localNotice('Not connected to chat.', 'error');
    return;
  }
  socket.send(msg);
}

/** Run one line from the chat input. Returns true if the input should be cleared. */
export function submitChatInput(text: string): boolean {
  const s = useSocialStore.getState();
  const cmd = parseInput(text, { activeTab: s.activeTab, whisperName: (tab) => s.whisperNames[tab] });
  switch (cmd.kind) {
    case 'none':
      return false;
    case 'error':
      s.localNotice(cmd.message, 'error');
      return false;
    case 'help':
      HELP_LINES.forEach((l) => s.localNotice(l));
      return true;
    case 'openWhisper':
      s.openWhisper(cmd.to);
      return true;
    case 'send':
      if (cmd.msg.type === 'whisper') s.openWhisper(cmd.msg.to);
      sendSocial(cmd.msg);
      return true;
  }
}
