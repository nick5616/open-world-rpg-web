// window.__lodestone: a debug-only handle for headless scripts and the
// browser console (wizard-wars exposed its stores the same way for
// browser-playtest.mjs). Headless Chromium has no pointer lock, so look is
// scripted via setLook; keys still come from real keyboard events.

import { useAppStore, type Screen } from './stores/appStore';
import { useDebugStore, type TeleportTarget } from './stores/debugStore';
import { useQualityStore, type QualitySetting } from './stores/qualityStore';
import { localPlayer, netStats, worldClock } from './state/live';

export function installDevHandle(): void {
  const handle = {
    player: () => JSON.parse(JSON.stringify(localPlayer)) as typeof localPlayer,
    net: netStats,
    screen: (s: Screen) => useAppStore.getState().setScreen(s),
    teleport: (t: TeleportTarget) => useDebugStore.getState().teleport(t),
    /** Radians; pass null to give look back to the mouse. */
    setLook: (yaw: number | null, pitch = 0) => useDebugStore.getState().setLookOverride(yaw === null ? null : { yaw, pitch }),
    setFly: (v: boolean) => useDebugStore.getState().setFly(v),
    setFreezeTime: (v: boolean) => useDebugStore.getState().setFreezeTime(v),
    setShowCells: (v: boolean) => useDebugStore.getState().setShowCells(v),
    setTimeOfDay: (s: number) => {
      worldClock.timeOfDayS = s;
    },
    setQuality: (q: QualitySetting) => useQualityStore.getState().setSetting(q),
  };
  (window as unknown as { __lodestone: typeof handle }).__lodestone = handle;
}
