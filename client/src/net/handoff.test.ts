// WP16: ZoneSession's handoff and failover against fake sockets (no zone
// process): a ZoneTransfer opens a standby connection with the token, that
// connection's Welcome makes it active (decoder reset, frames resent,
// prediction kept), and a dropped active connection fails over through the
// reconnect callback and snaps to the checkpoint.
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, PROTOCOL_VERSION, type AnyMessage as Message, type Welcome } from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';
import { newMoveState } from '../sim/movement';
import type { WebSocketLike } from './transport';
import { ZoneSession } from './zoneSession';

const flat: GroundQuery = { heightAt: () => 0 };

class FakeWs implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Message[] = [];
  constructor(readonly url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }
  send(data: Uint8Array): void {
    this.sent.push(decodeMessage(data));
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  deliver(m: Message): void {
    const b = encodeMessage(m);
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function welcome(entityId: number, x = 100): Welcome {
  return { type: 'Welcome', protocolVersion: PROTOCOL_VERSION, entityId, tick: 1, tickRate: 30, serverTime: Date.now(), worldId: 'w', seed: 1n, genVersion: 'g', x: x * 100, y: 0, z: 0, name: 'P' };
}

function selfSnap(tick: number, ackInputSeq: number, x: number) {
  const st = newMoveState({ x, y: 0, z: 0 });
  return {
    type: 'Snapshot' as const,
    tick,
    baselineTick: 0,
    ackInputSeq,
    serverTime: Date.now(),
    self: { mask: 0xffff, x: Math.round(x * 100), y: 0, z: 0, vx: 0, vy: 0, vz: 0, health: 100, healthMax: 100, stamina: Math.round(st.stamina / 6), staminaMax: Math.round(st.staminaMax / 6), mode: st.mode, airJumps: 0, activity: 0, flags: 0, moveExt: st.stamina },
    entities: [],
    removed: [],
  };
}

describe('ZoneSession handoff (WP16)', () => {
  it('switches to the standby connection on its Welcome, resends frames and keeps prediction', async () => {
    const socks: FakeWs[] = [];
    const s = new ZoneSession({ wsUrl: 'ws://a', ticket: 't', ground: flat, zoneId: 'zone-a', wsFactory: (u) => (socks.push(new FakeWs(u)), socks[socks.length - 1]) });
    const started = s.start();
    await tick();
    socks[0].deliver(welcome(7));
    await started;
    // Some predicted steps; the zone acked up to seq 2.
    for (let seq = 1; seq <= 5; seq++) s.pushStep(seq, { flags: 1, yaw: 0, pitch: 0 }, newMoveState({ x: 100, y: 0, z: -seq * 0.1 }));
    s.flushInput(true);
    socks[0].deliver({ type: 'ZoneTransfer', zoneId: 'zone-b', endpoint: 'ws://b', ticket: new TextEncoder().encode('ho1.abc'), kind: 0, wtEndpoint: '' });
    await tick();
    await tick();
    const b = socks.find((x) => x.url === 'ws://b')!;
    expect(b).toBeTruthy();
    const hello = b.sent[0];
    expect(hello.type).toBe('Hello');
    if (hello.type === 'Hello') expect(new TextDecoder().decode(hello.ticket)).toBe('ho1.abc');
    expect([...s.standby.keys()]).toEqual(['zone-b']);
    const before = s.decoder;
    b.deliver(welcome(7));
    expect(s.zoneId).toBe('zone-b');
    expect(s.transport).not.toBeNull();
    expect(s.decoder).not.toBe(before);
    expect(s.transfers).toHaveLength(1);
    expect(s.transfers[0]).toMatchObject({ from: 'zone-a', to: 'zone-b', kind: 'handoff', entityId: 7 });
    // Every unacked frame went to the new zone; the old one is now a standby.
    const resent = b.sent.filter((m) => m.type === 'Input').flatMap((m) => (m.type === 'Input' ? m.frames.map((f) => f.seq) : []));
    expect(resent).toEqual([1, 2, 3, 4, 5]);
    expect([...s.standby.keys()]).toEqual(['zone-a']);
    expect(s.phase).toBe('playing');
    // Snapshots on the old connection are ignored now.
    socks[0].deliver(selfSnap(50, 5, 1));
    expect(s.stats.snapshots).toBe(0);
    s.close();
  });

  it('cancel closes the standby connection', async () => {
    const socks: FakeWs[] = [];
    const s = new ZoneSession({ wsUrl: 'ws://a', ticket: 't', ground: flat, zoneId: 'zone-a', wsFactory: (u) => (socks.push(new FakeWs(u)), socks[socks.length - 1]) });
    const started = s.start();
    await tick();
    socks[0].deliver(welcome(7));
    await started;
    socks[0].deliver({ type: 'ZoneTransfer', zoneId: 'zone-b', endpoint: 'ws://b', ticket: new TextEncoder().encode('ho1.x'), kind: 0, wtEndpoint: '' });
    await tick();
    await tick();
    socks[0].deliver({ type: 'ZoneTransfer', zoneId: 'zone-b', endpoint: '', ticket: new Uint8Array(0), kind: 1, wtEndpoint: '' });
    expect(s.standby.size).toBe(0);
    expect(socks[1].readyState).toBe(3);
    s.close();
  });

  it('fails over through reconnect when the active zone dies, then snaps to the checkpoint', async () => {
    const socks: FakeWs[] = [];
    let asked = 0;
    const s = new ZoneSession({
      wsUrl: 'ws://a',
      ticket: 't',
      ground: flat,
      zoneId: 'zone-a',
      wsFactory: (u) => (socks.push(new FakeWs(u)), socks[socks.length - 1]),
      reconnect: async () => {
        asked++;
        return { zoneId: 'zone-p', ticket: 'fresh', wsUrl: 'ws://p' };
      },
    });
    let ended = false;
    s.onEnd = () => (ended = true);
    const started = s.start();
    await tick();
    socks[0].deliver(welcome(7));
    await started;
    socks[0].close(1006, ''); // the zone process died
    await tick();
    await tick();
    const p = socks.find((x) => x.url === 'ws://p')!;
    expect(asked).toBe(1);
    expect(p.sent[0].type).toBe('Hello');
    // Steps are dropped until the new zone welcomed us and we snapped.
    s.pushStep(10, { flags: 0, yaw: 0, pitch: 0 }, newMoveState({ x: 1, y: 0, z: 1 }));
    p.deliver(welcome(7, 42));
    await tick();
    expect(s.zoneId).toBe('zone-p');
    expect(s.stats.failovers).toBe(1);
    p.deliver(selfSnap(5, 0, 42));
    expect(s.prediction.awaitingForced).toBe(true);
    const c = s.prediction.takeCorrection();
    expect(c?.forced).toBe(true);
    expect(c?.state.pos.x).toBeCloseTo(42);
    expect(s.prediction.awaitingForced).toBe(false);
    expect(ended).toBe(false);
    expect(s.phase).toBe('playing');
    s.close();
  });

  it('a terminal kick ends the session instead of failing over', async () => {
    const socks: FakeWs[] = [];
    let asked = 0;
    const s = new ZoneSession({ wsUrl: 'ws://a', ticket: 't', ground: flat, wsFactory: (u) => (socks.push(new FakeWs(u)), socks[socks.length - 1]), reconnect: async () => (asked++, { zoneId: 'x', ticket: 'x', wsUrl: 'ws://x' }) });
    const started = s.start();
    await tick();
    socks[0].deliver(welcome(7));
    await started;
    socks[0].deliver({ type: 'Kick', code: 3, reason: 'duplicate' });
    socks[0].close(4003, 'duplicate');
    await tick();
    expect(asked).toBe(0);
    expect(s.phase).toBe('closed');
  });
});
