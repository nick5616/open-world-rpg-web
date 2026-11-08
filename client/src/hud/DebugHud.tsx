// Debug HUD: frame stats, position, move mode, look, world cell/chunk, quality
// tier, plus the net/world slots WP05/WP06 fill (state/live.ts netStats).
// Runs its own rAF and writes text straight into the DOM: it exists to
// diagnose main-thread jank, so it must not cause React re-renders itself.
//
// adapted from wizard-wars client/src/components/ui/FrameStats.tsx (extended
// with the spec 13 slots: transport, RTT, bandwidth, chunk queue).

import { useEffect, useRef } from 'react';
import { AOI_CELL_M, CHUNK_SIZE_M, DAY_LENGTH_S } from '@lodestone/contracts';
import { localPlayer, netStats, worldClock } from '../state/live';
import { useQualityStore } from '../stores/qualityStore';
import { useDebugStore } from '../stores/debugStore';
import { FrameStatsWindow, fpsColor } from './frameStats';

const dash = (v: number | string | null, unit = '') => (v === null ? '--' : `${v}${unit}`);
const clock = (s: number) => {
  const h = Math.floor((s / DAY_LENGTH_S) * 24);
  const m = Math.floor(((s / DAY_LENGTH_S) * 24 - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export function DebugHud() {
  const fpsRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const stats = new FrameStatsWindow();
    let raf = 0;
    let lastBody = 0;
    const tick = (now: number) => {
      const w = stats.tick(now);
      if (w) {
        if (fpsRef.current) {
          fpsRef.current.textContent = `${w.fps} FPS`;
          fpsRef.current.style.color = fpsColor(w.fps);
        }
        if (frameRef.current) {
          frameRef.current.textContent = `${w.avgMs.toFixed(1)} ms avg · ${w.maxMs.toFixed(0)} ms max · ${w.dropped} dropped`;
          frameRef.current.style.color = w.dropped > 0 ? '#ff6b6b' : '#ced4da';
        }
        // Exposed for headless captures/benchmarks (scripts/headless-shots.mjs).
        (window as unknown as { __lodestoneFrame?: unknown }).__lodestoneFrame = w;
      }
      // Body text ~10 Hz: readable, and cheap.
      if (now - lastBody > 100 && bodyRef.current) {
        lastBody = now;
        const p = localPlayer.pos;
        const v = localPlayer.vel;
        const hs = Math.hypot(v.x, v.z);
        const yawDeg = (((-localPlayer.yaw * 180) / Math.PI) % 360 + 360) % 360; // compass-style: clockwise from -Z (north)
        const dbg = useDebugStore.getState();
        bodyRef.current.textContent = [
          `pos   ${p.x.toFixed(2)}  ${p.y.toFixed(2)}  ${p.z.toFixed(2)}`,
          `vel   ${hs.toFixed(2)} m/s  vy ${v.y.toFixed(2)}`,
          `mode  ${localPlayer.mode}${localPlayer.grounded ? '' : `  air jumps ${localPlayer.airJumps}`}`,
          `look  yaw ${yawDeg.toFixed(0)}°  pitch ${((localPlayer.pitch * 180) / Math.PI).toFixed(0)}°`,
          `cell  ${Math.floor(p.x / AOI_CELL_M)},${Math.floor(p.z / AOI_CELL_M)}  chunk ${Math.floor(p.x / CHUNK_SIZE_M)},${Math.floor(p.z / CHUNK_SIZE_M)}`,
          `step  #${localPlayer.seq}`,
          `time  ${clock(worldClock.timeOfDayS)}${dbg.freezeTime ? ' (frozen)' : ''}  quality ${useQualityStore.getState().tier}`,
          `net   ${dash(netStats.transport)}  rtt ${dash(netStats.rttMs, ' ms')}  ↓${dash(netStats.downKbps, ' kbps')} ↑${dash(netStats.upKbps, ' kbps')}`,
          `chunk queue ${dash(netStats.chunkQueue)}  loaded ${dash(netStats.chunksLoaded)}`,
          ...(netStats.sync ? [`sync  ${netStats.sync}`] : []),
        ].join('\n');
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div data-testid="debug-hud" style={{ position: 'fixed', top: 10, left: 10, zIndex: 20, pointerEvents: 'none', font: '12px/1.45 ui-monospace, Consolas, monospace', color: '#e9ecef', background: 'rgba(8,10,16,0.62)', padding: '6px 9px', borderRadius: 4, minWidth: 300 }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 3 }}>
        <span ref={fpsRef} data-testid="hud-fps" style={{ color: '#8ce99a', fontWeight: 700 }}>-- FPS</span>
        <span ref={frameRef}>-- ms</span>
      </div>
      <pre ref={bodyRef} style={{ margin: 0, font: 'inherit' }} />
      <div style={{ opacity: 0.55, marginTop: 3 }}>F3 hud · ` debug panel · V fly (offline; online V talks) · F4 cells</div>
    </div>
  );
}
