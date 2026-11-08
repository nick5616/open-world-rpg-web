// Small always-on play overlays: crosshair and the pointer-lock hint.
import { useAppStore } from '../stores/appStore';

export function Crosshair() {
  return (
    <div style={{ position: 'fixed', left: '50%', top: '50%', width: 6, height: 6, marginLeft: -3, marginTop: -3, borderRadius: '50%', background: 'rgba(255,255,255,0.85)', boxShadow: '0 0 2px rgba(0,0,0,0.8)', pointerEvents: 'none', zIndex: 10 }} />
  );
}

/**
 * Shown while the mouse is free. Not a blocking pause screen: the world is
 * shared (spec 8: no pausing), and keyboard movement keeps working so
 * headless runs (no pointer lock) can still walk.
 */
export function LockHint() {
  const locked = useAppStore((s) => s.pointerLocked);
  const panel = useAppStore((s) => s.debugPanelOpen);
  if (locked || panel) return null;
  return (
    <div style={{ position: 'fixed', left: '50%', bottom: 48, transform: 'translateX(-50%)', padding: '8px 14px', borderRadius: 4, background: 'rgba(8,10,16,0.6)', color: '#e9ecef', font: '14px system-ui, sans-serif', pointerEvents: 'none', zIndex: 10 }}>
      Click to look around · WASD move · Shift sprint · Space jump (again in the air: double jump, then glide) · G glider · hold W into a cliff to climb
    </div>
  );
}
