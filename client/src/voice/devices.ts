// Playtest 2 voice settings: microphones and speakers. The choice is saved
// by device id and label (ids can change between sessions or after a
// replug; the label usually doesn't), and pickDevice decides which device
// to use now: the saved one, the same name under a new id, or the system
// default while the saved one is unplugged (and back to it when it returns).

export interface DevicePref {
  id: string;
  label: string;
}

export interface DeviceInfo {
  deviceId: string;
  label: string;
  groupId?: string;
}

export type PickStatus =
  /** No preference: the system default. */
  | 'default'
  /** The saved device, same id. */
  | 'chosen'
  /** The saved device by name under a new id (browser reset ids, replug). */
  | 'matched-label'
  /** The saved device is missing (unplugged): the default stands in. */
  | 'fallback'
  /** No device of this kind at all. */
  | 'none';

export interface Pick {
  deviceId: string;
  label: string;
  status: PickStatus;
}

/** The browser's default entry (Chrome lists "default" and "communications" first), else the first device. */
function systemDefault(list: DeviceInfo[]): DeviceInfo | undefined {
  return list.find((d) => d.deviceId === 'default') ?? list[0];
}

export function pickDevice(list: DeviceInfo[], pref: DevicePref | null): Pick {
  if (!list.length) return { deviceId: '', label: '', status: 'none' };
  const def = systemDefault(list)!;
  if (!pref || !pref.id || pref.id === 'default') return { deviceId: def.deviceId, label: def.label, status: 'default' };
  const same = list.find((d) => d.deviceId === pref.id);
  if (same) return { deviceId: same.deviceId, label: same.label || pref.label, status: 'chosen' };
  // Labels are empty until the page has microphone permission: no match then.
  const named = pref.label ? list.find((d) => d.label === pref.label && d.deviceId !== 'default' && d.deviceId !== 'communications') : undefined;
  if (named) return { deviceId: named.deviceId, label: named.label, status: 'matched-label' };
  return { deviceId: def.deviceId, label: def.label, status: 'fallback' };
}

/** A name for a device the browser won't label yet (no permission). */
export function deviceName(d: DeviceInfo, i: number, kind: 'input' | 'output'): string {
  if (d.label) return d.label;
  if (d.deviceId === 'default') return 'System default';
  return `${kind === 'input' ? 'Microphone' : 'Speakers'} ${i + 1}`;
}

/** Whether a speaker can be chosen here (AudioContext.setSinkId: Chrome / Edge 110+). */
export function outputSelectable(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
}

export interface DeviceLists {
  inputs: DeviceInfo[];
  outputs: DeviceInfo[];
}

export async function listDevices(): Promise<DeviceLists> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.enumerateDevices) return { inputs: [], outputs: [] };
  try {
    const all = await md.enumerateDevices();
    const map = (k: MediaDeviceKind) => all.filter((d) => d.kind === k).map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }));
    return { inputs: map('audioinput'), outputs: map('audiooutput') };
  } catch {
    return { inputs: [], outputs: [] };
  }
}

/** Calls `fn` when a device is plugged in or out. Returns the unsubscribe. */
export function onDeviceChange(fn: () => void): () => void {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.addEventListener) return () => {};
  md.addEventListener('devicechange', fn);
  return () => md.removeEventListener('devicechange', fn);
}

export type MicProblem = 'denied' | 'no-device' | 'busy' | 'constraints' | 'insecure' | 'other';

/** What a getUserMedia failure means for the player. */
export function micProblem(err: unknown): MicProblem {
  const name = (err as { name?: string } | null)?.name ?? '';
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '');
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || /permission|denied|not allowed/i.test(msg)) return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || /requested device not found|no device/i.test(msg)) return 'no-device';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError' || /could not start|in use/i.test(msg)) return 'busy';
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return 'constraints';
  if (name === 'SecurityError' || name === 'TypeError') return 'insecure';
  return 'other';
}

export type PermissionStateX = PermissionState | 'unknown';

/** The microphone permission (Permissions API; "unknown" where the browser won't say, e.g. Firefox). */
export async function micPermission(): Promise<PermissionStateX> {
  try {
    const st = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return st.state;
  } catch {
    return 'unknown';
  }
}

type SinkCtx = AudioContext & { sinkId?: string | object; setSinkId?: (id: string) => Promise<void> };

/** Routes a context to the saved speakers (or the default while they are unplugged). Returns what it picked. */
export async function applySink(ctx: AudioContext | null | undefined, pref: DevicePref | null): Promise<Pick | null> {
  const c = ctx as SinkCtx | null | undefined;
  if (!c?.setSinkId || c.state === 'closed') return null;
  const { outputs } = await listDevices();
  const pick = pickDevice(outputs, pref);
  const want = pick.status === 'none' || pick.deviceId === 'default' ? '' : pick.deviceId;
  const cur = typeof c.sinkId === 'string' ? c.sinkId : '';
  if (cur !== want) await c.setSinkId(want).catch(() => {});
  return pick;
}

/** getUserMedia audio constraints from the saved settings. */
export function audioConstraints(p: { deviceId: string; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }): MediaTrackConstraints {
  const c: MediaTrackConstraints = { echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGainControl, channelCount: 1 };
  if (p.deviceId && p.deviceId !== 'default') c.deviceId = { exact: p.deviceId };
  return c;
}
