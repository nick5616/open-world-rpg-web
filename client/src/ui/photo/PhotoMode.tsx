// Playtest 2 photo mode (Valheim / Breath of the Wild style): P frees the
// camera from your character (PhotoRig.tsx flies it), hides the HUD, and
// opens a panel: the visual style (restored when you leave), a time-of-day
// preview of the light (client only: the world clock and everyone else's
// sky are untouched), depth of field with auto or set focus, vignette,
// grain, field of view, nameplates; Enter (or the button) saves a PNG of
// the frame without the HUD. Esc frees the mouse, Esc again (or P) leaves.
// Works in first and third person; nothing is sent to the zone.
//
// Keys: the handler is installed when this module loads (before any
// panel's own capture listener) and, while photo mode is up, swallows every
// key but the movement keys (they fly the camera; your character stands
// still) so no panel, spell or prompt reacts. A zero-size data-ui-panel
// marker stays in the page meanwhile, so the Esc menu stands aside.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { isTextTarget, KEY_MAP } from '../../input/useKeyboard';
import { useQualityStore } from '../../stores/qualityStore';
import { STYLE_ORDER, STYLES } from '../../world/style/styles';
import { PHOTO_DEFAULTS, PHOTO_KEYS, photoKeys, photoLive, usePhoto } from './store';
import { DEBUG } from '../../config';
import { photoDebug } from './PhotoRig';

export const PHOTO_KEY = 'KeyP';
const SHOT_KEY = 'Enter';
const PANEL_KEY = 'KeyH';

const CSS = `
body.ls-photo * { visibility: hidden !important; }
body.ls-photo canvas[data-engine], body.ls-photo [data-photo-ui], body.ls-photo [data-photo-ui] * { visibility: visible !important; }
`;

function panelUp(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>('[data-ui-panel]:not([style*="display: none"])')) {
    if (el.dataset.testid !== 'photo-marker') return true;
  }
  return false;
}

function gameCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('canvas[data-engine]');
}

function lockCanvas(): void {
  const c = gameCanvas();
  if (!c || document.pointerLockElement) return;
  type Req = (o?: { unadjustedMovement?: boolean }) => Promise<void> | undefined;
  const req = c.requestPointerLock as unknown as Req;
  try {
    req.call(c, { unadjustedMovement: true })?.catch?.(() => (req.call(c) as Promise<void> | undefined)?.catch?.(() => {}));
  } catch {
    /* a click on the view tries again */
  }
}

export function enterPhoto(): void {
  const s = usePhoto.getState();
  if (s.active) return;
  if (typeof document !== 'undefined') {
    if (!document.getElementById('ls-photo-css')) {
      const st = document.createElement('style');
      st.id = 'ls-photo-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    document.body.classList.add('ls-photo');
  }
  usePhoto.setState({ active: true, panelHidden: false, hour: null, styleBefore: useQualityStore.getState().style });
}

export function exitPhoto(): void {
  const s = usePhoto.getState();
  if (!s.active) return;
  if (s.styleBefore && useQualityStore.getState().style !== s.styleBefore) useQualityStore.getState().setStyle(s.styleBefore);
  usePhoto.setState({ active: false, styleBefore: null, hour: null });
  if (typeof document !== 'undefined') document.body.classList.remove('ls-photo');
  for (const k of Object.keys(photoKeys) as (keyof typeof photoKeys)[]) photoKeys[k] = false;
}

/** Save the next rendered frame as a PNG (PhotoRig does it after the render). */
export function takeShot(): void {
  photoLive.captureRequested = true;
}

function onKey(e: KeyboardEvent): void {
  const s = usePhoto.getState();
  if (!s.active) {
    if (e.type !== 'keydown' || e.code !== PHOTO_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextTarget(e.target) || panelUp()) return;
    if (!gameCanvas()) return; // not in the world
    e.preventDefault();
    e.stopImmediatePropagation();
    enterPhoto();
    return;
  }
  if (isTextTarget(e.target)) return; // the panel's own inputs
  if (KEY_MAP[e.code]) return; // movement keys fly the camera (useKeyboard)
  const k = PHOTO_KEYS[e.code];
  if (k) photoKeys[k] = e.type === 'keydown';
  if (e.type === 'keydown' && !e.repeat) {
    if (e.code === 'Escape' || e.code === PHOTO_KEY) {
      e.preventDefault();
      exitPhoto();
    } else if (e.code === SHOT_KEY) {
      e.preventDefault();
      takeShot();
    } else if (e.code === PANEL_KEY) usePhoto.setState((x) => ({ panelHidden: !x.panelHidden }));
  }
  if (k || e.code === 'Tab') e.preventDefault();
  e.stopImmediatePropagation();
}

function onMouse(e: MouseEvent): void {
  if (!usePhoto.getState().active) return;
  const t = e.target as HTMLElement | null;
  if (t?.tagName !== 'CANVAS') return;
  // No attacks, casts or camera toggles from the photo camera; a click on the view captures the mouse.
  e.stopImmediatePropagation();
  if (e.type === 'mousedown' && e.button === 0) lockCanvas();
}

function onWheel(e: WheelEvent): void {
  if (!usePhoto.getState().active || (e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
  e.stopImmediatePropagation();
  usePhoto.setState((s) => ({ fov: Math.max(20, Math.min(100, s.fov + Math.sign(e.deltaY) * 3)) }));
}

if (typeof window !== 'undefined') {
  const w = window as Window & { __lsPhotoKeys?: [(e: KeyboardEvent) => void, (e: MouseEvent) => void, (e: WheelEvent) => void] };
  if (w.__lsPhotoKeys) {
    const [k, m, wh] = w.__lsPhotoKeys;
    window.removeEventListener('keydown', k, true);
    window.removeEventListener('keyup', k, true);
    window.removeEventListener('mousedown', m, true);
    window.removeEventListener('mouseup', m, true);
    window.removeEventListener('wheel', wh, true);
  }
  w.__lsPhotoKeys = [onKey, onMouse, onWheel];
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
  window.addEventListener('mouseup', onMouse, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
}

const panel: CSSProperties = {
  position: 'fixed',
  right: 16,
  top: 16,
  width: 290,
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  padding: '14px 16px',
  borderRadius: 10,
  background: 'rgba(10,12,18,0.78)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: '#e9ecef',
  font: '13px system-ui, sans-serif',
  zIndex: 60,
  pointerEvents: 'auto',
};
const btn = (on = false): CSSProperties => ({ font: '12px system-ui, sans-serif', padding: '4px 9px', borderRadius: 4, border: '1px solid #495057', background: on ? '#2b4f7a' : '#1b1f2a', color: '#e9ecef', cursor: 'pointer' });

function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', margin: '9px 0 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.85, marginBottom: 3 }}>
        <span>{label}</span>
        {value !== undefined && <span style={{ opacity: 0.8 }}>{value}</span>}
      </div>
      {children}
    </label>
  );
}

const hhmm = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const pct = (v: number) => `${Math.round(v * 100)} %`;

export function PhotoMode() {
  const s = usePhoto();
  const style = useQualityStore((q) => q.style);
  const set = usePhoto.setState;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!s.lastShotAt) return;
    const id = setTimeout(() => tick((n) => n + 1), 2200);
    return () => clearTimeout(id);
  }, [s.lastShotAt]);
  useEffect(() => () => exitPhoto(), []);
  if (!s.active) return null;
  const saved = s.lastShotAt && performance.now() - s.lastShotAt < 2000;
  return (
    <>
      <div data-ui-panel data-testid="photo-marker" data-photo-ui style={{ position: 'fixed', width: 0, height: 0, left: 0, top: 0 }} />
      {saved ? (
        <div data-photo-ui data-testid="photo-saved" style={{ position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', padding: '6px 14px', borderRadius: 6, background: 'rgba(10,12,18,0.7)', color: '#d3f9d8', font: '13px system-ui, sans-serif', zIndex: 61 }}>
          Photo saved ({s.shots} this session)
        </div>
      ) : null}
      {s.panelHidden ? null : (
        <div data-photo-ui data-testid="photo-panel" style={panel} onMouseDown={(e) => e.stopPropagation()}>
          <div style={{ font: '600 16px Georgia, serif', color: '#ffe2c4' }}>Photo mode</div>
          <div style={{ opacity: 0.7, fontSize: 12, lineHeight: 1.45, marginTop: 4 }}>
            Click the view, then WASD to fly · Space / E up · Ctrl / Q down · Shift fast · Alt slow · Z / C roll · wheel zoom · Enter saves · H hides this · Esc frees the mouse, Esc again leaves
          </div>
          <Row label="Style">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {STYLE_ORDER.map((k) => (
                <button key={k} type="button" data-testid={`photo-style-${k}`} style={btn(style === k)} onClick={() => useQualityStore.getState().setStyle(k)}>
                  {STYLES[k].label}
                </button>
              ))}
            </div>
            {s.styleBefore && style !== s.styleBefore ? <div style={{ fontSize: 11, opacity: 0.6, marginTop: 3 }}>Back to {STYLES[s.styleBefore].label} when you leave</div> : null}
          </Row>
          <Row label="Time of day (preview)" value={s.hour === null ? 'live' : hhmm(s.hour)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input aria-label="time of day" data-testid="photo-hour" type="range" min={0} max={23.98} step={0.25} value={s.hour ?? 12} onChange={(e) => set({ hour: Number(e.target.value) })} style={{ flex: 1 }} />
              <button type="button" style={btn(s.hour === null)} onClick={() => set({ hour: null })}>
                Live
              </button>
            </div>
          </Row>
          <Row label="Depth of field" value={s.dof ? pct(s.dof) : 'off'}>
            <input aria-label="depth of field" data-testid="photo-dof" type="range" min={0} max={1} step={0.05} value={s.dof} onChange={(e) => set({ dof: Number(e.target.value) })} style={{ width: '100%' }} />
          </Row>
          {s.dof > 0 && (
            <Row label="Focus" value={s.focusM ? `${s.focusM.toFixed(1)} m` : `auto (${photoLive.autoFocusM.toFixed(1)} m)`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input aria-label="focus distance" type="range" min={0} max={80} step={0.5} value={s.focusM} onChange={(e) => set({ focusM: Number(e.target.value) })} style={{ flex: 1 }} />
                <button type="button" style={btn(s.focusM === 0)} onClick={() => set({ focusM: 0 })}>
                  Auto
                </button>
              </div>
            </Row>
          )}
          <Row label="Vignette" value={pct(s.vignette)}>
            <input aria-label="vignette" data-testid="photo-vignette" type="range" min={0} max={1} step={0.05} value={s.vignette} onChange={(e) => set({ vignette: Number(e.target.value) })} style={{ width: '100%' }} />
          </Row>
          <Row label="Grain" value={pct(s.grain)}>
            <input aria-label="grain" data-testid="photo-grain" type="range" min={0} max={1} step={0.05} value={s.grain} onChange={(e) => set({ grain: Number(e.target.value) })} style={{ width: '100%' }} />
          </Row>
          <Row label="Field of view" value={`${Math.round(s.fov)}°`}>
            <input aria-label="field of view" type="range" min={20} max={100} step={1} value={s.fov} onChange={(e) => set({ fov: Number(e.target.value) })} style={{ width: '100%' }} />
          </Row>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <input type="checkbox" checked={s.hidePlates} onChange={(e) => set({ hidePlates: e.target.checked })} />
            Hide nameplates
          </label>
          <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" data-testid="photo-shot" style={btn(true)} onClick={takeShot}>
              Save PNG (Enter)
            </button>
            <button type="button" style={btn()} onClick={() => set({ ...PHOTO_DEFAULTS })}>
              Reset
            </button>
            <button type="button" style={btn()} onClick={() => set({ panelHidden: true })}>
              Hide (H)
            </button>
            <button type="button" data-testid="photo-exit" style={btn()} onClick={exitPhoto}>
              Leave (Esc)
            </button>
          </div>
        </div>
      )}
    </>
  );
}

if (DEBUG && typeof window !== 'undefined') {
  (window as unknown as { __lodestonePhoto?: unknown }).__lodestonePhoto = {
    enter: enterPhoto,
    exit: exitPhoto,
    shot: takeShot,
    set: (p: Partial<{ hour: number | null; dof: number; focusM: number; vignette: number; grain: number; fov: number; hidePlates: boolean; panelHidden: boolean }>) => usePhoto.setState(p),
    state: () => ({ ...usePhoto.getState(), autoFocusM: photoLive.autoFocusM, cam: photoDebug.cam ? { ...photoDebug.cam.pos, yaw: photoDebug.cam.yaw, pitch: photoDebug.cam.pitch } : null }),
    /** Place the free camera (evidence: no pointer lock headless). */
    pose: (x: number, y: number, z: number, yaw: number, pitch: number) => {
      const c = photoDebug.cam;
      if (!c) return;
      c.pos.x = x;
      c.pos.y = y;
      c.pos.z = z;
      c.yaw = yaw;
      c.pitch = pitch;
    },
  };
}
