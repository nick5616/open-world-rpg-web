// node --test tools/netsim/test/   (also run by `npm test -w @lodestone/netsim`)
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { PROFILES, resolveConfig } from '../profiles.mjs';
import { makeOrderedPipe, startProxy } from '../proxy.mjs';

test('profiles: thailand is ~160 ms RTT with 3% loss, mobile is 1.5 Mbit with 6% loss', () => {
  assert.equal(PROFILES.thailand.latency * 2, 160);
  assert.equal(PROFILES.thailand.loss, 0.03);
  assert.equal(PROFILES.mobile.bw, 1500);
  assert.equal(PROFILES.mobile.loss, 0.06);
  assert.equal(resolveConfig('thailand', { loss: '0.1' }).loss, 0.1);
  assert.throws(() => resolveConfig('nope'));
});

test('ordered pipe never reorders and a lost frame stalls everything behind it', async () => {
  const cfg = { ...resolveConfig('clean'), latency: 5, jitter: 20 };
  const got = [];
  let r = 0;
  // Deterministic rand: frame 3 is "lost" (loss check < 0.5), others not.
  const seq = [];
  const rand = () => (seq.length ? seq.shift() : 0.9);
  const stats = { frames: 0, bytes: 0, lost: 0 };
  const pipe = makeOrderedPipe({ ...cfg, loss: 0.5 }, (d) => got.push([d, Date.now()]), stats, () => {
    r++;
    return rand();
  });
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) {
    // gauss consumes two rands, loss one: make frame 3's loss check hit.
    seq.push(0.5, 0.5, i === 3 ? 0.1 : 0.9);
    pipe(Buffer.from([i]), true);
  }
  await new Promise((res) => setTimeout(res, 450));
  assert.deepEqual(got.map(([d]) => d[0]), [0, 1, 2, 3, 4, 5]);
  assert.equal(stats.lost, 1);
  // Frames 3..5 waited for the retransmit (>= 200 ms).
  assert.ok(got[3][1] - t0 >= 200 && got[5][1] >= got[3][1]);
  assert.ok(got[2][1] - t0 < 150);
  assert.ok(r > 0);
});

test('websocket proxy adds the profile latency and passes binary frames and close codes', async () => {
  const echo = new WebSocketServer({ port: 0 });
  echo.on('connection', (ws, req) => {
    ws.on('message', (d, bin) => {
      if (d[0] === 0xff) ws.close(4003, 'kick');
      else ws.send(Buffer.concat([Buffer.from(req.url ?? ''), d]), { binary: bin });
    });
  });
  await once(echo, 'listening');
  const cfg = resolveConfig('clean', { latency: 40 });
  const proxy = await startProxy({ config: cfg, listen: 18995, target: `ws://127.0.0.1:${echo.address().port}`, quiet: true });
  try {
    const ws = new WebSocket('ws://127.0.0.1:18995/ws?x=1');
    await once(ws, 'open');
    const t0 = Date.now();
    ws.send(Buffer.from([1, 2, 3]));
    const [msg] = await once(ws, 'message');
    const rtt = Date.now() - t0;
    assert.ok(rtt >= 75, `rtt ${rtt} should include 2 x 40 ms`);
    assert.equal(msg.subarray(0, 7).toString(), '/ws?x=1');
    ws.send(Buffer.from([0xff]));
    const [code] = await once(ws, 'close');
    assert.equal(code, 4003);
    assert.equal(proxy.stats.c2s.frames, 2);
  } finally {
    await proxy.close();
    echo.close();
  }
});

test('udp relay delays and drops datagrams', async () => {
  const echo = dgram.createSocket('udp4');
  echo.on('message', (m, r) => echo.send(m, r.port, r.address));
  await new Promise((res) => echo.bind(0, '127.0.0.1', res));
  const cfg = resolveConfig('clean', { latency: 20, loss: 0.3 });
  const proxy = await startProxy({ config: cfg, udpListen: 18996, udpTarget: `127.0.0.1:${echo.address().port}`, quiet: true });
  const client = dgram.createSocket('udp4');
  try {
    const got = [];
    client.on('message', (m) => got.push([m[0], Date.now()]));
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) client.send(Buffer.from([i]), 18996, '127.0.0.1');
    await new Promise((res) => setTimeout(res, 400));
    // Two directions at 30% loss: ~49% survive.
    assert.ok(got.length > 60 && got.length < 140, `got ${got.length} of 200`);
    assert.ok(got.every(([, t]) => t - t0 >= 38), 'every datagram should take >= 2 x 20 ms');
    assert.ok(proxy.stats.c2s.lost > 20);
  } finally {
    client.close();
    await proxy.close();
    echo.close();
  }
});
