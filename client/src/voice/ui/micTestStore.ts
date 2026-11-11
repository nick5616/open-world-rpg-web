// Playtest 2 voice settings: the running mic test (one at a time), shared by
// the settings' tabs (the Microphone tab's meter uses it before the voice
// microphone exists). Follows the saved settings while it runs, and stops
// when the settings close.

import { create } from 'zustand';
import { useVoiceStore } from '../store';
import { MicTest, MicTestError } from '../micTest';
import { pickDevice, listDevices, type MicProblem } from '../devices';

interface MicTestState {
  test: MicTest | null;
  starting: boolean;
  problem: MicProblem | null;
  error: string;
  loopback: boolean;
  phase: 'idle' | 'recording' | 'recorded' | 'playing';
  recordLeftMs: number;
  recording: Blob | null;
  set: (p: Partial<MicTestState>) => void;
}

export const useMicTest = create<MicTestState>()((set) => ({
  test: null,
  starting: false,
  problem: null,
  error: '',
  loopback: false,
  phase: 'idle',
  recordLeftMs: 0,
  recording: null,
  set: (p) => set(p),
}));

export const RECORD_MS = 5000;

async function options() {
  const s = useVoiceStore.getState();
  const { inputs } = await listDevices();
  const pick = pickDevice(inputs, s.inputDevice);
  return { deviceId: pick.deviceId, echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl, gainDb: s.inputGainDb };
}

export async function startMicTest(): Promise<MicTest | null> {
  const st = useMicTest.getState();
  if (st.test) return st.test;
  if (st.starting) return null;
  st.set({ starting: true, problem: null, error: '' });
  try {
    const test = await MicTest.start(await options());
    // Closed or stopped while the permission prompt was up.
    if (!useMicTest.getState().starting) {
      test.stop();
      return null;
    }
    test.setLoopback(useMicTest.getState().loopback, useVoiceStore.getState().loopbackDelayMs);
    useMicTest.getState().set({ test, starting: false });
    return test;
  } catch (e) {
    useMicTest.getState().set({ starting: false, problem: e instanceof MicTestError ? e.problem : 'other', error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export function stopMicTest(): void {
  const st = useMicTest.getState();
  st.test?.stop();
  st.set({ test: null, starting: false, loopback: false, phase: st.recording ? 'recorded' : 'idle', recordLeftMs: 0 });
}

/** Restarts a running test with the new device / processing. */
async function restartMicTest(): Promise<void> {
  const st = useMicTest.getState();
  if (!st.test) return;
  st.test.stop();
  st.set({ test: null });
  await startMicTest();
}

export async function recordAndPlay(): Promise<void> {
  const test = useMicTest.getState().test ?? (await startMicTest());
  if (!test || useMicTest.getState().phase === 'recording') return;
  const set = useMicTest.getState().set;
  set({ phase: 'recording', recordLeftMs: RECORD_MS, recording: null });
  const t0 = performance.now();
  const tick = setInterval(() => set({ recordLeftMs: Math.max(0, RECORD_MS - (performance.now() - t0)) }), 200);
  try {
    const blob = await test.record(RECORD_MS);
    set({ recording: blob, phase: 'recorded' });
    await playRecording();
  } catch (e) {
    set({ phase: 'idle', error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearInterval(tick);
  }
}

export async function playRecording(): Promise<void> {
  const st = useMicTest.getState();
  if (!st.recording) return;
  const s = useVoiceStore.getState();
  st.set({ phase: 'playing' });
  const el = new Audio();
  const test = st.test;
  if (test) await test.play(st.recording, s.outputDevice?.id && s.outputDevice.id !== 'default' ? s.outputDevice.id : '', Math.min(1, s.masterVolume));
  else {
    // The test stopped: play without it.
    el.src = URL.createObjectURL(st.recording);
    await new Promise<void>((r) => {
      el.onended = () => r();
      el.onerror = () => r();
      el.play().catch(() => r());
    });
    URL.revokeObjectURL(el.src);
  }
  useMicTest.getState().set({ phase: 'recorded' });
}

// Follow the settings while a test runs.
useVoiceStore.subscribe((s, prev) => {
  const t = useMicTest.getState().test;
  if (!t) return;
  if (s.inputGainDb !== prev.inputGainDb) t.setGainDb(s.inputGainDb);
  if (s.loopbackDelayMs !== prev.loopbackDelayMs) t.setLoopback(useMicTest.getState().loopback, s.loopbackDelayMs);
  if (s.inputDevice?.id !== prev.inputDevice?.id || s.echoCancellation !== prev.echoCancellation || s.noiseSuppression !== prev.noiseSuppression || s.autoGainControl !== prev.autoGainControl) void restartMicTest();
  if (!s.settingsOpen && prev.settingsOpen) stopMicTest();
});
