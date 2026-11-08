// window.__lodestone: a debug-only handle for headless scripts and the
// browser console (wizard-wars exposed its stores the same way for
// browser-playtest.mjs). Headless Chromium has no pointer lock, so look is
// scripted via setLook; keys still come from real keyboard events.

import { useAppStore, type Screen } from './stores/appStore';
import { useDebugStore, type TeleportTarget } from './stores/debugStore';
import { useQualityStore, type QualitySetting } from './stores/qualityStore';
import { localPlayer, netStats, worldClock } from './state/live';
import { netDebug, useNetStore } from './net/netStore';
import type { ReadySession } from './account/types';

export function installDevHandle(): void {
  const handle = {
    player: () => JSON.parse(JSON.stringify(localPlayer)) as typeof localPlayer,
    net: netStats,
    /** WP06: zone connection state (transport, corrections, interpolation, drawn remotes). */
    netDebug,
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
    /**
     * WP10 headless runs: connect straight to a zone with a dev ticket (no
     * account/director round trip). Fields not given are stubbed; social is
     * pointed at a dead port and just keeps backing off.
     */
    connectZone: (r: Pick<ReadySession, 'ticket' | 'zoneEndpoint' | 'zoneId' | 'worldId'> & { name?: string }) => {
      const ready: ReadySession = {
        ticket: r.ticket,
        socialTicket: '',
        ticketExpiresAt: Date.now() + 60_000,
        zoneId: r.zoneId,
        zoneEndpoint: r.zoneEndpoint,
        socialEndpoint: 'ws://127.0.0.1:9/ws',
        worldId: r.worldId,
        character: { id: 'dev', name: r.name ?? 'Dev', level: 1 } as ReadySession['character'],
        isLocalProfile: false,
        session: '',
        refreshTickets: () => Promise.reject(new Error('dev connect: no director')),
      };
      useNetStore.getState().setReady(ready);
      useAppStore.getState().setScreen('play');
    },
  };
  (window as unknown as { __lodestone: typeof handle }).__lodestone = handle;
}
