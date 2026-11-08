// WP12 HUD layer: compass strip, discovery toasts, the map (M) and its
// hotkeys, plus the debug handle `window.__lodestoneMap` for headless runs.
// Mounted by the play screen in both online and offline play; offline the
// map and compass work but nothing is ever revealed (progress is the
// server's).

import { useEffect } from 'react';
import { DEBUG } from '../../config';
import { localPlayer } from '../../state/live';
import { Compass, compassMarks } from './Compass';
import { MapScreen, mapView } from './MapScreen';
import { pruneToasts, setMapOpen, useExploration, type Toast } from './store';
import { useMapWorld } from './world';
import { hasBit } from './events';

const TOAST_STYLE: Record<Toast['kind'], { accent: string; icon: string }> = {
  discovery: { accent: '#ffd166', icon: '✦' },
  tower: { accent: '#ff7b72', icon: '▲' },
  waypoint: { accent: '#4cc9f0', icon: '◆' },
  level: { accent: '#b388ff', icon: '★' },
  info: { accent: '#adb5bd', icon: '•' },
  warn: { accent: '#ff922b', icon: '!' },
};

function Toasts() {
  const toasts = useExploration((s) => s.toasts);
  useEffect(() => {
    const id = setInterval(() => pruneToasts(), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', pointerEvents: 'none', zIndex: 13 }}>
      {toasts.map((t) => {
        const s = TOAST_STYLE[t.kind];
        return (
          <div key={t.id} data-testid={`toast-${t.kind}`} style={{ minWidth: 260, padding: '8px 16px', background: 'rgba(12,14,20,0.78)', borderTop: `2px solid ${s.accent}`, borderRadius: 3, color: '#f1f3f5', textAlign: 'center', font: '15px Georgia, serif', boxShadow: '0 4px 14px rgba(0,0,0,0.35)', animation: 'wp12toast 0.35s ease-out' }}>
            <div style={{ letterSpacing: 0.5 }}>
              <span style={{ color: s.accent, marginRight: 8 }}>{s.icon}</span>
              {t.title}
            </div>
            {t.detail && <div style={{ font: '12px system-ui, sans-serif', opacity: 0.75, marginTop: 2 }}>{t.detail}</div>}
          </div>
        );
      })}
      <style>{'@keyframes wp12toast { from { opacity: 0; transform: translateY(-8px) } to { opacity: 1; transform: none } }'}</style>
    </div>
  );
}

function useMapHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // typing in chat
      if (e.code === 'KeyM' && !e.repeat) setMapOpen(!useExploration.getState().mapOpen);
      else if (e.code === 'Escape' && useExploration.getState().mapOpen) setMapOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Headless scripts and the console read exploration state through this. */
function installMapHandle() {
  const handle = {
    state: () => {
      const s = useExploration.getState();
      return {
        level: s.progress.level,
        xp: Number(s.progress.xp),
        revealed: s.progress.revealed,
        lastWaypoint: s.progress.lastWaypoint,
        towersUnlocked: s.progress.towers.reduce((n, b) => n + popcount8(b), 0),
        waypointsUnlocked: s.progress.waypoints.reduce((n, b) => n + popcount8(b), 0),
        discoveries: s.progress.discoveries.reduce((n, b) => n + popcount8(b), 0),
        pins: s.pins,
        partyId: s.partyId,
        stats: s.stats,
        toasts: s.toasts.map((t) => ({ kind: t.kind, title: t.title, detail: t.detail })),
        mapOpen: s.mapOpen,
        online: !!s.actions,
      };
    },
    /** Towers with site index, region, top height and whether unlocked. */
    towers: () => {
      const unlocked = useExploration.getState().progress.towers;
      return useMapWorld.getState().towers.map((t) => {
        const site = useMapWorld.getState().data!.sites[t.site];
        return { site: t.site, region: site.region, name: site.name, x: t.shape.cx, z: t.shape.cz, topY: t.shape.topY, maxR: t.shape.maxR, ledgeR: t.shape.r[t.shape.r.length - 1], unlocked: hasBit(unlocked, t.site) };
      });
    },
    sites: (kind?: string) => (useMapWorld.getState().data?.sites ?? []).filter((s) => !kind || s.kind === kind).map((s) => ({ index: s.index, kind: s.kind, name: s.name, region: s.region, x: s.x, z: s.z })),
    open: (v = true) => setMapOpen(v),
    fastTravel: (site: number) => useExploration.getState().actions?.fastTravel(site),
    setPin: (x: number, z: number, party = false, color = 0) => useExploration.getState().actions?.setPin(x, z, party, color),
    compass: () => compassMarks(),
    /** Page coordinates of a world point on the open map (null when closed). */
    mapScreenPos: (x: number, z: number) => mapView.toScreen?.(x, z) ?? null,
    player: () => ({ ...localPlayer.pos, yaw: localPlayer.yaw }),
  };
  (window as unknown as { __lodestoneMap: typeof handle }).__lodestoneMap = handle;
}

function popcount8(b: number): number {
  let n = 0;
  for (let x = b; x; x &= x - 1) n++;
  return n;
}

export function ExplorationHud() {
  useMapHotkeys();
  useEffect(() => {
    if (DEBUG) installMapHandle();
  }, []);
  return (
    <>
      <Compass />
      <Toasts />
      <MapScreen />
    </>
  );
}
