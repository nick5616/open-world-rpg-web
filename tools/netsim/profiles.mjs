// Named network profiles (spec 14). One-way values: every frame or datagram
// is delayed by latency + normal(0, jitter) ms in each direction, so RTT is
// about 2 x latency. Values follow the-circle e2e/netem.sh:
//   thailand: "delay 80ms 20ms distribution normal loss 3%"  (~160 ms RTT)
//   mobile:   "delay 125ms 40ms distribution normal loss 6% rate 1500kbit"
// plus a few extra for quick checks.
export const PROFILES = {
  clean: { latency: 0, jitter: 0, loss: 0, bw: 0, spikeEvery: 0, spikeMs: 0 },
  lan: { latency: 1, jitter: 0.5, loss: 0, bw: 0, spikeEvery: 0, spikeMs: 0 },
  wifi: { latency: 15, jitter: 8, loss: 0.005, bw: 0, spikeEvery: 0, spikeMs: 0 },
  thailand: { latency: 80, jitter: 20, loss: 0.03, bw: 0, spikeEvery: 0, spikeMs: 0 },
  mobile: { latency: 125, jitter: 40, loss: 0.06, bw: 1500, spikeEvery: 0, spikeMs: 0 },
  awful: { latency: 150, jitter: 60, loss: 0.08, bw: 1000, spikeEvery: 6, spikeMs: 400 },
};

/** Normal(0, 1) via Box-Muller. */
export function gauss(rand = Math.random) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** One-way delay sample (ms, never negative). */
export function delaySample(cfg, rand = Math.random) {
  return Math.max(0, cfg.latency + (cfg.jitter ? gauss(rand) * cfg.jitter : 0));
}

/** If a periodic link freeze (wifi hiccup) is on at `now`, the time it ends; else 0. */
export function spikeHoldUntil(cfg, now) {
  if (!cfg.spikeEvery || !cfg.spikeMs) return 0;
  const period = cfg.spikeEvery * 1000;
  const phase = now % period;
  return phase < cfg.spikeMs ? now - phase + cfg.spikeMs : 0;
}

/** Resolve --profile plus explicit overrides into a config object. */
export function resolveConfig(profile, overrides = {}) {
  const base = PROFILES[profile];
  if (!base) throw new Error(`unknown profile "${profile}" (have: ${Object.keys(PROFILES).join(', ')})`);
  const cfg = { ...base, dropAfter: 0 };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && k in cfg) cfg[k] = Number(v);
  return cfg;
}
