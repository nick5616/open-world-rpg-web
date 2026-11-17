// Immersive HUD pieces (CR 052): the Esc menu's "Interface" page (the switch
// that shows everything as before), and the low-health feedback that lives
// in the picture instead of a tip: the screen edges darken and desaturate a
// little as health runs low, and a heartbeat sounds (slow, never flashing).
// Reduce flashing (stores/accessibility.ts) and prefers-reduced-motion
// keep the vignette steady (no breathing) and the heartbeat quieter.

import { useEffect, useRef } from 'react';
import { useAccessibility } from '../stores/accessibility';
import { netRuntime } from '../net/netStore';
import { useCombatHud } from '../combat/store';
import { emitSound } from '../audio/bridge';
import { registerMenuEntry } from '../ui/menu/store';
import { useHudSettings } from './immersive';

/** Health fraction below which the edges begin to close in, and where it is strongest. */
export const LOW_HP_START = 0.4;
export const LOW_HP_FULL = 0.1;

/** Pure: 0..1 how strongly the low-health effect shows. */
export function lowHealthAmount(hp: number): number {
  if (hp <= 0) return 0; // downed: the downed overlay owns the screen
  if (hp >= LOW_HP_START) return 0;
  return Math.max(0, Math.min(1, (LOW_HP_START - hp) / (LOW_HP_START - LOW_HP_FULL)));
}

/** Pure: seconds between heartbeats for a low-health amount (slower is calmer: 1.5 s .. 0.85 s). */
export function heartbeatPeriod(amount: number): number {
  return 1.5 - 0.65 * Math.max(0, Math.min(1, amount));
}

/** The vignette: one fixed div with a radial gradient and a backdrop that desaturates a touch; opacity written per frame. */
export function LowHealthVignette() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useAccessibility((s) => s.reduceFlashing);
  useEffect(() => {
    let raf = 0;
    let nextBeat = 0;
    let shown = -1;
    const calm = reduce || (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const tick = (nowMs: number) => {
      raf = requestAnimationFrame(tick);
      const el = ref.current;
      if (!el) return;
      const self = netRuntime.session?.latestFrame?.self;
      const hp = self ? self.health / Math.max(1, self.healthMax) : 1;
      const a = lowHealthAmount(hp);
      const downed = useCombatHud.getState().downedUntil > nowMs;
      const amt = downed ? 0 : a;
      // A slow swell with each heartbeat (under 1.2 Hz, tiny amplitude): never a flash; steady when calm.
      const swell = calm || amt === 0 ? 0 : 0.12 * Math.max(0, Math.sin((nowMs / 1000) * ((2 * Math.PI) / heartbeatPeriod(amt))));
      const o = amt === 0 ? 0 : Math.min(1, 0.35 + 0.55 * amt + swell);
      if (Math.abs(o - shown) > 0.004) {
        shown = o;
        el.style.opacity = String(o);
      }
      if (amt > 0 && nowMs >= nextBeat) {
        // lub-dub
        emitSound('heartbeat', { volume: calm ? 0.5 : 1 });
        nextBeat = nowMs + heartbeatPeriod(amt) * 1000;
      }
      if (amt === 0) nextBeat = 0;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);
  return (
    <div
      ref={ref}
      data-testid="low-health-vignette"
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 9,
        opacity: 0,
        transition: 'opacity 600ms ease',
        background: 'radial-gradient(ellipse at center, rgba(40,6,8,0) 52%, rgba(40,6,8,0.38) 80%, rgba(14,2,4,0.72) 100%)',
        backdropFilter: 'saturate(0.8)',
      }}
    />
  );
}

/** The switch for the Immersive HUD, as a page in the Esc menu. */
function InterfacePage() {
  const immersive = useHudSettings((s) => s.immersive);
  const set = useHudSettings((s) => s.setImmersive);
  return (
    <div data-testid="menu-interface-page" style={{ width: 'min(420px, calc(100vw - 72px))' }}>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input data-testid="immersive-toggle" type="checkbox" checked={immersive} onChange={(e) => set(e.target.checked)} style={{ marginTop: 4 }} />
        <span>
          <b>Immersive HUD</b>
          <span style={{ display: 'block', fontSize: 13, opacity: 0.75, marginTop: 2 }}>A quiet screen: health, mana and the hotbar appear when they matter, the quest card tucks away behind the compass, and notices are shorter. Turn it off to show everything all the time, as before.</span>
        </span>
      </label>
      <div style={{ fontSize: 13, opacity: 0.7, marginTop: 12 }}>
        Press <b>.</b> (period) any time for a guiding wisp that flies ahead of you toward your quest or map pin. Hold <b>Tab</b> or open <b>J</b> to see the quest card.
      </div>
    </div>
  );
}

/** Mount once on the play screen: the low-health vignette and the menu entry. */
export function ImmersiveHud() {
  useEffect(() => registerMenuEntry({ id: 'interface', label: 'Interface', order: 12, render: () => <InterfacePage /> }), []);
  return <LowHealthVignette />;
}
