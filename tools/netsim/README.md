# tools/netsim

Network impairment for playtests (spec 14) and the dense-crowd bandwidth
harness for decision 0005.

| File | What |
| --- | --- |
| `proxy.mjs` | WebSocket proxy with ordered pipes (port of wizard-wars `scripts/playtest/netsim-proxy.mjs`) plus a UDP relay that impairs WebTransport/QUIC as well. Live `/config`, `/stats`, `/kill`. |
| `profiles.mjs` | Named profiles |
| `dense-budget.mjs` | 150 WP03 bots inside a 40 m disc against a private zone (port 8097), with the per-client byte budget off and then on. Writes `docs/evidence/wp06-dense-budget-*` |
| `test/` | `node --test` (also `npm test -w @lodestone/netsim`) |

## Profiles

All values are one way. Each frame or datagram waits `latency + normal(0, jitter)` ms in each direction.

| Profile | latency | jitter (sd) | loss | bandwidth | From |
| --- | --- | --- | --- | --- | --- |
| `clean` | 0 | 0 | 0 | - | |
| `lan` | 1 | 0.5 | 0 | - | |
| `wifi` | 15 | 8 | 0.5% | - | |
| `thailand` | 80 | 20 | 3% | - | the-circle `netem.sh`: "delay 80ms 20ms distribution normal loss 3%", ~160 ms RTT |
| `mobile` | 125 | 40 | 6% | 1500 kbit/s | the-circle: "delay 125ms 40ms ... loss 6% rate 1500kbit" |
| `awful` | 150 | 60 | 8% | 1000 kbit/s | plus a 400 ms freeze every 6 s |

The two halves model loss differently, as the real transports behave:
- **WebSocket (TCP):** frames never reorder. A "lost" frame stalls itself and
  everything behind it for an RTO (200-300 ms), because that is what TCP
  retransmission does to a game stream.
- **UDP (QUIC/WebTransport):** a lost datagram is gone. Each datagram gets
  its own delay, so datagrams reorder. Bandwidth is a serialization queue
  with tail drop beyond 500 ms.

## Run

```
node tools/netsim/proxy.mjs --profile thailand --listen 8095 --target ws://localhost:8092 \
     --udp-listen 8096 --udp-target 127.0.0.1:8092
# then make the zone announce the proxy, so the director routes players through it:
LODESTONE_ZONE_PUBLIC_URL=ws://localhost:8095/ws LODESTONE_ZONE_WT_PUBLIC_URL=https://localhost:8096/wt go run ./server/zone
curl "http://localhost:8095/config?loss=0.06"     # live change
curl  http://localhost:8095/stats
```

Bots can go through it too: `go run ./tools/bots -url ws://localhost:8095/ws -n 20`.
The two-browser acceptance (`client/src/net/dev/acceptance.mjs`) starts the
proxy itself.

## Real netem (optional)

`proxy.mjs` impairs the game socket only, in user space. For packet-level
impairment of everything (handshakes, voice), the-circle's `e2e/netem.sh`
runs the clients inside a Linux container with `tc qdisc ... netem` on its
interfaces (Docker with `--cap-add=NET_ADMIN`). That works on Windows only
inside the Docker Desktop WSL2 VM and is not part of any WP06 check. Port it
here when a package needs packet-level fidelity (WP19 soak scenario 4).

## Dense-crowd budget measurement

```
node tools/netsim/dense-budget.mjs [--duration 40s] [--n 150] [--budgets 0,150]
```

Result on 2026-11-08 (Windows 11, 16 cores, zone and bots on one machine):

| Budget | Avg ↓ kbps | Max ↓ kbps | Players in view | Avg snapshot bytes | Tick p99 |
| --- | --- | --- | --- | --- | --- |
| off | 503 | 534 | 147 | 2060 | 4.9 ms |
| 150 kbps | 150.2 | 150.3 | 146 | 621 | 6.3 ms |
