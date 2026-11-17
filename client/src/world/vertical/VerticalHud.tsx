// CR 038 HUD: the name of where you are when you arrive (a layer, a named
// cavern or archipelago), a fair warning when a fall would hurt (open the
// glider), how to ride a sky lift, and the heat of the Depths. Plain DOM fed
// by a tiny store the VerticalManager writes a few times a second.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { eFree } from '../../input/interact';
import { notGameKey } from '../../input/useKeyboard';
import { nightRuntime } from '../../systems/night';

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
  use: { kind: 150 | 151 | 170 | 171; id: bigint; label: string } | null;
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
