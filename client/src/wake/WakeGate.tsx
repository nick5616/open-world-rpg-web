// "Waking the world" screen (spec 13, WP18). Renders its children once the
// director reports the game VM awake; until then a short status screen.
// Stays invisible for the first moments so an awake world (or local dev,
// where the director has no wake provider) never flashes it. While mounted
// it re-pings /v1/wake every 2 minutes: time spent on the account screen
// counts as activity, so the idle stopper doesn't put the world to sleep
// under someone creating a character.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { defaultUrls } from '../account/api';
import { waitAwake, wakeMessage, wakeOnce, type WakeReport } from './wake';

const SHOW_AFTER_MS = 400;
const HEARTBEAT_MS = 2 * 60 * 1000;

export function WakeGate({ children, directorUrl = defaultUrls().director }: { children: ReactNode; directorUrl?: string }) {
  const [report, setReport] = useState<WakeReport | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const awake = skipped || report?.awake === true;

  useEffect(() => {
    const signal = { aborted: false };
    const fetchImpl = (i: string, init?: RequestInit) => fetch(i, init);
    void waitAwake({
      directorUrl,
      fetchImpl,
      signal,
      onReport: (r, ms) => {
        if (signal.aborted) return;
        setReport(r);
        setElapsed(ms);
      },
    });
    const hb = setInterval(() => void wakeOnce(directorUrl, fetchImpl), HEARTBEAT_MS);
    return () => {
      signal.aborted = true;
      clearInterval(hb);
    };
  }, [directorUrl]);

  // Tick the elapsed counter between polls.
  const [t0] = useState(() => Date.now());
  useEffect(() => {
    if (awake) return;
    const id = setInterval(() => setElapsed(Date.now() - t0), 250);
    return () => clearInterval(id);
  }, [awake, t0]);

  if (awake) return <>{children}</>;
  if (elapsed < SHOW_AFTER_MS) return null;
  const state = report?.state ?? 'starting';
  return (
    <div style={wrap}>
      <div style={panel} data-testid="waking-world" data-state={state}>
        <h1 style={{ margin: '0 0 6px' }}>Lodestone</h1>
        <div style={orb} aria-hidden />
        <p style={{ margin: '14px 0 4px', fontSize: 16 }}>{wakeMessage(state)}</p>
        <p style={muted}>
          Nobody was playing, so the world was asleep. It usually takes under a minute. {Math.floor(elapsed / 1000)} s
        </p>
        {(state === 'unreachable' || state === 'unknown' || elapsed > 120_000) && (
          <button style={link} data-testid="waking-skip" onClick={() => setSkipped(true)}>
            Continue anyway
          </button>
        )}
      </div>
      <style>{'@keyframes lodestone-wake{0%,100%{opacity:.35;transform:scale(.9)}50%{opacity:1;transform:scale(1.05)}}'}</style>
    </div>
  );
}

const wrap: CSSProperties = { display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 32, minHeight: '100%', boxSizing: 'border-box' };
const panel: CSSProperties = { width: 440, background: '#141b24', border: '1px solid #26313f', borderRadius: 10, padding: 24, fontSize: 14, textAlign: 'center' };
const muted: CSSProperties = { color: '#93a1b0', margin: '4px 0 12px' };
const link: CSSProperties = { background: 'none', border: 0, color: '#8ab4f8', cursor: 'pointer', padding: 0, fontSize: 13 };
const orb: CSSProperties = {
  width: 54,
  height: 54,
  margin: '14px auto 0',
  borderRadius: '50%',
  background: 'radial-gradient(circle at 40% 35%, #8ef0ff, #2b8fb0 45%, #10394d 75%)',
  boxShadow: '0 0 24px #3fc4e8',
  animation: 'lodestone-wake 2.4s ease-in-out infinite',
};
