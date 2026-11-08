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

import {
  decodeMessage,
  encodeMessage,
  INPUT_REDUNDANCY,
  KickCode,
  PROTOCOL_VERSION,
  Transport,
  type InputFrame,
  type Kick,
  type Snapshot,
  type Welcome,
} from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';
import type { MoveInput, MoveState, StepEnv } from '../sim/movement';
import { ClockSync } from './clockSync';
import { EntityInterpolation, type RemoteView } from './interpolation';
import { ClientPrediction } from './prediction';
import { SnapshotDecoder, type Frame } from './snapshotDecoder';
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
  /** Injectable clocks for tests. */
  now?: () => number;
  perfNow?: () => number;
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
  readonly decoder = new SnapshotDecoder();
  readonly prediction: ClientPrediction;
  readonly interp: EntityInterpolation;
  latestFrame: Frame | null = null;

  onWelcome: ((w: Welcome) => void) | null = null;
  onEnd: ((e: SessionEnd) => void) | null = null;
  onFrame: ((f: Frame) => void) | null = null;

  /** Counters for tests and the acceptance log. */
  readonly stats = { snapshots: 0, stale: 0, noBaseline: 0, inputPackets: 0, framesSent: 0, decodeErrors: 0, earlySnapshots: 0 };

  private frames: InputFrame[] = [];
  private unsent = 0;
  private lastSend = -Infinity;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pings = 0;
  private lastPos = { x: 0, z: 0 };
  private bwWindow: { t: number; down: number; up: number }[] = [];
  private readonly now: () => number;
  private readonly perfNow: () => number;

  constructor(private readonly opts: SessionOptions) {
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
    transport.onClose = (info) => this.finish({ code: info.code, reason: info.reason });
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
    this.finish({ code: 1000, reason });
  }

  /**
   * A predicted local step (LocalSim.onStep): stored for reconciliation and
   * queued for the next Input packet.
   */
  pushStep(seq: number, input: MoveInput, state: MoveState, env?: Readonly<StepEnv>): void {
    if (this.phase !== 'playing') return;
    this.prediction.store({ seq, input, state, env });
    this.prediction.notePredicted(state);
    this.frames.push({ seq, flags: input.flags, yaw: input.yaw, pitch: input.pitch, castSlot: 0 });
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
      default:
        break; // Event, HitResult, SaveBlob...: later packages
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
    this.prediction.reconcile(f.self, f.ackInputSeq, this.perfNow());
    this.onFrame?.(f);
  }

  private handleKick(k: Kick): void {
    this.end = { code: 4000 + k.code, reason: k.reason, kick: { code: k.code, name: KICK_NAMES[k.code] ?? String(k.code), reason: k.reason } };
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
