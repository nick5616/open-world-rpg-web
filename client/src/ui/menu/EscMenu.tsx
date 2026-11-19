// Playtest 2 (new player onboarding): the Esc menu. Esc with no panel open
// (or freeing the mouse with Esc while it is captured) opens it: Resume,
// Controls (the full key reference, controls.ts), Sound, plug-in rows
// (registerMenuEntry: What's new), Graphics (openGraphicsPanel, F10), the
// camera, tips on/off, Leave to title.
// It is not a pause: the world is shared and keeps going (spec 8).
//
// Esc closes one thing at a time (playtest 2 polish): this listener runs
// first, in the capture phase, and closes only the top panel on the stack
// (input/panelStack.ts: every panel, mode and held wheel registers there
// when it opens), then stops the event. With nothing open it opens this
// menu. Text fields keep their own Esc (chat, the dev console's line).

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { isTextTarget, KEY_MAP } from '../../input/useKeyboard';
import { useAppStore } from '../../stores/appStore';
import { useAudioSettings } from '../../audio/settings';
import { useSocialStore } from '../../social/store';
import { useNetStore } from '../../net/netStore';
import { CameraSettings } from '../../hud/ViewHud';
import { openGraphicsPanel } from '../graphics/GraphicsPanel';
import { DEBUG } from '../../config';
import { useTips } from '../tips/store';
import { useAutoLoot } from '../inventory/ground/autoLoot';
import { controlGroups } from './controls';
import { HotbarKeys } from '../../combat/HotbarKeys';
import { useDev } from '../devconsole/store';
import { closeMenu, escAction, menuStale, openMenu, unlockOpensMenu, useMenu, type MenuEntry } from './store';
import { closeTopPanel, openPanels } from '../../input/panelStack';

const MENU_KEY = 'Escape';

/** A panel on the stack, or one drawn without registering (none should be), or a held emote / pet wheel. */
function panelUp(): boolean {
  if (openPanels().length) return true;
  for (const el of document.querySelectorAll<HTMLElement>('[data-ui-panel]:not([style*="display: none"]), [data-testid="emote-wheel"], [data-testid="pet-wheel"]')) {
    if (el.dataset.testid !== 'esc-menu') return true;
  }
  return false;
}

// Code that frees the mouse on purpose (a panel opening, chat) calls
// document.exitPointerLock; the browser's own Esc doesn't. Wrapped once so
// a lost lock can tell the two apart.
let exitRequestedAt = -1e9;
function watchExitRequests(): void {
  const d = document as Document & { __lsExitWatched?: boolean };
  if (d.__lsExitWatched || typeof d.exitPointerLock !== 'function') return;
  const orig = d.exitPointerLock.bind(d);
  d.exitPointerLock = () => {
    exitRequestedAt = performance.now();
    return orig();
  };
  d.__lsExitWatched = true;
}

/** Recapture the mouse on the game canvas (Resume is a click: a user gesture). */
function relock(): void {
  let best: HTMLCanvasElement | null = null;
  for (const c of document.querySelectorAll('canvas')) if (!best || c.width * c.height > best.width * best.height) best = c;
  if (!best) return;
  type Req = (o?: { unadjustedMovement?: boolean }) => Promise<void> | undefined;
  const req = best.requestPointerLock as unknown as Req;
  try {
    req.call(best, { unadjustedMovement: true })?.catch?.(() => (req.call(best) as Promise<void> | undefined)?.catch?.(() => {}));
  } catch {
    /* the lock hint offers a click */
  }
}

// The key listener is installed when this module loads, before any panel
// mounts its own: window capture listeners run in registration order, and
// some panels listen in the capture phase too (the inventory's I and G).
let keysActive = false;
let unlockedAt = -1e9;
let poppedAt = -1e9;
let menuOpenedAt = -1e9;

/** A field the player types into (a slider or checkbox in a panel is not: Esc still closes the panel). */
function typingIn(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'INPUT') return !/^(range|checkbox|radio|button|submit|color|file)$/i.test((el as HTMLInputElement).type);
  return el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function onMenuKey(e: KeyboardEvent): void {
  if (!keysActive) return;
  let m = useMenu.getState();
  // Playtest 5: an "open" menu that is not on screen would swallow E and every other hotkey for good (menuStale).
  if (m.open && menuStale({ open: true, openForMs: performance.now() - menuOpenedAt, rendered: !!document.querySelector('[data-testid="esc-menu"]') })) {
    closeMenu();
    m = useMenu.getState();
  }
  if (e.code !== MENU_KEY) {
    // While the menu is up, panel hotkeys wait (movement keeps working: the world doesn't pause).
    if (m.open && !isTextTarget(e.target) && !KEY_MAP[e.code]) e.stopImmediatePropagation();
    return;
  }
  if (e.repeat) return;
  const act = escAction({ menuOpen: m.open, stacked: openPanels().length > 0, panelOpen: panelUp(), typing: typingIn(e.target), sinceUnlockMs: performance.now() - unlockedAt });
  if (act === 'pop') {
    e.preventDefault();
    e.stopImmediatePropagation();
    poppedAt = performance.now();
    closeTopPanel();
  } else if (act === 'open') {
    e.preventDefault();
    openMenu();
  } else if (act === 'close') {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (m.page !== 'main') m.setPage('main');
    else closeMenu();
  }
}
useMenu.subscribe((s, prev) => {
  if (s.open && !prev.open) menuOpenedAt = performance.now();
});
if (typeof window !== 'undefined') {
  const w = window as Window & { __lsMenuKey?: (e: KeyboardEvent) => void };
  if (w.__lsMenuKey) window.removeEventListener('keydown', w.__lsMenuKey, true); // a hot reload of this module
  w.__lsMenuKey = onMenuKey;
  window.addEventListener('keydown', onMenuKey, true);
}

function useMenuKeys(): void {
  useEffect(() => {
    watchExitRequests();
    keysActive = true;
    let timer = 0;
    const onLock = () => {
      if (document.pointerLockElement) return;
      const now = performance.now();
      unlockedAt = now;
      const requestedMs = Math.min(now - exitRequestedAt, now - poppedAt); // an Esc that closed a panel is not a request for the menu
      clearTimeout(timer);
      // Let a panel that freed the mouse render first.
      timer = window.setTimeout(() => {
        const typing = isTextTarget(document.activeElement) || useSocialStore.getState().open;
        if (unlockOpensMenu({ menuOpen: useMenu.getState().open, panelOpen: panelUp(), typing, focused: document.hasFocus(), requestedMs })) openMenu();
      }, 120);
    };
    document.addEventListener('pointerlockchange', onLock);
    return () => {
      keysActive = false;
      clearTimeout(timer);
      document.removeEventListener('pointerlockchange', onLock);
      closeMenu();
    };
  }, []);

  // Free the mouse while the menu is open.
  const open = useMenu((s) => s.open);
  useEffect(() => {
    if (open && document.pointerLockElement) document.exitPointerLock();
  }, [open]);
}

const GOLD = '#ffd166';
const CARD: CSSProperties = { background: 'rgba(12,15,22,0.94)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, color: '#e9ecef', font: '14px system-ui, sans-serif', boxShadow: '0 10px 40px rgba(0,0,0,0.6)' };
const BTN: CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '9px 14px', margin: '6px 0', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, background: 'rgba(255,255,255,0.05)', color: '#e9ecef', font: '600 14px system-ui, sans-serif', textAlign: 'left', cursor: 'pointer' };
const SMALL: CSSProperties = { padding: '3px 10px', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 4, background: 'rgba(255,255,255,0.06)', color: '#e9ecef', font: '12px system-ui, sans-serif', cursor: 'pointer' };
export const KEYCAP: CSSProperties = { display: 'inline-block', minWidth: 16, padding: '0 6px', margin: '0 3px 2px 0', border: '1px solid rgba(255,255,255,0.4)', borderBottomWidth: 2, borderRadius: 4, background: 'rgba(255,255,255,0.07)', font: '600 11.5px/19px system-ui, sans-serif', textAlign: 'center', whiteSpace: 'nowrap' };

function MenuButton({ id, onClick, children, hint }: { id: string; onClick: () => void; children: ReactNode; hint?: string }) {
  return (
    <button data-testid={`menu-${id}`} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onClick} style={BTN}>
      {children}
      {hint && <span style={{ float: 'right', fontWeight: 400, opacity: 0.55, fontSize: 12 }}>{hint}</span>}
    </button>
  );
}

function Main({ entries }: { entries: MenuEntry[] }) {
  const tips = useTips();
  const autoLoot = useAutoLoot();
  const name = useNetStore((s) => s.ready?.character.name);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    const id = setTimeout(() => setLeaving(false), 3000);
    return () => clearTimeout(id);
  }, [leaving]);
  const resume = () => {
    closeMenu();
    relock();
  };
  const runEntry = (e: MenuEntry) => {
    if (e.render) useMenu.getState().setPage(`entry:${e.id}`);
    else {
      closeMenu();
      e.open?.();
    }
  };
  return (
    <div style={{ width: 'min(340px, calc(100vw - 32px))', padding: '18px 20px 14px', boxSizing: 'border-box' }}>
      <div style={{ font: '24px Georgia, serif', letterSpacing: 1 }}>Lodestone</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 10 }}>{name ? `${name} · ` : ''}the world keeps going while this is open</div>
      <MenuButton id="resume" onClick={resume} hint="Esc">
        Resume
      </MenuButton>
      <MenuButton id="controls" onClick={() => useMenu.getState().setPage('controls')}>
        Controls
      </MenuButton>
      {entries.map((e) => (
        <MenuButton key={e.id} id={`entry-${e.id}`} onClick={() => runEntry(e)}>
          {e.label}
        </MenuButton>
      ))}
      <div style={{ margin: '12px 0 4px', fontSize: 12, opacity: 0.7 }}>Camera</div>
      <CameraSettings compact />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 4px' }}>
        <span style={{ fontSize: 13 }}>Tips</span>
        <button data-testid="menu-tips-toggle" tabIndex={-1} onClick={() => tips.setEnabled(!tips.enabled)} style={{ ...SMALL, background: tips.enabled ? '#2b4f7a' : SMALL.background }}>
          {tips.enabled ? 'On' : 'Off'}
        </button>
        <button data-testid="menu-tips-reset" tabIndex={-1} onClick={() => tips.resetSeen()} style={SMALL} title="Show this character's tips again">
          Show again
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 4px' }} title="Walking over common materials, food, potions, arrows, ore and gems picks them up. Gold is always picked up; gear, tomes and anything rare or better wait for E.">
        <span style={{ fontSize: 13 }}>Auto-collect common loot</span>
        <button data-testid="menu-autoloot-toggle" tabIndex={-1} onClick={() => autoLoot.set(!autoLoot.on)} style={{ ...SMALL, background: autoLoot.on ? '#2b4f7a' : SMALL.background }}>
          {autoLoot.on ? 'On' : 'Off'}
        </button>
      </div>
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: 12, paddingTop: 4 }}>
        <MenuButton
          id="leave"
          onClick={() => {
            if (!leaving) return setLeaving(true);
            closeMenu();
            useAppStore.getState().setScreen('title');
          }}
        >
          <span style={{ color: leaving ? GOLD : undefined }}>{leaving ? 'Click again to leave' : 'Leave to title'}</span>
        </MenuButton>
        <div style={{ fontSize: 11, opacity: 0.5 }}>Your character is saved as you play.</div>
      </div>
    </div>
  );
}

function Controls() {
  const dev = useDev((s) => s.dev); // CR 032: the Dev group shows only on a dev zone
  const groups = controlGroups(DEBUG, dev);
  return (
    <div data-testid="menu-controls-page" style={{ width: 'min(860px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', padding: '16px 20px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <span style={{ font: '22px Georgia, serif' }}>Controls</span>
        <span style={{ fontSize: 12, opacity: 0.6 }}>Esc goes back</span>
        <button data-testid="menu-back" tabIndex={-1} onClick={() => useMenu.getState().setPage('main')} style={{ ...SMALL, marginLeft: 'auto' }}>
          Back
        </button>
      </div>
      <HotbarKeys />
      <div style={{ columns: '2 360px', columnGap: 28 }}>
        {groups.map((g) => (
          <div key={g.title} style={{ breakInside: 'avoid', marginBottom: 12 }}>
            <div style={{ color: GOLD, font: '600 12px system-ui, sans-serif', letterSpacing: 0.5, textTransform: 'uppercase', margin: '4px 0 4px' }}>{g.title}</div>
            {g.rows.map((r) => (
              <div key={r.action} data-testid="control-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', alignItems: 'baseline' }}>
                <span>
                  {r.keys.map((k) => (
                    <span key={k} style={KEYCAP}>
                      {k}
                    </span>
                  ))}
                </span>
                <span style={{ fontSize: 13 }}>
                  {r.action}
                  {r.note && <span style={{ display: 'block', fontSize: 11.5, opacity: 0.55 }}>{r.note}</span>}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function EscMenu() {
  useMenuKeys();
  const open = useMenu((s) => s.open);
  const page = useMenu((s) => s.page);
  const entries = useMenu((s) => s.entries);
  const sound = useAudioSettings((s) => s.setPanelOpen);
  const card = useRef<HTMLDivElement>(null);
  if (!open) return null;
  const all: MenuEntry[] = [{ id: 'graphics', label: 'Graphics', order: 5, open: openGraphicsPanel }, { id: 'sound', label: 'Sound', order: 10, open: () => sound(true) }, ...entries.filter((e) => e.id !== 'graphics')];
  all.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const entry = page.startsWith('entry:') ? all.find((e) => `entry:${e.id}` === page) : undefined;
  return (
    <div
      data-testid="esc-menu"
      data-ui-panel
      onMouseDown={(e) => {
        if (!card.current?.contains(e.target as Node)) {
          closeMenu();
          relock();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(4,6,10,0.5)', display: 'grid', placeItems: 'center', pointerEvents: 'auto' }}
    >
      <div ref={card} style={CARD}>
        {page === 'controls' ? (
          <Controls />
        ) : entry?.render ? (
          <div style={{ padding: '16px 20px', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ font: '22px Georgia, serif' }}>{entry.label}</span>
              <button data-testid="menu-back" tabIndex={-1} onClick={() => useMenu.getState().setPage('main')} style={{ ...SMALL, marginLeft: 'auto' }}>
                Back
              </button>
            </div>
            {entry.render()}
          </div>
        ) : (
          <Main entries={all} />
        )}
      </div>
    </div>
  );
}
