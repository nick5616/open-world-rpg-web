// Playtest 2 instruments (CR 028): play mode and the live zone session.
// Out: Interact 120 (start, batched notes, stop, the metronome). In: Event
// 1120 (someone near you played: heard from where they stand, through a
// jitter buffer that keeps their rhythm), 1121 (refusals), 1122 (a song
// ended, maybe to applause), 1123 (a shared metronome). Your own notes
// sound at once, locally; the sound itself is a lazy chunk (audio.ts),
// loaded when you pick up an instrument or first hear one.

import { CONTENT, type Event as ZoneEvent, type InstrumentDef } from '@lodestone/contracts';
import { drawnRemotes, netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { lookRouter } from '../../input/lookRouter';
import { view } from '../../state/live';
import { useInventory } from '../inventory/store';
import { setEmote, emoteOf, SELF as EMOTE_SELF } from '../emotes/store';
import { addNoteHit, clearNoteHits, instrumentDef, instrumentOfItem, musicToast, octaveFor, SELF, useMusic } from './store';
import { foldIntoRange, keyToMidi, scaleByKey, velocityOf } from './theory';
import { decodeNotesData, EMOTE_PLAYING, EV_JAM_TEMPO, EV_MUSIC_NOTES, EV_MUSIC_REFUSED, EV_MUSIC_SONG, MUSIC_ACT, MUSIC_INTERACT, MUSIC_REFUSAL, NoteBatcher, packBatch, Playout } from './wire';

type AudioMod = typeof import('./audio');
let audioP: Promise<AudioMod> | null = null;
let audio: AudioMod | null = null;
/** The sound (a lazy chunk): loaded on first use. */
export function loadMusicAudio(): Promise<AudioMod> {
  if (!audioP)
    audioP = import('./audio').then((m) => {
      audio = m;
      return m;
    });
  return audioP;
}

/** Instruments in your pack, in content order. */
export function carriedInstruments(): InstrumentDef[] {
  const items = useInventory.getState().inv?.items ?? [];
  const have = new Set(items.map((i) => i.b));
  return CONTENT.instruments.list.filter((d) => have.has(d.item));
}

const batcher = new NoteBatcher();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let movedBlock = false;
let lastRestart = -1e9;
/** Key code -> the note it started (a held flute note ends with its key). */
const held = new Map<string, number>();

function session(): ZoneSession | null {
  const s = netRuntime.session;
  return s && s.phase === 'playing' ? s : null;
}

function flush(): void {
  flushTimer = null;
  const now = performance.now();
  const b = batcher.due(now);
  const s = session();
  if (b && s) {
    const { targetId, arg } = packBatch(b.events, b.clock);
    s.sendInteract(MUSIC_INTERACT, targetId, MUSIC_ACT.notes, arg);
  }
  armFlush();
}

function armFlush(): void {
  if (flushTimer) return;
  const due = batcher.nextDue();
  if (!Number.isFinite(due)) return;
  const wait = Math.max(0, due - performance.now());
  if (wait === 0) flush();
  else flushTimer = setTimeout(flush, wait);
}

/** Enter play mode with an instrument (by id; else the last one, else the first you carry). False when you carry none. */
export function enterPlay(id?: number): boolean {
  const carried = carriedInstruments();
  const st = useMusic.getState();
  const pick = (id && carried.find((d) => d.id === id)) || carried.find((d) => d.id === st.instrument) || carried[0];
  if (!pick) {
    musicToast(MUSIC_REFUSAL[1]);
    return false;
  }
  if (st.active && st.instrument === pick.id) return true;
  useMusic.setState({ active: true, instrument: pick.id, octave: octaveFor(pick.id), pressed: {} });
  void loadMusicAudio().then((m) => m.warmInstrument(pick));
  session()?.sendInteract(MUSIC_INTERACT, BigInt(pick.id), MUSIC_ACT.start);
  setEmote(EMOTE_SELF, EMOTE_PLAYING, pick.id, view.feet.x, view.feet.y, view.feet.z);
  if (!lookRouter.blockMove) {
    lookRouter.blockMove = true;
    movedBlock = true;
  }
  return true;
}

/** Leave play mode (Esc). */
export function exitPlay(tell = true): void {
  const st = useMusic.getState();
  if (!st.active) return;
  releaseAll();
  batcher.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  useMusic.setState({ active: false, pressed: {} });
  if (tell) session()?.sendInteract(MUSIC_INTERACT, 0n, MUSIC_ACT.stop);
  const r = emoteOf(EMOTE_SELF);
  if (r && r.id === EMOTE_PLAYING) setEmote(EMOTE_SELF, 0, 0, view.feet.x, view.feet.y, view.feet.z);
  if (movedBlock) {
    lookRouter.blockMove = false;
    movedBlock = false;
  }
  audio?.setClick(null);
}

/** Switch to the next instrument you carry (Tab). */
export function cycleInstrument(): void {
  const carried = carriedInstruments();
  if (carried.length < 2) return;
  const i = carried.findIndex((d) => d.id === useMusic.getState().instrument);
  const next = carried[(i + 1) % carried.length];
  releaseAll();
  useMusic.setState({ instrument: next.id, octave: octaveFor(next.id) });
  void loadMusicAudio().then((m) => m.warmInstrument(next));
  session()?.sendInteract(MUSIC_INTERACT, BigInt(next.id), MUSIC_ACT.start);
  setEmote(EMOTE_SELF, EMOTE_PLAYING, next.id, view.feet.x, view.feet.y, view.feet.z);
}

/** The note a key plays now (null: not a note key), folded into the instrument's range. */
export function noteOfKey(code: string, shift: boolean): number | null {
  const st = useMusic.getState();
  const def = instrumentDef(st.instrument);
  const m = keyToMidi(code, scaleByKey(st.scale), st.root, st.octave, shift);
  if (m === null || !def) return null;
  return foldIntoRange(m, def.range);
}

/** A note key went down: sound it now, queue it for the zone, pose the avatar. */
export function noteDown(code: string, shift: boolean, accent: boolean): number | null {
  const st = useMusic.getState();
  const def = instrumentDef(st.instrument);
  if (!st.active || !def || held.has(code)) return null;
  const midi = noteOfKey(code, shift);
  if (midi === null) return null;
  const vel = velocityOf(st.dynamics, accent);
  const now = performance.now();
  held.set(code, midi);
  if (audio) audio.localNote(def, code, midi, vel);
  else void loadMusicAudio().then((m) => m.localNote(def, code, midi, vel));
  batcher.add(midi, vel, now);
  armFlush();
  addNoteHit(SELF, midi, vel, now);
  useMusic.setState((s) => ({ pressed: { ...s.pressed, [code]: midi }, played: s.played + 1 }));
  return midi;
}

/** A note key came up: a held (sustain) note ends. */
export function noteUp(code: string): void {
  const midi = held.get(code);
  if (midi === undefined) return;
  held.delete(code);
  const st = useMusic.getState();
  const def = instrumentDef(st.instrument);
  if (def?.sustain) {
    audio?.localRelease(code);
    batcher.add(midi, 0, performance.now());
    armFlush();
  }
  useMusic.setState((s) => {
    const p = { ...s.pressed };
    delete p[code];
    return { pressed: p };
  });
}

function releaseAll(): void {
  for (const code of [...held.keys()]) noteUp(code);
}

/** Your metronome click on or off; on with no jam nearby starts one (you lead it, everyone near you gets it). */
export function setClick(on: boolean): void {
  const st = useMusic.getState();
  useMusic.setState({ click: on });
  if (!on) {
    if (st.jam && st.jam.leader === selfId()) setTempo(0);
    else audio?.setClick(null);
    return;
  }
  if (st.jam) audio?.setClick(st.jam);
  else setTempo(st.bpm);
}

/** Set (or with 0 stop) the shared metronome. */
export function setTempo(bpm: number): void {
  const [lo, hi] = CONTENT.instruments.jam.bpm;
  const b = bpm === 0 ? 0 : Math.max(lo, Math.min(hi, Math.round(bpm)));
  if (b) useMusic.setState({ bpm: b });
  const s = session();
  if (s) {
    s.sendInteract(MUSIC_INTERACT, 0n, MUSIC_ACT.tempo, b);
    return;
  }
  // Offline: a metronome of your own.
  applyJam(b ? { leader: SELF, leaderName: 'You', bpm: b, epoch: performance.now(), epochLocal: performance.now() } : null);
}

function selfId(): number {
  return netRuntime.session?.welcome?.entityId ?? SELF;
}

function applyJam(j: import('./store').JamState | null): void {
  useMusic.setState({ jam: j });
  const st = useMusic.getState();
  if (j && st.click) void loadMusicAudio().then((m) => m.setClick(j));
  else if (!j) audio?.setClick(null);
}

// ---- the zone's side

const playouts = new Map<number, Playout>();

function onNotes(e: ZoneEvent): void {
  const def = instrumentDef(e.targetId);
  if (!def) return;
  let p = playouts.get(e.entityId);
  if (!p) playouts.set(e.entityId, (p = new Playout()));
  const now = performance.now();
  const start = p.schedule(e.value & 0xffff, now);
  const at = { x: e.x / 100, y: e.y / 100 + 1.2, z: e.z / 100 };
  const notes = decodeNotesData(e.data);
  for (const n of notes) {
    const when = start + n.offsetMs;
    if (n.vel > 0) addNoteHit(e.entityId, n.note, n.vel, when);
  }
  const go = (m: AudioMod) => m.remoteNotes(e.entityId, def, notes, start, at);
  if (audio) go(audio);
  else void loadMusicAudio().then(go);
}

const listener = (e: ZoneEvent) => {
  switch (e.kind) {
    case EV_MUSIC_NOTES:
      onNotes(e);
      break;
    case EV_MUSIC_REFUSED: {
      const st = useMusic.getState();
      if (e.value === 3 && st.active && performance.now() - lastRestart > 3000) {
        // The zone stopped us (a handoff, a knock that moved you): pick it up again once.
        lastRestart = performance.now();
        session()?.sendInteract(MUSIC_INTERACT, BigInt(st.instrument), MUSIC_ACT.start);
        return;
      }
      musicToast(MUSIC_REFUSAL[e.value] ?? 'Not now');
      if (e.value !== 4 && e.value !== 5) exitPlay(false);
      break;
    }
    case EV_MUSIC_SONG: {
      let j: { notes?: number; seconds?: number; applause?: number; line?: string } = {};
      try {
        j = JSON.parse(new TextDecoder().decode(e.data));
      } catch {
        /* the counts below */
      }
      const song = { notes: j.notes ?? e.value, seconds: j.seconds ?? 0, applause: j.applause ?? e.targetId, line: j.line ?? '', at: performance.now() };
      useMusic.setState({ lastSong: song });
      musicToast(song.line || `A song of ${song.notes} notes`);
      break;
    }
    case EV_JAM_TEMPO: {
      const s = netRuntime.session;
      if (!e.value) {
        const j = useMusic.getState().jam;
        if (j && j.leader === e.entityId) applyJam(null);
        break;
      }
      const dv = new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      const epoch = e.data.byteLength >= 8 ? Number(dv.getBigUint64(0, true)) : 0;
      // Server ms -> local performance ms through the session's clock sync.
      const offset = s ? s.clock.serverNow() - performance.now() : 0;
      const name = e.entityId === selfId() ? 'You' : drawnRemotes.views.find((v) => v.id === e.entityId)?.name || 'Someone';
      applyJam({ leader: e.entityId, leaderName: name, bpm: e.value, epoch, epochLocal: epoch - offset });
      if (e.entityId !== selfId()) musicToast(`${name} keeps time at ${e.value} bpm (Enter: the click)`);
      break;
    }
  }
};

let hooked: ZoneSession | null = null;

/** Hook the live session if it changed (the overlay calls it on a timer). */
export function ensureMusicHook(): void {
  const s = netRuntime.session;
  if (s === hooked) return;
  hooked?.eventListeners.delete(listener);
  hooked = s;
  playouts.clear();
  clearNoteHits();
  if (useMusic.getState().active) exitPlay(false);
  useMusic.setState({ jam: null });
  s?.eventListeners.add(listener);
}

/** Dev builds: every instrument in your pack (Interact 120/9). */
export function devInstruments(): void {
  session()?.sendInteract(MUSIC_INTERACT, 0n, MUSIC_ACT.devKit);
}

/** The instrument an inventory item is (null: not one). */
export function instrumentItem(itemKey: string): InstrumentDef | null {
  return instrumentOfItem(itemKey) ?? null;
}
