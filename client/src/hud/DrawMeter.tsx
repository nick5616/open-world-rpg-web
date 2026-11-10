// CR 033 (playtest 2 bow rework): how far the bow is drawn, a thin ring
// round the crosshair that closes as the draw grows and turns gold at full
// draw (the hardest, fastest, farthest shot). Hidden unless drawing. Like the
// stamina wheel it reads the timeline on its own rAF and writes the DOM
// directly (no React render per frame).

import { useEffect, useRef } from 'react';
import { combatRuntime } from '../combat/link';

const R = 11;
const C = 2 * Math.PI * R;

export function DrawMeter() {
  const wrap = useRef<HTMLDivElement>(null);
  const arc = useRef<SVGCircleElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      const f = combatRuntime.current?.timeline.drawFrac ?? 0;
      const key = f.toFixed(3);
      if (key !== last && wrap.current && arc.current) {
        last = key;
        wrap.current.style.opacity = f > 0 ? '1' : '0';
        wrap.current.dataset.draw = (f * 100).toFixed(0);
        arc.current.style.strokeDashoffset = String(C * (1 - f));
        arc.current.style.stroke = f >= 1 ? '#ffd43b' : 'rgba(255,255,255,0.75)';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={wrap} data-testid="draw-meter" style={{ position: 'fixed', left: 'calc(50% - 15px)', top: 'calc(50% - 15px)', width: 30, height: 30, pointerEvents: 'none', zIndex: 10, opacity: 0, transition: 'opacity 120ms' }}>
      <svg width="30" height="30" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r={R} fill="none" stroke="rgba(8,10,16,0.35)" strokeWidth="3" />
        <circle ref={arc} cx="15" cy="15" r={R} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1.6" strokeDasharray={C} strokeDashoffset={C} strokeLinecap="round" transform="rotate(-90 15 15)" />
      </svg>
    </div>
  );
}
