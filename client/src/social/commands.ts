// Chat input parsing: slash commands (spec 10: /g /z /s /p /w /r) plus the
// social verbs, so every social action is reachable from the keyboard.
// Pure functions: unit-tested in social.test.ts.

import { CHAT_MAX_LEN, type Channel } from '@lodestone/contracts';
import type { C2S } from './types';

export type Command =
  | { kind: 'send'; msg: C2S }
  /** `/w Name` with no text: open (or focus) that whisper tab. */
  | { kind: 'openWhisper'; to: string }
  | { kind: 'help' }
  /** Playtest 2: a zone-side verb (/pvp, /duel, /yield) for the game's handler (session.ts setGameCommandHandler). */
  | { kind: 'game'; verb: 'pvp' | 'duel' | 'yield' | 'emote'; args: string }
  | { kind: 'error'; message: string }
  | { kind: 'none' };

export const HELP_LINES = [
  '/g msg  global · /z msg  zone · /s msg  local (say) · /p msg  party',
  '/w Name msg  whisper · /r msg  reply to last whisper',
  '/invite Name · /leave · /kick Name · /promote Name',
  '/friend Name · /unfriend Name · /accept Name · /decline Name',
  '/mute Name · /unmute Name · /block Name · /unblock Name',
  '/report Name [reason] · /filter on|off',
  '/pvp [on|off] · /duel Name (a party member) · /duel accept|decline · /yield',
  '/emote name (wave, bow, cheer, point, sit, dance, laugh, shrug, salute, rest) · /emote alone lists them · hold H for the wheel',
];

const CHANNEL_ALIASES: Record<string, Channel> = {
  g: 'global', global: 'global',
  z: 'zone', zone: 'zone',
  s: 'local', say: 'local', l: 'local', local: 'local',
  p: 'party', party: 'party',
};

const NAME_VERBS: Record<string, 'block' | 'unblock' | 'mute' | 'unmute' | 'party_invite' | 'party_kick' | 'party_promote' | 'friend_request' | 'friend_remove'> = {
  block: 'block', unblock: 'unblock', mute: 'mute', unmute: 'unmute',
  invite: 'party_invite', inv: 'party_invite', kick: 'party_kick', promote: 'party_promote',
  friend: 'friend_request', addfriend: 'friend_request', unfriend: 'friend_remove', removefriend: 'friend_remove',
};

/** Where plain text (no slash) goes: the active tab's channel, or its whisper partner. */
export interface InputContext {
  /** 'global' | 'zone' | 'local' | 'party' | 'system' | 'w:<lowercase name>' */
  activeTab: string;
  /** Display name for a whisper tab key. */
  whisperName?: (tabKey: string) => string | undefined;
  /** Report from the active channel by default. */
}

function splitFirst(s: string): [string, string] {
  const t = s.trimStart();
  const i = t.search(/\s/);
  return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1).trim()];
}

function tooLong(text: string): boolean {
  // Count code points, as the server does (runes), not UTF-16 units.
  return [...text].length > CHAT_MAX_LEN;
}

/** Turn one line of chat input into an action. */
export function parseInput(raw: string, ctx: InputContext): Command {
  const input = raw.trim();
  if (!input) return { kind: 'none' };
  if (!input.startsWith('/')) {
    return plain(input, ctx);
  }
  const [cmdRaw, rest] = splitFirst(input.slice(1));
  const cmd = cmdRaw.toLowerCase();

  if (cmd in CHANNEL_ALIASES) {
    if (!rest) return { kind: 'error', message: `Usage: /${cmd} message` };
    return chatTo(CHANNEL_ALIASES[cmd], rest);
  }
  switch (cmd) {
    case 'w':
    case 'whisper':
    case 't':
    case 'tell': {
      const [to, text] = splitFirst(rest);
      if (!to) return { kind: 'error', message: 'Usage: /w Name message' };
      if (!text) return { kind: 'openWhisper', to };
      if (tooLong(text)) return { kind: 'error', message: `Messages are limited to ${CHAT_MAX_LEN} characters.` };
      return { kind: 'send', msg: { type: 'whisper', to, text } };
    }
    case 'r':
    case 'reply':
      if (!rest) return { kind: 'error', message: 'Usage: /r message' };
      if (tooLong(rest)) return { kind: 'error', message: `Messages are limited to ${CHAT_MAX_LEN} characters.` };
      return { kind: 'send', msg: { type: 'reply', text: rest } };
    case 'leave':
      return { kind: 'send', msg: { type: 'party_leave' } };
    case 'accept':
    case 'decline': {
      const [name] = splitFirst(rest);
      if (!name) return { kind: 'error', message: `Usage: /${cmd} Name` };
      return { kind: 'send', msg: { type: 'friend_respond', name, accept: cmd === 'accept' } };
    }
    case 'report': {
      const [name, reason] = splitFirst(rest);
      if (!name) return { kind: 'error', message: 'Usage: /report Name [reason]' };
      return { kind: 'send', msg: { type: 'report', name, channel: tabChannel(ctx.activeTab), ...(reason ? { reason } : {}) } };
    }
    case 'filter': {
      const v = rest.toLowerCase();
      if (v !== 'on' && v !== 'off') return { kind: 'error', message: 'Usage: /filter on|off' };
      return { kind: 'send', msg: { type: 'set_filter', profanity: v === 'on' } };
    }
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'pvp':
    case 'duel':
      return { kind: 'game', verb: cmd, args: rest };
    case 'yield':
    case 'forfeit':
      return { kind: 'game', verb: 'yield', args: rest };
    case 'emote':
    case 'em':
    case 'e':
      return { kind: 'game', verb: 'emote', args: rest }; // playtest 2 emotes (ui/emotes)
  }
  if (cmd in NAME_VERBS) {
    const [name] = splitFirst(rest);
    if (!name) return { kind: 'error', message: `Usage: /${cmd} Name` };
    // Every name verb has the same {type, name} shape on the wire.
    return { kind: 'send', msg: { type: NAME_VERBS[cmd], name } as C2S };
  }
  return { kind: 'error', message: `Unknown command /${cmd}. Type /help.` };
}

function chatTo(channel: Channel, text: string): Command {
  if (tooLong(text)) return { kind: 'error', message: `Messages are limited to ${CHAT_MAX_LEN} characters.` };
  return { kind: 'send', msg: { type: 'chat_send', channel, text } };
}

function plain(text: string, ctx: InputContext): Command {
  if (ctx.activeTab.startsWith('w:')) {
    const to = ctx.whisperName?.(ctx.activeTab) ?? ctx.activeTab.slice(2);
    if (tooLong(text)) return { kind: 'error', message: `Messages are limited to ${CHAT_MAX_LEN} characters.` };
    return { kind: 'send', msg: { type: 'whisper', to, text } };
  }
  // Spec 10: local is the default when typing in the world; the system tab
  // has no composer channel of its own, so it says locally too.
  const ch = tabChannel(ctx.activeTab);
  return chatTo(ch === 'system' || ch === 'whisper' ? 'local' : ch, text);
}

/** The channel a tab key belongs to. */
export function tabChannel(tab: string): Channel {
  if (tab.startsWith('w:')) return 'whisper';
  return (['global', 'zone', 'local', 'party', 'system'] as const).find((c) => c === tab) ?? 'local';
}

/** Tab key for a whisper partner (names are case-insensitive, spec 10). */
export function whisperTab(name: string): string {
  return 'w:' + name.toLowerCase();
}

/**
 * Name completion for the composer: given the input and the cursor at its
 * end, complete the word being typed when it is a name argument
 * (`/w Al` -> `/w Alice `). Returns null when nothing matches. `cycle`
 * picks the n-th match so repeated Tab presses walk the list.
 */
export function completeName(input: string, candidates: Iterable<string>, cycle = 0): string | null {
  const m = /^(\/(?:w|whisper|t|tell|invite|inv|kick|promote|friend|unfriend|accept|decline|mute|unmute|block|unblock|report|duel)\s+)(\S*)$/i.exec(input);
  if (!m) return null;
  const prefix = m[2].toLowerCase();
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const c of candidates) {
    const k = c.toLowerCase();
    if (!seen.has(k) && k.startsWith(prefix)) {
      seen.add(k);
      matches.push(c);
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return m[1] + matches[cycle % matches.length] + ' ';
}

/** Region label for presence: 1024 m regions, "x,z" (director's region math). */
export function regionOf(x: number, z: number, regionM = 1024, regions = 4): string {
  const clamp = (v: number) => Math.min(regions - 1, Math.max(0, Math.floor(v / regionM)));
  return `${clamp(x)},${clamp(z)}`;
}
