// Full-bleed cavern behind the title and the character screens. Layers:
//   1. a CSS cavern (gradients and faceted gems): painted at first paint and
//      kept as the whole backdrop when WebGL is missing, software-rendered or
//      lost, or `?cave=0`;
//   2. the live 3D cavern (lazy chunk), faded in once it has drawn;
//   3. drag-to-turn on the stage (pointer events on this layer, so panels
//      above it keep their own clicks).

import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { Look } from '../../net/look';
import type { StageVariant } from './caveGen';
import { calmNow, sceneMode } from './capability';

const CaveCanvas = lazy(() => import('./CaveCanvas'));

class Boundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export interface CaveBackdropProps {
  variant: StageVariant;
  /** Stage only: the look of the figure shown (null/undefined: an empty cavern). */
  look?: Look | null;
  /** Receives the drag-turn (radians), for tests and screenshots. */
  yawRef?: MutableRefObject<number>;
  children?: ReactNode;
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.innerWidth < 760);
  useEffect(() => {
    const on = () => setPhone(window.innerWidth < 760);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return phone;
}

export function CaveBackdrop({ variant, look, yawRef: external, children }: CaveBackdropProps) {
  const mode = sceneMode();
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const own = useRef(0);
  const yawRef = external ?? own;
  const phone = usePhone();
  const quality = useMemo(() => ({ tier: mode === 'full' ? ('full' as const) : ('lite' as const), ...calmNow() }), [mode]);
  const drag = useRef<{ x: number; id: number } | null>(null);
  const onFail = useCallback(() => setFailed(true), []);
  const live = mode !== 'css' && !failed;

  const down = (e: React.PointerEvent) => {
    // only a press on the cavern itself turns the figure: panels above keep their clicks
    if (variant !== 'stage' || !(e.target instanceof HTMLCanvasElement || e.target === e.currentTarget)) return;
    drag.current = { x: e.clientX, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    yawRef.current += (e.clientX - d.x) * 0.012;
    d.x = e.clientX;
  };
  const up = () => {
    drag.current = null;
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#05060f', cursor: variant === 'stage' ? 'grab' : 'default' }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      data-testid="cave-backdrop"
      data-cave={live ? (ready ? mode : 'loading') : 'css'}
    >
      <CssCave dim={live && ready} />
      {live && (
        <div style={{ position: 'absolute', inset: 0, opacity: ready ? 1 : 0, transition: 'opacity 900ms ease' }}>
          <Boundary onError={onFail}>
            <Suspense fallback={null}>
              <CaveCanvas variant={variant} quality={quality} look={look} yawRef={yawRef} offsetY={phone && variant === 'stage' ? 0.22 : phone ? 0.08 : 0} onReady={() => setReady(true)} onFail={onFail} />
            </Suspense>
          </Boundary>
        </div>
      )}
      {children}
    </div>
  );
}

const GEM_CSS = [
  { c: '#4d8cff', d: '#1f5fd6' },
  { c: '#c38bff', d: '#6b3fb5' },
  { c: '#4dff98', d: '#1c8a4b' },
  { c: '#ff3a6e', d: '#a30b43' },
  { c: '#ffd36b', d: '#b8821d' },
];

// [left %, bottom %, width px, height px, gem, rotate deg]
const SPIKES: [number, number, number, number, number, number][] = [
  [6, 0, 78, 250, 0, -8], [11, 0, 52, 160, 0, 10], [3, 0, 40, 120, 1, -20],
  [28, 0, 60, 190, 2, 6], [33, 0, 40, 110, 2, -12],
  [58, 0, 90, 300, 1, 5], [64, 0, 56, 180, 1, -14], [69, 0, 44, 120, 4, 18],
  [84, 0, 70, 230, 3, -6], [90, 0, 48, 140, 3, 12], [94, 0, 36, 100, 0, 22],
];

/** The no-WebGL cavern: dark rock gradient, a cold shaft, glowing faceted gem clusters along the floor. */
function CssCave({ dim }: { dim: boolean }) {
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, opacity: dim ? 0.0 : 1, transition: 'opacity 900ms ease', pointerEvents: 'none' }}>
      <style>{`@keyframes lsGlimmer { 0%,100% { opacity: .78 } 50% { opacity: 1 } } @media (prefers-reduced-motion: reduce) { .ls-gem { animation: none !important } }`}</style>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 70% 55% at 50% 38%, #1b2350 0%, #0d1030 45%, #05060f 80%), #05060f' }} />
      <div style={{ position: 'absolute', left: '30%', top: 0, width: '26%', height: '78%', background: 'linear-gradient(180deg, rgba(150,180,255,.20), rgba(150,180,255,0))', transform: 'skewX(-14deg)', filter: 'blur(14px)' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '26%', background: 'linear-gradient(180deg, rgba(5,6,15,0) 0%, #0a0b1c 60%, #05060f 100%)' }} />
      {SPIKES.map(([left, bottom, w, h, g, rot], i) => (
        <div
          key={i}
          className="ls-gem"
          style={{
            position: 'absolute', left: `${left}%`, bottom: `${bottom + 6}%`, width: w, height: h, transform: `rotate(${rot}deg)`, transformOrigin: '50% 100%',
            background: `linear-gradient(100deg, ${GEM_CSS[g].d} 0%, ${GEM_CSS[g].c} 45%, ${GEM_CSS[g].d} 100%)`,
            clipPath: 'polygon(50% 0%, 100% 22%, 88% 100%, 12% 100%, 0% 22%)',
            filter: `drop-shadow(0 0 22px ${GEM_CSS[g].c})`,
            animation: `lsGlimmer ${7 + (i % 4)}s ease-in-out ${i * 0.7}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

