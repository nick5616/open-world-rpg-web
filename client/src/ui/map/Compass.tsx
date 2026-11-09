// Compass strip at the top of the HUD (spec 8: "the compass shows party
// members and pinned markers"): heading ticks and cardinal letters, party
// members (from the zone's party ring, any distance) and pins, each with its
// distance. Drawn into a canvas on rAF; markers outside the strip's
// +-100 degree window stick to its edge so you know which way to turn.

import { useEffect, useRef } from 'react';
import { localPlayer } from '../../state/live';
import { drawnRemotes } from '../../net/netStore';
import { PIN_COLORS } from './events';
import { useExploration } from './store';
import { trackedQuest } from '../quests/store'; // playtest 1: quest markers on the strip

const W = 560;
const H = 46;
const HALF_FOV = (100 * Math.PI) / 180;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Compass bearing (clockwise from north = -z) from (x, z) to (tx, tz). */
export function bearing(x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(tx - x, -(tz - z));
}

/** Heading of a yaw (yaw 0 faces -z = north; positive yaw turns toward -x = west). */
export function headingOf(yaw: number): number {
  return -yaw;
}

/** Wrap to (-pi, pi]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

export interface CompassMark {
  rel: number; // radians relative to heading, (-pi, pi]
  dist: number;
  color: string;
  label: string;
  kind: 'party' | 'pin' | 'quest';
}

/** What the strip shows right now (exported for the dev handle and tests). */
export function compassMarks(): CompassMark[] {
  const st = useExploration.getState();
  const px = localPlayer.pos.x;
  const pz = localPlayer.pos.z;
  const head = headingOf(localPlayer.yaw);
  const out: CompassMark[] = [];
  if (st.partyId) {
    for (const r of drawnRemotes.views) {
      if (r.partyId !== st.partyId) continue;
      out.push({ rel: wrapAngle(bearing(px, pz, r.x, r.z) - head), dist: Math.hypot(r.x - px, r.z - pz), color: '#4cc9f0', label: r.name, kind: 'party' });
    }
  }
  for (const p of st.pins) {
    out.push({ rel: wrapAngle(bearing(px, pz, p.x, p.z) - head), dist: Math.hypot(p.x - px, p.z - pz), color: PIN_COLORS[p.color % PIN_COLORS.length], label: p.party ? p.owner : '', kind: 'pin' });
  }
  // Playtest 1: the tracked quest's current markers (an area counts from its edge).
  const q = trackedQuest();
  for (const m of q?.markers ?? []) {
    const d = Math.hypot(m.x - px, m.z - pz);
    out.push({ rel: wrapAngle(bearing(px, pz, m.x, m.z) - head), dist: Math.max(0, d - (m.r ?? 0)), color: '#ffd166', label: m.label, kind: 'quest' });
  }
  return out;
}

export function Compass() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const toX = (rel: number) => W / 2 + (rel / HALF_FOV) * (W / 2 - 14);
    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, 'rgba(10,12,18,0)');
      grad.addColorStop(0.12, 'rgba(10,12,18,0.55)');
      grad.addColorStop(0.88, 'rgba(10,12,18,0.55)');
      grad.addColorStop(1, 'rgba(10,12,18,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 6, W, 24);
      const head = headingOf(localPlayer.yaw);
      ctx.textAlign = 'center';
      for (let d = 0; d < 360; d += 15) {
        const rel = wrapAngle((d * Math.PI) / 180 - head);
        if (Math.abs(rel) > HALF_FOV) continue;
        const x = toX(rel);
        const card = d % 45 === 0;
        ctx.strokeStyle = card ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)';
        ctx.lineWidth = card ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x, 6);
        ctx.lineTo(x, card ? 13 : 10);
        ctx.stroke();
        if (card) {
          ctx.font = d % 90 === 0 ? '700 13px system-ui, sans-serif' : '600 10px system-ui, sans-serif';
          ctx.fillStyle = d === 0 ? '#ff7b72' : '#f1f3f5';
          ctx.fillText(CARDINALS[d / 45], x, 26);
        }
      }
      for (const m of compassMarks()) {
        const clamped = Math.max(-HALF_FOV, Math.min(HALF_FOV, m.rel));
        const x = toX(clamped);
        const edge = clamped !== m.rel;
        ctx.fillStyle = m.color;
        ctx.strokeStyle = '#0b0d12';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (m.kind === 'party') ctx.arc(x, 18, 5, 0, Math.PI * 2);
        else if (m.kind === 'quest') {
          ctx.moveTo(x, 10);
          ctx.lineTo(x + 6, 18);
          ctx.lineTo(x, 26);
          ctx.lineTo(x - 6, 18);
          ctx.closePath();
        } else {
          ctx.moveTo(x, 24);
          ctx.lineTo(x - 5, 14);
          ctx.lineTo(x + 5, 14);
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.fillStyle = '#f1f3f5';
        const dist = m.dist >= 1000 ? `${(m.dist / 1000).toFixed(1)} km` : `${Math.round(m.dist)} m`;
        ctx.fillText(`${edge ? (m.rel < 0 ? '‹ ' : '') : ''}${m.label ? m.label + ' ' : ''}${dist}${edge && m.rel > 0 ? ' ›' : ''}`, Math.max(40, Math.min(W - 40, x)), 41);
      }
      // Centre notch.
      ctx.fillStyle = '#ffdf6b';
      ctx.beginPath();
      ctx.moveTo(W / 2, 30);
      ctx.lineTo(W / 2 - 5, 35);
      ctx.lineTo(W / 2 + 5, 35);
      ctx.closePath();
      ctx.fill();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} data-testid="compass" style={{ position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', width: W, height: H, pointerEvents: 'none', zIndex: 12 }} />;
}
