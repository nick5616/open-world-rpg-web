// Prediction-vs-server divergence per movement mode, for headless runs (WP10).
// Wraps a live ZoneSession: every predicted step is remembered by seq, and on
// every snapshot the server's position at ackInputSeq is compared with what
// the client predicted for that step, grouped by the server's mode. Same
// measurement as the Node harness (traversalRun.ts), but inside the browser
// game loop. Exposed as window.__lodestone.probe() (dev only).

import type { ZoneSession } from '../../net/zoneSession';
import type { MoveState } from '../movement';

const MODES = ['ground', 'air', 'climb', 'glide', 'swim', 'fly'];

export interface ProbeStats {
  snapshots: number;
  maxDivM: number;
  perMode: Record<string, { snapshots: number; maxDivM: number; maxY: number; minY: number }>;
  transitions: string[];
}

const probes = new WeakMap<ZoneSession, ProbeStats>();

export function divergenceProbe(session: ZoneSession): ProbeStats {
  const existing = probes.get(session);
  if (existing) return existing;
  const stats: ProbeStats = { snapshots: 0, maxDivM: 0, perMode: {}, transitions: [] };
  probes.set(session, stats);
  const predicted = new Map<number, { x: number; y: number; z: number }>();
  const push = session.pushStep.bind(session);
  session.pushStep = (seq: number, input, state: MoveState, env) => {
    predicted.set(seq, { x: state.pos.x, y: state.pos.y, z: state.pos.z });
    if (predicted.size > 2000) predicted.delete(predicted.keys().next().value as number);
    push(seq, input, state, env);
  };
  const prev = session.onFrame;
  let lastMode = -1;
  session.onFrame = (f) => {
    prev?.(f);
    const p = predicted.get(f.ackInputSeq);
    if (!p) return;
    const sx = f.self.x / 100;
    const sy = f.self.y / 100;
    const sz = f.self.z / 100;
    const d = Math.hypot(sx - p.x, sy - p.y, sz - p.z);
    const mode = MODES[f.self.mode] ?? String(f.self.mode);
    const m = (stats.perMode[mode] ??= { snapshots: 0, maxDivM: 0, maxY: -Infinity, minY: Infinity });
    m.snapshots++;
    m.maxDivM = Math.max(m.maxDivM, d);
    m.maxY = Math.max(m.maxY, sy);
    m.minY = Math.min(m.minY, sy);
    stats.snapshots++;
    stats.maxDivM = Math.max(stats.maxDivM, d);
    if (f.self.mode !== lastMode) {
      stats.transitions.push(`seq ${f.ackInputSeq}: ${lastMode < 0 ? 'start' : MODES[lastMode]} -> ${mode} at (${sx.toFixed(2)}, ${sy.toFixed(2)}, ${sz.toFixed(2)})`);
      lastMode = f.self.mode;
    }
  };
  return stats;
}
