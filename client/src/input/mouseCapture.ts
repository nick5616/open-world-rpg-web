// Playtest 6 polish: the mouse belongs to the game whenever nothing else
// needs it. Browsers only grant pointer lock on a user gesture (a click or a
// key press, never Esc), and Esc always takes it away again (outside full
// screen with the keyboard locked). So the game takes the mouse at every
// moment the browser allows, instead of only on a click on the view:
//
//   - a key press with the mouse free and nothing open (W, Space, T...):
//     the player started playing, so looking around starts too;
//   - a panel, menu, conversation or chat that freed the mouse closing
//     (by its key, a button, or Esc): the mouse comes back. Chrome lets a
//     page re-take a lock the page itself let go of, even without a gesture;
//   - a mode that wants it (placing a camp piece, the build ghost) starting.
//
// A free mouse the player asked for (Esc, the window losing focus) is left
// free until they press a key or click the view. Requests made here are
// "soft": a refusal (Chrome's cool-down right after Esc, headless browsers)
// is ignored and does not count toward the refusals that let clicks fight
// unlocked (pointerLockState).
//
// Full screen (the Esc menu): where the browser has the Keyboard Lock API
// (Chrome, Edge) the game also locks Esc, so Esc is a game key like in a
// desktop game: it opens and closes the menu and panels, and the mouse goes
// and comes back with them; holding Esc leaves full screen.

import { useAppStore } from '../stores/appStore';
import { useMenu } from '../ui/menu/store';
import { useSocialStore } from '../social/store';
import { isTextTarget } from './useKeyboard';

/**
 * Playtest 2 polish: the click that captures the mouse is the game's, not an
 * attack or a cast (combat/runtime.ts asks before it swings). Where the
 * browser keeps refusing the lock (some headless or embedded browsers),
 * clicks fight unlocked after two refusals in a row instead of never.
 * `softUntil`: a refusal before then answers a soft request (not counted).
 */
export const pointerLockState = { refusals: 0, softUntil: -1e9 };

/** The game view: the largest canvas on the page. */
export function gameCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  let best: HTMLCanvasElement | null = null;
  for (const c of document.querySelectorAll('canvas')) if (!best || c.width * c.height > best.width * best.height) best = c;
  return best;
}

/**
 * Asks for pointer lock on `el` (default: the game view), raw (unaccelerated)
 * mouse input where supported: OS pointer acceleration makes equal hand
 * motions turn by different amounts and is where Chrome's bogus large deltas
 * come from. Falls back to the plain lock if the option is rejected. A soft
 * request's refusal is not counted (pointerLockState).
 */
export function requestCapture(opts: { soft: boolean; el?: Element | null } = { soft: true }): void {
  if (typeof document === 'undefined' || document.pointerLockElement) return;
  const el = opts.el ?? gameCanvas();
  if (!el || typeof el.requestPointerLock !== 'function') return;
  pointerLockState.softUntil = opts.soft ? performance.now() + 1500 : -1e9;
  type Req = (o?: { unadjustedMovement?: boolean }) => Promise<void> | undefined;
  const req = el.requestPointerLock as unknown as Req;
  // Chrome returns a promise and rejects if the user just exited lock (it
  // enforces a short cool-down); that is harmless, so swallow it.
  const plain = () => (req.call(el) as Promise<void> | undefined)?.catch?.(() => {});
  try {
    req.call(el, { unadjustedMovement: true })?.catch?.((err: unknown) => {
      if ((err as { name?: string } | null)?.name === 'NotSupportedError') plain();
    });
  } catch {
    plain();
  }
}

/** A pointerlockerror: counts toward the refusals unless it answers a soft request. */
export function noteLockRefused(now = performance.now()): void {
  if (now < pointerLockState.softUntil) return;
  pointerLockState.refusals++;
}

// Code that frees the mouse on purpose (a panel opening, chat) calls
// document.exitPointerLock; the browser's own Esc doesn't. Wrapped once so
// a lost lock can tell the two apart.
let exitRequestedAt = -1e9;
export function watchExitRequests(): void {
  if (typeof document === 'undefined') return;
  const d = document as Document & { __lsExitWatched?: boolean };
  if (d.__lsExitWatched || typeof d.exitPointerLock !== 'function') return;
  const orig = d.exitPointerLock.bind(d);
  d.exitPointerLock = () => {
    exitRequestedAt = performance.now();
    return orig();
  };
  d.__lsExitWatched = true;
}

/** When the game last freed the mouse on purpose (performance.now()). */
export function lastExitRequestAt(): number {
  return exitRequestedAt;
}

/** Something open that has the mouse: a panel, the Esc menu, a wheel, chat, the debug panel, a text box. */
export interface MouseNeeds {
  screenPlay: boolean;
  menuOpen: boolean;
  chatOpen: boolean;
  debugPanel: boolean;
  typing: boolean;
  /** A visible panel that uses the mouse (not a mode that looks around, data-wants-mouse). */
  panelUp: boolean;
  focused: boolean;
}

/** Whether the game should have the mouse now: playing, nothing open that uses it, the window focused. */
export function gameWantsMouse(s: MouseNeeds): boolean {
  return s.screenPlay && s.focused && !s.menuOpen && !s.chatOpen && !s.debugPanel && !s.typing && !s.panelUp;
}

/** A visible panel or wheel that uses the mouse; modes that look around mark themselves data-wants-mouse. */
function mousePanelUp(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>('[data-ui-panel], [data-testid="emote-wheel"], [data-testid="pet-wheel"]')) {
    if (el.hasAttribute('data-wants-mouse')) continue;
    if (el.style.display !== 'none' && el.getClientRects().length > 0) return true;
  }
  return false;
}

function needsNow(): MouseNeeds {
  const app = useAppStore.getState();
  return {
    screenPlay: app.screen === 'play',
    menuOpen: useMenu.getState().open,
    chatOpen: useSocialStore.getState().open,
    debugPanel: app.debugPanelOpen,
    typing: isTextTarget(document.activeElement),
    panelUp: mousePanelUp(),
    focused: document.hasFocus() && !document.hidden,
  };
}

/** Whether the game should have the mouse right now (the live page). */
export function wantsMouse(): boolean {
  if (typeof document === 'undefined') return false;
  return gameWantsMouse(needsNow());
}

/**
 * A key press that means "playing": a letter, digit, Space, an arrow, Tab or
 * punctuation, without Ctrl / Cmd / Alt (browser shortcuts) and not typed
 * into a text box. Never Esc (it frees the mouse, and is no gesture), never
 * F1-F12 (devtools, reload, full screen) or a lone modifier.
 */
export function isPlayKey(e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, typing: boolean): boolean {
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return false;
  return /^(Key[A-Z]|Digit\d|Space|Arrow(Up|Down|Left|Right)|Tab|Enter|Minus|Equal|BracketLeft|BracketRight|Backslash|Period|Comma|Slash|Semicolon|Quote)$/.test(e.code);
}

/**
 * Why the game may take the mouse back: `released` (the game freed it on
 * purpose, until the player frees it themselves or it is taken back) or a
 * gesture (`gestureUntil`: a play key, a click in a panel: the browser
 * honours a lock request for a few seconds after one).
 */
export interface CaptureArm {
  released: boolean;
  gestureUntil: number;
}

/** Whether to ask for the mouse now. */
export function shouldCapture(arm: CaptureArm, locked: boolean, wants: boolean, now: number): boolean {
  if (locked || !wants) return false;
  return arm.released || now < arm.gestureUntil;
}

/** How long after a gesture a lock request is still tried (Chrome and Firefox honour ~5 s, Safari ~1 s). */
export const GESTURE_MS = 4000;
/** How often the page is checked while a capture is armed. */
const POLL_MS = 50;
/** How long nothing must need the mouse before it is taken back. */
const SETTLE_MS = 120;

const arm: CaptureArm = { released: false, gestureUntil: -1e9 };

/**
 * Installs the auto-capture listeners (useMouseLook mounts it with the game
 * view); returns the removal.
 */
export function installAutoCapture(): () => void {
  if (typeof window === 'undefined') return () => {};
  watchExitRequests();
  arm.released = false;
  arm.gestureUntil = -1e9;
  let tried = -1e9;
  let clearSince = -1; // since when nothing has needed the mouse (-1: something does)
  const tick = () => {
    const now = performance.now();
    if (!arm.released && now >= arm.gestureUntil) return;
    const locked = !!document.pointerLockElement;
    const wants = !locked && wantsMouse();
    if (!wants) clearSince = -1;
    else if (clearSince < 0) clearSince = now;
    // Clear for a moment first: a conversation handing over to a shop closes one panel just before the next opens.
    if (!shouldCapture(arm, locked, wants && now - clearSince >= SETTLE_MS, now)) return;
    if (now - tried < 400) return; // one request in flight at a time
    tried = now;
    requestCapture({ soft: true });
  };
  const timer = window.setInterval(tick, POLL_MS);
  const onKey = (e: KeyboardEvent) => {
    if (document.pointerLockElement || e.repeat) return;
    if (!isPlayKey(e, isTextTarget(e.target))) return;
    arm.gestureUntil = performance.now() + GESTURE_MS;
    window.setTimeout(tick, 60); // after the key's own handlers opened or closed a panel
  };
  const onDown = (e: MouseEvent) => {
    if (document.pointerLockElement) return;
    // A click inside a panel (its close box, a piece to place, an answer) may close it: take the mouse back after.
    const t = e.target as HTMLElement | null;
    if (!t?.closest?.('[data-ui-panel]')) return;
    arm.gestureUntil = performance.now() + GESTURE_MS;
  };
  const onUp = (e: MouseEvent) => {
    if (arm.gestureUntil > performance.now() && !document.pointerLockElement && (e.target as HTMLElement | null)?.closest?.('[data-ui-panel]')) window.setTimeout(tick, 60);
  };
  const onLock = () => {
    if (document.pointerLockElement) {
      arm.released = false;
      arm.gestureUntil = -1e9;
      return;
    }
    // Freed by the game on purpose (a panel opening): it comes back when the panel closes. Freed by the player: stays free.
    arm.released = performance.now() - exitRequestedAt < 600;
  };
  const onRefused = () => {
    // Refused (the browser's cool-down, no gesture left): wait for the next key or click.
    arm.released = false;
    arm.gestureUntil = -1e9;
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('mouseup', onUp, true);
  document.addEventListener('pointerlockchange', onLock);
  document.addEventListener('pointerlockerror', onRefused);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('mouseup', onUp, true);
    document.removeEventListener('pointerlockchange', onLock);
    document.removeEventListener('pointerlockerror', onRefused);
  };
}

// ---- full screen -------------------------------------------------------------

type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };
const keyboardApi = (): KeyboardLock | undefined => (typeof navigator !== 'undefined' ? (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard : undefined);

/** Whether Esc can stay in the game in full screen (the Keyboard Lock API: Chrome, Edge). */
export function escStaysInFullscreen(): boolean {
  return typeof keyboardApi()?.lock === 'function';
}

export function isFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.fullscreenElement;
}

const FS_KEY = 'lodestone_fullscreen';

/** The player's choice (Esc menu): play in full screen. */
export function fullscreenPreferred(): boolean {
  try {
    return localStorage.getItem(FS_KEY) === '1';
  } catch {
    return false;
  }
}

function setFullscreenPreferred(on: boolean): void {
  try {
    localStorage.setItem(FS_KEY, on ? '1' : '0');
  } catch {
    /* private window: just this time */
  }
}

/** Enters full screen and locks Esc where the browser can (call from a click or a key press). */
export async function enterFullscreen(): Promise<boolean> {
  if (typeof document === 'undefined' || typeof document.documentElement.requestFullscreen !== 'function') return false;
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return false;
  }
  try {
    await keyboardApi()?.lock?.(['Escape']);
  } catch {
    /* no keyboard lock: Esc leaves full screen as usual */
  }
  return true;
}

export function exitFullscreen(): void {
  keyboardApi()?.unlock?.();
  if (typeof document !== 'undefined' && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

/** The Esc menu's switch: remembers the choice, then enters (and takes the mouse back) or leaves. */
export async function setFullscreen(on: boolean): Promise<void> {
  setFullscreenPreferred(on);
  if (!on) return exitFullscreen();
  await enterFullscreen();
}

/**
 * The player chose full screen: the first key press or click in the world
 * after it loads enters it (once per visit: leaving full screen by holding
 * Esc is respected until the next visit or the Esc menu's switch). Returns
 * the removal.
 */
export function installFullscreenPreference(): () => void {
  if (typeof window === 'undefined') return () => {};
  let done = false;
  const onGesture = (e: Event) => {
    if (done || !fullscreenPreferred() || isFullscreen()) return;
    if (e instanceof KeyboardEvent && !isPlayKey(e, isTextTarget(e.target))) return;
    if (e instanceof MouseEvent && (e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
    done = true;
    void enterFullscreen();
  };
  const onChange = () => {
    if (!document.fullscreenElement) keyboardApi()?.unlock?.();
    else done = true;
  };
  window.addEventListener('keydown', onGesture);
  window.addEventListener('mousedown', onGesture);
  document.addEventListener('fullscreenchange', onChange);
  return () => {
    window.removeEventListener('keydown', onGesture);
    window.removeEventListener('mousedown', onGesture);
    document.removeEventListener('fullscreenchange', onChange);
  };
}
