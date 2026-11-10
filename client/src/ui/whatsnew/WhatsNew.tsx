// Playtest 2: the "What's new since you last played" panel after login (or
// a short welcome for a first-time player) and the Esc menu's "What's new"
// page with the whole list. Logic and storage in whatsnew.ts; the entries
// in changelog.json. Wrapped in an error boundary: whatever the changelog
// holds, the worst case is no panel.

import { Component, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useNetStore } from '../../net/netStore';
import { registerMenuEntry, useMenu } from '../menu/store';
import { useIntro } from '../intro/queue';
import { useCombatHud } from '../../combat/store';
import raw from './changelog.json';
import { RETURNING_AT_LOAD, readSeen, validEntries, whatsNew, writeSeen, type ChangelogEntry, type WhatsNew as Shown } from './news';

const ENTRIES = validEntries(raw as unknown);
const GOLD = '#ffd166';
const CARD: CSSProperties = { background: 'rgba(12,15,22,0.95)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, color: '#e9ecef', font: '14px/1.45 system-ui, sans-serif', boxShadow: '0 10px 40px rgba(0,0,0,0.6)' };
const BTN: CSSProperties = { padding: '8px 18px', border: '1px solid rgba(255,209,102,0.6)', borderRadius: 6, background: 'rgba(255,209,102,0.14)', color: '#ffe7a8', font: '600 14px system-ui, sans-serif', cursor: 'pointer' };
/** After the world is up, once the arrival cards are done (at most MAX_WAIT_MS). */
const SHOW_AFTER_MS = 2500;
const MAX_WAIT_MS = 25000;

function fmtDate(d: string): string {
  const t = Date.parse(d + 'T12:00:00');
  return Number.isNaN(t) ? d : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function EntryList({ entries }: { entries: readonly ChangelogEntry[] }) {
  return (
    <div>
      {entries.map((e) => (
        <div key={e.id} data-testid="whatsnew-entry" data-id={e.id} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ color: GOLD, fontWeight: 600 }}>{e.title}</span>
            <span style={{ fontSize: 11.5, opacity: 0.5 }}>{fmtDate(e.date)}</span>
          </div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {e.items.map((it, i) => (
              <li key={i} style={{ fontSize: 13.5, margin: '2px 0' }}>
                {it}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Panel({ shown, onClose }: { shown: Exclude<Shown, { kind: 'none' }>; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    // Never trap a player in a fight behind it (playtest: a slime pack
    // downed a new character while the welcome card ate every click).
    let hp = useCombatHud.getState().health;
    const unsub = useCombatHud.subscribe((st) => {
      if (st.health < hp) onClose();
      hp = st.health;
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      unsub();
    };
  }, [onClose]);
  const welcome = shown.kind === 'welcome';
  return (
    <div data-testid="whatsnew" data-kind={shown.kind} data-ui-panel onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, zIndex: 65, display: 'grid', placeItems: 'center', background: 'rgba(4,6,10,0.35)', pointerEvents: 'auto' }}>
      <div style={{ ...CARD, width: 'min(520px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
        <div style={{ padding: '18px 22px 8px' }}>
          <div style={{ font: '24px Georgia, serif', letterSpacing: 0.5 }}>{welcome ? 'Welcome to Lodestone' : "What's new since you last played"}</div>
        </div>
        <div style={{ padding: '4px 22px', overflowY: 'auto' }}>
          {welcome ? (
            <ul style={{ margin: '4px 0 10px', paddingLeft: 18 }}>
              <li>One shared world: the people you meet out there are other players.</li>
              <li>Someone in town has a first job for you: follow the gold marker on your compass.</li>
              <li>Press Esc any time for the controls, sound and camera settings.</li>
            </ul>
          ) : (
            <EntryList entries={shown.entries} />
          )}
        </div>
        <div style={{ padding: '10px 22px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          {!welcome && <span style={{ fontSize: 12, opacity: 0.55 }}>The full list: Esc, What&apos;s new</span>}
          <button data-testid="whatsnew-close" onMouseDown={(e) => e.preventDefault()} onClick={onClose} style={{ ...BTN, marginLeft: 'auto' }}>
            {welcome ? "Let's go" : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
}

function WhatsNewInner() {
  const ready = useNetStore((s) => !!s.ready);
  const [shown, setShown] = useState<Shown>({ kind: 'none' });
  useEffect(
    () =>
      registerMenuEntry({
        id: 'whatsnew',
        label: "What's new",
        order: 20,
        render: () => (
          <div data-testid="menu-whatsnew-page" style={{ width: 'min(520px, calc(100vw - 72px))' }}>
            {ENTRIES.length ? <EntryList entries={ENTRIES} /> : <div style={{ opacity: 0.6 }}>Nothing here yet.</div>}
          </div>
        ),
      }),
    [],
  );
  useEffect(() => {
    if (!ready) return;
    // Let the arrival card (town / region intro) and the menu go first; give up waiting after a while.
    const t0 = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      if (now - t0 < SHOW_AFTER_MS) return;
      const intro = useIntro.getState();
      const busy = !!intro.current || intro.queue.length > 0 || useMenu.getState().open || useCombatHud.getState().downedUntil > 0;
      if (busy && now - t0 < MAX_WAIT_MS) return;
      clearInterval(t);
      setShown(whatsNew(ENTRIES, readSeen(), RETURNING_AT_LOAD));
    }, 400);
    return () => clearInterval(t);
  }, [ready]);
  if (shown.kind === 'none') return null;
  return (
    <Panel
      shown={shown}
      onClose={() => {
        writeSeen(shown.newest);
        setShown({ kind: 'none' });
      }}
    />
  );
}

class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(e: unknown) {
    console.warn('[whatsnew] hidden after an error', e);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function WhatsNew() {
  return (
    <Guard>
      <WhatsNewInner />
    </Guard>
  );
}
