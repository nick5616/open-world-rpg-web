// CR 038 HUD: the name of where you are when you arrive (a layer, a named
// cavern or archipelago), a fair warning when a fall would hurt (open the
// glider), how to ride a sky lift, and the heat of the Depths. Plain DOM fed
// by a tiny store the VerticalManager writes a few times a second.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { eFree } from '../../input/interact';
import { notGameKey } from '../../input/useKeyboard';
import { nightRuntime } from '../../systems/night';
import { usePalace } from '../palace/palaceStore';
import { useRace } from './race';

export interface VerticalHudState {
  /** 0 surface, 1 sky, 2 Underground, 3 Depths. */
  layer: number;
  /** The named place you are in (a cavern, a Depths hall, an archipelago), or null. */
  place: string | null;
  /** Falling fast with the ground far below: open the glider. */
  falling: boolean;
  /** Metres to the ground while falling (for the warning). */
  dropM: number;
  /** Standing at a sky lift's crystal. */
  lift: boolean;
  /** Near lava in the Depths. */
  heat: boolean;
  /** CR 038 hooks: at a sky palace's doors (Interact 150, the site index) or a sky town's activity spot (Interact 151, the prop id). */
  use: { kind: 150 | 151 | 152 | 153; id: bigint; label: string } | null;
}

export const useVerticalHud = create<VerticalHudState>(() => ({ layer: 0, place: null, falling: false, dropM: 0, lift: false, heat: false, use: null }));

const LAYER_TITLE = ['', 'The Sky', 'The Underground', 'The Depths'];

const card: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '22%',
  transform: 'translateX(-50%)',
  textAlign: 'center',
  pointerEvents: 'none',
  color: '#f4ecd8',
  textShadow: '0 2px 12px rgba(0,0,0,0.85)',
  fontFamily: 'Georgia, serif',
  transition: 'opacity 1.2s',
  zIndex: 30,
};

const hint: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: '22%',
  transform: 'translateX(-50%)',
  padding: '8px 14px',
  borderRadius: 8,
  background: 'rgba(12,14,20,0.62)',
  color: '#f4ecd8',
  font: '600 14px system-ui, sans-serif',
  pointerEvents: 'none',
  zIndex: 30,
};

/** CR 044: the palace's trial: the three wards and the Sky Guardian's health. */
function PalacePanel() {
  const st = usePalace();
  if (!st.near || st.phase < 1) return null;
  const names = ['Sun', 'Moon', 'Wind'];
  return (
    <div style={{ ...card, top: '9%', fontSize: 14 }} data-testid="palace-panel">
      <div style={{ fontSize: 16, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.9 }}>{st.name || 'The Sky Palace'}</div>
      {st.phase === 1 && (
        <div style={{ marginTop: 6, display: 'flex', gap: 14, justifyContent: 'center' }}>
          {names.map((n, i) => (
            <span key={n} style={{ color: st.wards[i] ? '#ffd870' : '#9aa0b0' }}>
              {st.wards[i] ? '\u25C9' : '\u25CB'} {n}
            </span>
          ))}
        </div>
      )}
      {st.phase === 2 && (
        <div style={{ marginTop: 6, width: 280 }}>
          <div style={{ opacity: 0.85, marginBottom: 3 }}>The Sky Guardian</div>
          <div style={{ height: 8, borderRadius: 4, background: 'rgba(0,0,0,0.5)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(0, st.boss)}%`, height: '100%', background: 'linear-gradient(90deg,#c88a2a,#ffe08a)' }} />
          </div>
        </div>
      )}
      {st.phase === 3 && <div style={{ marginTop: 6, color: '#ffd870' }}>{st.opened ? 'The guardian has fallen. You have taken your treasure.' : 'The guardian has fallen: open the chest behind the throne.'}</div>}
    </div>
  );
}

/** CR 044: the glide ring race: ring count, the clock, the result and the stand's board. */
function RacePanel() {
  const r = useRace();
  const [, tick] = useState(0);
  useEffect(() => {
    if (r.phase !== 'running') return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [r.phase]);
  if (r.phase === 'idle' || !r.course) return null;
  if ((r.phase === 'done' || r.phase === 'failed') && performance.now() - r.at > 20000) return null;
  const n = r.course.rings.length;
  const secs = r.phase === 'running' ? (performance.now() - r.startedAt) / 1000 : 0;
  const board = r.phase === 'done' && r.result ? r.result.board : r.course.board;
  return (
    <div style={{ ...card, top: '12%', left: 'auto', right: 24, transform: 'none', textAlign: 'left', fontSize: 14, minWidth: 190 }} data-testid="race-panel">
      <div style={{ fontSize: 15, letterSpacing: 2, textTransform: 'uppercase' }}>Glide Ring Race</div>
      {r.phase === 'armed' && <div style={{ marginTop: 4 }}>Fly through the first ring to start.</div>}
      {r.phase === 'running' && (
        <div style={{ marginTop: 4, fontSize: 24 }}>
          {secs.toFixed(1)} s <span style={{ fontSize: 14, opacity: 0.8 }}>ring {Math.min(r.next + 1, n)} / {n}</span>
        </div>
      )}
      {r.phase === 'failed' && <div style={{ marginTop: 4, color: '#ffb0a0' }}>{r.message}</div>}
      {r.phase === 'done' && r.result && (
        <div style={{ marginTop: 4, color: '#ffd870' }}>
          {(r.result.ms / 1000).toFixed(2)} s{r.result.medal ? ' - ' + r.result.medal + ' medal' : ''}
          {r.result.pb ? ' - new best!' : ''} (#{r.result.rank})
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>Gold {(r.course.gold / 1000).toFixed(0)} s, silver {(r.course.silver / 1000).toFixed(0)} s, bronze {(r.course.bronze / 1000).toFixed(0)} s</div>
      {board.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          {board.map((b, i) => (
            <div key={i}>
              {i + 1}. {b.n} {(b.ms / 1000).toFixed(2)} s
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function VerticalHud() {
  const layer = useVerticalHud((s) => s.layer);
  const place = useVerticalHud((s) => s.place);
  const falling = useVerticalHud((s) => s.falling);
  const dropM = useVerticalHud((s) => s.dropM);
  const lift = useVerticalHud((s) => s.lift);
  const heat = useVerticalHud((s) => s.heat);
  const use = useVerticalHud((s) => s.use);
  const canUse = !!use && eFree('vertical');
  useEffect(() => {
    if (!use) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyE' || e.repeat || notGameKey(e) || !eFree('vertical')) return;
      nightRuntime.session?.sendInteract(use.kind, use.id, 1, 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [use]);
  const [banner, setBanner] = useState<{ title: string; sub: string; at: number } | null>(null);
  const [, tick] = useState(0);

  // A banner when you arrive somewhere new (a layer or a named place).
  useEffect(() => {
    if (layer === 0 && !place) return;
    const title = place ?? LAYER_TITLE[layer];
    const sub = place ? LAYER_TITLE[layer] : '';
    setBanner({ title, sub, at: performance.now() });
    const t = setInterval(() => tick((n) => n + 1), 500);
    const end = setTimeout(() => {
      clearInterval(t);
      setBanner(null);
    }, 5200);
    return () => {
      clearInterval(t);
      clearTimeout(end);
    };
  }, [layer, place]);

  const fade = banner ? Math.max(0, Math.min(1, (5000 - (performance.now() - banner.at)) / 1200)) : 0;
  return (
    <>
      {banner && (
        <div style={{ ...card, opacity: fade }} data-testid="vertical-banner">
          <div style={{ fontSize: 34, letterSpacing: 2 }}>{banner.title}</div>
          {banner.sub && <div style={{ fontSize: 15, opacity: 0.8, marginTop: 4, letterSpacing: 4, textTransform: 'uppercase' }}>{banner.sub}</div>}
        </div>
      )}
      <PalacePanel />
      <RacePanel />
      {falling && (
        <div style={{ ...hint, background: 'rgba(120,30,20,0.72)' }} data-testid="vertical-fall">
          Falling fast, {Math.round(dropM)} m to the ground: press Space to open your glider
        </div>
      )}
      {!falling && canUse && use && (
        <div style={{ ...hint, bottom: '30%' }} data-testid="vertical-prompt">
          [E] {use.label}
        </div>
      )}
      {!falling && lift && (
        <div style={hint} data-testid="vertical-lift">
          Sky lift: jump, then press Space again to open your glider in the wind
        </div>
      )}
      {!falling && !lift && heat && (
        <div style={{ ...hint, background: 'rgba(110,40,10,0.65)' }} data-testid="vertical-heat">
          The air shimmers with heat: lava burns
        </div>
      )}
    </>
  );
}
