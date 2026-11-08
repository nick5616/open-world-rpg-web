import { describe, expect, it } from 'vitest';
import { waitAwake, wakeMessage, wakeOnce } from './wake';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('wakeOnce', () => {
  it('passes the director report through', async () => {
    const calls: string[] = [];
    const r = await wakeOnce('http://d', async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return json(200, { state: 'starting', awake: false, provider: 'gce', retryAfterS: 3 });
    });
    expect(calls).toEqual(['POST http://d/v1/wake']);
    expect(r).toEqual({ state: 'starting', awake: false, provider: 'gce', retryAfterS: 3 });
  });

  it('treats a director without /v1/wake as awake (older deploys, dev)', async () => {
    expect((await wakeOnce('http://d', async () => new Response('', { status: 404 }))).awake).toBe(true);
    expect((await wakeOnce('http://d', async () => new Response('', { status: 405 }))).awake).toBe(true);
  });

  it('reports an unreachable director without throwing', async () => {
    const r = await wakeOnce('http://d', async () => {
      throw new TypeError('fetch failed');
    });
    expect(r.state).toBe('unreachable');
    expect(r.awake).toBe(false);
  });

  it('survives a non-JSON error page', async () => {
    const r = await wakeOnce('http://d', async () => new Response('<html>502</html>', { status: 502 }));
    expect(r).toMatchObject({ state: 'unknown', awake: false });
  });
});

describe('waitAwake', () => {
  it('polls through starting and booting until awake, honoring retryAfterS', async () => {
    const script = [
      { state: 'starting', awake: false, provider: 'fake', retryAfterS: 3 },
      { state: 'starting', awake: false, provider: 'fake', retryAfterS: 30 }, // clamped to 5 s
      { state: 'booting', awake: false, provider: 'fake', retryAfterS: 0 }, // clamped to 1 s
      { state: 'awake', awake: true, provider: 'fake' },
    ];
    let i = 0;
    const sleeps: number[] = [];
    const states: string[] = [];
    const r = await waitAwake({
      directorUrl: 'http://d',
      fetchImpl: async () => json(200, script[i++]),
      sleep: async (ms) => void sleeps.push(ms),
      onReport: (rep) => states.push(rep.state),
    });
    expect(r.awake).toBe(true);
    expect(states).toEqual(['starting', 'starting', 'booting', 'awake']);
    expect(sleeps).toEqual([3000, 5000, 1000]);
  });

  it('stops when aborted', async () => {
    const signal = { aborted: false };
    let n = 0;
    const r = await waitAwake({
      directorUrl: 'http://d',
      fetchImpl: async () => {
        n++;
        return json(200, { state: 'starting', awake: false, provider: 'fake' });
      },
      sleep: async () => {
        signal.aborted = true;
      },
      signal,
    });
    expect(r.awake).toBe(false);
    expect(n).toBe(1);
  });

  it('has a message for every state', () => {
    for (const s of ['starting', 'booting', 'stopping', 'unreachable', 'awake', 'unknown']) expect(wakeMessage(s).length).toBeGreaterThan(3);
  });
});
