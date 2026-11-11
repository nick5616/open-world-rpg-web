// Playtest 2 voice settings: what the diagnostics page shows (and "Copy
// diagnostics" puts on the clipboard), plus the recent voice errors. The
// runtime fills a VoiceDiagnostics once a second while the page is open;
// guidance.ts reads the same object to explain common failures.
//
// Never in here: the join token itself (only its grant), IP addresses.

import type { AudioRates } from './stats';
import type { MicProblem, PermissionStateX, PickStatus } from './devices';
import type { MicState, PttMode, TalkMode, VoiceStatus } from './store';
import type { VoiceMode } from './spatial';

export interface VoiceError {
  at: number;
  where: string;
  message: string;
}

const MAX_ERRORS = 12;
const errors: VoiceError[] = [];

/** Remember a voice failure for the diagnostics page (newest last, a dozen kept). */
export function recordVoiceError(where: string, err: unknown): void {
  const e = err as { name?: string; message?: string } | null;
  const message = e && typeof e === 'object' ? [e.name && e.name !== 'Error' ? e.name : '', e.message ?? ''].filter(Boolean).join(': ') || String(err) : String(err);
  const last = errors[errors.length - 1];
  if (last && last.where === where && last.message === message && Date.now() - last.at < 2000) return;
  errors.push({ at: Date.now(), where, message: message.slice(0, 300) });
  if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
}

export function voiceErrors(): VoiceError[] {
  return [...errors];
}

export function clearVoiceErrors(): void {
  errors.length = 0;
}

export interface TokenInfo {
  canPublish: boolean | null;
  canSubscribe: boolean | null;
  room: string | null;
  identity: string | null;
  expiresInS: number | null;
}

export interface SpeakerDiag {
  id: string;
  name: string;
  mode: VoiceMode;
  distance: number | null;
  /** The voice's level here (pre-volume analyser), dBFS. */
  levelDb: number | null;
  volume: number;
  muted: boolean;
  stats: AudioRates | null;
}

export interface VoiceDiagnostics {
  at: number;
  status: VoiceStatus;
  statusText: string;
  room: {
    state: string | null;
    url: string | null;
    region: string | null;
    serverVersion: string | null;
    identity: string | null;
    reconnects: number;
    connectAttempts: number;
    connectFailures: number;
    connectedForS: number | null;
  };
  token: TokenInfo | null;
  listenOnly: boolean;
  listenOnlyReason: string | null;
  mic: {
    permission: PermissionStateX;
    state: MicState;
    muted: boolean;
    transmitting: boolean;
    talkMode: TalkMode;
    pttMode: PttMode;
    pttKey: string;
    muteKey: string;
    deviceLabel: string;
    devicePick: PickStatus;
    inputCount: number;
    settings: { deviceId?: string; sampleRate?: number; channelCount?: number; echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean; latencyMs?: number } | null;
    inputGainDb: number;
    /** The input boost stage is in the send path (false = the browser refused the processor: boost is not applied). */
    boostActive: boolean;
    levelDb: number | null;
    lastProblem: MicProblem | null;
  };
  output: { deviceLabel: string; selectable: boolean; outputCount: number };
  audio: { contextState: string | null; sampleRate: number | null; baseLatencyMs: number | null; outputLatencyMs: number | null };
  publisher: AudioRates | null;
  speakers: SpeakerDiag[];
  errors: VoiceError[];
  browser: string;
}

/** The JSON "Copy diagnostics" puts on the clipboard (times as ISO strings). */
export function diagnosticsJson(d: VoiceDiagnostics): string {
  const iso = (t: number) => new Date(t).toISOString();
  return JSON.stringify(
    {
      ...d,
      at: iso(d.at),
      errors: d.errors.map((e) => ({ ...e, at: iso(e.at) })),
      // The URL can carry a token as a query parameter in some setups: keep only scheme, host and path.
      room: { ...d.room, url: d.room.url ? d.room.url.replace(/[?#].*$/, '') : null },
    },
    null,
    2,
  );
}

/** Copies text; falls back to a hidden textarea where the async clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
