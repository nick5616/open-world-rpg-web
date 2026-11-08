// The dev handle (window.__lodestone.voiceDebug) reads voice state through
// this tiny module, so the title screen bundle does not pull in
// livekit-client: runtime.ts (lazy, with the play screen) fills it in.
export const voiceDebugHook: { fn: (() => unknown) | null } = { fn: null };
