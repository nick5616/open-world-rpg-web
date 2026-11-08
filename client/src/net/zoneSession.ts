// One connection to a zone server: handshake, 30 Hz input packets, snapshot
// decode + ack, reconciliation of the local player, interpolation of
// everyone else, clock sync and bandwidth stats. Independent of React and
// three.js so it runs in Node tests against a real zone process.
//
// Protocol (server/zone/README.md "Session protocol"):
//  Hello{protocolVersion, ticket, clientTime, transport, saveBlob} ->
//  Welcome | Kick; then Input at 30 Hz carrying the newest 60 Hz frames plus
//  INPUT_REDUNDANCY repeats and ackTick = newest applied snapshot; Snapshot
//  every tick; ClockPing <-> ClockPong.
//
// WP16 multiple zones (server/zone/README.md "Multiple zones", decision
// 0016): a ZoneTransfer(kind 0) asks us to pre-connect to the neighbor zone
// with a one-time token; that connection waits on standby until its Welcome,
// which means the server moved ownership there. We then swap the active
// connection, reset the snapshot decoder, resend the inputs the old zone may
// not have applied, and keep everything else: prediction (the new zone
// continues the exact state, so the next snapshot agrees), interpolation
// (entity ids are world-stable, zone clocks are all Unix time) and clock
// sync. The old connection stays open as a standby for the way back. When
// the active zone dies instead (a reclaimed spot VM, spec 13) and the
// caller gave us `reconnect`, we fail over: fresh director ticket, connect
// to whoever owns the region now, and snap to the checkpoint it loaded.

import {
  decodeMessage,
  encodeMessage,
  INPUT_REDUNDANCY,
  KickCode,
  PROTOCOL_VERSION,
  Transport,
  type Event as ZoneEvent,
  type HitResult,
  type InputFrame,
  type Kick,
  type Snapshot,
  type Welcome,
  type WorldEdits,
  type ZoneTransfer,
} from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';
import type { MoveInput, MoveState, StepEnv } from '../sim/movement';
import { ClockSync } from './clockSync';
import { EntityInterpolation, type RemoteView } from './interpolation';
import { ClientPrediction } from './prediction';
import { SnapshotDecoder, type Frame } from './snapshotDecoder';
import { fromSelf } from '../sim/moveWire';
import { connectTransport, type ConnectAttempt, type ConnectOptions, type NetTransport } from './transport';

export type SessionPhase = 'connecting' | 'handshake' | 'playing' | 'closed';

export interface SessionEndpoints {
  /** ws(s)://.../ws (always present). */
  wsUrl: string;
  /** https://.../wt[#certHash=...] when the zone offers WebTransport. */
  wtUrl?: string;
}

export interface SessionOptions extends SessionEndpoints {
  ticket: string;
  ground: GroundQuery;
  /** Local profiles' signed save blob (JSON text, presented to the zone). */
  saveBlob?: Uint8Array;
  prefer?: ConnectOptions['prefer'];
  wtTimeoutMs?: number;
  wsFactory?: ConnectOptions['wsFactory'];
  /** WP16: the zone this connects to first (ZoneTransfer and failover change it). */
  zoneId?: string;
  /**
   * WP16 failover: a fresh ticket and endpoints for whoever owns our region
   * now (the director). Without it a dropped connection ends the session.
   */
  reconnect?: () => Promise<FailoverTarget>;
  /** Injectable clocks for tests. */
  now?: () => number;
  perfNow?: () => number;
}

/** WP16: where to fail over to. */
export interface FailoverTarget {
  zoneId: string;
  ticket: string;
  wsUrl: string;
  wtUrl?: string;
}

/** WP16: one ownership switch, for tests and the acceptance log. */
export interface TransferRecord {
  atMs: number;
  from: string;
  to: string;
  kind: 'handoff' | 'failover';
  /** Since the old zone's last snapshot (handoff) or since the drop (failover). */
  gapMs: number;
  entityId: number;
}

export interface SessionEnd {
  code: number;
  reason: string;
  kick?: { code: number; name: string; reason: string };
}

const KICK_NAMES: Record<number, string> = Object.fromEntries(Object.entries(KickCode).map(([k, v]) => [v, k]));

/** One InputFrame packet every 33 ms: 2 new frames at 60 Hz. */
const SEND_INTERVAL_MS = 1000 / 30;

export class ZoneSession {
  phase: SessionPhase = 'connecting';
  transport: NetTransport | null = null;
  attempts: ConnectAttempt[] = [];
  welcome: Welcome | null = null;
  end: SessionEnd | null = null;
  readonly clock: ClockSync;
  /** Replaced on every zone switch (each zone has its own snapshot baselines). */
  decoder = new SnapshotDecoder();
  /** WP16: the zone owning us now, standby connections by zone, switches so far. */
  zoneId: string;
  readonly standby = new Map<string, NetTransport>();
  readonly transfers: TransferRecord[] = [];
  onTransfer: ((r: TransferRecord) => void) | null = null;
  readonly prediction: ClientPrediction;
  readonly interp: EntityInterpolation;
  latestFrame: Frame | null = null;

  onWelcome: ((w: Welcome) => void) | null = null;
  onEnd: ((e: SessionEnd) => void) | null = null;
  onFrame: ((f: Frame) => void) | null = null;
  /** WP12: reliable gameplay Events (contracts/events.md) and local-profile save blobs. */
  onEvent: ((e: ZoneEvent) => void) | null = null;
  onSaveBlob: ((blob: Uint8Array) => void) | null = null;
  /** WP13: HitResults (combat uses eventListeners for its Events). */
  onHitResult: ((r: HitResult) => void) | null = null;
  /** WP09: world edits (mined veins), and extra Event listeners (mining 700-799) next to onEvent. */
  onWorldEdits: ((m: WorldEdits) => void) | null = null;
  readonly eventListeners = new Set<(e: ZoneEvent) => void>();

  /** Counters for tests and the acceptance log. */
  readonly stats = { snapshots: 0, stale: 0, noBaseline: 0, inputPackets: 0, framesSent: 0, decodeErrors: 0, earlySnapshots: 0, preconnects: 0, handoffs: 0, failovers: 0, resent: 0 };

  private frames: InputFrame[] = [];
  private unsent = 0;
  private lastSend = -Infinity;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pings = 0;
  private lastPos = { x: 0, z: 0 };
  private bwWindow: { t: number; down: number; up: number }[] = [];
  private readonly now: () => number;
  private readonly perfNow: () => number;
  private lastSnapAt = 0;
  private failingOver = false;
  private forceOnNextSnapshot = false;
  private latestSaveBlob: Uint8Array | undefined;

  constructor(private readonly opts: SessionOptions) {
    this.zoneId = opts.zoneId ?? '';
    this.latestSaveBlob = opts.saveBlob;
    this.now = opts.now ?? Date.now;
    this.perfNow = opts.perfNow ?? (() => performance.now());
    this.clock = new ClockSync(this.now);
    this.prediction = new ClientPrediction(opts.ground);
    this.interp = new EntityInterpolation(opts.ground);
  }

  /** Connect, send Hello and resolve with Welcome (rejects on kick/close). */
  async start(): Promise<Welcome> {
    const { transport, attempts } = await connectTransport({ wsUrl: this.opts.wsUrl, wtUrl: this.opts.wtUrl, prefer: this.opts.prefer, wtTimeoutMs: this.opts.wtTimeoutMs, wsFactory: this.opts.wsFactory });
    if (this.phase === 'closed') {
      // Closed while connecting (React StrictMode mounts effects twice in
      // dev; a player backing out). Logging in anyway would leave a zombie
      // session that the zone's duplicate-login rule pits against the real
      // one.
      transport.close(1000, 'cancelled');
      throw new Error('session closed before it connected');
    }
    this.transport = transport;
    this.attempts = attempts;
    this.phase = 'handshake';
    const welcome = new Promise<Welcome>((resolve, reject) => {
      this.onWelcomeResolve = resolve;
      this.onWelcomeReject = reject;
    });
    transport.onFrame = (b) => this.handleFrame(b);
    transport.onClose = (info) => this.onActiveClose(transport, info);
    transport.sendReliable(
      encodeMessage({
        type: 'Hello',
        protocolVersion: PROTOCOL_VERSION,
        ticket: new TextEncoder().encode(this.opts.ticket),
        clientTime: this.now(),
        transport: transport.kind === 'webtransport' ? Transport.webtransport : Transport.websocket,
        saveBlob: this.opts.saveBlob ?? new Uint8Array(0),
      }),
    );
    return welcome;
  }

  private onWelcomeResolve: ((w: Welcome) => void) | null = null;
  private onWelcomeReject: ((e: Error) => void) | null = null;

  /** Leave politely (Bye) and close. */
  close(reason = 'bye'): void {
    if (this.phase === 'closed') return;
    try {
      this.transport?.sendReliable(encodeMessage({ type: 'Bye', reason: 0 }));
    } catch {}
    this.transport?.close(1000, reason);
    for (const t of this.standby.values()) t.close(1000, reason);
    this.standby.clear();
    this.finish({ code: 1000, reason });
  }

  /**
   * A predicted local step (LocalSim.onStep): stored for reconciliation and
   * queued for the next Input packet.
   */
  pushStep(seq: number, input: MoveInput, state: MoveState, env?: Readonly<StepEnv>): void {
    if (this.phase !== 'playing') return;
    // WP16 failover: nothing goes out until we are reconnected and the
    // renderer has snapped to the checkpoint (steps before that start from
    // where we were, not where the new zone put us).
    if (this.failingOver || this.forceOnNextSnapshot || this.prediction.awaitingForced) return;
    this.prediction.store({ seq, input, state, env });
    this.prediction.notePredicted(state);
    this.frames.push({ seq, flags: input.flags, yaw: input.yaw, pitch: input.pitch, castSlot: input.castSlot ?? 0 });
    if (this.frames.length > 64) this.frames.splice(0, this.frames.length - 64);
    this.unsent++;
    this.lastPos.x = state.pos.x;
    this.lastPos.z = state.pos.z;
  }

  /**
   * Call once per rendered frame (after LocalSim ran its steps): sends an
   * Input packet when two new frames are waiting or a send interval passed.
   * Packets carry every unsent frame plus INPUT_REDUNDANCY older ones, so a
   * lost datagram costs nothing (spec 9).
   */
  flushInput(force = false): void {
    if (this.phase !== 'playing' || !this.transport) return;
    const t = this.perfNow();
    const due = this.unsent >= 2 || (this.unsent > 0 && t - this.lastSend >= SEND_INTERVAL_MS) || (force && this.unsent > 0);
    // Even with nothing new, ack snapshots every ~100 ms so baselines stay
    // fresh while standing still (tab focused, no keys held still makes
    // frames, but a paused sim does not).
    const ackOnly = this.unsent === 0 && t - this.lastSend >= 100;
    if (!due && !ackOnly) return;
    const n = Math.min(this.frames.length, this.unsent + INPUT_REDUNDANCY);
    const frames = this.frames.slice(this.frames.length - n);
    this.transport.sendUnreliable(encodeMessage({ type: 'Input', ackTick: this.decoder.latest, frames }));
    this.stats.inputPackets++;
    this.stats.framesSent += this.unsent;
    this.unsent = 0;
    this.lastSend = t;
  }

  /** Send an Interact (reliable; WP12 fast travel and pins, WP09 mining: contracts/events.md "Interact"). */
  sendInteract(targetKind: number, targetId: bigint, action: number, arg = 0): void {
    if (this.phase !== 'playing' || !this.transport) return;
    this.transport.sendReliable(encodeMessage({ type: 'Interact', targetKind, targetId, action, arg }));
  }

  /** WP13: one predicted hit on an enemy (reliable; the zone answers with HitResult). */
  sendHitClaim(c: { attackSeq: number; attackId: number; targetId: number; tick: number; x: number; y: number; z: number; yaw: number; pitch: number }): void {
    if (this.phase !== 'playing' || !this.transport) return;
    this.transport.sendReliable(encodeMessage({ type: 'HitClaim', ...c }));
  }

  /** Advance interpolation to now and return what to draw (frameDtMs paces easing). */
  views(frameDtMs: number, out: RemoteView[] = []): RemoteView[] {
    return this.interp.update(this.now(), frameDtMs, out);
  }

  /** Down/up kbps over the last ~2 s (transport bytes incl. framing). */
  bandwidth(): { downKbps: number; upKbps: number } {
    const tr = this.transport;
    if (!tr) return { downKbps: 0, upKbps: 0 };
    const t = this.perfNow();
    this.bwWindow.push({ t, down: tr.bytesIn, up: tr.bytesOut });
    while (this.bwWindow.length > 2 && t - this.bwWindow[0].t > 2000) this.bwWindow.shift();
    const a = this.bwWindow[0];
    const dt = (t - a.t) / 1000;
    if (dt < 0.25) return { downKbps: 0, upKbps: 0 };
    return { downKbps: ((tr.bytesIn - a.down) * 8) / 1000 / dt, upKbps: ((tr.bytesOut - a.up) * 8) / 1000 / dt };
  }

  private handleFrame(b: Uint8Array): void {
    let m;
    try {
      m = decodeMessage(b);
    } catch {
      this.stats.decodeErrors++;
      return;
    }
    switch (m.type) {
      case 'Welcome':
        this.handleWelcome(m);
        break;
      case 'Snapshot':
        this.handleSnapshot(m);
        break;
      case 'ClockPong':
        this.clock.onPong(m.t1, m.t2, m.t3);
        break;
      case 'Kick':
        this.handleKick(m);
        break;
      case 'Event':
        this.onEvent?.(m);
        for (const l of this.eventListeners) l(m);
        break;
      case 'SaveBlob':
        this.latestSaveBlob = m.blob;
        this.onSaveBlob?.(m.blob);
        break;
      case 'HitResult':
        this.onHitResult?.(m);
        break;
      case 'ZoneTransfer':
        this.handleZoneTransfer(m);
        break;
      case 'WorldEdits':
        this.onWorldEdits?.(m);
        break;
      default:
        break; // HitResult...: later packages
    }
  }

  private handleWelcome(w: Welcome): void {
    if (this.welcome) return;
    this.welcome = w;
    this.phase = 'playing';
    this.lastPos = { x: w.x / 100, z: w.z / 100 };
    // Clock: a quick burst for a first estimate, then 1 Hz (spec rate
    // limit is 4/s sustained, burst 16).
    const ping = () => this.transport?.sendUnreliable(encodeMessage({ type: 'ClockPing', t1: this.now() }));
    ping();
    this.pingTimer = setInterval(() => {
      this.pings++;
      if (this.pings < 5 || this.pings % 4 === 0) ping();
    }, 250);
    this.onWelcome?.(w);
    this.onWelcomeResolve?.(w);
    this.onWelcomeResolve = this.onWelcomeReject = null;
  }

  private handleSnapshot(s: Snapshot): void {
    if (!this.welcome) {
      // A datagram can overtake Welcome on WebTransport; the zone keeps
      // sending full snapshots until we ack, so dropping it costs nothing.
      this.stats.earlySnapshots++;
      return;
    }
    const r = this.decoder.apply(s);
    if (!r.ok) {
      if (r.reason === 'stale') this.stats.stale++;
      else this.stats.noBaseline++;
      return;
    }
    const f = r.frame;
    this.stats.snapshots++;
    this.latestFrame = f;
    this.lastSnapAt = this.now();
    const arrival = this.now();
    this.interp.onSnapshot(f.serverTime, arrival);
    const self = this.welcome.entityId;
    const present = new Set<number>();
    for (const e of f.ents) {
      if (e.id === self) continue;
      present.add(e.id);
      if (f.updated.has(e.id)) this.interp.record(e, f.serverTime, this.lastPos);
      else this.interp.touch(e);
    }
    for (const id of f.removed) this.interp.remove(id, f.serverTime);
    if (s.baselineTick === 0) this.interp.removeAbsent(present, f.serverTime);
    if (this.forceOnNextSnapshot) {
      // WP16 failover: the new zone loaded our checkpoint. Snap there (the
      // renderer takes it as a correction beyond the snap distance).
      this.forceOnNextSnapshot = false;
      this.prediction.force(fromSelf(f.self));
    } else {
      this.prediction.reconcile(f.self, f.ackInputSeq, this.perfNow());
    }
    this.onFrame?.(f);
  }

  private handleKick(k: Kick): void {
    this.end = { code: 4000 + k.code, reason: k.reason, kick: { code: k.code, name: KICK_NAMES[k.code] ?? String(k.code), reason: k.reason } };
  }

  // ---- WP16: handoff between zones and failover ----

  private handleZoneTransfer(m: ZoneTransfer): void {
    if (m.kind === 1) {
      const t = this.standby.get(m.zoneId);
      this.standby.delete(m.zoneId);
      t?.close(1000, 'cancelled');
      return;
    }
    void this.preconnect(m);
  }

  /** Open the standby connection a ZoneTransfer(kind 0) asks for. */
  private async preconnect(m: ZoneTransfer): Promise<void> {
    let tr: NetTransport;
    try {
      ({ transport: tr } = await connectTransport({ wsUrl: m.endpoint, wtUrl: m.wtEndpoint || undefined, prefer: this.opts.prefer, wtTimeoutMs: this.opts.wtTimeoutMs, wsFactory: this.opts.wsFactory }));
    } catch {
      return; // the old zone keeps us and re-asks later
    }
    if (this.phase === 'closed' || this.failingOver) {
      tr.close(1000, 'cancelled');
      return;
    }
    const old = this.standby.get(m.zoneId);
    if (old && old !== tr) old.close(1000, 'replaced');
    this.standby.set(m.zoneId, tr);
    this.stats.preconnects++;
    this.attachStandby(m.zoneId, tr);
    tr.sendReliable(
      encodeMessage({
        type: 'Hello',
        protocolVersion: PROTOCOL_VERSION,
        ticket: m.ticket,
        clientTime: this.now(),
        transport: tr.kind === 'webtransport' ? Transport.webtransport : Transport.websocket,
        saveBlob: new Uint8Array(0),
      }),
    );
  }

  private attachStandby(zone: string, tr: NetTransport): void {
    tr.onFrame = (b) => this.handleStandbyFrame(zone, tr, b);
    tr.onClose = () => {
      if (this.standby.get(zone) === tr) this.standby.delete(zone);
    };
  }

  /** A frame on a standby connection: only its Welcome matters. */
  private handleStandbyFrame(zone: string, tr: NetTransport, b: Uint8Array): void {
    let m;
    try {
      m = decodeMessage(b);
    } catch {
      return;
    }
    if (m.type === 'Welcome') this.switchTo(zone, tr, m);
    else if (m.type === 'SaveBlob') {
      this.latestSaveBlob = m.blob;
      this.onSaveBlob?.(m.blob);
    }
  }

  /** Ownership moved to zone: its connection becomes the active one. */
  private switchTo(zone: string, tr: NetTransport, w: Welcome): void {
    if (this.phase !== 'playing' || this.failingOver) return;
    const old = this.transport;
    const from = this.zoneId;
    this.standby.delete(zone);
    if (old && old !== tr) {
      this.standby.set(from, old); // the old zone keeps it for the way back
      this.attachStandby(from, old);
    }
    tr.onFrame = (b) => this.handleFrame(b);
    tr.onClose = (info) => this.onActiveClose(tr, info);
    this.transport = tr;
    this.zoneId = zone;
    this.decoder = new SnapshotDecoder();
    this.bwWindow = [];
    const rec: TransferRecord = { atMs: this.now(), from, to: zone, kind: 'handoff', gapMs: this.lastSnapAt ? this.now() - this.lastSnapAt : 0, entityId: w.entityId };
    this.welcome = w;
    // Resend every frame the old zone may not have applied; the new one
    // skips those it already has (its state is at the old zone's last seq).
    const pending = this.frames.filter((f) => f.seq > this.prediction.ackSeq);
    for (let i = 0; i < pending.length; i += 16) {
      // Reliable: these frames have no later repeats (WebTransport datagrams
      // could drop them, leaving the new zone a gap it would fill by guessing).
      tr.sendReliable(encodeMessage({ type: 'Input', ackTick: 0, frames: pending.slice(i, i + 16) }));
      this.stats.resent += Math.min(16, pending.length - i);
    }
    this.unsent = 0;
    this.lastSend = this.perfNow();
    this.stats.handoffs++;
    this.transfers.push(rec);
    if (this.transfers.length > 200) this.transfers.shift();
    this.onTransfer?.(rec);
  }

  private onActiveClose(tr: NetTransport, info: { code: number; reason: string }): void {
    if (tr !== this.transport) return; // a connection we already switched away from
    const kick = this.end?.kick?.code ?? info.code - 4000;
    // Terminal kicks end the session; a zone going away (shutdown kick, or
    // the socket just dying) is what failover is for.
    const terminal = ([KickCode.bad_ticket, KickCode.version_mismatch, KickCode.duplicate_login, KickCode.rate_limited, KickCode.server_full] as number[]).includes(kick) || info.code === 1002;
    if (this.welcome && this.opts.reconnect && !terminal && this.phase === 'playing') {
      void this.failover();
      return;
    }
    this.finish({ code: info.code, reason: info.reason });
  }

  private async failover(): Promise<void> {
    if (this.failingOver) return;
    this.failingOver = true;
    this.end = null;
    for (const t of this.standby.values()) t.close(1000, 'failover');
    this.standby.clear();
    const from = this.zoneId;
    const t0 = this.now();
    let delay = 250;
    while (this.phase === 'playing' && this.now() - t0 < 60_000) {
      try {
        const target = await this.opts.reconnect!();
        const { transport: tr } = await connectTransport({ wsUrl: target.wsUrl, wtUrl: target.wtUrl, prefer: this.opts.prefer, wtTimeoutMs: this.opts.wtTimeoutMs, wsFactory: this.opts.wsFactory });
        if (this.phase !== 'playing') {
          tr.close(1000, 'cancelled');
          break;
        }
        const w = await this.helloAndWelcome(tr, target.ticket);
        tr.onFrame = (b) => this.handleFrame(b);
        tr.onClose = (info) => this.onActiveClose(tr, info);
        this.transport = tr;
        this.zoneId = target.zoneId;
        this.decoder = new SnapshotDecoder();
        this.bwWindow = [];
        this.welcome = w;
        this.frames = [];
        this.unsent = 0;
        this.prediction.reset();
        this.forceOnNextSnapshot = true;
        this.failingOver = false;
        this.stats.failovers++;
        const rec: TransferRecord = { atMs: this.now(), from, to: target.zoneId, kind: 'failover', gapMs: this.now() - t0, entityId: w.entityId };
        this.transfers.push(rec);
        this.onTransfer?.(rec);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(2000, delay * 2);
      }
    }
    this.failingOver = false;
    this.finish({ code: 1006, reason: 'zone lost; failover gave up' });
  }

  /** Hello on a fresh connection; resolves with its Welcome. */
  private helloAndWelcome(tr: NetTransport, ticket: string): Promise<Welcome> {
    return new Promise<Welcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        tr.close(1000, 'no welcome');
        reject(new Error('no welcome'));
      }, 5000);
      tr.onFrame = (b) => {
        let m;
        try {
          m = decodeMessage(b);
        } catch {
          return;
        }
        if (m.type === 'Welcome') {
          clearTimeout(timer);
          resolve(m);
        } else if (m.type === 'Kick') {
          clearTimeout(timer);
          reject(new Error(`kicked: ${m.reason}`));
        }
      };
      tr.onClose = () => {
        clearTimeout(timer);
        reject(new Error('closed'));
      };
      tr.sendReliable(
        encodeMessage({
          type: 'Hello',
          protocolVersion: PROTOCOL_VERSION,
          ticket: new TextEncoder().encode(ticket),
          clientTime: this.now(),
          transport: tr.kind === 'webtransport' ? Transport.webtransport : Transport.websocket,
          saveBlob: this.latestSaveBlob ?? new Uint8Array(0),
        }),
      );
    });
  }

  private finish(info: { code: number; reason: string }): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    // A kick frame (if it arrived) explains the close better than the code;
    // otherwise decode a 4000+KickCode close code.
    if (!this.end) {
      const kc = info.code - 4000;
      this.end = KICK_NAMES[kc] ? { ...info, kick: { code: kc, name: KICK_NAMES[kc], reason: info.reason } } : { ...info };
    }
    const e = this.end;
    this.onWelcomeReject?.(new Error(e.kick ? `kicked: ${e.kick.name} (${e.kick.reason})` : `connection closed (${e.code}${e.reason ? ': ' + e.reason : ''})`));
    this.onWelcomeResolve = this.onWelcomeReject = null;
    this.onEnd?.(e);
  }
}
