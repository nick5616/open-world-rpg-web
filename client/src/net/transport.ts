// Zone transports (spec 9): WebTransport over HTTP/3 when the browser has it
// and it connects in time, else the mandatory WebSocket fallback. Both carry
// the same binary frames ([msgId][body], one protocol message per frame);
// server side is server/pkg/transport.
//
// WebTransport mapping (must match server/pkg/transport/webtransport.go):
//  - reliable frames: one bidirectional stream the client opens first,
//    every frame prefixed with its length as u32 little-endian;
//  - unreliable frames (Input, ClockPing up; Snapshot, ClockPong down): one
//    datagram each. Datagrams and stream data are NOT ordered relative to
//    each other: a snapshot can arrive before Welcome, so the session ignores
//    snapshots until it has its Welcome.
//  - a dev zone's self-signed cert is pinned via serverCertificateHashes,
//    the hash arriving as the endpoint's #certHash= fragment.

export type TransportKind = 'websocket' | 'webtransport';

export interface CloseInfo {
  code: number;
  reason: string;
}

export interface NetTransport {
  readonly kind: TransportKind;
  /** Bytes including transport framing estimates (same accounting as the zone's metrics). */
  readonly bytesIn: number;
  readonly bytesOut: number;
  sendReliable(frame: Uint8Array): void;
  sendUnreliable(frame: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onFrame: ((frame: Uint8Array) => void) | null;
  onClose: ((info: CloseInfo) => void) | null;
}

/** Minimal WebSocket surface (browser WebSocket, or the `ws` package in Node tests). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultWsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

/** WebSocket header size for a payload (+4 mask bytes client -> server). */
export function wsHeaderLen(n: number, masked: boolean): number {
  const h = n >= 65536 ? 10 : n >= 126 ? 4 : 2;
  return masked ? h + 4 : h;
}

/** Same estimates as server/pkg/transport (QUIC packet + DATAGRAM frame; stream prefix + frame header). */
export const WT_DATAGRAM_OVERHEAD = 27;
export const WT_STREAM_OVERHEAD = 8;

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null; // text frames are not part of the protocol
}

export class WsTransport implements NetTransport {
  readonly kind = 'websocket' as const;
  bytesIn = 0;
  bytesOut = 0;
  onFrame: ((frame: Uint8Array) => void) | null = null;
  onClose: ((info: CloseInfo) => void) | null = null;
  private closed = false;

  private constructor(private ws: WebSocketLike) {
    ws.onmessage = (ev) => {
      const b = toBytes(ev.data);
      if (!b) return;
      this.bytesIn += b.length + wsHeaderLen(b.length, false);
      this.onFrame?.(b);
    };
    ws.onclose = (ev) => this.finish({ code: ev.code, reason: ev.reason });
    ws.onerror = () => {};
  }

  static connect(url: string, timeoutMs = 10000, factory: WebSocketFactory = defaultWsFactory): Promise<WsTransport> {
    return new Promise((resolve, reject) => {
      let ws: WebSocketLike;
      try {
        ws = factory(url);
      } catch (e) {
        reject(e);
        return;
      }
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        ws.onopen = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {}
        reject(new Error(`websocket connect timeout (${timeoutMs} ms)`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new WsTransport(ws));
      };
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        clearTimeout(timer);
        reject(new Error(`websocket closed before open (${ev.code})`));
      };
    });
  }

  sendReliable(frame: Uint8Array): void {
    if (this.closed || this.ws.readyState !== 1) return;
    this.ws.send(frame);
    this.bytesOut += frame.length + wsHeaderLen(frame.length, true);
  }

  /** TCP can't drop: unreliable frames ride the same ordered socket. */
  sendUnreliable(frame: Uint8Array): void {
    this.sendReliable(frame);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    try {
      this.ws.close(code, reason);
    } catch {}
    this.finish({ code, reason });
  }

  private finish(info: CloseInfo): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(info);
  }
}

/** Reassembles u32-LE length-prefixed frames from a byte stream. */
export class FrameParser {
  private buf = new Uint8Array(0);

  constructor(private readonly maxFrame = 1 << 20) {}

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    const out: Uint8Array[] = [];
    let off = 0;
    while (merged.length - off >= 4) {
      const n = merged[off] | (merged[off + 1] << 8) | (merged[off + 2] << 16) | (merged[off + 3] << 24);
      const len = n >>> 0;
      if (len > this.maxFrame) throw new Error(`frame of ${len} bytes exceeds ${this.maxFrame}`);
      if (merged.length - off - 4 < len) break;
      out.push(merged.slice(off + 4, off + 4 + len));
      off += 4 + len;
    }
    this.buf = merged.slice(off);
    return out;
  }
}

export function lengthPrefixed(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + frame.length);
  const n = frame.length;
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  out.set(frame, 4);
  return out;
}

/** "https://host/wt#certHash=BASE64" -> url and hash bytes (mirror of Go SplitCertHash). */
export function splitCertHash(raw: string): { url: string; hash: Uint8Array | null } {
  const i = raw.indexOf('#');
  if (i < 0) return { url: raw, hash: null };
  const url = raw.slice(0, i);
  for (const kv of raw.slice(i + 1).split('&')) {
    if (kv.startsWith('certHash=')) {
      const b64 = kv.slice('certHash='.length);
      const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      return { url, hash: bytes };
    }
  }
  return { url, hash: null };
}

/** WebTransport availability in this browser (Safari: see docs/decisions/0006). */
export function hasWebTransport(): boolean {
  return typeof (globalThis as { WebTransport?: unknown }).WebTransport === 'function';
}

// Narrow structural types for the parts of the WebTransport API we use, so
// this compiles whether or not the DOM lib ships them.
interface WTStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}
interface WTLike {
  ready: Promise<void>;
  closed: Promise<{ closeCode?: number; reason?: string }>;
  datagrams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; maxDatagramSize?: number };
  createBidirectionalStream(): Promise<WTStream>;
  close(info?: { closeCode?: number; reason?: string }): void;
}
type WTCtor = new (url: string, opts?: { serverCertificateHashes?: { algorithm: string; value: BufferSource }[] }) => WTLike;

export class WtTransport implements NetTransport {
  readonly kind = 'webtransport' as const;
  bytesIn = 0;
  bytesOut = 0;
  onFrame: ((frame: Uint8Array) => void) | null = null;
  onClose: ((info: CloseInfo) => void) | null = null;
  private closed = false;
  private streamWriter: WritableStreamDefaultWriter<Uint8Array>;
  private dgramWriter: WritableStreamDefaultWriter<Uint8Array>;

  private constructor(private wt: WTLike, stream: WTStream) {
    this.streamWriter = stream.writable.getWriter();
    this.dgramWriter = wt.datagrams.writable.getWriter();
    void this.readStream(stream.readable);
    void this.readDatagrams(wt.datagrams.readable);
    wt.closed.then(
      (info) => this.finish({ code: info?.closeCode ?? 0, reason: info?.reason ?? '' }),
      (err: unknown) => {
        // A session closed by the peer with an application code rejects with
        // a WebTransportError in Chromium; its code is not exposed there, so
        // the Kick frame (sent first) is what carries the reason.
        this.finish({ code: 0, reason: err instanceof Error ? err.message : String(err) });
      },
    );
  }

  static async connect(rawUrl: string, timeoutMs: number): Promise<WtTransport> {
    const Ctor = (globalThis as { WebTransport?: WTCtor }).WebTransport;
    if (!Ctor) throw new Error('WebTransport not available in this browser');
    const { url, hash } = splitCertHash(rawUrl);
    const wt = new Ctor(url, hash ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] } : undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`webtransport connect timeout (${timeoutMs} ms)`)), timeoutMs);
    });
    try {
      await Promise.race([wt.ready, timeout]);
      const stream = await Promise.race([wt.createBidirectionalStream(), timeout]);
      return new WtTransport(wt, stream);
    } catch (e) {
      wt.closed.catch(() => {});
      try {
        wt.close();
      } catch {}
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readStream(readable: ReadableStream<Uint8Array>): Promise<void> {
    const parser = new FrameParser();
    const reader = readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const f of parser.push(value)) {
          this.bytesIn += f.length + WT_STREAM_OVERHEAD;
          this.onFrame?.(f);
        }
      }
    } catch {
      // stream reset: the session close handler reports why
    }
  }

  private async readDatagrams(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.bytesIn += value.length + WT_DATAGRAM_OVERHEAD;
        this.onFrame?.(value);
      }
    } catch {}
  }

  sendReliable(frame: Uint8Array): void {
    if (this.closed) return;
    this.streamWriter.write(lengthPrefixed(frame)).catch(() => {});
    this.bytesOut += frame.length + WT_STREAM_OVERHEAD;
  }

  sendUnreliable(frame: Uint8Array): void {
    if (this.closed) return;
    const max = this.wt.datagrams.maxDatagramSize ?? 1100;
    if (frame.length > max) {
      this.sendReliable(frame);
      return;
    }
    // Datagram writes resolve when queued; a full queue drops (which is
    // what latest-wins wants), never blocks the frame loop.
    this.dgramWriter.write(frame).catch(() => {});
    this.bytesOut += frame.length + WT_DATAGRAM_OVERHEAD;
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    try {
      this.wt.close({ closeCode: code, reason });
    } catch {}
    this.finish({ code, reason });
  }

  private finish(info: CloseInfo): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(info);
  }
}

export interface ConnectOptions {
  wsUrl: string;
  wtUrl?: string;
  /** auto: WebTransport if available and it connects within wtTimeoutMs, else WebSocket. */
  prefer?: 'auto' | 'websocket' | 'webtransport';
  wtTimeoutMs?: number;
  wsTimeoutMs?: number;
  wsFactory?: WebSocketFactory;
}

export interface ConnectAttempt {
  kind: TransportKind;
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Pick a transport at connect (spec 9). WebTransport gets wtTimeoutMs
 * (default 2.5 s): a UDP-blocking network or a broken HTTP/3 path should not
 * cost a player more than that before the WebSocket fallback.
 */
export async function connectTransport(opts: ConnectOptions): Promise<{ transport: NetTransport; attempts: ConnectAttempt[] }> {
  const attempts: ConnectAttempt[] = [];
  const prefer = opts.prefer ?? 'auto';
  if (prefer !== 'websocket' && opts.wtUrl && hasWebTransport()) {
    const t0 = performance.now();
    try {
      const transport = await WtTransport.connect(opts.wtUrl, opts.wtTimeoutMs ?? 2500);
      attempts.push({ kind: 'webtransport', ok: true, ms: performance.now() - t0 });
      return { transport, attempts };
    } catch (e) {
      attempts.push({ kind: 'webtransport', ok: false, ms: performance.now() - t0, error: e instanceof Error ? e.message : String(e) });
      if (prefer === 'webtransport') throw new Error(`webtransport failed: ${attempts[0].error}`);
    }
  } else if (prefer === 'webtransport') {
    throw new Error(opts.wtUrl ? 'WebTransport not available in this browser' : 'zone offers no WebTransport endpoint');
  }
  const t0 = performance.now();
  const transport = await WsTransport.connect(opts.wsUrl, opts.wsTimeoutMs ?? 10000, opts.wsFactory);
  attempts.push({ kind: 'websocket', ok: true, ms: performance.now() - t0 });
  return { transport, attempts };
}
