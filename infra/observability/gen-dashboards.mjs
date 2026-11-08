#!/usr/bin/env node
// Generates the Grafana dashboards in ./grafana/dashboards (WP18). The JSON
// is committed (Grafana provisions it from disk); edit this file and re-run
// `node infra/observability/gen-dashboards.mjs` rather than hand-editing it.
//
// Design rules: one y-axis per panel (two measures of different scale get
// two panels), headline numbers as stat tiles, legends on every multi-series
// panel, Grafana's fixed classic palette (series keep their color), and
// budget lines from spec 9/12 drawn as thresholds so "within budget" is
// visible at a glance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DS = { type: 'prometheus', uid: 'lodestone-prom' };
let nextId = 1;

const envVar = {
  name: 'env',
  label: 'Environment',
  type: 'query',
  datasource: DS,
  query: { query: 'label_values(lodestone_build_info, env)', refId: 'env' },
  refresh: 2,
  current: {},
  includeAll: true,
  multi: false,
};

function ts(title, targets, { x, y, w = 12, h = 8, unit = 'short', thresholds = null, desc = '', min = 0, stack = false } = {}) {
  return {
    id: nextId++,
    type: 'timeseries',
    title,
    description: desc,
    datasource: DS,
    gridPos: { x, y, w, h },
    targets: targets.map(([expr, legend], i) => ({ refId: String.fromCharCode(65 + i), datasource: DS, expr, legendFormat: legend })),
    fieldConfig: {
      defaults: {
        unit,
        min,
        color: { mode: 'palette-classic' },
        custom: {
          lineWidth: 2,
          fillOpacity: stack ? 30 : 0,
          showPoints: 'never',
          spanNulls: true,
          stacking: { mode: stack ? 'normal' : 'none' },
          axisSoftMin: 0,
          ...(thresholds ? { thresholdsStyle: { mode: 'line+area' } } : {}),
        },
        thresholds: thresholds ?? { mode: 'absolute', steps: [{ color: 'transparent', value: null }] },
      },
      overrides: [],
    },
    options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'desc' } },
  };
}

function stat(title, expr, { x, y, w = 4, h = 4, unit = 'short', thresholds = null, desc = '', decimals = null, reduce = 'lastNotNull' } = {}) {
  return {
    id: nextId++,
    type: 'stat',
    title,
    description: desc,
    datasource: DS,
    gridPos: { x, y, w, h },
    targets: [{ refId: 'A', datasource: DS, expr, instant: false }],
    fieldConfig: {
      defaults: {
        unit,
        ...(decimals !== null ? { decimals } : {}),
        color: { mode: thresholds ? 'thresholds' : 'fixed', fixedColor: 'text' },
        thresholds: thresholds ?? { mode: 'absolute', steps: [{ color: 'text', value: null }] },
      },
      overrides: [],
    },
    options: { reduceOptions: { calcs: [reduce], fields: '', values: false }, colorMode: thresholds ? 'value' : 'none', graphMode: 'area', textMode: 'value_and_name', justifyMode: 'auto' },
  };
}

const budget = (value) => ({ mode: 'absolute', steps: [{ color: 'transparent', value: null }, { color: 'red', value }] });
const traffic = (warn, bad) => ({ mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: warn }, { color: 'red', value: bad }] });
const row = (title, y) => ({ id: nextId++, type: 'row', title, gridPos: { x: 0, y, w: 24, h: 1 }, collapsed: false, panels: [] });
const E = 'env=~"$env"';

function overview() {
  nextId = 1;
  const p = [];
  let y = 0;
  p.push(stat('Players online', `sum(zone_players{${E}})`, { x: 0, y, desc: 'zone_players summed over zones' }));
  p.push(stat('Zone tick p99', `max(zone_tick_ms{${E},q="p99"})`, { x: 4, y, unit: 'ms', decimals: 2, thresholds: traffic(16, 33), desc: 'Last 60 s window. Tick period is 33.3 ms (30 Hz); spec 9 wants p99 well inside it.' }));
  p.push(stat('Downlink p99 / client', `max(zone_client_down_kbps{${E},q="p99"})`, { x: 8, y, unit: 'Kbits', thresholds: traffic(128, 160), desc: 'Spec 9 downlink budget 160 kbps per client (byte budget 150).' }));
  p.push(stat('Write-behind depth', `sum(zone_writebehind_depth{${E}})`, { x: 12, y, thresholds: traffic(1000, 8000), desc: 'Persistence ops waiting; LODESTONE_WRITEBEHIND_MAX is 10000.' }));
  p.push(stat('Social sessions', `sum(social_sessions{${E}})`, { x: 16, y }));
  p.push(stat('Services up', `sum(up{${E}})`, { x: 20, y, desc: 'Scrape targets answering /metrics.' }));
  y += 4;

  p.push(row('Zone simulation', y++));
  p.push(ts('Tick time', [[`zone_tick_ms{${E},q="p50"}`, 'p50 {{env}}'], [`zone_tick_ms{${E},q="p99"}`, 'p99 {{env}}'], [`zone_tick_ms{${E},q="max"}`, 'max {{env}}']], { x: 0, y, unit: 'ms', thresholds: budget(33.3), desc: 'Red line: one 30 Hz tick period.' }));
  p.push(ts('Tick jitter', [[`zone_tick_jitter_ms{${E},q="p99"}`, 'p99 {{env}}'], [`zone_tick_jitter_ms{${E},q="max"}`, 'max {{env}}']], { x: 12, y, unit: 'ms', desc: '|spacing - 33.33 ms| (gameloop spin tail, LODESTONE_SPIN_MS).' }));
  y += 8;
  p.push(ts('Players', [[`zone_players{${E}}`, '{{env}} {{instance}}'], [`sum by (env, transport) (zone_sessions{${E}})`, '{{transport}} {{env}}']], { x: 0, y, desc: 'Connected players and sessions per transport.' }));
  p.push(ts('Interest (AOI) set size per client', [[`zone_aoi_entities_avg{${E}}`, '{{ring}} avg {{env}}'], [`zone_aoi_entities_max{${E}}`, 'max {{env}}']], { x: 12, y, desc: 'Entities in each ring (near/mid/far/party), last second.' }));
  y += 8;

  p.push(row('Bandwidth (the real cost, spec 13)', y++));
  p.push(ts('Downlink per client', [[`zone_client_down_kbps{${E},q="avg"}`, 'avg {{env}}'], [`zone_client_down_kbps{${E},q="p99"}`, 'p99 {{env}}'], [`zone_client_down_kbps{${E},q="max"}`, 'max {{env}}']], { x: 0, y, unit: 'Kbits', thresholds: budget(160), desc: 'Red line: 160 kbps budget (spec 9).' }));
  p.push(ts('Uplink per client', [[`zone_client_up_kbps{${E},q="avg"}`, 'avg {{env}}'], [`zone_client_up_kbps{${E},q="max"}`, 'max {{env}}']], { x: 12, y, unit: 'Kbits', thresholds: budget(24), desc: 'Red line: 24 kbps budget (spec 9).' }));
  y += 8;
  p.push(ts('Zone egress (all clients)', [[`sum by (env) (rate(zone_bytes_out_total{${E}}[1m])) * 8`, 'out {{env}}']], { x: 0, y, unit: 'bps', desc: 'rate(zone_bytes_out_total): what the VM egress bill is made of.' }));
  p.push(ts('Zone ingress (all clients)', [[`sum by (env) (rate(zone_bytes_in_total{${E}}[1m])) * 8`, 'in {{env}}']], { x: 12, y, unit: 'bps' }));
  y += 8;

  p.push(row('Persistence and terrain', y++));
  p.push(ts('Write-behind queue depth', [[`zone_writebehind_depth{${E}}`, 'depth {{env}}']], { x: 0, y, desc: 'Checkpoints and progress writes waiting for Postgres.' }));
  p.push(ts('Write-behind outcomes', [[`rate(zone_writebehind_done_total{${E}}[1m])`, 'done/s {{env}}'], [`rate(zone_writebehind_retries_total{${E}}[1m])`, 'retries/s {{env}}'], [`rate(zone_writebehind_failed_total{${E}}[1m])`, 'failed/s {{env}}']], { x: 12, y, unit: 'ops' }));
  y += 8;
  p.push(ts('Terrain chunk cache', [[`zone_terrain_chunks{${E}}`, 'cached {{env}}'], [`zone_terrain_pending{${E}}`, 'pending {{env}}']], { x: 0, y }));
  p.push(ts('Chunk generation time', [[`zone_terrain_gen_ms_mean{${E}}`, 'mean {{env}}'], [`zone_terrain_gen_ms_max{${E}}`, 'max {{env}}']], { x: 12, y, unit: 'ms', thresholds: budget(8), desc: 'Red line: 8 ms per chunk (spec 12, browser worker budget; the server shares the generator).' }));
  y += 8;

  p.push(row('Services', y++));
  p.push(ts('HTTP requests by status', [[`sum by (job, code) (rate(http_requests_total{${E}}[1m]))`, '{{job}} {{code}}']], { x: 0, y, unit: 'reqps', desc: 'Plain HTTP endpoints (sign-in, tickets, mints); WebSockets excluded.' }));
  p.push(ts('HTTP latency p95', [[`histogram_quantile(0.95, sum by (job, le) (rate(http_request_duration_seconds_bucket{${E}}[5m])))`, '{{job}}']], { x: 12, y, unit: 's' }));
  y += 8;
  p.push(ts('Director: tickets and waking', [[`sum by (kind) (rate(director_tickets_issued_total{${E}}[5m]))`, 'tickets {{kind}}'], [`rate(director_waking_total{${E}}[5m])`, 'waking_world answers'], [`rate(director_wake_starts_total{${E}}[5m])`, 'VM starts']], { x: 0, y, unit: 'reqps' }));
  p.push(ts('Chat', [[`rate(social_chat_accepted_total{${E}}[1m])`, 'accepted {{env}}'], [`rate(social_chat_rejected_total{${E}}[1m])`, 'rejected {{env}}']], { x: 12, y, unit: 'reqps' }));
  y += 8;
  p.push(ts('Goroutines', [[`go_goroutines{${E}}`, '{{job}} {{env}}']], { x: 0, y }));
  p.push(ts('Heap', [[`go_heap_bytes{${E}}`, '{{job}} {{env}}']], { x: 12, y, unit: 'bytes' }));

  return {
    uid: 'lodestone-overview',
    title: 'Lodestone overview',
    tags: ['lodestone'],
    timezone: 'browser',
    schemaVersion: 39,
    version: 1,
    refresh: '10s',
    time: { from: 'now-30m', to: 'now' },
    templating: { list: [envVar] },
    panels: p,
  };
}

// Spec 13 rule 6 "know the number": monthly cost / peak concurrent players.
// The cost is not a metric any service can export; it is a dashboard
// variable (WP19 fills it from the billing report, see infra/cost/README.md).
function cost() {
  nextId = 1;
  const p = [];
  p.push({
    id: nextId++,
    type: 'text',
    title: 'How to read this',
    gridPos: { x: 0, y: 0, w: 24, h: 4 },
    options: {
      mode: 'markdown',
      content:
        'Spec 13: *a small dashboard tracks monthly cost divided by peak concurrent players*. Set **monthly_cost_usd** (top) from the billing report for the month (Billing > Reports, filter the project; infra/cost/README.md has the line items). Peak CCU comes from `max_over_time(sum(zone_players)[30d])`. WP19 records the number in docs/decisions/v1-capacity.md.',
    },
  });
  p.push(stat('Monthly cost (input)', 'vector($monthly_cost_usd)', { x: 0, y: 4, w: 6, unit: 'currencyUSD', decimals: 2 }));
  p.push(stat('Peak CCU (30 d)', `max_over_time(sum(zone_players{${E}})[30d:1m])`, { x: 6, y: 4, w: 6, decimals: 0 }));
  p.push(stat('Cost per peak player', `vector($monthly_cost_usd) / clamp_min(max_over_time(sum(zone_players{${E}})[30d:1m]), 1)`, { x: 12, y: 4, w: 6, unit: 'currencyUSD', decimals: 2, desc: 'monthly cost / max(1, peak CCU)' }));
  p.push(stat('VM awake (30 d)', `sum(count_over_time(up{job="zone",${E}}[30d:5m])) * 5 / 60`, { x: 18, y: 4, w: 6, unit: 'h', decimals: 1, desc: 'Hours the zone answered scrapes: the VM is billed only while awake (wake on demand).' }));
  p.push(ts('Concurrent players', [[`sum(zone_players{${E}})`, 'players']], { x: 0, y: 8, w: 12 }));
  p.push(ts('Zone egress per player', [[`sum(rate(zone_bytes_out_total{${E}}[5m])) * 8 / clamp_min(sum(zone_players{${E}}), 1)`, 'egress per player']], { x: 12, y: 8, w: 12, unit: 'bps', desc: 'Bandwidth is the real cost (spec 13 rule 4).' }));
  return {
    uid: 'lodestone-cost',
    title: 'Lodestone cost per player',
    tags: ['lodestone'],
    timezone: 'browser',
    schemaVersion: 39,
    version: 1,
    refresh: '1m',
    time: { from: 'now-7d', to: 'now' },
    templating: {
      list: [
        envVar,
        { name: 'monthly_cost_usd', label: 'Monthly cost (USD)', type: 'textbox', query: '0', current: { text: '0', value: '0' } },
      ],
    },
    panels: p,
  };
}

const outDir = path.join(here, 'grafana', 'dashboards');
fs.mkdirSync(outDir, { recursive: true });
for (const d of [overview(), cost()]) {
  const f = path.join(outDir, `${d.uid}.json`);
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), f)} (${d.panels.length} panels)`);
}
