import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@lodestone/contracts';
import { completeName, parseInput, regionOf, tabChannel, whisperTab } from './commands';
import { clearBubbles, getSpeechBubble, showBubble } from './bubbles';
import { initialSocialState, nameCandidates, reduce, tabFor, type SocialState } from './store';
import { SocialSocket } from './socket';
import type { S2C } from './types';

const ctx = { activeTab: 'local' };

describe('parseInput', () => {
  it('routes slash channels', () => {
    expect(parseInput('/g hello all', ctx)).toEqual({ kind: 'send', msg: { type: 'chat_send', channel: 'global', text: 'hello all' } });
    expect(parseInput('/z hi', ctx)).toMatchObject({ msg: { channel: 'zone' } });
    expect(parseInput('/s hi', ctx)).toMatchObject({ msg: { channel: 'local' } });
    expect(parseInput('/p omw', ctx)).toMatchObject({ msg: { channel: 'party' } });
  });
  it('whispers and replies', () => {
    expect(parseInput('/w Alice see you at the tower', ctx)).toEqual({ kind: 'send', msg: { type: 'whisper', to: 'Alice', text: 'see you at the tower' } });
    expect(parseInput('/w alice', ctx)).toEqual({ kind: 'openWhisper', to: 'alice' });
    expect(parseInput('/r ok', ctx)).toEqual({ kind: 'send', msg: { type: 'reply', text: 'ok' } });
    expect(parseInput('/w', ctx).kind).toBe('error');
  });
  it('plain text goes to the active tab; system and local tabs say locally', () => {
    expect(parseInput('hi', { activeTab: 'global' })).toMatchObject({ msg: { channel: 'global' } });
    expect(parseInput('hi', { activeTab: 'system' })).toMatchObject({ msg: { channel: 'local' } });
    expect(parseInput('hi', { activeTab: 'w:bob', whisperName: () => 'Bob' })).toEqual({ kind: 'send', msg: { type: 'whisper', to: 'Bob', text: 'hi' } });
    expect(parseInput('   ', ctx)).toEqual({ kind: 'none' });
  });
  it('social verbs', () => {
    expect(parseInput('/invite Bob', ctx)).toEqual({ kind: 'send', msg: { type: 'party_invite', name: 'Bob' } });
    expect(parseInput('/block Troll', ctx)).toEqual({ kind: 'send', msg: { type: 'block', name: 'Troll' } });
    expect(parseInput('/accept Ann', ctx)).toEqual({ kind: 'send', msg: { type: 'friend_respond', name: 'Ann', accept: true } });
    expect(parseInput('/leave', ctx)).toEqual({ kind: 'send', msg: { type: 'party_leave' } });
    expect(parseInput('/report Troll spamming', { activeTab: 'global' })).toEqual({
      kind: 'send', msg: { type: 'report', name: 'Troll', channel: 'global', reason: 'spamming' },
    });
    expect(parseInput('/filter off', ctx)).toEqual({ kind: 'send', msg: { type: 'set_filter', profanity: false } });
    expect(parseInput('/dance', ctx).kind).toBe('error');
  });
  it('enforces 280 characters (code points) before sending', () => {
    expect(parseInput('/g ' + 'x'.repeat(281), ctx).kind).toBe('error');
    expect(parseInput('/g ' + '😀'.repeat(280), ctx).kind).toBe('send'); // 560 UTF-16 units, 280 characters
  });
});

describe('completeName', () => {
  const names = ['Alice', 'alfred', 'Bob', 'ALICE'];
  it('completes and cycles case-insensitively', () => {
    expect(completeName('/w al', names)).toBe('/w alfred ');
    expect(completeName('/w al', names, 1)).toBe('/w Alice ');
    expect(completeName('/invite b', names)).toBe('/invite Bob ');
    expect(completeName('/w zz', names)).toBeNull();
    expect(completeName('hello al', names)).toBeNull();
  });
});

describe('helpers', () => {
  it('regions match the director (1024 m, clamped to 4x4)', () => {
    expect(regionOf(2048, 2048)).toBe('2,2');
    expect(regionOf(-5, 5000)).toBe('0,3');
  });
  it('tab keys', () => {
    expect(whisperTab('Bob')).toBe('w:bob');
    expect(tabChannel('w:bob')).toBe('whisper');
    expect(tabChannel('party')).toBe('party');
  });
});

const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: Math.random().toString(36), channel: 'global', fromId: 'b', fromName: 'Bob', text: 'hi', ts: 1, ...m });

function run(state: SocialState, ...msgs: S2C[]): SocialState {
  for (const m of msgs) state = { ...state, ...reduce(state, m) };
  return state;
}

describe('reduce', () => {
  const welcomed = () => run(initialSocialState(), { type: 'welcome', characterId: 'me', name: 'Me', isLocalProfile: false });

  it('whispers open a tab named after the partner, both directions', () => {
    let s = welcomed();
    s = run(s, { type: 'chat', message: msg({ channel: 'whisper', fromId: 'a', fromName: 'Alice', toName: 'Me', text: 'psst' }) });
    expect(s.tabs['w:alice'].map((l) => l.text)).toEqual(['psst']);
    expect(s.whisperNames['w:alice']).toBe('Alice');
    expect(s.unread['w:alice']).toBe(1);
    expect(s.toasts).toHaveLength(1); // chat closed -> toast
    s = run(s, { type: 'chat', message: msg({ channel: 'whisper', fromId: 'me', fromName: 'Me', toName: 'Alice', text: 'yes?' }) });
    expect(s.tabs['w:alice']).toHaveLength(2);
    expect(s.unread['w:alice']).toBe(1); // own echo is not unread
    expect(tabFor(msg({ channel: 'whisper', fromId: 'me', toName: 'Zed' }), 'me').tab).toBe('w:zed');
  });

  it('no unread or toast for the open, active tab; no toast for global', () => {
    let s = { ...welcomed(), open: true, activeTab: 'global' };
    s = run(s, { type: 'chat', message: msg({}) });
    expect(s.unread.global ?? 0).toBe(0);
    s = { ...s, open: false };
    s = run(s, { type: 'chat', message: msg({}) });
    expect(s.unread.global).toBe(1);
    expect(s.toasts).toHaveLength(0);
  });

  it('dedupes by id and caps tabs', () => {
    let s = welcomed();
    const m = msg({ id: 'x' });
    s = run(s, { type: 'chat', message: m }, { type: 'history', channel: 'global', messages: [m] });
    expect(s.tabs.global).toHaveLength(1);
    const many = Array.from({ length: 250 }, (_, i) => msg({ id: 'h' + i }));
    s = run(s, { type: 'history', channel: 'global', messages: many });
    expect(s.tabs.global).toHaveLength(200);
  });

  it('whisper history uses the conversation name; zone history replaces the tab', () => {
    let s = welcomed();
    s = run(s, { type: 'history', channel: 'whisper', conversation: 'Carol', messages: [msg({ channel: 'whisper', fromName: 'Carol' })] });
    expect(s.tabs['w:carol']).toHaveLength(1);
    s = run(s, { type: 'history', channel: 'zone', messages: [msg({ channel: 'zone', id: 'z1' })] });
    s = run(s, { type: 'history', channel: 'zone', messages: [msg({ channel: 'zone', id: 'z2' })] });
    expect(s.tabs.zone.map((l) => l.id)).toEqual(['z2']);
  });

  it('offline whisper status shows "Name is offline" in that tab', () => {
    const s = run(welcomed(), { type: 'whisper_status', to: 'Ghost', status: 'offline' });
    expect(s.tabs['w:ghost'].at(-1)?.text).toBe('Ghost is offline.');
    expect(s.tabs.system.at(-1)?.text).toBe('Ghost is offline.');
  });

  it('an unknown whisper target closes the empty tab it opened', () => {
    let s: SocialState = { ...welcomed(), activeTab: 'w:nobody', tabs: { ...welcomed().tabs, 'w:nobody': [] } };
    s = run(s, { type: 'error', code: 'unknown_target', message: 'There is no one called Nobody.' });
    expect(s.tabs['w:nobody']).toBeUndefined();
    expect(s.activeTab).toBe('local');
    expect(s.tabs.local.at(-1)?.text).toBe('There is no one called Nobody.');
  });

  it('party, invites, friends, relations', () => {
    let s = welcomed();
    s = run(s, { type: 'party_invite', partyId: 'p1', fromName: 'Ann' });
    expect(s.invites).toHaveLength(1);
    s = run(s, { type: 'party_state', partyId: 'p1', leaderId: 'a', members: [{ characterId: 'a', name: 'Ann', online: true }] });
    expect(s.invites).toHaveLength(0);
    expect(s.party?.members[0].name).toBe('Ann');
    s = run(s, { type: 'party_left' });
    expect(s.party).toBeNull();
    s = run(s, { type: 'friends', friends: [{ characterId: 'f', name: 'Finn', state: 'accepted', online: true, region: '1,1' }] });
    s = run(s, { type: 'relations', muted: ['Troll'], blocked: [], profanityFilter: false });
    expect(s.relations.profanityFilter).toBe(false);
    expect(nameCandidates(s, ['Nearby'])).toEqual(expect.arrayContaining(['Finn', 'Nearby']));
  });
});

describe('bubbles', () => {
  afterEach(() => clearBubbles());
  it('show and expire by name, case-insensitively', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'Date'] });
    showBubble('Alice', 'hello', { x: 1, z: 2 }, 1000);
    expect(getSpeechBubble('alice')?.text).toBe('hello');
    vi.advanceTimersByTime(1001);
    expect(getSpeechBubble('Alice')).toBeUndefined();
    vi.useRealTimers();
  });
});

describe('SocialSocket', () => {
  class FakeWS {
    static all: FakeWS[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor(readonly url: string) {
      FakeWS.all.push(this);
    }
    send(s: string) {
      this.sent.push(s);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    recv(m: object) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
  }

  it('auths, queues until welcome, reconnects with a fresh ticket, stops on replaced', async () => {
    vi.useFakeTimers();
    FakeWS.all = [];
    const tickets = ['t2', 't3'];
    const statuses: string[] = [];
    const sock = new SocialSocket({
      endpoint: 'ws://x/ws', ticket: 't1', refreshTicket: async () => tickets.shift()!,
      onMessage: () => {}, onStatus: (s) => statuses.push(s), WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    sock.start();
    await vi.advanceTimersByTimeAsync(0);
    const a = FakeWS.all[0];
    sock.send({ type: 'chat_send', channel: 'local', text: 'early' });
    a.open();
    expect(JSON.parse(a.sent[0])).toEqual({ type: 'auth', ticket: 't1' });
    expect(a.sent).toHaveLength(1); // chat waits for welcome
    a.recv({ type: 'welcome', characterId: 'c', name: 'C', isLocalProfile: false });
    expect(JSON.parse(a.sent[1]).text).toBe('early');

    a.close(); // network drop
    await vi.advanceTimersByTimeAsync(1000);
    const b = FakeWS.all[1];
    b.open();
    expect(JSON.parse(b.sent[0])).toEqual({ type: 'auth', ticket: 't2' });
    b.recv({ type: 'error', code: 'replaced', message: 'signed in from another window' });
    b.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeWS.all).toHaveLength(2); // no reconnect after replaced
    expect(statuses.at(-1)).toBe('closed');
    vi.useRealTimers();
  });
});
