// Music for the title cavern and character select/creation (playtest 4):
// Nicole's "main menu theme", looped sample-exact. It lives in the main
// bundle, beside context.ts, because the audio engine (and the director) is a
// lazy chunk that only loads after the first playable frame: the title screen
// has to sound before that.
//
// Browsers need a user gesture first: the page-wide unlock (context.ts) creates
// the AudioContext on the first click or key, `onAudioReady` fires, and the
// theme starts then (fading in over TITLE_MUSIC.fadeIn). A visitor who clicks
// Play at once hears it from the character screen. It plays through the
// account step and the world's loading screen; the engine hands it over
// (`releaseTitleMusic`) the moment the world's own music begins, and the
// two crossfade. It goes through the music bus, so the player's music volume,
// the master volume and mute apply.
//
// The asset is a seamless loop built by tools/audio/build-audio.mjs (`fold`:
// the last 4 beats are blended into the first, so the file wraps with no seam),
// decoded whole (~21 MB of PCM, freed when it stops) and looped with a buffer
// source: Opus and AAC streams cannot loop gaplessly through a media element.

import { useAppStore } from '../../stores/appStore';
import { assetUrl } from '../assets';
import { busInput, getAudioContext, onAudioReady } from '../context';
import { TITLE_MUSIC } from './tracks';

interface Running {
  src: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
}

let buffer: AudioBuffer | null = null;
let loading: Promise<AudioBuffer | null> | null = null;
let running: Running | null = null;
let installed = false;
let handoffTimer: ReturnType<typeof setTimeout> | null = null;

/** The title theme belongs to every screen before the world. */
function wanted(): boolean {
  return useAppStore.getState().screen !== 'play';
}

async function load(ctx: AudioContext): Promise<AudioBuffer | null> {
  if (buffer) return buffer;
  loading ??= (async () => {
    const url = assetUrl(TITLE_MUSIC.track);
    if (!url) return null;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      buffer = await ctx.decodeAudioData(await r.arrayBuffer());
      return buffer;
    } catch {
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Start the theme if it should be playing and the context exists (idempotent). */
export function startTitleMusic(): void {
  const ctx = getAudioContext();
  const bus = busInput('music');
  if (!ctx || !bus || running || !wanted()) return;
  void load(ctx).then((b) => {
    // The screen may have moved on while it decoded, or another start won.
    if (!b || running || !wanted()) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = b.duration;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(TITLE_MUSIC.gain, t + TITLE_MUSIC.fadeIn);
    src.connect(gain).connect(bus);
    src.start(t);
    running = { src, gain, startedAt: t };
  });
}

/** Fade the theme out (s) and let go of its memory. Safe to call when it is not playing. */
export function releaseTitleMusic(fade = 4): void {
  const r = running;
  if (handoffTimer) {
    clearTimeout(handoffTimer);
    handoffTimer = null;
  }
  if (!r) return;
  running = null;
  const ctx = r.src.context;
  const t = ctx.currentTime;
  r.gain.gain.cancelScheduledValues(t);
  r.gain.gain.setValueAtTime(r.gain.gain.value, t);
  r.gain.gain.linearRampToValueAtTime(0, t + fade);
  try {
    r.src.stop(t + fade + 0.05);
  } catch {
    /* already stopped */
  }
  r.src.onended = () => {
    r.src.disconnect();
    r.gain.disconnect();
    if (!running) buffer = null;
  };
}

export interface TitleMusicStatus {
  playing: boolean;
  track: string;
  loop: boolean;
  /** Loop length in samples (the decoded buffer) and seconds. */
  length: number | null;
  seconds: number | null;
  /** Position in the loop (s) and how many times it has wrapped. */
  position: number;
  wraps: number;
  gain: number;
}

export function titleMusicStatus(): TitleMusicStatus {
  const ctx = getAudioContext();
  const b = running?.src.buffer ?? buffer;
  const elapsed = running && ctx ? Math.max(0, ctx.currentTime - running.startedAt) : 0;
  const dur = b?.duration ?? 0;
  return { playing: !!running, track: TITLE_MUSIC.track, loop: running?.src.loop ?? false, length: b?.length ?? null, seconds: b ? dur : null, position: dur ? elapsed % dur : 0, wraps: dur ? Math.floor(elapsed / dur) : 0, gain: running?.gain.gain.value ?? 0 };
}

/**
 * Wire it up once (main.tsx, after installAudioUnlock): start on the first
 * gesture, and when the screen returns to the title or the account step.
 * Falls back to letting go by itself if the world never takes over.
 */
export function installTitleMusic(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // The debug handle before the engine exists (the engine's own replaces it, keeping `title`).
  const w = window as unknown as { __lodestoneAudio?: unknown };
  w.__lodestoneAudio ??= { state: () => ({ ctxState: getAudioContext()?.state ?? 'none' }), title: () => titleMusicStatus() };
  onAudioReady(() => startTitleMusic());
  useAppStore.subscribe((s, prev) => {
    if (s.screen === prev.screen) return;
    if (s.screen === 'play') {
      // The engine releases it when the world's music starts; if it never does (no WebGL, a failed boot), go quietly.
      if (handoffTimer) clearTimeout(handoffTimer);
      handoffTimer = setTimeout(() => releaseTitleMusic(3), 120000);
    } else startTitleMusic();
  });
}
