// Social socket client: JSON frames over WebSocket (contracts/social.yaml),
// auth with a 60 s social ticket, reconnect with backoff.
//
// Reconnect adapted from 3d-portfolio-website src/multiplayer/connection.ts:
// delay starts at 1 s, doubles to 30 s, resets once the server welcomes us.
// Tickets live 60 s, so every reconnect asks for a fresh one (director
// POST /v1/social-ticket) instead of replaying the first.

import type { C2S, S2C } from './types';

export interface SocialSocketOptions {
  endpoint: string;
  /** First ticket (from the director's connect response). */
  ticket: string;
  /** Fresh ticket for reconnects. Without it a reconnect reuses `ticket` (fine within 60 s). */
  refreshTicket?: () => Promise<string>;
  onMessage: (msg: S2C) => void;
  onStatus: (status: 'connecting' | 'online' | 'reconnecting' | 'closed', reason?: string) => void;
  /** Injected for tests. */
  WebSocketImpl?: typeof WebSocket;
  pingMs?: number;
}

// Error codes after which reconnecting would be wrong: another window took
// over, or a moderator removed us.
const FINAL_CODES = new Set(['replaced', 'banned']);

export class SocialSocket {
  private ws: WebSocket | null = null;
  private delay = 1000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private final: string | null = null;
  private firstTicket: string | null;
  private queue: C2S[] = [];
  private welcomed = false;

  constructor(private readonly opts: SocialSocketOptions) {
    this.firstTicket = opts.ticket;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.opts.onStatus('closed');
  }

  /** Send now, or queue (bounded) until the socket is welcomed again. */
  send(msg: C2S): void {
    if (this.ws && this.welcomed && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    // Presence is latest-wins: keep only the newest while offline.
    if (msg.type === 'presence') this.queue = this.queue.filter((q) => q.type !== 'presence');
    this.queue.push(msg);
    if (this.queue.length > 50) this.queue.shift();
  }

  private async ticket(): Promise<string> {
    if (this.firstTicket) {
      const t = this.firstTicket;
      this.firstTicket = null;
      return t;
    }
    return this.opts.refreshTicket ? this.opts.refreshTicket() : this.opts.ticket;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.opts.onStatus(this.welcomed ? 'reconnecting' : 'connecting');
    this.welcomed = false;
    let ticket: string;
    try {
      ticket = await this.ticket();
    } catch {
      this.retry();
      return;
    }
    if (this.stopped) return;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new WS(this.opts.endpoint);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', ticket } satisfies C2S));
    ws.onmessage = (ev) => {
      let msg: S2C;
      try {
        msg = JSON.parse(String(ev.data)) as S2C;
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.welcomed = true;
        this.delay = 1000;
        this.opts.onStatus('online');
        const q = this.queue;
        this.queue = [];
        q.forEach((m) => this.send(m));
      }
      if (msg.type === 'error' && FINAL_CODES.has(msg.code)) this.final = msg.message;
      this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ping) clearInterval(this.ping);
      if (this.final) {
        this.stopped = true;
        this.opts.onStatus('closed', this.final);
        return;
      }
      this.retry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    if (this.ping) clearInterval(this.ping);
    // Pings measure RTT and keep idle proxies from closing the socket; never queued.
    this.ping = setInterval(() => {
      if (this.welcomed) this.send({ type: 'ping', t: Date.now() });
    }, this.opts.pingMs ?? 20000);
  }

  private retry(): void {
    if (this.stopped) return;
    this.opts.onStatus('reconnecting');
    this.timer = setTimeout(() => void this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, 30000);
  }
}
