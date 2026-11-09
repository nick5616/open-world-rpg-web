// Chat panel: channel tabs, whisper tabs with unread counts, a composer with
// slash commands and Tab name completion, and toasts while closed.
// Behaviour adapted from the-circle frontend/src/components/Chat.tsx (follow
// new messages unless the reader scrolled up; toasts for messages arriving
// while closed), reshaped for channels.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { completeName, tabChannel } from '../commands';
import { submitChatInput } from '../session';
import { FIXED_TABS, nameCandidates, useSocialStore, type Line } from '../store';
import { NameMenu, type NameMenuTarget } from './NameMenu';
import { button, channelColor, glass, nameColor, tabLabel } from './style';
import { CHAT_WIDTH, CORNER_BOTTOM } from '../../hud/layout'; // playtest 1: shared bottom layout

const WIDTH = 400;

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface ChatPanelProps {
  /** Extra autocomplete names (e.g. nearby players from the zone). */
  extraNames?: () => Iterable<string>;
}

export function ChatPanel({ extraNames }: ChatPanelProps) {
  const s = useSocialStore();
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<NameMenuTarget | null>(null);
  const cycle = useRef<{ base: string; n: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lines = s.tabs[s.activeTab] ?? [];

  // Enter opens chat from the game; the panel then owns the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Enter' && !typing) {
        e.preventDefault();
        if (document.pointerLockElement) document.exitPointerLock();
        useSocialStore.getState().setOpen(true);
        setTimeout(() => input.current?.focus(), 0);
      } else if (e.key === '/' && !typing && !useSocialStore.getState().open) {
        e.preventDefault();
        useSocialStore.getState().setOpen(true);
        setDraft('/');
        setTimeout(() => input.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, s.open, s.activeTab]);

  useEffect(() => {
    if (s.open) setTimeout(() => input.current?.focus(), 0);
  }, [s.open, s.activeTab]);

  // Toasts fade on their own after 6 s (the-circle used the same lifetime).
  useEffect(() => {
    if (s.toasts.length === 0) return;
    const id = s.toasts[0].id;
    const t = setTimeout(() => useSocialStore.getState().dismissToast(id), 6000);
    return () => clearTimeout(t);
  }, [s.toasts]);

  const whisperTabs = Object.keys(s.tabs).filter((k) => k.startsWith('w:'));
  const totalUnread = Object.values(s.unread).reduce((a, b) => a + b, 0);

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      input.current?.blur();
      s.setOpen(false);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const base = cycle.current?.base ?? draft;
      const n = cycle.current ? cycle.current.n + 1 : 0;
      const done = completeName(base, nameCandidates(useSocialStore.getState(), extraNames?.() ?? []), n);
      if (done) {
        cycle.current = { base, n };
        setDraft(done);
      }
      return;
    }
    cycle.current = null;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!draft.trim()) {
        input.current?.blur();
        s.setOpen(false);
        return;
      }
      if (submitChatInput(draft)) {
        setDraft('');
        stick.current = true;
      }
    }
  }

  const nameClick = (name: string, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!name || name === s.me?.name) return;
    setMenu({ name, x: e.clientX, y: e.clientY, channel: tabChannel(s.activeTab) });
  };

  const statusText =
    s.status === 'online' ? '' : s.status === 'closed' ? (s.closedReason ?? 'disconnected') : s.status === 'idle' ? 'not connected' : `${s.status}…`;

  return (
    <>
      {!s.open && (
        <div style={{ position: 'fixed', left: 12, bottom: CORNER_BOTTOM, zIndex: 30, display: 'flex', flexDirection: 'column', gap: 6, width: CHAT_WIDTH, pointerEvents: 'none' }}>
          {s.toasts.map((t) => (
            <div
              key={t.id}
              data-testid="chat-toast"
              onClick={() => {
                s.setActiveTab(t.tab);
                s.setOpen(true);
              }}
              style={{ ...glass, padding: '6px 10px', pointerEvents: 'auto', cursor: 'pointer' }}
            >
              <span style={{ color: t.tab.startsWith('w:') ? channelColor.whisper : channelColor.party, fontWeight: 600, marginRight: 6 }}>
                {t.tab.startsWith('w:') ? `${t.from} whispers` : `[Party] ${t.from}`}
              </span>
              {t.text}
            </div>
          ))}
          <button
            data-testid="chat-open"
            style={{ ...glass, ...button, alignSelf: 'flex-start', pointerEvents: 'auto', padding: '5px 10px' }}
            onClick={() => s.setOpen(true)}
          >
            Chat (Enter){totalUnread > 0 ? ` · ${totalUnread} new` : ''}
            {statusText ? ` · ${statusText}` : ''}
          </button>
        </div>
      )}
      {s.open && (
        <div
          data-testid="chat-panel"
          style={{ ...glass, position: 'fixed', left: 12, bottom: CORNER_BOTTOM, width: `max(${WIDTH * 0.7}px, ${CHAT_WIDTH})`, height: 340, maxHeight: `calc(100vh - 120px - ${CORNER_BOTTOM})`, zIndex: 30, display: 'flex', flexDirection: 'column' }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '6px 6px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            {[...FIXED_TABS, ...whisperTabs].map((tab) => {
              const active = tab === s.activeTab;
              const unread = s.unread[tab] ?? 0;
              const isW = tab.startsWith('w:');
              const label = isW ? (s.whisperNames[tab] ?? tab.slice(2)) : tabLabel[tab];
              return (
                <span
                  key={tab}
                  data-testid={`chat-tab-${tab}`}
                  onClick={() => s.setActiveTab(tab)}
                  style={{
                    cursor: 'pointer', padding: '2px 7px', borderRadius: 5, fontSize: 12, userSelect: 'none',
                    background: active ? 'rgba(255,255,255,0.16)' : 'transparent',
                    color: isW ? channelColor.whisper : channelColor[tabChannel(tab)],
                  }}
                >
                  {label}
                  {unread > 0 && (
                    <b data-testid={`chat-unread-${tab}`} style={{ marginLeft: 4, background: '#e03131', color: 'white', borderRadius: 8, padding: '0 5px', fontSize: 10 }}>
                      {unread}
                    </b>
                  )}
                  {isW && (
                    <span
                      title="Close"
                      onClick={(e) => {
                        e.stopPropagation();
                        s.closeWhisper(tab);
                      }}
                      style={{ marginLeft: 4, opacity: 0.6 }}
                    >
                      ×
                    </span>
                  )}
                </span>
              );
            })}
            <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6, alignSelf: 'center' }}>{statusText}</span>
          </div>
          <div
            ref={scroller}
            data-testid="chat-feed"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px' }}
          >
            {lines.map((l) => (
              <ChatLine key={l.id} line={l} myId={s.me?.characterId} onName={nameClick} />
            ))}
          </div>
          <input
            ref={input}
            data-testid="chat-input"
            value={draft}
            maxLength={600}
            onChange={(e) => {
              setDraft(e.target.value);
              cycle.current = null;
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder(s.activeTab, s.whisperNames[s.activeTab])}
            autoComplete="off"
            spellCheck={false}
            style={{ margin: 6, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.35)', color: '#fff', font: 'inherit' }}
          />
        </div>
      )}
      {menu && <NameMenu target={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

function placeholder(tab: string, whisper?: string): string {
  if (tab.startsWith('w:')) return `Whisper ${whisper ?? tab.slice(2)}…`;
  if (tab === 'system' || tab === 'local') return 'Say something nearby… (/help for commands)';
  return `Message ${tabLabel[tab] ?? tab}… (/help)`;
}

function ChatLine({ line, myId, onName }: { line: Line; myId?: string; onName: (name: string, e: ReactMouseEvent) => void }) {
  if (line.notice || line.channel === 'system') {
    return (
      <div data-testid="chat-line" style={{ color: line.notice === 'error' ? '#ff8787' : channelColor.system, fontStyle: 'italic', margin: '2px 0' }}>
        <span style={{ opacity: 0.5, marginRight: 6, fontStyle: 'normal', fontSize: 11 }}>{time(line.ts)}</span>
        {line.text}
      </div>
    );
  }
  const mine = line.fromId === myId;
  let who: ReactNode;
  if (line.channel === 'whisper') {
    who = mine ? (
      <>
        To <NameSpan name={line.toName ?? ''} onName={onName} />
      </>
    ) : (
      <>
        <NameSpan name={line.fromName} onName={onName} /> whispers
      </>
    );
  } else {
    who = <NameSpan name={line.fromName} onName={onName} />;
  }
  const tag = line.channel === 'local' ? '' : `[${tabLabel[line.channel] ?? line.channel}] `;
  return (
    <div data-testid="chat-line" style={{ margin: '2px 0', color: channelColor[line.channel], wordBreak: 'break-word' }}>
      <span style={{ opacity: 0.5, marginRight: 6, fontSize: 11, color: '#ccc' }}>{time(line.ts)}</span>
      {tag}
      {who}: <span style={{ color: '#f1f3f5' }}>{line.text}</span>
    </div>
  );
}

function NameSpan({ name, onName }: { name: string; onName: (name: string, e: ReactMouseEvent) => void }) {
  return (
    <span onClick={(e) => onName(name, e)} onContextMenu={(e) => onName(name, e)} style={{ color: nameColor(name), fontWeight: 600, cursor: 'pointer' }}>
      {name}
    </span>
  );
}
