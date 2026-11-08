// The creator page. State is one editable WorldSpec plus where it came
// from. The default path is "from seed": the spec is exactly
// spec_from_seed(seed) and minting sends only the seed. Any edit (slider,
// preset, name, vibe) makes it a creator spec: it is normalized here (the
// same rules as the Go endpoint, shared fixtures prove it) before preview,
// and normalized again by the endpoint before minting, so the preview's atlas
// hash is the minted world's atlas hash.
import { LOOTTHEME_VALUES, LOOT_THEMES_MAX, NAMEGRAMMAR_VALUES, PALETTE_VALUES, type WorldSpec } from '@lodestone/contracts';
import { api, ApiError, setToken, type CreatorConfig, type World } from './api';
import { GROUPS, getField, setField, type SliderField } from './spec/fields';
import { normalize, type Change, type NormalizeResult } from './spec/normalize';
import { PRESETS, applyPreset } from './spec/presets';
import { BIOME_RGB, SITE_STYLE, type PreviewStats } from './preview/render';
import type { FromWorker, ToWorker } from './preview/protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type Source = 'seed' | 'preset' | 'sliders' | 'vibe';
const state = {
  spec: null as WorldSpec | null,
  source: 'seed' as Source,
  presetId: '' as string,
  normalized: null as NormalizeResult | null,
  previewHash: '',
  previewSpecJSON: '',
  config: null as CreatorConfig | null,
};

// ---------- worker ----------
const worker = new Worker(new URL('./preview/worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
let latestPreview = 0;
const specWaiters = new Map<number, (s: WorldSpec) => void>();
const send = (m: ToWorker) => worker.postMessage(m);

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  if (m.type === 'ready') {
    loadFromSeed($<HTMLInputElement>('seed').value);
  } else if (m.type === 'spec') {
    specWaiters.get(m.id)?.(m.spec);
    specWaiters.delete(m.id);
  } else if (m.type === 'preview') {
    if (m.id !== latestPreview) {
      m.bitmap.close(); // superseded while it was building
      return;
    }
    $<HTMLCanvasElement>('map').getContext('2d')!.drawImage(m.bitmap, 0, 0);
    m.bitmap.close();
    state.previewHash = m.stats.atlasHash;
    renderStats(m.stats);
    document.body.dataset.busy = '0';
    document.body.dataset.previewHash = m.stats.atlasHash;
    document.body.dataset.ready = '1';
    updateMintButton();
  } else if (m.type === 'error') {
    document.body.dataset.busy = '0';
    $('validation').innerHTML = `<div class="notice bad">${esc(m.message)}</div>`;
  }
};

function specFromSeed(seed: string): Promise<WorldSpec> {
  const id = nextId++;
  return new Promise((resolve) => {
    specWaiters.set(id, resolve);
    send({ type: 'fromSeed', id, seed });
  });
}

// ---------- seed handling ----------
function parseSeed(s: string): string | null {
  const t = s.trim();
  if (!/^[0-9]{1,20}$/.test(t)) return null;
  const n = BigInt(t);
  return n <= (1n << 64n) - 1n ? n.toString() : null;
}

function randomSeed(): string {
  const a = new BigUint64Array(1);
  crypto.getRandomValues(a);
  return a[0].toString();
}

async function loadFromSeed(raw: string) {
  const seed = parseSeed(raw);
  if (!seed) {
    $('validation').innerHTML = `<div class="notice bad">Seed must be a whole number from 0 to 18446744073709551615.</div>`;
    return;
  }
  $<HTMLInputElement>('seed').value = seed;
  state.spec = await specFromSeed(seed);
  state.source = 'seed';
  state.presetId = '';
  syncControls();
  schedulePreview(0);
}

function markEdited(source: Source) {
  // A slider touch after a preset or vibe keeps that label (it is still
  // "the Highland preset, adjusted"); after a seed it becomes "sliders".
  if (source !== 'sliders' || state.source === 'seed') state.source = source;
  if (source !== 'preset') state.presetId = state.source === 'preset' ? state.presetId : '';
  renderMode();
  schedulePreview();
}

// ---------- controls ----------
const sliders = new Map<string, { input: HTMLInputElement; out: HTMLOutputElement; share?: HTMLElement; f: SliderField }>();

function fmt(f: SliderField, v: number) {
  return f.integer || f.step >= 1 ? String(Math.round(v)) : v.toFixed(2);
}

function buildControls() {
  const groups = $('groups');
  for (const g of GROUPS) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h2>${g.title}${g.weights ? '<span class="muted" style="text-transform:none;letter-spacing:0">share</span>' : ''}</h2>`;
    for (const f of g.fields) {
      const row = document.createElement('label');
      row.className = 'row';
      row.title = f.hint ?? `${f.key}: ${f.min} to ${f.max}`;
      row.innerHTML = `<span class="name">${f.label}</span><input type="range" min="${f.min}" max="${f.max}" step="${f.step}" data-key="${f.key}"><output></output>`;
      const input = row.querySelector('input')!;
      const out = row.querySelector('output')!;
      let share: HTMLElement | undefined;
      if (g.weights) {
        share = document.createElement('span');
        share.className = 'share';
        out.after(share);
        row.style.gridTemplateColumns = '112px 1fr 40px 34px';
      }
      input.addEventListener('input', () => {
        if (!state.spec) return;
        setField(state.spec, f.key, Number(input.value));
        out.textContent = fmt(f, Number(input.value));
        if (g.weights) updateShares();
        markEdited('sliders');
      });
      sliders.set(f.key, { input, out, share, f });
      card.appendChild(row);
    }
    groups.appendChild(card);
  }

  const presets = $('presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.dataset.preset = p.id;
    b.innerHTML = `${p.label}<small>${p.blurb}</small>`;
    b.onclick = () => {
      if (!state.spec) return;
      state.spec = applyPreset(state.spec, p);
      state.source = 'preset';
      state.presetId = p.id;
      syncControls();
      markEdited('preset');
    };
    presets.appendChild(b);
  }

  const fill = (sel: HTMLSelectElement, values: readonly string[]) => (sel.innerHTML = values.map((v) => `<option value="${v}">${v}</option>`).join(''));
  fill($<HTMLSelectElement>('palette'), PALETTE_VALUES);
  fill($<HTMLSelectElement>('grammar'), NAMEGRAMMAR_VALUES);
  $<HTMLSelectElement>('palette').onchange = (e) => {
    state.spec!.palette = (e.target as HTMLSelectElement).value as WorldSpec['palette'];
    markEdited('sliders');
  };
  $<HTMLSelectElement>('grammar').onchange = (e) => {
    state.spec!.nameGrammar = (e.target as HTMLSelectElement).value as WorldSpec['nameGrammar'];
    markEdited('sliders');
  };
  $('loot').innerHTML = LOOTTHEME_VALUES.map((t) => `<label data-tag="${t}"><input type="checkbox" value="${t}">${t}</label>`).join('');
  $('loot').addEventListener('change', (e) => {
    const box = e.target as HTMLInputElement;
    const themes = new Set(state.spec!.lootThemes);
    if (box.checked) {
      if (themes.size >= LOOT_THEMES_MAX) {
        box.checked = false; // the 4-tag cap is enforced in the UI too
        return;
      }
      themes.add(box.value as WorldSpec['lootThemes'][number]);
    } else themes.delete(box.value as WorldSpec['lootThemes'][number]);
    state.spec!.lootThemes = LOOTTHEME_VALUES.filter((t) => themes.has(t));
    syncLoot();
    markEdited('sliders');
  });

  $<HTMLInputElement>('name').addEventListener('input', (e) => {
    if (!state.spec) return;
    state.spec.name = (e.target as HTMLInputElement).value;
    markEdited('sliders');
  });
  $<HTMLInputElement>('seed').addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value;
    if (state.source === 'seed') loadFromSeed(v);
    else if (state.spec) {
      state.spec.seed = v.trim();
      schedulePreview();
    }
  });
  $('random').onclick = () => {
    const s = randomSeed();
    $<HTMLInputElement>('seed').value = s;
    if (state.source === 'seed' || !state.spec) loadFromSeed(s);
    else {
      state.spec.seed = s;
      schedulePreview(0);
    }
  };
  $('fromseed').onclick = () => loadFromSeed($<HTMLInputElement>('seed').value);
  $('vibego').onclick = runVibe;
  $('mint').onclick = runMint;
  $('refresh').onclick = refreshWorlds;

  const legendSites = Object.entries(SITE_STYLE).filter(([k]) => ['tower', 'settlement', 'cave_mouth', 'waypoint', 'landmark', 'enemy_camp', 'ruin'].includes(k));
  $('legend').innerHTML =
    ['meadow', 'forest', 'highlands', 'snowpeak', 'badlands', 'wetland'].map((b, i) => `<span><i class="sw" style="background:rgb(${BIOME_RGB[i].join(',')})"></i>${b}</span>`).join('') +
    legendSites.map(([, v]) => `<span><i class="sw" style="background:${v.color}"></i>${v.label}</span>`).join('') +
    `<span><i class="sw" style="background:#3d8fd6"></i>river</span><span><i class="sw" style="border:2px solid #00ff88;background:none"></i>spawn</span>`;
}

function updateShares() {
  if (!state.spec) return;
  for (const g of GROUPS.filter((x) => x.weights)) {
    const total = g.fields.reduce((a, f) => a + getField(state.spec!, f.key), 0);
    for (const f of g.fields) {
      const s = sliders.get(f.key)!;
      s.share!.textContent = total > 0 ? `${Math.round((100 * getField(state.spec, f.key)) / total)}%` : '–';
    }
  }
}

function syncLoot() {
  const on = new Set(state.spec?.lootThemes ?? []);
  for (const l of $('loot').querySelectorAll('label')) {
    const tag = l.dataset.tag!;
    l.classList.toggle('on', on.has(tag as WorldSpec['lootThemes'][number]));
    l.querySelector('input')!.checked = on.has(tag as WorldSpec['lootThemes'][number]);
  }
}

/** Push the state's spec into every control (after seed, preset or vibe). */
function syncControls() {
  const s = state.spec;
  if (!s) return;
  for (const { input, out, f } of sliders.values()) {
    const v = getField(s, f.key);
    input.value = String(v);
    out.textContent = fmt(f, v);
  }
  updateShares();
  $<HTMLInputElement>('name').value = s.name;
  $<HTMLInputElement>('seed').value = s.seed;
  $<HTMLSelectElement>('palette').value = s.palette;
  $<HTMLSelectElement>('grammar').value = s.nameGrammar;
  syncLoot();
  renderMode();
}

function renderMode() {
  const m = $('mode');
  const preset = PRESETS.find((p) => p.id === state.presetId);
  m.className = `badge ${state.source === 'seed' ? 'seed' : 'edited'}`;
  m.textContent = state.source === 'seed' ? 'seed only' : state.source === 'preset' ? `preset: ${preset?.label ?? '?'}` : state.source === 'vibe' ? 'from vibe' : 'edited';
  for (const b of $('presets').querySelectorAll('button')) b.classList.toggle('active', b.dataset.preset === state.presetId);
  $('mintsrc').textContent = state.source === 'seed' ? 'sends only the seed: spec_from_seed' : `sends the normalized spec (source: ${state.source})`;
}

// ---------- preview ----------
let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced: dragging a slider previews ~5 times a second at most. */
function schedulePreview(delay = 200) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!state.spec) return;
    let spec: WorldSpec;
    if (state.source === 'seed') {
      state.normalized = null;
      spec = state.spec;
      $('validation').innerHTML = `<div class="notice ok">Seed only: the world is spec_from_seed(${esc(state.spec.seed)}), minted untouched.</div>`;
    } else {
      state.normalized = normalize(state.spec);
      renderValidation(state.normalized);
      if (!state.normalized.ok) {
        updateMintButton();
        return;
      }
      spec = state.normalized.spec;
    }
    const json = JSON.stringify(spec);
    if (json === state.previewSpecJSON && state.previewHash) return; // nothing changed (e.g. a no-op slider event)
    state.previewSpecJSON = json;
    state.previewHash = '';
    $('mintlog').innerHTML = ''; // the last mint result described a different spec
    latestPreview = nextId++;
    document.body.dataset.busy = '1';
    updateMintButton();
    send({ type: 'preview', id: latestPreview, spec });
  }, delay);
}

function summarizeChanges(changes: Change[]): string[] {
  const out: string[] = [];
  const renorm = new Set<string>();
  for (const c of changes) {
    if (c.reason === 'renormalized') {
      renorm.add(c.path.split('.')[0]);
      continue;
    }
    const v = (x: unknown) => (typeof x === 'number' ? String(Math.round(x * 1000) / 1000) : JSON.stringify(x));
    if (c.reason.startsWith('dropped')) out.push(`lootThemes: ${c.reason.replace('dropped-', 'dropped ').replace(/-/g, ' ')} ${v(c.from)}`);
    else out.push(`${c.path} ${c.reason} ${v(c.from)} → ${v(c.to)}`);
  }
  for (const g of renorm) out.push(`${g} renormalized (strongest = 1, as the generator reads them)`);
  return out;
}

function renderValidation(r: NormalizeResult) {
  if (!r.ok) {
    $('validation').innerHTML = `<div class="notice bad"><b>Not mintable:</b><ul id="changes">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    return;
  }
  const lines = summarizeChanges(r.changes);
  $('validation').innerHTML = lines.length
    ? `<div class="notice">Clamped before preview and mint:<ul id="changes">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`
    : `<div class="notice ok">Spec is valid as is.</div>`;
}

function renderStats(s: PreviewStats) {
  const counts = s.counts.map(([k, v]) => `<tr><td>&nbsp;&nbsp;${esc(k)}</td><td class="n">${v}</td></tr>`).join('');
  const biomes = s.biomes
    .map((b, i) => `<tr><td><i class="sw" style="background:rgb(${BIOME_RGB[i].join(',')})"></i>${b.name}</td><td style="width:45%"><div class="bar"><i style="width:${b.pct.toFixed(1)}%;background:rgb(${BIOME_RGB[i].join(',')})"></i></div></td><td class="n">${b.pct.toFixed(0)}%</td></tr>`)
    .join('');
  $('stats').innerHTML = `<h2>Preview <span class="mono" id="previewhash" title="atlasHash">${s.atlasHash}</span></h2>
    <div style="font-size:15px;font-weight:600;margin-bottom:4px" id="previewname">${esc(s.name)}</div>
    <table>
      <tr><td>seed</td><td class="n mono">${esc(s.seed)}</td></tr>
      <tr><td>atlas</td><td class="n">${(s.bytes / 1024).toFixed(0)} KiB · ${s.atlasMs.toFixed(0)} ms in the worker</td></tr>
      <tr><td>land / sea level / peak</td><td class="n">${(s.landFraction * 100).toFixed(0)}% · ${s.seaY.toFixed(0)} m · ${s.peak.toFixed(0)} m</td></tr>
      <tr><td>POI visible within 800 m</td><td class="n">${(s.coverage800 * 100).toFixed(1)}% of land</td></tr>
      <tr><td>sites</td><td class="n">${s.sites}</td></tr>
      ${counts}
    </table>
    <table style="margin-top:6px">${biomes}</table>`;
  $('regions').innerHTML = `<table>${s.regions
    .map((r, i) => `<tr><td class="muted">${i}</td><td>${esc(r.name)}<br><span class="muted">${r.biome} · ${r.element}/${r.element2} · ${r.settlements} settl.</span></td><td class="n">danger ${r.danger.toFixed(2)}</td></tr>`)
    .join('')}</table>`;
}

// ---------- mint / vibe / worlds ----------
function updateMintButton() {
  const ok = !!state.spec && !!state.previewHash && (state.source === 'seed' || (state.normalized?.ok ?? false));
  $<HTMLButtonElement>('mint').disabled = !ok;
}

async function runMint() {
  if (!state.spec) return;
  const btn = $<HTMLButtonElement>('mint');
  btn.disabled = true;
  const log = $('mintlog');
  log.innerHTML = `<div class="notice">Minting… (the server rebuilds the atlas with the same wasm)</div>`;
  const previewHash = state.previewHash;
  try {
    const r =
      state.source === 'seed' ? await api.mintSeed(state.spec.seed) : await api.mintSpec((state.normalized as Extract<NormalizeResult, { ok: true }>).spec, state.source);
    const same = r.world.atlasHash === previewHash;
    log.innerHTML = `<div class="notice ${same ? 'ok' : 'bad'}" id="mintresult" data-world-id="${r.world.id}" data-atlas-hash="${r.world.atlasHash}" data-matches-preview="${same}">
      <b>${r.existed ? 'Already minted' : 'Minted'}</b> “${esc(r.world.name)}” (${esc(r.source)})<br>
      <span class="mono">id ${r.world.id}</span><br>
      seed <span class="mono">${esc(r.world.seed)}</span> · genVersion ${esc(r.world.genVersion)} · atlasHash <span class="mono">${r.world.atlasHash}</span><br>
      ${same ? 'Server atlas hash matches the browser preview.' : `Server atlas hash differs from the preview (${previewHash})!`} Server atlas ${r.atlas.buildMs} ms, ${r.atlas.sites} sites.
    </div>`;
    refreshWorlds();
  } catch (e) {
    const err = e as ApiError;
    log.innerHTML = `<div class="notice bad">Mint failed: ${esc(err.message)}${err.details?.length ? `<ul>${err.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>`;
  } finally {
    updateMintButton();
  }
}

async function runVibe() {
  const prompt = $<HTMLTextAreaElement>('vibe').value.trim();
  const notice = $('vibenotice');
  if (!prompt) return;
  $<HTMLButtonElement>('vibego').disabled = true;
  $('vibestatus').textContent = 'asking the model…';
  try {
    const r = await api.vibe(prompt, $<HTMLInputElement>('seed').value);
    state.spec = r.spec;
    state.source = 'vibe';
    state.presetId = '';
    syncControls();
    schedulePreview(0);
    const lines = summarizeChanges(r.changes);
    notice.innerHTML = `<div class="notice ok" id="vibeok">${r.cached ? 'From cache' : `From ${esc(r.model)} (${r.attempts} call${r.attempts > 1 ? 's' : ''})`}: the sliders now show the result; adjust anything before minting.${
      lines.length ? `<ul id="changes">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''
    }</div>`;
  } catch (e) {
    const err = e as ApiError;
    // Fallback (spec 6): flag off or a failed call leaves the sliders as they were.
    const why = err.code === 'llm_disabled' ? 'Vibe text is turned off on this server.' : err.code === 'llm_failed' ? 'The model did not produce a valid world.' : err.message;
    notice.innerHTML = `<div class="notice" id="vibefallback">${esc(why)} Use the presets and sliders instead; nothing was changed.</div>`;
  } finally {
    $('vibestatus').textContent = '';
    $<HTMLButtonElement>('vibego').disabled = !state.config?.llm;
  }
}

async function refreshWorlds() {
  try {
    const { worlds } = await api.worlds();
    $('worlds').innerHTML = worlds.length
      ? `<table>${worlds
          .map((w: World) => `<tr><td>${esc(w.name)}${w.official ? ' <span class="badge">official</span>' : ''}<br><span class="muted mono">seed ${esc(w.seed)} · ${w.atlasHash}</span></td><td class="n muted">${new Date(w.createdAt).toLocaleString()}</td></tr>`)
          .join('')}</table>`
      : 'none yet';
  } catch (e) {
    $('worlds').textContent = (e as Error).message;
  }
}

async function loadConfig() {
  try {
    const c = await api.config();
    state.config = c;
    $('server').textContent = `server: genVersion ${c.genVersion} · wasm ${c.wasmSha256.slice(0, 12)} · vibe ${c.llm ? `on (${c.model})` : 'off'}`;
    $('vibebadge').textContent = c.llm ? 'on' : 'off';
    $<HTMLButtonElement>('vibego').disabled = !c.llm;
    if (!c.llm) $('vibenotice').innerHTML = `<div class="notice" id="vibeoff">Vibe text is off on this server (LODESTONE_CREATOR_LLM unset). Presets and sliders do everything.</div>`;
    document.body.dataset.server = '1';
  } catch (e) {
    $('server').textContent = `server unreachable: ${(e as Error).message}. Preview still works; minting needs the server.`;
    $<HTMLButtonElement>('vibego').disabled = true;
  }
}

const params = new URLSearchParams(location.search);
if (params.get('token')) setToken(params.get('token')!);
$<HTMLInputElement>('seed').value = parseSeed(params.get('seed') ?? '') ?? randomSeed();
buildControls();
loadConfig();
refreshWorlds();
