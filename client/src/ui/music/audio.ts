// Playtest 2 instruments (CR 028): the sound of playing (a lazy chunk:
// loaded when you pick up an instrument or first hear someone play).
//
// Your own instrument plays at once, centred, on the sfx bus. Everyone
// else's is a positional source at their body: the audio system's own
// rules (audio/spatial.ts): inverse distance easing to silence at
// instruments.hearM, air absorption, walls and rock between you and them
// (the engine's acoustic spaces), equal-power panning for direction; and
// through the engine's reverb send, so a song in a cave or a closed
// building rings in it (the engine sets the send from where you stand).
// Sources follow the drawn avatar 10 times a second while they sound.
// Voices are capped (per player and in all); the background music ducks
// while instruments play near you (audio/bridge.ts audioWorld).

import { CONTENT, type InstrumentDef } from '@lodestone/contracts';
import { audioWorld, type Vec3 } from '../../audio/bridge';
import { busInput, getAudioContext } from '../../audio/context';
import { audioEngine } from '../../audio/engine';
import { airLowpassHz, distanceGain, LOWPASS_BYPASS_HZ, occlusion, type Falloff } from '../../audio/spatial';
import { liveAvatars } from '../../net/avatar';
import { midiToHz } from './theory';
import { NoteCache, startVoice, type VoiceHandle } from './synth';
import type { JamState } from './store';
import type { VoiceKind } from './voices';
import type { NoteEvent } from './wire';

const FALLOFF: Falloff = { ref: 3, max: CONTENT.instruments.hearM, rolloff: 1.1 };
const LOCAL_VOICES = 16;
const SOURCE_VOICES = 10;
const ALL_VOICES = 48;
const UPDATE_MS = 100;
/** Background music ducks while an instrument sounds this close (m). */
const DUCK_M = 24;

interface Source {
  id: number;
  input: GainNode;
  dist: GainNode;
  lp: BiquadFilterNode;
  pan: PannerNode | null;
  send: GainNode | null;
  voices: VoiceHandle[];
  held: Map<string | number, VoiceHandle>;
  at: Vec3;
  lastNote: number;
}

let cache: NoteCache | null = null;
const sources = new Map<number, Source>();
let local: Source | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let total: VoiceHandle[] = [];

function ctx(): AudioContext | null {
  return getAudioContext();
}

function noteCache(c: AudioContext): NoteCache {
  if (!cache) cache = new NoteCache(c);
  return cache;
}

function makeSource(id: number, positional: boolean): Source | null {
  const c = ctx();
  const bus = busInput('sfx');
  if (!c || !bus) return null;
  const input = c.createGain();
  input.gain.value = positional ? 1 : 0.85;
  const dist = c.createGain();
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 20000;
  lp.Q.value = 0.5;
  input.connect(dist).connect(lp);
  let tail: AudioNode = lp;
  let pan: PannerNode | null = null;
  if (positional) {
    pan = c.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.rolloffFactor = 0; // direction only: distance is spatial.ts's (dist)
    lp.connect(pan);
    tail = pan;
  }
  tail.connect(bus);
  const eng = audioEngine();
  let send: GainNode | null = null;
  if (eng) {
    send = c.createGain();
    send.gain.value = 0.85;
    tail.connect(send).connect(eng.sfx.reverbSend);
  }
  return { id, input, dist, lp, pan, send, voices: [], held: new Map(), at: { x: 0, y: 0, z: 0 }, lastNote: 0 };
}

/** Distance, air and walls from the listener to a source (the audio engine's rules). */
function place(s: Source): void {
  const c = ctx();
  const eng = audioEngine();
  if (!c || !s.pan) return;
  const av = liveAvatars.get(s.id);
  if (av) {
    const p = av.root.position;
    s.at = { x: p.x, y: p.y + 1.2, z: p.z };
  }
  const L = eng?.sfx.listener ?? s.at;
  const d = Math.hypot(s.at.x - L.x, s.at.y - L.y, s.at.z - L.z);
  let g = distanceGain(d, FALLOFF);
  let lpHz = airLowpassHz(d);
  if (eng?.sfx.spaceOf) {
    const o = occlusion(eng.sfx.listenerSpace, eng.sfx.spaceOf(s.at.x, s.at.y, s.at.z), eng.sfx.leak);
    g *= o.gain;
    lpHz = Math.min(lpHz, o.lowpassHz);
  }
  const t = c.currentTime;
  s.dist.gain.setTargetAtTime(g, t, 0.05);
  s.lp.frequency.setTargetAtTime(lpHz >= LOWPASS_BYPASS_HZ ? 20000 : Math.max(200, lpHz), t, 0.05);
  if (s.pan.positionX) {
    s.pan.positionX.setTargetAtTime(s.at.x, t, 0.03);
    s.pan.positionY.setTargetAtTime(s.at.y, t, 0.03);
    s.pan.positionZ.setTargetAtTime(s.at.z, t, 0.03);
  } else s.pan.setPosition(s.at.x, s.at.y, s.at.z);
  if (d < DUCK_M && g > 0.05) audioWorld.instrumentUntil = Math.max(audioWorld.instrumentUntil, performance.now() + 2500);
}

function tick(): void {
  const now = performance.now();
  const c = ctx();
  for (const s of sources.values()) {
    if (now - s.lastNote > 12000 && !s.held.size) {
      try {
        s.input.disconnect();
        s.pan?.disconnect();
        s.send?.disconnect();
      } catch {
        /* gone */
      }
      sources.delete(s.id);
      continue;
    }
    place(s);
  }
  if (c) total = total.filter((v) => v.ends > c.currentTime);
  if (!sources.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function admit(s: Source, max: number): void {
  const c = ctx();
  if (!c) return;
  const t = c.currentTime;
  s.voices = s.voices.filter((v) => v.ends > t);
  if (s.voices.length >= max) s.voices.shift()?.stop(t);
  total = total.filter((v) => v.ends > t);
  if (total.length >= ALL_VOICES) total.shift()?.stop(t);
}

function sound(s: Source, def: InstrumentDef, midi: number, vel: number, when: number, key: string | number | null): void {
  const c = ctx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  admit(s, s.pan ? SOURCE_VOICES : LOCAL_VOICES);
  const v = startVoice(c, s.input, def.voice as VoiceKind, midi, vel, when, noteCache(c), CONTENT.instruments.holdMaxS);
  s.voices.push(v);
  total.push(v);
  if (key !== null && def.sustain) {
    s.held.get(key)?.release(when);
    s.held.set(key, v);
  }
  s.lastNote = performance.now();
}

/** Your own note, now. `code` keys a held note for its release. */
export function localNote(def: InstrumentDef, code: string, midi: number, vel: number): void {
  if (!local) local = makeSource(-1, false);
  const c = ctx();
  if (!local || !c) return;
  // Re-attach the reverb send if the engine booted after the source was made.
  if (!local.send && audioEngine()) {
    local = makeSource(-1, false);
    if (!local) return;
  }
  sound(local, def, midi, vel, c.currentTime + 0.005, code);
  audioWorld.instrumentUntil = Math.max(audioWorld.instrumentUntil, performance.now() + 2500);
}

export function localRelease(code: string): void {
  const c = ctx();
  const v = local?.held.get(code);
  if (!c || !v) return;
  v.release(c.currentTime + 0.005);
  local!.held.delete(code);
}

/** Another player's batch: `startMs` is the local performance time the batch starts (the jitter buffer's). */
export function remoteNotes(entity: number, def: InstrumentDef, notes: NoteEvent[], startMs: number, at: Vec3): void {
  const c = ctx();
  if (!c) return;
  let s = sources.get(entity);
  if (!s) {
    const made = makeSource(entity, true);
    if (!made) return;
    s = made;
    s.at = at;
    sources.set(entity, s);
  }
  place(s);
  if (!timer) timer = setInterval(tick, UPDATE_MS);
  const base = c.currentTime + (startMs - performance.now()) / 1000;
  for (const n of notes) {
    const when = Math.max(c.currentTime + 0.002, base + n.offsetMs / 1000);
    if (n.vel > 0) sound(s, def, n.note, n.vel, when, n.note);
    else {
      s.held.get(n.note)?.release(when);
      s.held.delete(n.note);
    }
  }
}

/** Render the notes of an instrument's keyboard ahead (entering play mode): the first notes sound with no render cost. */
export function warmInstrument(def: InstrumentDef): void {
  const c = ctx();
  if (!c || def.voice === 'flute') return;
  const notes: number[] = [];
  for (let m = def.range[0]; m <= def.range[1]; m++) notes.push(m);
  const nc = noteCache(c);
  // In slices on idle time: about a millisecond or two per note.
  let i = 0;
  const step = () => {
    const t0 = performance.now();
    while (i < notes.length && performance.now() - t0 < 6) nc.warm(def.voice as VoiceKind, [notes[i++]], 5);
    if (i < notes.length) setTimeout(step, 16);
  };
  setTimeout(step, 0);
}

// ---- the metronome click (local, aligned to the jam's downbeat on the server clock)

let clickTimer: ReturnType<typeof setInterval> | null = null;
let clickJam: JamState | null = null;
let nextBeat = 0;

/** Click along with a jam (null stops). */
export function setClick(j: JamState | null): void {
  clickJam = j;
  if (clickTimer) clearInterval(clickTimer);
  clickTimer = null;
  if (!j) return;
  const beatMs = 60000 / j.bpm;
  nextBeat = Math.ceil((performance.now() - j.epochLocal) / beatMs);
  clickTimer = setInterval(scheduleClicks, 40);
  scheduleClicks();
}

function scheduleClicks(): void {
  const c = ctx();
  const j = clickJam;
  const bus = busInput('ui');
  if (!c || !j || !bus) return;
  const beatMs = 60000 / j.bpm;
  const now = performance.now();
  while (j.epochLocal + nextBeat * beatMs < now + 150) {
    const atMs = j.epochLocal + nextBeat * beatMs;
    if (atMs >= now - 5) {
      const when = c.currentTime + (atMs - now) / 1000;
      const down = ((nextBeat % 4) + 4) % 4 === 0;
      const o = c.createOscillator();
      o.frequency.value = down ? midiToHz(96) : midiToHz(89);
      const g = c.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(down ? 0.22 : 0.13, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, when + 0.05);
      o.connect(g).connect(bus);
      o.start(when);
      o.stop(when + 0.06);
    }
    nextBeat++;
  }
}

/** Debug handle: what is sounding. */
export function musicAudioDebug(): { sources: number; voices: number; cached: number; click: number | null } {
  const c = ctx();
  return { sources: sources.size, voices: c ? total.filter((v) => v.ends > c.currentTime).length : 0, cached: cache?.size ?? 0, click: clickJam?.bpm ?? null };
}
