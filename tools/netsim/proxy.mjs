#!/usr/bin/env node
/**
 * Network impairment proxies for playtests (spec 14 "Netsim proxy").
 *
 * adapted from wizard-wars scripts/playtest/netsim-proxy.mjs (WebSocket half,
 * ordered pipes, TCP-retransmit loss model, live /config), plus a UDP relay so
 * WebTransport/QUIC can be impaired too (real datagram loss and reordering).
 *
 *   node tools/netsim/proxy.mjs --profile thailand \
 *        --listen 8095 --target ws://localhost:8092 \
 *        [--udp-listen 8096 --udp-target 127.0.0.1:8092] \
 *        [--latency 80 --jitter 20 --loss 0.03 --bw 0 --spike-every 0 --spike-ms 0 --drop-after 0]
 *
 * Point the zone's announced endpoints at the proxy (LODESTONE_ZONE_PUBLIC_URL
 * = ws://localhost:8095/ws, LODESTONE_ZONE_WT_PUBLIC_URL =
 * https://localhost:8096/wt) and players go through it. Paths and query
 * strings are forwarded untouched.
 *
 * WebSocket (TCP) direction pipes keep order, because TCP never reorders:
 *   latency   ms one-way delay added to every frame (RTT += 2 x latency)
 *   jitter    ms standard deviation of extra normal delay (order preserved,
 *             so jitter shows up as bunching, exactly like real TCP)
 *   loss      probability a frame "gets lost" -> modeled as a TCP retransmit:
 *             that frame AND everything behind it stall ~RTO (200-300 ms)
 *   bw        kbit/s cap per direction (0 = unlimited); frames serialize
 *   spikeEvery / spikeMs: every N s freeze the link for M ms (wifi hiccup)
 *   dropAfter s after connect to hard-kill the socket (reconnect tests)
 * UDP (QUIC) datagrams get the same latency/jitter/bw/spikes but real loss
 * (dropped, not stalled) and may reorder, like netem with jitter.
 *
 * Live reconfigure (applies to new frames):
 *   curl "http://localhost:8095/config?latency=150&jitter=40&loss=0.05"
 *   curl  http://localhost:8095/config   -> current config JSON
 *   curl  http://localhost:8095/stats    -> per-direction byte/frame counts
 *   curl  http://localhost:8095/kill     -> hard-close every proxied socket
 */
import dgram from 'node:dgram';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { delaySample, resolveConfig, spikeHoldUntil } from './profiles.mjs';

/** TCP retransmission timeout model: Linux's 200 ms minimum RTO plus scheduling slack. */
const RTO_MS = 200;
const RTO_SLACK_MS = 100;

function newStats() {
  return { c2s: { frames: 0, bytes: 0, lost: 0 }, s2c: { frames: 0, bytes: 0, lost: 0 }, connections: 0, open: 0, udpClients: 0 };
}

/**
 * Ordered delayed pipe: frames leave in arrival order, never earlier than
 * their release time. One FIFO + one timer per pipe: independent setTimeouts
 * with equal release times can fire out of order (1 ms timer granularity),
 * which the server would see as reordered input. Real TCP never does that.
 */
export function makeOrderedPipe(cfg, send, dirStats, rand = Math.random) {
  let lastRelease = 0;
  const fifo = [];
  let timer = null;
  function pump() {
    timer = null;
    const now = Date.now();
    while (fifo.length && fifo[0][0] <= now) {
      const [, d, b] = fifo.shift();
      send(d, b);
    }
    if (fifo.length) timer = setTimeout(pump, Math.max(1, fifo[0][0] - Date.now()));
  }
  return (data, isBinary) => {
    const now = Date.now();
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    dirStats.frames++;
    dirStats.bytes += size;
    let release = now + delaySample(cfg, rand);
    if (cfg.loss > 0 && rand() < cfg.loss) {
      release += RTO_MS + rand() * RTO_SLACK_MS;
      dirStats.lost++;
    }
    const spike = spikeHoldUntil(cfg, now);
    if (spike) release = Math.max(release, spike + cfg.latency);
    if (cfg.bw > 0) release = Math.max(release, lastRelease + (size * 8) / cfg.bw); // kbit/s = bits per ms
    release = Math.max(release, lastRelease); // TCP: no reordering
    lastRelease = release;
    fifo.push([release, data, isBinary]);
    if (!timer) timer = setTimeout(pump, Math.max(0, fifo[0][0] - now));
  };
}

/**
 * Datagram pipe: independent delay per datagram (reordering allowed), real
 * loss, bandwidth as a serialization queue (overflowing it drops, like a
 * router's tail drop).
 */
export function makeDatagramPipe(cfg, send, dirStats, rand = Math.random) {
  let busyUntil = 0;
  return (msg) => {
    const now = Date.now();
    dirStats.frames++;
    dirStats.bytes += msg.length;
    if (cfg.loss > 0 && rand() < cfg.loss) {
      dirStats.lost++;
      return;
    }
    let release = now + delaySample(cfg, rand);
    const spike = spikeHoldUntil(cfg, now);
    if (spike) release = Math.max(release, spike + cfg.latency);
    if (cfg.bw > 0) {
      const tx = (msg.length * 8) / cfg.bw;
      const start = Math.max(now, busyUntil);
      if (start - now > 500) {
        dirStats.lost++; // queue longer than 500 ms: tail drop
        return;
      }
      busyUntil = start + tx;
      release = Math.max(release, busyUntil + cfg.latency);
    }
    setTimeout(() => send(msg), Math.max(0, release - now));
  };
}

/** Start the proxies; returns { config, stats, close() }. */
export async function startProxy(opts) {
  const cfg = opts.config;
  const stats = newStats();
  const sockets = new Set();
  const closers = [];

  if (opts.listen) {
    const httpServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/config') {
        for (const [k, v] of url.searchParams) if (k in cfg) cfg[k] = parseFloat(v);
        res.end(JSON.stringify(cfg));
        if (!opts.quiet) console.log('[netsim] config', JSON.stringify(cfg));
      } else if (url.pathname === '/stats') {
        res.end(JSON.stringify(stats));
      } else if (url.pathname === '/kill') {
        for (const s of sockets) s.terminate();
        res.end(JSON.stringify({ killed: sockets.size }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'netsim proxy: /config /stats /kill, or upgrade to WebSocket' }));
      }
    });
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (client, req) => {
      stats.connections++;
      sockets.add(client);
      stats.open = sockets.size;
      const target = opts.target.replace(/\/$/, '') + (req.url ?? '');
      const upstream = new WebSocket(target);
      const pending = [];
      const toServer = makeOrderedPipe(cfg, (d, b) => upstream.readyState === WebSocket.OPEN && upstream.send(d, { binary: b }), stats.c2s);
      const toClient = makeOrderedPipe(cfg, (d, b) => client.readyState === WebSocket.OPEN && client.send(d, { binary: b }), stats.s2c);
      client.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) toServer(data, isBinary);
        else pending.push([data, isBinary]);
      });
      upstream.on('open', () => {
        for (const [d, b] of pending.splice(0)) toServer(d, b);
      });
      upstream.on('message', (data, isBinary) => toClient(isBinary ? data : data.toString(), isBinary));
      let dropTimer = null;
      if (cfg.dropAfter > 0) dropTimer = setTimeout(() => client.terminate(), cfg.dropAfter * 1000);
      let closing = false;
      const closeBoth = (code, reason) => {
        if (closing) return;
        closing = true;
        if (dropTimer) clearTimeout(dropTimer);
        sockets.delete(client);
        stats.open = sockets.size;
        // Delay the close by the link latency so it can't overtake queued
        // frames, and pass the close code through (kicks are 4000+code).
        const c = typeof code === 'number' && code >= 1000 && code !== 1005 && code !== 1006 ? code : 1000;
        const r = reason ? reason.toString().slice(0, 120) : '';
        setTimeout(() => {
          try {
            client.close(c, r);
          } catch {}
          try {
            upstream.close(c, r);
          } catch {}
        }, cfg.latency + 2 * cfg.jitter + 50);
      };
      client.on('close', (code, reason) => closeBoth(code, reason));
      upstream.on('close', (code, reason) => closeBoth(code, reason));
      client.on('error', () => {});
      upstream.on('error', () => closeBoth(1011, 'upstream error'));
    });
    await new Promise((resolve) => httpServer.listen(opts.listen, resolve));
    if (!opts.quiet) console.log(`[netsim] ws://localhost:${opts.listen} -> ${opts.target}`, JSON.stringify(cfg));
    closers.push(
      () =>
        new Promise((resolve) => {
          for (const s of sockets) s.terminate();
          wss.close();
          httpServer.close(() => resolve());
        }),
    );
  }

  if (opts.udpListen) {
    const [thost, tport] = splitHostPort(opts.udpTarget);
    // Dual-stack: browsers may resolve localhost to ::1 or 127.0.0.1.
    const front = dgram.createSocket({ type: 'udp6', ipv6Only: false });
    const clients = new Map(); // "addr:port" -> { sock, toServer, toClient, last }
    front.on('message', (msg, rinfo) => {
      const key = `${rinfo.address}:${rinfo.port}`;
      let c = clients.get(key);
      if (!c) {
        const sock = dgram.createSocket('udp4');
        sock.connect(tport, thost);
        c = {
          sock,
          last: Date.now(),
          toServer: makeDatagramPipe(cfg, (m) => {
            try {
              sock.send(m);
            } catch {}
          }, stats.c2s),
          toClient: makeDatagramPipe(cfg, (m) => front.send(m, rinfo.port, rinfo.address), stats.s2c),
        };
        sock.on('message', (m) => c.toClient(m));
        sock.on('error', () => {});
        clients.set(key, c);
        stats.udpClients = clients.size;
      }
      c.last = Date.now();
      c.toServer(msg);
    });
    // QUIC idles out after 30 s; forget relays silent for 60 s.
    const sweep = setInterval(() => {
      for (const [k, c] of clients) {
        if (Date.now() - c.last > 60000) {
          c.sock.close();
          clients.delete(k);
        }
      }
      stats.udpClients = clients.size;
    }, 10000);
    await new Promise((resolve) => front.bind(opts.udpListen, resolve));
    if (!opts.quiet) console.log(`[netsim] udp [::]:${opts.udpListen} -> ${opts.udpTarget} (QUIC / WebTransport)`);
    closers.push(async () => {
      clearInterval(sweep);
      for (const c of clients.values()) c.sock.close();
      front.close();
    });
  }

  return { config: cfg, stats, close: () => Promise.all(closers.map((f) => f())) };
}

function splitHostPort(s) {
  const i = s.lastIndexOf(':');
  return [s.slice(0, i) || '127.0.0.1', Number(s.slice(i + 1))];
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const arg = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : (process.env[`NETSIM_${name.toUpperCase().replace(/-/g, '_')}`] ?? def);
  };
  const config = resolveConfig(arg('profile', 'clean'), {
    latency: arg('latency'),
    jitter: arg('jitter'),
    loss: arg('loss'),
    bw: arg('bw'),
    spikeEvery: arg('spike-every'),
    spikeMs: arg('spike-ms'),
    dropAfter: arg('drop-after'),
  });
  const udpListen = arg('udp-listen');
  await startProxy({
    config,
    listen: arg('listen') ? Number(arg('listen')) : 8095,
    target: arg('target', 'ws://localhost:8092'),
    udpListen: udpListen ? Number(udpListen) : 0,
    udpTarget: arg('udp-target', '127.0.0.1:8092'),
  });
}
