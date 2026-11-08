// Prediction-vs-server divergence per movement mode, for headless runs (WP10).
// Wraps a live ZoneSession: every predicted step is remembered by seq, and on
// every snapshot the server's position at ackInputSeq is compared with what
// the client predicted for that step, grouped by the server's mode. Same
// measurement as the Node harness (traversalRun.ts), but inside the browser
// game loop. Exposed as window.__lodestone.probe() (dev only).

import type { ZoneSession } from '../../net/zoneSession';
import type { MoveState } from '../movement';
import { packFlags, packMoveExt } from '../moveWire';

const MODES = ['ground', 'air', 'climb', 'glide', 'swim', 'fly'];

export interface ProbeStats {
  snapshots: number;
  maxDivM: number;
  perMode: Record<string, { snapshots: number; maxDivM: number; maxY: number; minY: number }>;
  transitions: string[];
  /** G3: the first snapshots whose acked step disagreed with the prediction (any field), with what differed. */
  mismatches: { seq: number; mode: string; divCm: number; at: [number, number, number]; fields: string[] }[];
}

const probes = new WeakMap<ZoneSession, ProbeStats>();

/** Start a fresh measurement on a live probe (headless runs measure phase by phase; G3). */
export function resetProbe(session: ZoneSession): void {
  const s = probes.get(session);
  if (!s) return;
  s.snapshots = 0;
  s.maxDivM = 0;
  s.perMode = {};
  s.transitions = [];
  s.mismatches = [];
}

export function divergenceProbe(session: ZoneSession): ProbeStats {
  const existing = probes.get(session);
  if (existing) return existing;
  const stats: ProbeStats = { snapshots: 0, maxDivM: 0, perMode: {}, transitions: [], mismatches: [] };
  probes.set(session, stats);
  const predicted = new Map<number, MoveState>();
  const push = session.pushStep.bind(session);
  session.pushStep = (seq: number, input, state: MoveState, env) => {
    predicted.set(seq, { ...state, pos: { ...state.pos }, vel: { ...state.vel } });
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
    const d = Math.hypot(sx - p.pos.x, sy - p.pos.y, sz - p.pos.z);
    const mode = MODES[f.self.mode] ?? String(f.self.mode);
    if (stats.mismatches.length < 60) {
      const s = f.self;
      const fields: string[] = [];
      const cm = (v: number) => Math.round(v * 100);
      if (Math.abs(cm(p.pos.x) - s.x) > 2 || Math.abs(cm(p.pos.y) - s.y) > 2 || Math.abs(cm(p.pos.z) - s.z) > 2) fields.push(`pos (${p.pos.x.toFixed(2)},${p.pos.y.toFixed(2)},${p.pos.z.toFixed(2)})`);
      if (Math.abs(cm(p.vel.x) - s.vx) > 5 || Math.abs(cm(p.vel.y) - s.vy) > 5 || Math.abs(cm(p.vel.z) - s.vz) > 5) fields.push(`vel (${cm(p.vel.x)},${cm(p.vel.y)},${cm(p.vel.z)}) vs (${s.vx},${s.vy},${s.vz})`);
      if (p.airJumps !== s.airJumps) fields.push(`airJumps ${p.airJumps} vs ${s.airJumps}`);
      if (p.mode !== s.mode) fields.push(`mode ${MODES[p.mode]} vs ${mode}`);
      if (packFlags(p) !== s.flags) fields.push(`flags ${packFlags(p)} vs ${s.flags}`);
      if (packMoveExt(p) !== s.moveExt) fields.push(`moveExt ${packMoveExt(p)} vs ${s.moveExt}`);
      if (fields.length) stats.mismatches.push({ seq: f.ackInputSeq, mode, divCm: Math.round(d * 1000) / 10, at: [sx, sy, sz], fields });
    }
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
