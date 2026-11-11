// Playtest 2 vibe explorer, composer aids (docs/cr/036-vibe-explorer.md):
// the runtime behind the Vibe tab's music column and the /music commands.
//
//   - Now playing: the director's state and track, why (override.ts
//     explain), the vibe context (biome, time, weather, area tier, story act,
//     combat), the intensity, the ambience layers and the positional loops
//     with their levels, every bus's volume, duck and solo/mute.
//   - Override: force a state (the director's inputs, override.ts
//     inputsForState) or a track (built-in or a loaded file) with a forced
//     intensity and a loop section.
//   - Loaded files: WAV/MP3/OGG/... picked from disk, decoded in the browser,
//     kept in IndexedDB (files.ts), played through the music bus on the
//     composer's own deck: the same bus ducking (voice, stings, hidden tab)
//     and a crossfade with the game's music.
//   - Mappings (mapping.ts): a loaded file plays whenever the vibe matches
//     its condition; saved in localStorage, exported as JSON.
//
// Registers itself as the engine's composer hook (hook.ts) on first use, so
// a session that never opens the console runs exactly as before.

import { LAYER_TAGS, audioWorld } from '../bridge';
import { create } from 'zustand';
import { localPlayer } from '../../state/live';
import { useCombatHud } from '../../combat/store';
import { useProgression } from '../../ui/progression/store';
import { useStory } from '../../ui/story/store';
import { liveWeather } from '../../systems/weather/runtime';
import { STATE_KEYS } from '../../systems/weather/weather';
import { assetUrl } from '../assets';
import { busDuck, busInput, devBusGains, getAudioContext, setDevBusGain } from '../context';
import { BUSES, useAudioSettings, type BusName } from '../settings';
import type { AudioEngine } from '../engine';
import type { MusicDecision, MusicInputs, MusicState } from '../music/director';
import { STATE_MUSIC, TIMED_MUSIC } from '../music/tracks';
import { composerHook, type ComposerHook } from './hook';
import { deleteFile, listFiles, readFile, saveFile } from './files';
import { describeWhen, exportMappings, importMappings, loadStoredMappings, MAP_STORAGE_KEY, newMappingId, resolveMapping, type MusicMapping } from './mapping';
import { AUTO, computeIntensity, explain, inputsForState, reduceOverride, resolveForceTarget, timeOfDay, type LoopSection, type MusicOverride, type OverrideCmd, type VibeContext } from './override';

/** Every built-in music asset (the cue sheet in ../README.md). */
export const BUILT_IN_TRACKS: string[] = [...new Set([...Object.values(STATE_MUSIC).flatMap((s) => s.tracks), TIMED_MUSIC.intro, TIMED_MUSIC.loop, TIMED_MUSIC.final])];

export const AUDIO_ACCEPT = '.wav,.mp3,.ogg,.oga,.opus,.m4a,.aac,.flac,.webm,audio/*';

export interface LoadedFile {
  name: string;
  size: number;
  duration: number | null;
  /** Decoded in memory now (else it is in the browser's storage and decodes on first play). */
  ready: boolean;
}

export interface NowPlaying {
  director: MusicState;
  /** What carries the music: the game's player, a forced track, a mapped file. */
  source: 'game' | 'forced' | 'mapping';
  track: string | null;
  timedPhase: string | null;
  position: number;
  duration: number | null;
  loop: LoopSection | null;
  mapping: string | null;
  context: VibeContext;
  why: string[];
  ambience: { name: string; level: number }[];
  loops: { id: string; gain: number }[];
  buses: { bus: BusName; volume: number; duck: number; dev: number | null }[];
  levelDb: number;
  /** A file the composer is decoding (it plays when ready). */
  loading: string | null;
}

export interface ComposerState {
  override: MusicOverride;
  mappings: MusicMapping[];
  files: LoadedFile[];
  now: NowPlaying | null;
  solo: BusName | null;
  muted: BusName[];
  /** The small now-playing box over the game while the console is closed. */
  pinned: boolean;
}

function storedMappings(): MusicMapping[] {
  try {
    return typeof localStorage === 'undefined' ? [] : loadStoredMappings(localStorage.getItem(MAP_STORAGE_KEY));
  } catch {
    return [];
  }
}

export const useComposer = create<ComposerState>(() => ({ override: { ...AUTO }, mappings: storedMappings(), files: [], now: null, solo: null, muted: [], pinned: false }));

function saveMappings(list: MusicMapping[]): void {
  try {
    localStorage.setItem(MAP_STORAGE_KEY, exportMappings(list));
  } catch {
    /* private mode: this session only */
  }
}

interface Deck {
  key: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** ctx time when the source started, and the offset it started at. */
  t0: number;
  off: number;
  loop: LoopSection | null;
  duration: number;
  source: 'forced' | 'mapping';
  mapping: string | null;
}

interface Want {
  key: string;
  loop: boolean;
  section: LoopSection | null;
  gain: number;
  fade: number;
  source: 'forced' | 'mapping';
  mapping: MusicMapping | null;
}

let log: (kind: 'ok' | 'err' | 'info', text: string) => void = () => {};

/** Where the composer's messages go (the dev console log). */
export function setComposerLog(fn: typeof log): void {
  log = fn;
}

class Composer implements ComposerHook {
  private deck: Deck | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private builtInOrder: string[] = [];
  private pending = new Set<string>();
  private failed = new Set<string>();
  private memFiles = new Map<string, Blob>();
  private doneKey: string | null = null;
  private lastWant: string | null = null;
  private lastSnap = 0;
  private eng: AudioEngine | null = null;
  /** A forced state was just chosen: the director switches at once (no dwell). */
  jump = false;

  inputs(i: MusicInputs): MusicInputs {
    const o = useComposer.getState().override;
    if (this.jump && this.eng) {
      this.jump = false;
      this.eng.director.state = 'silence'; // from silence every state follows immediately
    }
    return o.mode === 'state' && o.state ? inputsForState(o.state, o.intensity, i) : i;
  }

  tick(engine: unknown, d: MusicDecision, i: MusicInputs, nowMs: number): boolean {
    const eng = engine as AudioEngine;
    this.eng = eng;
    const st = useComposer.getState();
    const c = this.context(eng, d, i, st.override);
    const want = this.want(st, c);
    if (want?.key !== this.lastWant) {
      this.doneKey = null;
      this.lastWant = want?.key ?? null;
    }
    const w = want && !want.loop && this.doneKey === want.key ? null : want;
    let loading: string | null = null;
    if (!w) {
      if (this.deck) this.stopDeck(2);
    } else {
      const buf = this.buffers.get(w.key);
      if (!buf) {
        loading = this.failed.has(w.key) ? null : w.key;
        void this.ensure(w.key);
      } else if (!this.deck || this.deck.key !== w.key) this.startDeck(w, buf, w.section?.a ?? 0);
      else if (!sameLoop(this.deck.loop, w.section)) this.startDeck(w, buf, w.section?.a ?? Math.min(this.position(), buf.duration - 0.05), 0.08);
      else if (this.deck.gain.gain.value > 0 && Math.abs(this.deck.gain.gain.value - w.gain) > 0.01 && this.deck.source === 'mapping') this.deck.gain.gain.setTargetAtTime(w.gain, eng.ctx.currentTime, 0.2);
    }
    if (nowMs - this.lastSnap > 240) {
      this.lastSnap = nowMs;
      useComposer.setState({ now: this.snapshot(eng, d, i, c, st.override, loading) });
    }
    return this.deck !== null;
  }

  /** What should play on the composer's deck now (null: the game's music). */
  private want(st: ComposerState, c: VibeContext): Want | null {
    const o = st.override;
    if (o.mode === 'track' && o.track) return { key: o.track, loop: true, section: o.loop, gain: o.track.startsWith('file:') ? 1 : 0.8, fade: 1.5, source: 'forced', mapping: null };
    const m = resolveMapping(st.mappings, c, (f) => st.files.some((x) => x.name === f));
    if (!m) return null;
    return { key: `file:${m.file}`, loop: m.loop, section: null, gain: m.gain, fade: m.fadeIn, source: 'mapping', mapping: m };
  }

  context(eng: AudioEngine, d: MusicDecision, i: MusicInputs, o: MusicOverride): VibeContext {
    const area = useProgression.getState().area;
    const hud = useCombatHud.getState();
    const sync = useStory.getState().sync;
    const p = localPlayer.pos;
    const base = {
      state: d.state,
      biome: i.underground > 0.3 ? null : eng.probe.biomeAt(p.x, p.z),
      hour: i.hour,
      weather: STATE_KEYS[liveWeather.state] ?? 'clear',
      tier: area?.tierKey ?? null,
      tierIndex: area ? area.tierIndex : -1,
      areaLevel: area?.level ?? null,
      act: sync && sync.act > 0 ? sync.act : null,
      combat: i.combat,
      boss: !!hud.boss,
      underground: i.underground,
      inTown: i.inTown,
      layer: LAYER_TAGS[audioWorld.layer] ?? 'surface',
      timedPhase: d.timedPhase,
    };
    return { ...base, time: timeOfDay(i.hour), intensity: o.intensity ?? computeIntensity(base) };
  }

  private snapshot(eng: AudioEngine, d: MusicDecision, i: MusicInputs, c: VibeContext, o: MusicOverride, loading: string | null): NowPlaying {
    const ms = eng.music.status();
    const a = eng.ambience.current;
    const wild = a.wild ?? { birds: 0, hawks: 0, frogs: 0, owls: 0 };
    const vols = useAudioSettings.getState().volumes;
    const dev = devBusGains();
    const deck = this.deck;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      director: d.state,
      source: deck ? deck.source : 'game',
      track: deck ? deck.key : ms.track,
      timedPhase: ms.timedPhase,
      position: deck ? this.position() : ms.position,
      duration: deck ? deck.duration : ms.duration,
      loop: deck?.loop ?? null,
      mapping: deck?.mapping ?? null,
      context: c,
      why: explain(i, c, o),
      ambience: [
        ['wind', a.wind],
        ['gusts', a.gust ?? 0],
        ['rain', a.rain],
        ['rain on roof', a.roofRain],
        ['storm roll', a.storm ?? 0],
        ['blowing sand', a.sand ?? 0],
        ['night insects', a.insects],
        ['songbirds', wild.birds],
        ['hawk', wild.hawks],
        ['frogs', wild.frogs],
        ['owls', wild.owls],
        ['underwater', a.water],
        ['cave drips', a.drips],
        ['weather through shelter', a.weatherGain],
      ].map(([name, level]) => ({ name: name as string, level: r2(level as number) })),
      loops: eng.loops.debug().map((l) => ({ id: l.id, gain: l.gain })),
      buses: BUSES.filter((b) => b !== 'master').map((b) => ({ bus: b, volume: r2(vols[b]), duck: r2(busDuck(b as Exclude<BusName, 'master'>)), dev: dev[b] ?? null })),
      levelDb: Math.round(eng.level() * 10) / 10,
      loading,
    };
  }

  /** Decode a track or loaded file into memory (once). */
  private async ensure(key: string): Promise<void> {
    if (this.buffers.has(key) || this.pending.has(key) || this.failed.has(key)) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    this.pending.add(key);
    try {
      let data: ArrayBuffer | null = null;
      if (key.startsWith('file:')) {
        const name = key.slice(5);
        const blob = this.memFiles.get(name) ?? (await readFile(name));
        data = blob ? await blob.arrayBuffer() : null;
      } else {
        const url = assetUrl(key);
        const r = url ? await fetch(url) : null;
        data = r?.ok ? await r.arrayBuffer() : null;
      }
      if (!data) throw new Error('not found');
      const buf = await ctx.decodeAudioData(data);
      this.buffers.set(key, buf);
      if (!key.startsWith('file:')) {
        // Built-in tracks are big decoded (a 3-minute track is ~70 MB): keep two.
        this.builtInOrder = [...this.builtInOrder.filter((k) => k !== key), key];
        while (this.builtInOrder.length > 2) {
          const old = this.builtInOrder.shift()!;
          if (this.deck?.key !== old) this.buffers.delete(old);
        }
      } else this.markReady(key.slice(5), buf.duration);
    } catch (e) {
      this.failed.add(key);
      log('err', `could not play ${key}: ${(e as Error).message || e}`);
    } finally {
      this.pending.delete(key);
    }
  }

  private markReady(name: string, duration: number): void {
    useComposer.setState((s) => ({ files: s.files.map((f) => (f.name === name ? { ...f, ready: true, duration } : f)) }));
  }

  private startDeck(w: Want, buf: AudioBuffer, offset: number, fade = w.fade): void {
    const ctx = getAudioContext();
    const out = busInput('music');
    if (!ctx || !out) return;
    this.stopDeck(fade);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const sec = w.section && w.section.b <= buf.duration + 0.01 ? w.section : null;
    if (w.loop) {
      src.loop = true;
      src.loopStart = sec ? sec.a : 0;
      src.loopEnd = sec ? Math.min(sec.b, buf.duration) : buf.duration;
    }
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(w.gain, t + Math.max(0.02, fade));
    src.connect(g).connect(out);
    const off = Math.max(0, Math.min(offset, buf.duration - 0.05));
    src.start(t, off);
    const deck: Deck = { key: w.key, src, gain: g, t0: t, off, loop: sec, duration: buf.duration, source: w.source, mapping: w.mapping ? `${w.mapping.file}: ${describeWhen(w.mapping.when)}` : null };
    src.onended = () => {
      if (this.deck === deck) {
        this.deck = null;
        this.doneKey = deck.key;
      }
    };
    this.deck = deck;
  }

  private stopDeck(fade: number): void {
    const d = this.deck;
    const ctx = getAudioContext();
    if (!d || !ctx) return;
    this.deck = null;
    d.src.onended = null;
    const t = ctx.currentTime;
    d.gain.gain.cancelScheduledValues(t);
    d.gain.gain.setValueAtTime(d.gain.gain.value, t);
    d.gain.gain.linearRampToValueAtTime(0, t + Math.max(0.02, fade));
    try {
      d.src.stop(t + Math.max(0.02, fade) + 0.05);
    } catch {
      /* stopped */
    }
  }

  /** The deck's position in its track (s), looping included. */
  position(): number {
    const d = this.deck;
    const ctx = getAudioContext();
    if (!d || !ctx) return 0;
    const raw = d.off + (ctx.currentTime - d.t0);
    if (!d.src.loop) return Math.min(raw, d.duration);
    const a = d.src.loopStart;
    const b = d.src.loopEnd || d.duration;
    if (raw < b) return raw;
    return a + ((raw - a) % Math.max(0.05, b - a));
  }

  /** Add files picked from disk: decode now (to check they play), keep in IndexedDB. */
  async addFiles(list: FileList | File[]): Promise<void> {
    const ctx = getAudioContext();
    for (const f of Array.from(list)) {
      this.memFiles.set(f.name, f);
      this.failed.delete(`file:${f.name}`);
      this.buffers.delete(`file:${f.name}`);
      useComposer.setState((s) => ({ files: [...s.files.filter((x) => x.name !== f.name), { name: f.name, size: f.size, duration: null, ready: false }].sort((a, b) => a.name.localeCompare(b.name)) }));
      const kept = await saveFile(f.name, f);
      if (ctx) await this.ensure(`file:${f.name}`);
      const ok = this.buffers.has(`file:${f.name}`);
      log(ok || !ctx ? 'ok' : 'err', `${ok ? 'loaded' : ctx ? 'could not decode' : 'added (decodes once the sound is on)'} ${f.name} (${(f.size / 1048576).toFixed(1)} MB${ok ? `, ${this.buffers.get(`file:${f.name}`)!.duration.toFixed(1)} s` : ''})${kept ? ', kept in this browser' : ''}`);
    }
  }

  async restoreFiles(): Promise<void> {
    const stored = await listFiles();
    if (!stored.length) return;
    useComposer.setState((s) => {
      const have = new Set(s.files.map((f) => f.name));
      return { files: [...s.files, ...stored.filter((f) => !have.has(f.name)).map((f) => ({ name: f.name, size: f.size, duration: null, ready: false }))].sort((a, b) => a.name.localeCompare(b.name)) };
    });
  }

  async removeFile(name: string): Promise<void> {
    this.memFiles.delete(name);
    this.buffers.delete(`file:${name}`);
    await deleteFile(name);
    useComposer.setState((s) => ({ files: s.files.filter((f) => f.name !== name) }));
  }

  /** Play a loaded or built-in track now (forced), or preview. */
  preload(key: string): void {
    void this.ensure(key);
  }
}

function sameLoop(a: LoopSection | null, b: LoopSection | null): boolean {
  return a === b || (!!a && !!b && Math.abs(a.a - b.a) < 1e-3 && Math.abs(a.b - b.b) < 1e-3);
}

let composer: Composer | null = null;

/** The composer (registers the engine hook on first use). */
export function getComposer(): Composer {
  if (!composer) {
    composer = new Composer();
    composerHook.current = composer;
    void composer.restoreFiles();
    if (typeof window !== 'undefined') (window as unknown as { __lodestoneComposer?: unknown }).__lodestoneComposer = { state: () => useComposer.getState(), set: (p: Partial<ComposerState>) => useComposer.setState(p) };
  }
  return composer;
}

// ---- actions (the tab's buttons and the /music commands) ----

export function overrideMusic(cmd: OverrideCmd): string | null {
  getComposer();
  const r = reduceOverride(useComposer.getState().override, cmd);
  if ('error' in r) return r.error;
  const prev = useComposer.getState().override;
  useComposer.setState({ override: r });
  if (r.mode === 'track' && r.track) getComposer().preload(r.track);
  if ((r.mode === 'state' && (prev.mode !== 'state' || prev.state !== r.state)) || (r.mode === 'auto' && prev.mode !== 'auto')) getComposer().jump = true;
  return null;
}

/** `/music force <state|track|file|auto> [intensity]`. */
export function forceMusic(target: string, intensity?: number): string {
  const files = useComposer.getState().files.map((f) => f.name);
  const t = resolveForceTarget(target, BUILT_IN_TRACKS, files);
  if ('error' in t) return `error:${t.error}`;
  const err = t.kind === 'auto' ? overrideMusic({ kind: 'auto' }) : t.kind === 'state' ? overrideMusic({ kind: 'state', state: t.state, intensity }) : overrideMusic({ kind: 'track', track: t.track, intensity });
  if (err) return `error:${err}`;
  return t.kind === 'auto' ? 'music follows the game again' : t.kind === 'state' ? `music forced to ${t.state}${intensity !== undefined ? ` at intensity ${intensity}` : ''}` : `playing ${t.track} (looping)`;
}

/** Solo one bus (the others muted), or null for none. */
export function soloBus(bus: BusName | null): void {
  useComposer.setState({ solo: bus });
  applyBusDev();
}

export function muteBus(bus: BusName, on?: boolean): boolean {
  const m = useComposer.getState().muted;
  const now = on ?? !m.includes(bus);
  useComposer.setState({ muted: now ? [...new Set([...m, bus])] : m.filter((b) => b !== bus) });
  applyBusDev();
  return now;
}

function applyBusDev(): void {
  const { solo, muted } = useComposer.getState();
  for (const b of BUSES) {
    if (b === 'master' || b === 'voice') continue;
    const off = muted.includes(b) || (solo !== null && solo !== b);
    setDevBusGain(b, off ? 0 : null);
  }
}

export function setMappings(list: MusicMapping[]): void {
  useComposer.setState({ mappings: list });
  saveMappings(list);
}

export function addMapping(m: Omit<MusicMapping, 'id'>): MusicMapping {
  const full = { ...m, id: newMappingId() };
  setMappings([...useComposer.getState().mappings, full]);
  return full;
}

/** Download the mappings as JSON (and copy them); returns the text. */
export function downloadMappings(): string {
  const text = exportMappings(useComposer.getState().mappings);
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `lodestone-music-map-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    /* no DOM */
  }
  void navigator.clipboard?.writeText(text).catch(() => {});
  return text;
}

export function importMappingsText(text: string, replace = false): string {
  const r = importMappings(text);
  if ('error' in r) return `error:${r.error}`;
  setMappings(replace ? r.mappings : [...useComposer.getState().mappings, ...r.mappings]);
  return `imported ${r.mappings.length} mapping(s)${r.dropped ? `, ${r.dropped} invalid dropped` : ''}`;
}

/** Open a file picker (call from a click or a key press). */
export function pickFiles(accept: string, multiple: boolean, then: (files: FileList) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = multiple;
  input.style.display = 'none';
  input.onchange = () => {
    if (input.files?.length) then(input.files);
    input.remove();
  };
  document.body.appendChild(input);
  input.click();
}

/** `/music load`: pick audio files to test. */
export function openAudioPicker(): void {
  pickFiles(AUDIO_ACCEPT, true, (fl) => void getComposer().addFiles(fl));
}

/** Pick an exported mappings JSON and add its mappings. */
export function openMappingImport(): void {
  pickFiles('.json,application/json', false, (fl) => {
    void fl[0].text().then((t) => {
      const r = importMappingsText(t);
      log(r.startsWith('error:') ? 'err' : 'ok', r.replace(/^error:/, ''));
    });
  });
}

/** A one-paragraph text of the readout (/music now). */
export function nowPlayingText(n: NowPlaying | null): string[] {
  if (!n) return ['no music data yet (the sound starts after the first click in the world)'];
  const pos = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const out = [`${n.source === 'game' ? 'game' : n.source}: ${n.track ?? 'nothing'}${n.timedPhase ? ` (${n.timedPhase})` : ''} ${pos(n.position)}${n.duration ? ` / ${pos(n.duration)}` : ''}${n.loop ? ` loop ${n.loop.a.toFixed(1)}-${n.loop.b.toFixed(1)} s` : ''} · director ${n.director} · intensity ${n.context.intensity.toFixed(2)}`];
  if (n.mapping) out.push(`mapping: ${n.mapping}`);
  out.push(...n.why);
  const amb = n.ambience.filter((a) => a.level > 0.02 && a.name !== 'weather through shelter');
  out.push(`ambience: ${amb.length ? amb.map((a) => `${a.name} ${a.level.toFixed(2)}`).join(', ') : 'quiet'}${n.loops.length ? `; loops ${n.loops.map((l) => `${l.id} ${l.gain}`).join(', ')}` : ''}`);
  out.push(`buses: ${n.buses.map((b) => `${b.bus} ${b.dev === 0 ? 'MUTED' : b.volume.toFixed(2)}${b.duck < 0.99 ? ` (ducked ${b.duck.toFixed(2)})` : ''}`).join(', ')} · out ${n.levelDb} dBFS`);
  return out;
}
