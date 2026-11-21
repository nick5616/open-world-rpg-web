// Social UI state. `reduce` is a pure function from (state, server message)
// to the next state so the protocol handling is unit-testable without a
// socket or React; the zustand store just applies it.

import { create } from 'zustand';
import type { ChatMessage, Friend, S2CPartyInvite, S2CPartyState, S2CRelations } from '@lodestone/contracts';
import type { S2C } from './types';
import { whisperTab } from './commands';

/** A line in a tab: a chat message, or a notice (system frames, errors, statuses). */
export interface Line extends ChatMessage {
  notice?: 'info' | 'error';
}

export interface Toast {
  id: string;
  tab: string;
  from: string;
  text: string;
}

export type Status = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'closed';

export const FIXED_TABS = ['local', 'zone', 'global', 'party', 'system'] as const;

/** Lines kept per tab: matches the largest server history (global, 200). */
export const TAB_CAP = 200;

export interface SocialState {
  status: Status;
  /** Why the socket is closed for good (replaced, banned), shown instead of reconnecting. */
  closedReason?: string;
  me: { characterId: string; name: string; isLocalProfile: boolean } | null;
  tabs: Record<string, Line[]>;
  /** whisper tab key -> partner display name */
  whisperNames: Record<string, string>;
  unread: Record<string, number>;
  activeTab: string;
  open: boolean;
  toasts: Toast[];
  party: S2CPartyState | null;
  invites: S2CPartyInvite[];
  friends: Friend[];
  relations: Omit<S2CRelations, 'type'>;
  /** Names seen in chat recently (autocomplete; spec 10 "nearby players"). */
  recentNames: string[];
  rttMs: number | null;
}

export const initialSocialState = (): SocialState => ({
  status: 'idle',
  me: null,
  tabs: { local: [], zone: [], global: [], party: [], system: [] },
  whisperNames: {},
  unread: {},
  activeTab: 'local',
  open: false,
  toasts: [],
  party: null,
  invites: [],
  friends: [],
  relations: { muted: [], blocked: [], profanityFilter: true },
  recentNames: [],
  rttMs: null,
});

let noticeSeq = 0;
function notice(text: string, kind: 'info' | 'error' = 'info'): Line {
  return { id: `n${Date.now()}-${noticeSeq++}`, channel: 'system', fromId: '', fromName: '', text, ts: Date.now(), notice: kind };
}

/** The tab a chat message belongs in, from the reader's point of view. */
export function tabFor(m: ChatMessage, myId: string | undefined): { tab: string; partner?: string } {
  if (m.channel === 'whisper') {
    const partner = m.fromId === myId ? (m.toName ?? m.fromName) : m.fromName;
    return { tab: whisperTab(partner), partner };
  }
  return { tab: m.channel };
}

function appendLines(list: Line[] | undefined, add: Line[]): Line[] {
  const seen = new Set((list ?? []).map((l) => l.id));
  const merged = [...(list ?? []), ...add.filter((l) => !seen.has(l.id))];
  return merged.length > TAB_CAP ? merged.slice(merged.length - TAB_CAP) : merged;
}

function bump(s: SocialState, tab: string, n = 1): Record<string, number> {
  if (s.open && s.activeTab === tab) return s.unread;
  return { ...s.unread, [tab]: (s.unread[tab] ?? 0) + n };
}

function addRecent(s: SocialState, name: string): string[] {
  if (!name || name === s.me?.name) return s.recentNames;
  return [name, ...s.recentNames.filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 50);
}

/** Put a notice in the system tab and, when the reader is looking elsewhere, in the active tab too. */
export function withNotice(s: SocialState, text: string, kind: 'info' | 'error' = 'info', tab?: string): Partial<SocialState> {
  const line = notice(text, kind);
  const tabs: Record<string, Line[]> = { ...s.tabs, system: appendLines(s.tabs.system, [line]) };
  const target = tab ?? s.activeTab;
  if (target !== 'system') tabs[target] = appendLines(s.tabs[target], [line]);
  return { tabs };
}

/** Apply one server message. Returns only the changed fields. */
export function reduce(s: SocialState, msg: S2C): Partial<SocialState> {
  switch (msg.type) {
    case 'welcome':
      return { me: { characterId: msg.characterId, name: msg.name, isLocalProfile: msg.isLocalProfile }, status: 'online', closedReason: undefined };
    case 'chat': {
      const m = msg.message;
      const { tab, partner } = tabFor(m, s.me?.characterId);
      const out: Partial<SocialState> = {
        tabs: { ...s.tabs, [tab]: appendLines(s.tabs[tab], [m]) },
        recentNames: addRecent(s, m.channel === 'whisper' ? (partner ?? '') : m.fromName),
      };
      if (partner) out.whisperNames = { ...s.whisperNames, [tab]: partner };
      const mine = m.fromId === s.me?.characterId;
      if (!mine) {
        out.unread = bump(s, tab);
        // Spec 10: whisper (and party) toasts fire when the chat is closed.
        if (!s.open && (m.channel === 'whisper' || m.channel === 'party')) {
          out.toasts = [...s.toasts, { id: m.id, tab, from: m.fromName, text: m.text }].slice(-3);
        }
      }
      return out;
    }
    case 'history': {
      let tab: string = msg.channel;
      const out: Partial<SocialState> = {};
      if (msg.channel === 'whisper') {
        if (!msg.conversation) return {};
        tab = whisperTab(msg.conversation);
        out.whisperNames = { ...s.whisperNames, [tab]: msg.conversation };
      }
      // Zone history replaces the tab: it is a different region's channel.
      const base = msg.channel === 'zone' ? [] : s.tabs[tab];
      out.tabs = { ...s.tabs, [tab]: appendLines(base, msg.messages) };
      return out;
    }
    case 'whisper_status': {
      const tab = whisperTab(msg.to);
      // The server answers with the canonical spelling ("/w alice" -> "Alice").
      const names = { ...s.whisperNames, [tab]: msg.to };
      if (msg.status === 'offline') return { ...withNotice(s, `${msg.to} is offline.`, 'info', tab), whisperNames: names };
      if (msg.status === 'not_allowed') return { whisperNames: names }; // the server's system line explains why
      return { whisperNames: names };
    }
    case 'party_state':
      return { party: msg, invites: s.invites.filter((i) => i.partyId !== msg.partyId) };
    case 'party_invite':
      return { invites: [...s.invites.filter((i) => i.partyId !== msg.partyId), msg], ...withNotice(s, `${msg.fromName} invited you to a party.`) };
    case 'party_left':
      return { party: null };
    case 'friends':
      return { friends: msg.friends };
    case 'relations':
      return { relations: { muted: msg.muted, blocked: msg.blocked, profanityFilter: msg.profanityFilter } };
    case 'error': {
      // Playtest 6 polish: a stale ticket is refused and the socket reconnects with a fresh one on its own;
      // the refusal ("invalid or expired ticket") is not news for the chat log.
      if (msg.code === 'bad_auth') return {};
      if (msg.code === 'unknown_target' && s.activeTab.startsWith('w:') && (s.tabs[s.activeTab]?.length ?? 0) === 0) {
        // "/w Nobody hi" opened an empty tab for a name that doesn't exist: drop it.
        const tabs = { ...s.tabs };
        delete tabs[s.activeTab];
        const next = { ...s, tabs, activeTab: 'local' };
        return { tabs, activeTab: 'local', ...withNotice(next, msg.message, 'error') };
      }
      return withNotice(s, msg.message, 'error');
    }
    case 'system':
      return withNotice(s, msg.text);
    case 'pong':
      return { rttMs: Math.max(0, Date.now() - msg.t) };
    case 'voice_token':
      return {};
  }
  return {};
}

export interface SocialActions {
  apply: (msg: S2C) => void;
  setStatus: (status: Status, closedReason?: string) => void;
  setOpen: (open: boolean) => void;
  setActiveTab: (tab: string) => void;
  openWhisper: (name: string) => void;
  closeWhisper: (tab: string) => void;
  dismissToast: (id: string) => void;
  dismissInvite: (partyId: string) => void;
  localNotice: (text: string, kind?: 'info' | 'error') => void;
  reset: () => void;
}

export const useSocialStore = create<SocialState & SocialActions>()((set, get) => ({
  ...initialSocialState(),
  apply: (msg) => set(reduce(get(), msg)),
  setStatus: (status, closedReason) => set({ status, closedReason }),
  setOpen: (open) =>
    set((s) => ({ open, toasts: open ? [] : s.toasts, unread: open ? { ...s.unread, [s.activeTab]: 0 } : s.unread })),
  setActiveTab: (activeTab) => set((s) => ({ activeTab, unread: { ...s.unread, [activeTab]: 0 } })),
  openWhisper: (name) =>
    set((s) => {
      const tab = whisperTab(name);
      return {
        activeTab: tab,
        open: true,
        whisperNames: { ...s.whisperNames, [tab]: s.whisperNames[tab] ?? name },
        tabs: s.tabs[tab] ? s.tabs : { ...s.tabs, [tab]: [] },
        unread: { ...s.unread, [tab]: 0 },
      };
    }),
  closeWhisper: (tab) =>
    set((s) => {
      const tabs = { ...s.tabs };
      delete tabs[tab];
      return { tabs, activeTab: s.activeTab === tab ? 'local' : s.activeTab };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dismissInvite: (partyId) => set((s) => ({ invites: s.invites.filter((i) => i.partyId !== partyId) })),
  localNotice: (text, kind = 'info') => set((s) => withNotice(s, text, kind)),
  reset: () => set(initialSocialState()),
}));

/** Every name worth offering in autocomplete: friends, party, whisper partners, recent speakers, plus extras (e.g. nearby players from WP06). */
export function nameCandidates(s: SocialState, extra: Iterable<string> = []): string[] {
  const out: string[] = [];
  for (const f of s.friends) out.push(f.name);
  for (const m of s.party?.members ?? []) out.push(m.name);
  out.push(...Object.values(s.whisperNames), ...s.recentNames, ...extra);
  return out.filter((n) => n && n !== s.me?.name);
}
