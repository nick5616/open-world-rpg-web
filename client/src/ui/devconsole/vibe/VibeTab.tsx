// Playtest 2 vibe explorer (docs/cr/036-vibe-explorer.md): the dev
// console's Vibe tab. Nicole: "i wanna build a local dev thing where I can
// teleport to a new chunk with specified params like what is in that chunk
// like landmarks, what level it is, and the biome. I want to assess vibe and
// difficulty. also let me change my level too. this will be used to compose
// new music."
//
// Left: find and teleport (the zone searches the world exactly: Event
// 1403), set the vibe (area level, typical enemies, your level, time,
// weather, demons, a world event, freeze). Right: the composer's column
// (audio/composer): now playing and why, overrides, buses, loop, your own
// audio files and the mappings that wire them to a vibe. Loaded lazily (the
// composer's code downloads when this tab first opens).

import { LAYER_TAGS } from '../../../audio/bridge';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { BORDER, BTN_BG, CARD_BG, GOLD, GREEN, RED, SLOT_BG, TEXT, TEXT_2, TEXT_3 } from '../../spellcards/theme';
import { WEATHER, WORLD_EVENTS } from '../catalog';
import { DEV_ACT, send, teleportSend } from '../events';
import { devLog, sendDev, useDev } from '../store';
import { MUSIC_STATES } from '../../../audio/composer/override';
import { TIMES, describeWhen, type MappingWhen, type MusicMapping } from '../../../audio/composer/mapping';
import { addMapping, BUILT_IN_TRACKS, forceMusic, getComposer, muteBus, openAudioPicker, openMappingImport, overrideMusic, setComposerLog, setMappings, soloBus, downloadMappings, useComposer, type NowPlaying } from '../../../audio/composer/composer';
import type { MusicState } from '../../../audio/music/director';
import { anyVibe, describeVibe, LANDMARK_LABEL, packVibe, VIBE_BIOMES, VIBE_LANDMARKS, VIBE_TIERS, type VibeFilter } from './filters';
import { parseVibe } from './commands';
import { useVibe, VIBE_ACT, type VibeResult } from './store';

const S = {
  btn: { background: BTN_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', font: 'inherit', fontSize: 12 } as CSSProperties,
  input: { background: SLOT_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 4, padding: '3px 6px', font: 'inherit', fontSize: 12 } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', margin: '5px 0' } as CSSProperties,
  h: { fontWeight: 700, color: GOLD, margin: '12px 0 4px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 } as CSSProperties,
  card: { background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 4, padding: 6 } as CSSProperties,
  small: { fontSize: 11, color: TEXT_3 } as CSSProperties,
};

function Btn({ onClick, children, title, testid, active }: { onClick: () => void; children: ReactNode; title?: string; testid?: string; active?: boolean }) {
  return (
    <button type="button" style={{ ...S.btn, ...(active ? { borderColor: GOLD, color: GOLD } : null) }} onClick={onClick} title={title} data-testid={testid}>
      {children}
    </button>
  );
}

function Num({ value, onChange, width = 56, min, max, step, label }: { value: number; onChange: (v: number) => void; width?: number; min?: number; max?: number; step?: number; label: string }) {
  return <input aria-label={label} type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} style={{ ...S.input, width }} />;
}

function Sel({ value, onChange, label, children, testid }: { value: string | number; onChange: (v: string) => void; label: string; children: ReactNode; testid?: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} style={S.input} data-testid={testid}>
      {children}
    </select>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const STATE_LABEL: Record<string, string> = { haven: 'Haven', stamped: 'stamped', provisional: 'provisional', override: 'OVERRIDE', unstamped: 'unstamped: you would stamp', off: 'no difficulty' };

function sendLog(line: string, s: ReturnType<typeof send>): void {
  devLog('cmd', line);
  sendDev(s);
}

function find(f: VibeFilter): void {
  useVibe.setState({ filter: { ...f, go: false, random: false }, cursor: -1 });
  const { target, arg } = packVibe(f);
  sendLog(`/vibe find ${describeVibe(f, useVibe.getState().regions)}`, send(VIBE_ACT.find, target, arg));
}

/** go next / prev / random / #n through the same parser as the command line. */
function vibeGo(how: string): void {
  const r = parseVibe(['go', how], useVibe.getState());
  if ('error' in r) {
    devLog('err', r.error);
    return;
  }
  devLog('cmd', `/vibe go ${how}${r.note ? `  (${r.note})` : ''}`);
  if (r.cursor !== undefined) useVibe.setState({ cursor: r.cursor });
  for (const s of r.sends) sendDev(s);
}

function goTo(r: VibeResult): void {
  useVibe.setState({ cursor: r.i });
  sendLog(`/vibe go ${r.i + 1}  (${r.n})`, send(VIBE_ACT.go, teleportSend(r.x, r.z).target, 0));
}

// ---- find & teleport ----

function FindPanel() {
  const st = useVibe();
  const [f, setF] = useState<VibeFilter>(() => ({ ...useVibe.getState().filter }));
  const set = (p: Partial<VibeFilter>) => setF((o) => ({ ...o, ...p }));
  return (
    <div data-testid="vibe-find">
      <div style={S.h}>Find a place</div>
      <div style={S.row}>
        <Sel label="biome" value={f.biome} onChange={(v) => set({ biome: Number(v) })} testid="vibe-biome">
          <option value={-1}>Any biome</option>
          {VIBE_BIOMES.map((b, i) => (
            <option key={b} value={i}>
              {cap(b)}
            </option>
          ))}
        </Sel>
        <Sel label="landmark" value={f.landmark} onChange={(v) => set({ landmark: Number(v) })} testid="vibe-landmark">
          <option value={0}>Any place</option>
          {VIBE_LANDMARKS.map((l, i) => (
            <option key={l} value={i + 1}>
              {LANDMARK_LABEL[l]}
            </option>
          ))}
        </Sel>
        <Sel label="region" value={f.region} onChange={(v) => set({ region: Number(v) })} testid="vibe-region">
          <option value={-1}>Any region</option>
          {st.regions.map((r, i) => (
            <option key={i} value={i}>
              {r || `Region ${i}`}
            </option>
          ))}
        </Sel>
      </div>
      <div style={S.row}>
        area level <Num label="level from" value={f.levelMin} onChange={(v) => set({ levelMin: v })} min={0} max={60} width={46} />-
        <Num label="level to" value={f.levelMax} onChange={(v) => set({ levelMax: v })} min={0} max={60} width={46} />
        <Sel label="tier" value={f.tier} onChange={(v) => set({ tier: Number(v) })}>
          <option value={-1}>any tier</option>
          {VIBE_TIERS.map((t, i) => (
            <option key={t} value={i}>
              {cap(t)}
            </option>
          ))}
        </Sel>
        <Sel label="stamped" value={f.stamped} onChange={(v) => set({ stamped: Number(v) })}>
          <option value={0}>stamped or not</option>
          <option value={1}>stamped only</option>
          <option value={2}>unstamped only</option>
        </Sel>
      </div>
      <div style={S.row}>
        from spawn <Num label="distance from" value={f.distMin} onChange={(v) => set({ distMin: v })} min={0} max={6000} step={64} width={62} />-
        <Num label="distance to" value={f.distMax} onChange={(v) => set({ distMax: v })} min={0} max={6000} step={64} width={62} /> m
        <span style={S.small}>(0 = open)</span>
        show <Num label="results" value={f.n || 20} onChange={(v) => set({ n: v })} min={1} max={60} width={46} />
      </div>
      <div style={S.row}>
        <Btn onClick={() => find({ ...f, offset: 0 })} testid="vibe-search">
          Search
        </Btn>
        <Btn onClick={() => (useVibe.setState({ filter: { ...f, go: false, random: false } }), vibeGo('random'))} testid="vibe-random">
          Random match
        </Btn>
        <Btn onClick={() => vibeGo('prev')}>Prev</Btn>
        <Btn onClick={() => vibeGo('next')} testid="vibe-next">
          Next match
        </Btn>
        <Btn onClick={() => setF(anyVibe())}>Reset filters</Btn>
      </div>
      <div style={{ ...S.small, margin: '4px 0' }} data-testid="vibe-count">
        {st.answers === 0 ? 'Search to list places (the zone searches the whole world).' : `${st.total} matches${st.total > st.results.length ? `, showing ${st.offset + 1}-${st.offset + st.results.length}` : ''} · sorted by distance from the spawn · levels for unstamped areas are what you would stamp them at now`}
        {st.total > st.offset + st.results.length && (
          <>
            {' '}
            <Btn onClick={() => find({ ...useVibe.getState().filter, offset: st.offset + st.results.length })}>More</Btn>
          </>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="vibe-results">
        {st.results.map((r) => (
          <div key={`${r.i}-${r.x}`} data-testid={`vibe-result-${r.i}`} style={{ ...S.card, display: 'flex', gap: 8, alignItems: 'center', ...(r.i === st.cursor ? { borderColor: GOLD } : null) }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span style={{ color: TEXT_3 }}>#{r.i + 1}</span> {r.n}
              </div>
              <div style={{ fontSize: 11, color: TEXT_2 }}>
                {cap(r.k)} · {r.b} · {r.r} · <b style={{ color: r.st === 'override' ? GOLD : TEXT }}>level {r.lv}</b> {cap(r.t)} ({STATE_LABEL[r.st] ?? r.st}) · {r.d} m from spawn · {r.dy} m from you
              </div>
              {r.near && r.near.length > 0 && <div style={{ ...S.small, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>near: {r.near.join(' · ')}</div>}
            </div>
            <Btn onClick={() => goTo(r)} testid={`vibe-go-${r.i}`}>
              Teleport
            </Btn>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- set the vibe ----

function VibePanel() {
  const here = useVibe((s) => s.here);
  const status = useDev((s) => s.status);
  const [area, setArea] = useState(10);
  const [count, setCount] = useState(0);
  const [elvl, setElvl] = useState(0);
  const [mylvl, setMylvl] = useState(10);
  const [hour, setHour] = useState('22:00');
  const [ev, setEv] = useState(1);
  const sp = here?.spot;
  return (
    <div data-testid="vibe-set">
      <div style={S.h}>Here</div>
      <div style={S.card} data-testid="vibe-here">
        {sp ? (
          <>
            <div>
              <b>{cap(sp.b)}</b> in {sp.r || 'the wilds'} · area {sp.c} · <b style={{ color: sp.st === 'override' ? GOLD : TEXT }}>level {sp.lv}</b> {cap(sp.t)} ({STATE_LABEL[sp.st] ?? sp.st})
            </div>
            <div style={S.small}>
              {here.weather ? `${cap(here.weather)} · ` : ''}
              {String(Math.floor(here.hour)).padStart(2, '0')}:{String(Math.floor((here.hour % 1) * 60)).padStart(2, '0')} · {sp.d} m from spawn · demons {here.demons ? 'on' : 'off'}
              {here.frozen ? ' · VIBE FROZEN' : ''}
              {here.invuln > 0 ? ` · invulnerable ${here.invuln.toFixed(0)} s` : ''}
            </div>
            {sp.near && sp.near.length > 0 && <div style={S.small}>near: {sp.near.join(' · ')}</div>}
          </>
        ) : (
          <span style={S.small}>asking the zone...</span>
        )}
      </div>
      <div style={S.h}>Set the vibe</div>
      <div style={S.row}>
        area level <Num label="area level" value={area} onChange={setArea} min={1} max={60} width={46} />
        <Btn onClick={() => sendLog(`/vibe level ${area}`, send(VIBE_ACT.level, 0, area))} testid="vibe-area-level">
          Set this area
        </Btn>
        <Btn onClick={() => sendLog('/vibe level clear', send(VIBE_ACT.level, 0, 0))}>Clear</Btn>
        <Btn onClick={() => sendLog('/vibe level clear all', send(VIBE_ACT.level, 0, 0xffff))}>Clear all</Btn>
      </div>
      {here && here.overrides.length > 0 && (
        <div style={S.small}>
          overrides:{' '}
          {here.overrides.map((o) => (
            <span key={o.c} style={{ marginRight: 8 }}>
              area {o.c} = {o.lv} (was {o.was}){' '}
              <Btn onClick={() => sendLog(`/vibe level clear (area ${o.c})`, send(VIBE_ACT.level, BigInt(o.c + 1), 0))}>x</Btn>
            </span>
          ))}
        </div>
      )}
      <div style={S.row}>
        typical enemies: count <Num label="enemy count" value={count} onChange={setCount} min={0} max={20} width={42} /> level <Num label="enemy level" value={elvl} onChange={setElvl} min={0} max={60} width={42} />
        <span style={S.small}>(0 = a camp / the area)</span>
        <Btn onClick={() => sendLog(`/vibe spawn ${count} ${elvl}`, send(VIBE_ACT.spawn, 0, (count & 0xff) | ((elvl & 0xff) << 8)))} testid="vibe-spawn">
          Spawn
        </Btn>
        <Btn onClick={() => sendLog('/despawn', send(DEV_ACT.despawn))}>Despawn</Btn>
      </div>
      <div style={S.row}>
        your level <Num label="your level" value={mylvl} onChange={setMylvl} min={1} max={255} width={50} />
        <Btn onClick={() => sendLog(`/level ${mylvl}`, send(DEV_ACT.level, 0, mylvl))} testid="vibe-my-level">
          Set
        </Btn>
      </div>
      <div style={S.row}>
        time
        {(
          [
            ['dawn', 6.25],
            ['morning', 9],
            ['noon', 12],
            ['dusk', 18.25],
            ['night', 22],
            ['3 am', 3],
          ] as const
        ).map(([n, h]) => (
          <Btn key={n} onClick={() => sendLog(`/time ${h}`, send(DEV_ACT.time, 0, Math.round(h * 100)))}>
            {n}
          </Btn>
        ))}
        <input aria-label="hour" value={hour} onChange={(e) => setHour(e.target.value)} style={{ ...S.input, width: 50 }} />
        <Btn
          onClick={() => {
            const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(hour);
            if (m) sendLog(`/time ${hour}`, send(DEV_ACT.time, 0, Math.round((Number(m[1]) + Number(m[2] ?? 0) / 60) * 100)));
          }}
        >
          Set
        </Btn>
      </div>
      <div style={S.row}>
        weather
        <Sel label="weather" value={status.weather} onChange={(v) => sendLog(`/weather ${v === '-1' ? 'seeded' : WEATHER[Number(v)].key}`, send(DEV_ACT.weather, 0, Number(v) + 1))}>
          <option value={-1}>Seeded (normal)</option>
          {WEATHER.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name.replace(/_/g, ' ')}
            </option>
          ))}
        </Sel>
        demons
        <Btn onClick={() => sendLog('/vibe demons on', send(VIBE_ACT.demons, 0, 2))} active={here?.demons}>
          on
        </Btn>
        <Btn onClick={() => sendLog('/vibe demons off', send(VIBE_ACT.demons, 0, 1))} active={here ? !here.demons : false}>
          off
        </Btn>
      </div>
      <div style={S.row}>
        world event
        <Sel label="world event" value={ev} onChange={(v) => setEv(Number(v))}>
          {WORLD_EVENTS.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Sel>
        <Btn onClick={() => sendLog(`/event ${WORLD_EVENTS.find((w) => w.id === ev)?.key ?? ev}`, send(DEV_ACT.event, 0, ev))}>Start here</Btn>
      </div>
      <div style={S.row}>
        <Btn onClick={() => sendLog(`/vibe freeze ${here?.frozen ? 'off' : 'on'}`, send(VIBE_ACT.freeze, 0, here?.frozen ? 0 : 1))} active={here?.frozen} testid="vibe-freeze">
          {here?.frozen ? 'Unfreeze the vibe' : 'Freeze the vibe'}
        </Btn>
        <span style={S.small}>time, weather and enemies hold still (zone-wide) while you listen</span>
      </div>
    </div>
  );
}

// ---- the composer ----

function Bar({ v, color = GREEN }: { v: number; color?: string }) {
  return (
    <span style={{ display: 'inline-block', width: 70, height: 6, background: SLOT_BG, borderRadius: 3, verticalAlign: 'middle', overflow: 'hidden' }}>
      <span style={{ display: 'block', width: `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`, height: '100%', background: color }} />
    </span>
  );
}

export function NowPlayingCard({ n, compact }: { n: NowPlaying | null; compact?: boolean }) {
  if (!n) return <div style={{ ...S.card, ...S.small }}>No music data yet: the sound starts with your first click in the world.</div>;
  const c = n.context;
  return (
    <div style={S.card} data-testid="vibe-now-playing">
      <div style={{ fontWeight: 700 }}>
        <span style={{ color: n.source === 'game' ? GREEN : GOLD }}>{n.source === 'game' ? 'Game' : n.source === 'forced' ? 'Forced' : 'Mapped'}</span> · {n.track ? n.track.replace(/^music\//, '').replace(/^file:/, 'file: ') : 'silence'}
        {n.timedPhase ? ` (${n.timedPhase})` : ''}
      </div>
      <div style={S.small}>
        {mmss(n.position)}
        {n.duration ? ` / ${mmss(n.duration)}` : ''}
        {n.loop ? ` · loop ${n.loop.a.toFixed(1)}-${n.loop.b.toFixed(1)} s` : ''} · director <b style={{ color: TEXT }}>{n.director}</b> · intensity <b style={{ color: TEXT }}>{c.intensity.toFixed(2)}</b> <Bar v={c.intensity} color={GOLD} />
        {n.loading ? ` · decoding ${n.loading}...` : ''}
      </div>
      {n.mapping && <div style={S.small}>mapping: {n.mapping}</div>}
      <div style={{ fontSize: 12, color: TEXT_2, marginTop: 4 }}>
        {(compact ? n.why.slice(0, 3) : n.why).map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      {!compact && (
        <>
          <div style={{ ...S.small, marginTop: 4 }}>Ambience layers</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1px 10px', fontSize: 11, color: TEXT_2 }}>
            {n.ambience.map((a) => (
              <div key={a.name} style={{ opacity: a.level > 0.01 ? 1 : 0.55 }}>
                <Bar v={a.level} /> {a.name} {a.level.toFixed(2)}
              </div>
            ))}
          </div>
          {n.loops.length > 0 && <div style={S.small}>positional loops: {n.loops.map((l) => `${l.id} ${l.gain}`).join(', ')}</div>}
          <div style={{ ...S.small, marginTop: 4 }}>
            buses: {n.buses.map((b) => `${b.bus} ${b.dev === 0 ? 'MUTED' : b.volume.toFixed(2)}${b.duck < 0.99 ? ` (ducked ${b.duck.toFixed(2)})` : ''}`).join(' · ')} · out {n.levelDb} dBFS
          </div>
        </>
      )}
    </div>
  );
}

const EMPTY_WHEN: Record<keyof MappingWhen, boolean> = { state: false, biome: true, time: true, weather: false, tierMin: false, tierMax: false, act: false, combat: false, intensityMin: false, intensityMax: false, layer: false };

function MappingEditor({ now }: { now: NowPlaying | null }) {
  const files = useComposer((s) => s.files);
  const [file, setFile] = useState('');
  const [use, setUse] = useState(EMPTY_WHEN);
  const [w, setW] = useState<MappingWhen>({});
  const [gain, setGain] = useState(1);
  const [loop, setLoop] = useState(true);
  const [fade, setFade] = useState(3);
  useEffect(() => {
    if (!file && files[0]) setFile(files[0].name);
  }, [files, file]);
  const fillHere = () => {
    const c = now?.context;
    if (!c) return;
    setW({ state: c.state, biome: c.biome ?? undefined, time: c.time, weather: c.weather, tierMin: Math.max(0, c.tierIndex), tierMax: Math.max(0, c.tierIndex), act: c.act ?? undefined, combat: c.combat, layer: c.layer });
  };
  const ready = now !== null;
  useEffect(() => {
    if (ready) fillHere();
  }, [ready]);
  const chosen = (): MappingWhen => {
    const out: MappingWhen = {};
    if (use.state && w.state) out.state = w.state;
    if (use.biome && w.biome) out.biome = w.biome;
    if (use.time && w.time) out.time = w.time;
    if (use.weather && w.weather) out.weather = w.weather;
    if (use.tierMin) {
      out.tierMin = w.tierMin ?? 0;
      out.tierMax = w.tierMax ?? 5;
    }
    if (use.act && w.act) out.act = w.act;
    if (use.combat) out.combat = !!w.combat;
    if (use.layer && w.layer) out.layer = w.layer;
    return out;
  };
  const tick = (k: keyof MappingWhen, label: ReactNode) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <input type="checkbox" checked={use[k]} onChange={(e) => setUse({ ...use, [k]: e.target.checked })} /> {label}
    </label>
  );
  return (
    <div style={{ ...S.card, marginTop: 6 }} data-testid="vibe-mapping-editor">
      <div style={S.row}>
        map
        <Sel label="file" value={file} onChange={setFile}>
          {files.length === 0 && <option value="">load a file first</option>}
          {files.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </Sel>
        to <Btn onClick={fillHere}>fill from here</Btn>
      </div>
      <div style={{ ...S.row, fontSize: 12 }}>
        {tick(
          'state',
          <Sel label="state" value={w.state ?? 'day'} onChange={(v) => setW({ ...w, state: v as MusicState })}>
            {MUSIC_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Sel>,
        )}
        {tick(
          'layer',
          <Sel label="layer" value={w.layer ?? 'surface'} onChange={(v) => setW({ ...w, layer: v })}>
            {LAYER_TAGS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Sel>,
        )}
        {tick(
          'biome',
          <Sel label="biome" value={w.biome ?? 'meadow'} onChange={(v) => setW({ ...w, biome: v })}>
            {VIBE_BIOMES.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Sel>,
        )}
        {tick(
          'time',
          <Sel label="time" value={w.time ?? 'day'} onChange={(v) => setW({ ...w, time: v as MappingWhen['time'] })}>
            {TIMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Sel>,
        )}
        {tick(
          'weather',
          <Sel label="weather" value={w.weather ?? 'clear'} onChange={(v) => setW({ ...w, weather: v })}>
            {WEATHER.map((x) => (
              <option key={x.key}>{x.key}</option>
            ))}
          </Sel>,
        )}
        {tick(
          'tierMin',
          <>
            tier <Num label="tier from" value={w.tierMin ?? 0} onChange={(v) => setW({ ...w, tierMin: v })} min={0} max={5} width={38} />-
            <Num label="tier to" value={w.tierMax ?? 5} onChange={(v) => setW({ ...w, tierMax: v })} min={0} max={5} width={38} />
          </>,
        )}
        {tick('act', <>act <Num label="act" value={w.act ?? 1} onChange={(v) => setW({ ...w, act: v })} min={1} max={6} width={38} /></>)}
        {tick(
          'combat',
          <Sel label="combat" value={w.combat ? 'yes' : 'no'} onChange={(v) => setW({ ...w, combat: v === 'yes' })}>
            <option value="yes">in combat</option>
            <option value="no">not in combat</option>
          </Sel>,
        )}
      </div>
      <div style={S.row}>
        gain <Num label="gain" value={gain} onChange={setGain} min={0} max={2} step={0.05} width={50} />
        <label>
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
        </label>
        fade in <Num label="fade" value={fade} onChange={setFade} min={0} max={30} step={0.5} width={46} /> s
        <Btn
          onClick={() => {
            if (!file) return devLog('err', 'load an audio file first (Load audio files...)');
            const m = addMapping({ file, when: chosen(), gain, loop, fadeIn: fade, enabled: true });
            devLog('ok', `mapped ${m.file} to ${describeWhen(m.when)}`);
          }}
          testid="vibe-add-mapping"
        >
          Add mapping
        </Btn>
      </div>
      <div style={S.small}>{describeWhen(chosen())}: the most specific matching mapping plays; nothing matching = the game&apos;s own music.</div>
    </div>
  );
}

function ComposerPanel() {
  const now = useComposer((s) => s.now);
  const o = useComposer((s) => s.override);
  const files = useComposer((s) => s.files);
  const mappings = useComposer((s) => s.mappings);
  const solo = useComposer((s) => s.solo);
  const muted = useComposer((s) => s.muted);
  const pinned = useComposer((s) => s.pinned);
  const [track, setTrack] = useState(BUILT_IN_TRACKS[0]);
  const [la, setLa] = useState(0);
  const [lb, setLb] = useState(8);
  const tracks = useMemo(() => [...BUILT_IN_TRACKS, ...files.map((f) => `file:${f.name}`)], [files]);
  const say = (r: string | null, ok?: string) => (r && r.startsWith('error:') ? devLog('err', r.slice(6)) : devLog('ok', r ?? ok ?? 'ok'));
  return (
    <div data-testid="vibe-composer">
      <div style={S.h}>
        Now playing{' '}
        <Btn onClick={() => useComposer.setState({ pinned: !pinned })} active={pinned} title="Keep a small now-playing box over the game while the console is closed">
          {pinned ? 'pinned' : 'pin'}
        </Btn>
      </div>
      <NowPlayingCard n={now} />
      <div style={S.h}>Override</div>
      <div style={S.row}>
        <Btn onClick={() => say(forceMusic('auto'))} active={o.mode === 'auto'} testid="vibe-music-auto">
          Auto
        </Btn>
        {MUSIC_STATES.map((s) => (
          <Btn key={s} onClick={() => say(forceMusic(s))} active={o.mode === 'state' && o.state === s} testid={`vibe-music-${s}`}>
            {s}
          </Btn>
        ))}
      </div>
      <div style={S.row}>
        <Sel label="track" value={track} onChange={setTrack}>
          {tracks.map((t) => (
            <option key={t} value={t}>
              {t.replace(/^music\//, '').replace(/^file:/, 'file: ')}
            </option>
          ))}
        </Sel>
        <Btn onClick={() => say(overrideMusic({ kind: 'track', track }), `playing ${track}`)} active={o.mode === 'track' && o.track === track}>
          Play track
        </Btn>
      </div>
      <div style={S.row}>
        intensity
        <input
          aria-label="intensity"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={o.intensity ?? now?.context.intensity ?? 0}
          onChange={(e) => overrideMusic({ kind: 'intensity', value: Number(e.target.value) })}
          style={{ width: 120 }}
        />
        <span style={S.small}>{o.intensity === null ? 'auto' : o.intensity.toFixed(2)}</span>
        <Btn onClick={() => overrideMusic({ kind: 'intensity', value: null })} active={o.intensity === null}>
          auto
        </Btn>
      </div>
      <div style={S.row}>
        loop A <Num label="loop a" value={la} onChange={setLa} min={0} step={0.1} width={58} /> B <Num label="loop b" value={lb} onChange={setLb} min={0} step={0.1} width={58} />
        <Btn onClick={() => setLa(Math.round((now?.position ?? 0) * 10) / 10)}>A = now</Btn>
        <Btn onClick={() => setLb(Math.round((now?.position ?? 0) * 10) / 10)}>B = now</Btn>
        <Btn onClick={() => say(overrideMusic({ kind: 'loop', a: la, b: lb }), `looping ${la}-${lb} s`)} active={!!o.loop}>
          Loop
        </Btn>
        <Btn onClick={() => overrideMusic({ kind: 'loopOff' })}>Off</Btn>
      </div>
      <div style={S.row}>
        solo
        {(['music', 'ambience', 'sfx', 'ui'] as const).map((b) => (
          <Btn key={b} onClick={() => soloBus(solo === b ? null : b)} active={solo === b} testid={`vibe-solo-${b}`}>
            {b}
          </Btn>
        ))}
        mute
        {(['music', 'ambience', 'sfx', 'ui'] as const).map((b) => (
          <Btn key={b} onClick={() => muteBus(b)} active={muted.includes(b)}>
            {b}
          </Btn>
        ))}
      </div>
      <div style={S.h}>Your audio files</div>
      <div style={S.row}>
        <Btn onClick={openAudioPicker} testid="vibe-load-audio">
          Load audio files...
        </Btn>
        <span style={S.small}>WAV, MP3, OGG, FLAC, M4A: decoded here, kept in this browser, played through the music bus (same ducking and crossfades). No rebuild.</span>
      </div>
      {files.map((f) => (
        <div key={f.name} style={{ ...S.row, fontSize: 12 }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {f.name} <span style={S.small}>{f.duration ? mmss(f.duration) : f.ready ? '' : '(decodes on play)'}</span>
          </span>
          <Btn onClick={() => say(overrideMusic({ kind: 'track', track: `file:${f.name}` }), `playing ${f.name}`)}>Play</Btn>
          <Btn onClick={() => void getComposer().removeFile(f.name)}>Remove</Btn>
        </div>
      ))}
      <MappingEditor now={now} />
      <div style={S.h}>Mappings ({mappings.length})</div>
      {mappings.map((m: MusicMapping) => (
        <div key={m.id} style={{ ...S.row, fontSize: 12 }}>
          <input type="checkbox" aria-label="enabled" checked={m.enabled} onChange={(e) => setMappings(mappings.map((x) => (x.id === m.id ? { ...x, enabled: e.target.checked } : x)))} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>{m.file}</b> <span style={{ color: TEXT_2 }}>when {describeWhen(m.when)}</span> <span style={S.small}>gain {m.gain} · {m.loop ? 'loop' : 'once'} · fade {m.fadeIn} s</span>
            {now?.mapping?.startsWith(`${m.file}:`) && <b style={{ color: GOLD }}> playing</b>}
          </span>
          <Btn onClick={() => setMappings(mappings.filter((x) => x.id !== m.id))}>x</Btn>
        </div>
      ))}
      <div style={S.row}>
        <Btn onClick={() => devLog('ok', `exported ${mappings.length} mapping(s): ${downloadMappings().length} bytes (downloaded and copied)`)} testid="vibe-export">
          Export JSON
        </Btn>
        <Btn onClick={openMappingImport}>Import JSON</Btn>
        {mappings.length > 0 && (
          <Btn onClick={() => setMappings([])}>
            <span style={{ color: RED }}>Clear all</span>
          </Btn>
        )}
      </div>
      <div style={S.small}>Hand the exported JSON back to wire the files in for good (client/src/audio/README.md, &quot;Composer mappings&quot;).</div>
    </div>
  );
}

/** The small now-playing box over the game (pinned, console closed). */
export function NowPlayingPin() {
  const pinned = useComposer((s) => s.pinned);
  const open = useDev((s) => s.open);
  const now = useComposer((s) => s.now);
  if (!pinned || open) return null;
  return (
    <div data-testid="vibe-now-pin" style={{ position: 'fixed', right: 12, top: 60, width: 320, zIndex: 35, pointerEvents: 'none', opacity: 0.94, font: '12px/1.35 system-ui, sans-serif', color: TEXT }}>
      <NowPlayingCard n={now} compact />
    </div>
  );
}

let listed = false;

export default function VibeTab() {
  useEffect(() => {
    setComposerLog(devLog);
    getComposer();
    useVibe.setState({ composer: true });
    const ask = () => sendDev(send(VIBE_ACT.here));
    ask();
    // The first visit lists what is around the spawn (and brings the region names).
    if (!listed && useVibe.getState().answers === 0) {
      listed = true; // once (StrictMode runs effects twice in dev)
      find({ ...useVibe.getState().filter, n: 20, offset: 0 });
    }
    const id = setInterval(ask, 3000);
    return () => clearInterval(id);
  }, []);
  return (
    <div data-testid="dev-vibe" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
      <div style={{ minWidth: 0 }}>
        <FindPanel />
        <VibePanel />
      </div>
      <div style={{ minWidth: 0 }}>
        <ComposerPanel />
      </div>
    </div>
  );
}
