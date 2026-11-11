// Playtest 2 voice settings: WebRTC getStats() for the diagnostics page.
// The microphone's sender (publisher) and every voice we hear (subscriber)
// report raw counters; parseAudioStats picks out the audio stream, its codec
// and the network path, withRates turns two readings into bitrate and loss
// over the interval, and the fmt* helpers make them readable. Pure: tested
// with hand-made reports.

export interface StatLike {
  id: string;
  type: string;
  timestamp?: number;
  [k: string]: unknown;
}

export interface Transport {
  /** host (direct), srflx (through NAT), prflx, relay (TURN). */
  localType: string | null;
  remoteType: string | null;
  /** udp / tcp. */
  protocol: string | null;
  /** The TURN leg's protocol when relayed (udp / tcp / tls). */
  relayProtocol: string | null;
  rttMs: number | null;
  availableOutKbps: number | null;
}

export interface AudioStats {
  direction: 'out' | 'in';
  timestamp: number;
  codec: string | null;
  clockRate: number | null;
  channels: number | null;
  fmtp: string | null;
  bytes: number;
  packets: number;
  /** Lost packets so far (out: as the server reports them back). */
  packetsLost: number;
  jitterMs: number | null;
  /** Round trip from RTCP (out) or the selected candidate pair. */
  rttMs: number | null;
  /** 0-1 audio level the browser measured (out: the microphone, in: the received voice). */
  audioLevel: number | null;
  /** in: share of samples the decoder had to invent (late or lost packets). */
  concealedPct: number | null;
  /** in: average jitter buffer delay (ms). */
  jitterBufferMs: number | null;
  transport: Transport | null;
}

export interface AudioRates extends AudioStats {
  bitrateKbps: number | null;
  /** Loss over the interval since the previous reading (else since the start), percent. */
  lossPct: number | null;
}

type StatMap = Map<string, StatLike>;

function toMap(report: Iterable<StatLike> | { forEach: (cb: (v: StatLike) => void) => void }): StatMap {
  const m: StatMap = new Map();
  // An RTCStatsReport is map-like (forEach gives the values; iterating it gives [id, value] pairs); arrays forEach too.
  if (typeof (report as { forEach?: unknown }).forEach === 'function') {
    (report as { forEach: (cb: (v: StatLike) => void) => void }).forEach((v) => m.set(v.id, v));
  } else {
    for (const v of report as Iterable<StatLike>) m.set(v.id, v);
  }
  return m;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isAudio = (s: StatLike) => s.kind === 'audio' || s.mediaType === 'audio';

function transportOf(m: StatMap): Transport | null {
  let pair: StatLike | undefined;
  for (const s of m.values()) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = m.get(s.selectedCandidatePairId);
    if (pair) break;
  }
  if (!pair) for (const s of m.values()) if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated === true || s.selected === true)) pair = s;
  if (!pair) return null;
  const local = typeof pair.localCandidateId === 'string' ? m.get(pair.localCandidateId) : undefined;
  const remote = typeof pair.remoteCandidateId === 'string' ? m.get(pair.remoteCandidateId) : undefined;
  const rtt = num(pair.currentRoundTripTime);
  const avail = num(pair.availableOutgoingBitrate);
  return {
    localType: str(local?.candidateType),
    remoteType: str(remote?.candidateType),
    protocol: str(local?.protocol) ?? str(remote?.protocol),
    relayProtocol: str(local?.relayProtocol),
    rttMs: rtt !== null ? rtt * 1000 : null,
    availableOutKbps: avail !== null ? avail / 1000 : null,
  };
}

/** The audio stream in one getStats() report: the sender's outbound-rtp ('out') or the receiver's inbound-rtp ('in'). */
export function parseAudioStats(report: Iterable<StatLike> | { forEach: (cb: (v: StatLike) => void) => void }, direction: 'out' | 'in'): AudioStats | null {
  const m = toMap(report);
  const rtp = [...m.values()].find((s) => s.type === (direction === 'out' ? 'outbound-rtp' : 'inbound-rtp') && isAudio(s));
  if (!rtp) return null;
  const codec = typeof rtp.codecId === 'string' ? m.get(rtp.codecId) : undefined;
  const transport = transportOf(m);
  const out: AudioStats = {
    direction,
    timestamp: num(rtp.timestamp) ?? 0,
    codec: str(codec?.mimeType)?.replace(/^audio\//i, '').toLowerCase() ?? null,
    clockRate: num(codec?.clockRate),
    channels: num(codec?.channels),
    fmtp: str(codec?.sdpFmtpLine),
    bytes: num(direction === 'out' ? rtp.bytesSent : rtp.bytesReceived) ?? 0,
    packets: num(direction === 'out' ? rtp.packetsSent : rtp.packetsReceived) ?? 0,
    packetsLost: 0,
    jitterMs: null,
    rttMs: transport?.rttMs ?? null,
    audioLevel: null,
    concealedPct: null,
    jitterBufferMs: null,
    transport,
  };
  if (direction === 'out') {
    // The server's receiver reports back (RTCP): loss, jitter, round trip.
    const back = [...m.values()].find((s) => s.type === 'remote-inbound-rtp' && (s.localId === rtp.id || isAudio(s)));
    if (back) {
      out.packetsLost = Math.max(0, num(back.packetsLost) ?? 0);
      const j = num(back.jitter);
      out.jitterMs = j !== null ? j * 1000 : null;
      const rtt = num(back.roundTripTime);
      if (rtt !== null) out.rttMs = rtt * 1000;
    }
    const src = typeof rtp.mediaSourceId === 'string' ? m.get(rtp.mediaSourceId) : [...m.values()].find((s) => s.type === 'media-source' && isAudio(s));
    out.audioLevel = num(src?.audioLevel);
  } else {
    out.packetsLost = Math.max(0, num(rtp.packetsLost) ?? 0);
    const j = num(rtp.jitter);
    out.jitterMs = j !== null ? j * 1000 : null;
    out.audioLevel = num(rtp.audioLevel);
    const concealed = num(rtp.concealedSamples);
    const total = num(rtp.totalSamplesReceived);
    out.concealedPct = concealed !== null && total ? (100 * concealed) / total : null;
    const jbd = num(rtp.jitterBufferDelay);
    const jbn = num(rtp.jitterBufferEmittedCount);
    out.jitterBufferMs = jbd !== null && jbn ? (1000 * jbd) / jbn : null;
  }
  return out;
}

/** Bitrate and loss between two readings of the same stream (or totals when there is no previous one). */
export function withRates(cur: AudioStats, prev: AudioStats | null): AudioRates {
  let bitrateKbps: number | null = null;
  let lossPct: number | null = null;
  const dt = prev ? (cur.timestamp - prev.timestamp) / 1000 : 0;
  if (prev && dt > 0 && cur.bytes >= prev.bytes) {
    bitrateKbps = ((cur.bytes - prev.bytes) * 8) / 1000 / dt;
    const dp = cur.packets - prev.packets;
    const dl = Math.max(0, cur.packetsLost - prev.packetsLost);
    lossPct = dp + dl > 0 ? (100 * dl) / (dp + dl) : 0;
  } else if (cur.packets + cur.packetsLost > 0) {
    lossPct = (100 * cur.packetsLost) / (cur.packets + cur.packetsLost);
  }
  return { ...cur, bitrateKbps, lossPct };
}

const dash = '–';

export function fmtKbps(v: number | null | undefined): string {
  if (v === null || v === undefined) return dash;
  return v >= 100 ? `${Math.round(v)} kbps` : `${v.toFixed(1)} kbps`;
}

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return dash;
  return v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`;
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return dash;
  return v >= 10 ? `${Math.round(v)} %` : `${v.toFixed(1)} %`;
}

export function fmtDb(v: number | null | undefined): string {
  if (v === null || v === undefined || v <= -99) return '-∞ dBFS';
  return `${v.toFixed(1)} dBFS`;
}

/** A browser audioLevel (0-1, linear) in dBFS. */
export function levelToDb(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return v > 0 ? 20 * Math.log10(v) : -100;
}

/** "opus 48 kHz mono, FEC" from the codec fields. */
export function fmtCodec(s: Pick<AudioStats, 'codec' | 'clockRate' | 'channels' | 'fmtp'> | null | undefined): string {
  if (!s?.codec) return dash;
  const parts = [s.codec];
  if (s.clockRate) parts.push(`${Math.round(s.clockRate / 1000)} kHz`);
  if (s.fmtp && /stereo=1/.test(s.fmtp)) parts.push('stereo');
  else if (s.channels) parts.push(s.channels >= 2 ? '(2 ch)' : 'mono');
  const extras: string[] = [];
  if (s.fmtp && /useinbandfec=1/.test(s.fmtp)) extras.push('FEC');
  if (s.fmtp && /usedtx=1/.test(s.fmtp)) extras.push('DTX');
  return parts.join(' ') + (extras.length ? `, ${extras.join(' + ')}` : '');
}

/** "UDP direct" / "UDP via NAT" / "TCP" / "TURN relay (tcp)". */
export function fmtTransport(t: Transport | null | undefined): string {
  if (!t) return dash;
  const proto = (t.protocol ?? '?').toUpperCase();
  if (t.localType === 'relay' || t.remoteType === 'relay') return `TURN relay (${(t.relayProtocol ?? t.protocol ?? '?').toLowerCase()})`;
  const how = t.localType === 'host' ? 'direct' : t.localType === 'srflx' || t.localType === 'prflx' ? 'via NAT' : t.localType ?? '';
  return `${proto} ${how}`.trim();
}

/** A rough quality word for the header: good / fair / poor. */
export function quality(s: { lossPct: number | null; rttMs: number | null; jitterMs: number | null } | null): 'good' | 'fair' | 'poor' | 'unknown' {
  if (!s || (s.lossPct === null && s.rttMs === null)) return 'unknown';
  const loss = s.lossPct ?? 0;
  const rtt = s.rttMs ?? 0;
  const jit = s.jitterMs ?? 0;
  if (loss > 8 || rtt > 400 || jit > 60) return 'poor';
  if (loss > 2 || rtt > 200 || jit > 30) return 'fair';
  return 'good';
}
