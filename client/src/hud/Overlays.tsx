// Small always-on play overlays: crosshair and the pointer-lock hint.
import { useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { ABOVE_HOTBAR, ensureHudLayoutCss, useHudHeight } from './layout';
import { CameraSettings } from './ViewHud';

export function Crosshair() {
  ensureHudLayoutCss(); // playtest 1: the shared HUD layout variables (hud/layout.ts)
  return (
    <div style={{ position: 'fixed', left: '50%', top: '50%', width: 6, height: 6, marginLeft: -3, marginTop: -3, borderRadius: '50%', background: 'rgba(255,255,255,0.85)', boxShadow: '0 0 2px rgba(0,0,0,0.8)', pointerEvents: 'none', zIndex: 10 }} />
  );
}

/**
 * Shown while the mouse is free. Not a blocking pause screen: the world is
 * shared (spec 8: no pausing), and keyboard movement keeps working so
 * headless runs (no pointer lock) can still walk.
 *
 * Playtest 1: it sits right above the combat hotbar (it used to be drawn
 * across it) and publishes its height (--ls-hint-h) so narrow windows lift
 * chat and voice above both.
 */
export function LockHint() {
  const locked = useAppStore((s) => s.pointerLocked);
  const panel = useAppStore((s) => s.debugPanelOpen);
  const ref = useRef<HTMLDivElement>(null);
  const show = !locked && !panel;
  useHudHeight(ref, '--ls-hint-h', show);
  if (!show) return null;
  return (
    <div
      ref={ref}
      data-testid="lock-hint"
      style={{ position: 'fixed', left: '50%', bottom: ABOVE_HOTBAR, transform: 'translateX(-50%)', width: 'max-content', maxWidth: 'min(calc(2 * var(--ls-center-half, 260px)), calc(100vw - 32px))', boxSizing: 'border-box', padding: '6px 12px', borderRadius: 4, background: 'rgba(8,10,16,0.6)', color: '#e9ecef', font: '13px/1.35 system-ui, sans-serif', textAlign: 'center', pointerEvents: 'none', zIndex: 10 }}
    >
      <b>Click to look around</b> · WASD move · Shift sprint · Space jump (again in the air: double jump, then glide) · G glider · hold W into a cliff to climb · T third person
      {/* playtest 2: the camera settings, clickable while the mouse is free */}
      <div style={{ marginTop: 5 }}>
        <CameraSettings />
      </div>
    </div>
  );
}
