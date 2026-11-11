// The dev handle (window.__lodestone.voiceDebug / voiceDiagnostics) reads
// voice state through this tiny module, so the title screen bundle does not
// pull in livekit-client: runtime.ts (lazy, with the play screen) fills it in.
export const voiceDebugHook: { fn: (() => unknown) | null; diag: (() => Promise<unknown>) | null } = { fn: null, diag: null };
