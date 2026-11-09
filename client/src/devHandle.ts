// window.__lodestone: a debug-only handle for headless scripts and the
// browser console (wizard-wars exposed its stores the same way for
// browser-playtest.mjs). Headless Chromium has no pointer lock, so look is
// scripted via setLook; keys still come from real keyboard events.

import { useAppStore, type Screen } from './stores/appStore';
import { useDebugStore, type TeleportTarget } from './stores/debugStore';
import { useQualityStore, type QualitySetting } from './stores/qualityStore';
import { localPlayer, netStats, view, worldClock } from './state/live';
import { useViewStore } from './stores/viewStore';
import { netDebug, netRuntime, useNetStore } from './net/netStore';
import { divergenceProbe, resetProbe } from './sim/dev/divergenceProbe';
import type { ReadySession } from './account/types';
import { voiceDebugHook } from './voice/debugHook';

/** G4: Events and HitResults of the live session, recorded once tapped (headless acceptance). */
const tap: { session: unknown; events: { t: number; kind: number; entityId: number; targetId: number; value: number }[]; hits: { t: number; targetId: number; accepted: boolean; damage: number; targetHealthPct: number; flags: number }[] } = { session: null, events: [], hits: [] };
function ensureTap(): void {
  const s = netRuntime.session;
  if (!s || tap.session === s) return;
  tap.session = s;
  s.eventListeners.add((e) => {
    tap.events.push({ t: Date.now(), kind: e.kind, entityId: e.entityId, targetId: Number(e.targetId), value: e.value });
    if (tap.events.length > 20000) tap.events.splice(0, 5000);
  });
  const prev = s.onHitResult;
  s.onHitResult = (r) => {
    tap.hits.push({ t: Date.now(), targetId: r.targetId, accepted: r.accepted, damage: r.damage, targetHealthPct: r.targetHealthPct, flags: r.flags });
    prev?.(r);
  };
}

export function installDevHandle(): void {
  // WP19: auto quality tier changes with their time (each one recompiles
  // shaders; see qualityGuard.ts).
  const tierLog: { atMs: number; from: string; to: string }[] = [];
  useQualityStore.subscribe((s, p) => {
    if (s.tier !== p.tier) tierLog.push({ atMs: Date.now(), from: p.tier, to: s.tier });
  });
  const handle = {
    quality: () => ({ setting: useQualityStore.getState().setting, tier: useQualityStore.getState().tier, changes: tierLog.slice() }),
    player: () => JSON.parse(JSON.stringify(localPlayer)) as typeof localPlayer,
    net: netStats,
    /** WP06: zone connection state (transport, corrections, interpolation, drawn remotes). */
    netDebug,
    /** WP11: voice mixer (who is subscribed, positions, panner gains, output L/R levels). */
    voiceDebug: () => voiceDebugHook.fn?.() ?? null,
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
    /** Playtest 2: 'first' | 'third' person camera (optional shoulder 1 right / -1 left, boom distance m). */
    setView: (mode: 'first' | 'third', shoulder?: 1 | -1, distance?: number) => {
      const v = useViewStore.getState();
      v.setMode(mode);
      if (shoulder) v.setShoulder(shoulder);
      if (distance) v.setDistance(distance);
    },
    /** Playtest 2: the third-person camera this frame (boom length after collision, eye, converged aim). */
    viewState: () => JSON.parse(JSON.stringify({ ...view, aimYaw: localPlayer.aimYaw, aimPitch: localPlayer.aimPitch })) as typeof view & { aimYaw: number; aimPitch: number },
    /**
     * WP10 headless runs: connect straight to a zone with a dev ticket (no
     * account/director round trip). Fields not given are stubbed; social is
     * pointed at a dead port and just keeps backing off.
     */
    /** WP10: per-mode prediction-vs-server divergence of the live session (installs on first call). */
    probe: () => (netRuntime.session ? JSON.parse(JSON.stringify(divergenceProbe(netRuntime.session))) : null),
    /** G3: start the probe over (per-phase numbers in one long session). */
    probeReset: () => netRuntime.session && resetProbe(netRuntime.session),
    /** G4: the online character (ids for the zone's debug endpoints). */
    session: () => {
      const r = useNetStore.getState().ready;
      return r ? { characterId: r.character.id, name: r.character.name, worldId: r.worldId, zoneId: r.zoneId, zoneEndpoint: r.zoneEndpoint } : null;
    },
    /**
     * G4: rejoin the zone at a dev spawn point (zone LODESTONE_ZONE_DEV_SPAWN;
     * `?spawn=x,z`, or `x,y,z` in a cave) with a fresh director ticket for the
     * same character. Leave first (`screen('title')`) and wait until the zone
     * has let the character go, or its duplicate-login rule keeps the old position.
     */
    rejoinAt: async (at: { x: number; z: number; y?: number }) => {
      const r = useNetStore.getState().ready;
      if (!r) throw new Error('rejoinAt: not online');
      const resp = await r.refreshTickets();
      const u = new URL(resp.zone.endpoint);
      u.searchParams.set('spawn', at.y === undefined ? `${at.x.toFixed(2)},${at.z.toFixed(2)}` : `${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)}`);
      useNetStore.getState().setReady({ ...r, ticket: resp.ticket, socialTicket: resp.socialTicket, ticketExpiresAt: resp.expiresAt, zoneId: resp.zone.zoneId, zoneEndpoint: u.toString(), zoneWtEndpoint: undefined });
      useAppStore.getState().setScreen('play');
    },
    /** G4: own health from the latest SelfState (what the HUD bar draws). */
    selfHealth: () => {
      const f = netRuntime.session?.latestFrame?.self;
      return f ? { health: f.health, healthMax: f.healthMax } : null;
    },
    /** G4: start recording the live session's Events and HitResults (idempotent; call again after a reconnect). */
    tap: () => {
      ensureTap();
      return { events: tap.events.length, hits: tap.hits.length };
    },
    /** G4: recorded Events (optionally only some kinds) and HitResults since `since` (ms epoch). */
    tapped: (kinds: number[] | null = null, since = 0) => {
      ensureTap();
      return { events: tap.events.filter((e) => e.t >= since && (!kinds || kinds.includes(e.kind))), hits: tap.hits.filter((h) => h.t >= since) };
    },
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
