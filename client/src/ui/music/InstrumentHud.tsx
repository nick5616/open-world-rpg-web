// Playtest 2 instruments (CR 028): play mode. U picks up the instrument you
// carry; the keyboard becomes four rows of a scale (numbers an octave up,
// Q W E R ... from the root, A S D ... an octave down, Z X C ... two down),
// Shift raises a note an octave, Space accents it, the mouse wheel moves the
// keyboard by octaves, the arrows change the root (left / right) and the
// scale (up / down), Tab the instrument, Enter the metronome click; Esc puts
// the instrument away. The overlay shows every key's note.
//
// Keys: the handler is installed when this module loads (before any
// panel's own capture listener, like photo mode) and, while playing,
// swallows every key so no spell, prompt or panel reacts; key-ups of the
// movement keys still pass (a held W is let go). The overlay is a
// data-ui-panel and on the panel stack (input/panelStack.ts): Esc puts
// the instrument away.

import { useEffect, useState, type CSSProperties } from 'react';
import { CONTENT } from '@lodestone/contracts';
import { isTextTarget } from '../../input/useKeyboard';
import { DEBUG } from '../../config';
import { usePvp } from '../pvp/store';
import { carriedInstruments, cycleInstrument, devInstruments, ensureMusicHook, enterPlay, exitPlay, loadMusicAudio, noteDown, noteOfKey, noteUp, setClick, setTempo } from './link';
import { instrumentDef, musicToast, useMusic } from './store';
import { trackPanel } from '../../input/panelStack';

// Esc puts the instrument away when play mode is the top thing open (input/panelStack.ts).
trackPanel(useMusic, (s) => !!s.active, 'instrument', () => exitPlay());
import { clampOctave, DYNAMICS, isNoteKey, KEY_ROWS, noteName, pitchClassName, ROOT_NAMES, scaleByKey, SCALES } from './theory';

export const PLAY_KEY = 'KeyU'; // U: the one letter free outside a duel challenge (Y/U answer one; a pending challenge keeps U)

function panelUp(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>('[data-ui-panel]:not([style*="display: none"])')) {
    if (el.dataset.testid !== 'music-overlay' && el.getClientRects().length > 0) return true;
  }
  return false;
}

function gameCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('canvas[data-engine]');
}

let accent = false;

function onKey(e: KeyboardEvent): void {
  const st = useMusic.getState();
  if (!st.active) {
    if (e.type !== 'keydown' || e.code !== PLAY_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextTarget(e.target) || panelUp()) return;
    if (!gameCanvas() || usePvp.getState().challenge) return; // not in the world; U declines a duel
    e.preventDefault();
    e.stopImmediatePropagation();
    enterPlay();
    return;
  }
  if (isTextTarget(e.target)) return; // the overlay's own selects
  if (e.ctrlKey || e.metaKey) return; // browser shortcuts stay the browser's
  // A duel challenge waiting for an answer keeps Y and U (accept / decline) even while you play.
  if ((e.code === 'KeyY' || e.code === 'KeyU') && usePvp.getState().challenge) return;
  if (e.code === 'Space') accent = e.type === 'keydown';
  if (e.type === 'keyup') {
    // Every release still reaches the game: a key held before you picked the instrument up
    // (W, a spell key, Z) must not stay held (playtest 2 integration QA).
    if (isNoteKey(e.code)) noteUp(e.code);
    return;
  }
  if (/^F\d+$/.test(e.code)) return; // F-keys (debug, graphics) stay
  if (e.code === 'Escape') return; // the Esc menu's listener closes the top thing: this mode, or a panel over it (input/panelStack.ts)
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.repeat) return;
  const s = useMusic.getState();
  switch (e.code) {
    case 'ArrowLeft':
    case 'ArrowRight':
      useMusic.setState({ root: (s.root + (e.code === 'ArrowRight' ? 1 : 11)) % 12 });
      return;
    case 'ArrowUp':
    case 'ArrowDown': {
      const i = SCALES.findIndex((x) => x.key === s.scale);
      useMusic.setState({ scale: SCALES[(i + (e.code === 'ArrowDown' ? 1 : SCALES.length - 1)) % SCALES.length].key });
      return;
    }
    case 'Tab':
      cycleInstrument();
      return;
    case 'Enter':
      setClick(!s.click);
      return;
  }
  if (isNoteKey(e.code)) noteDown(e.code, e.shiftKey, accent);
}

function onMouse(e: MouseEvent): void {
  if (!useMusic.getState().active || e.type === 'mouseup') return; // a release always reaches combat (no held attack)
  if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
  e.stopImmediatePropagation(); // no attacks or casts while the hands are on an instrument
}

function onWheel(e: WheelEvent): void {
  if (!useMusic.getState().active) return;
  const t = e.target as HTMLElement | null;
  if (t?.tagName !== 'CANVAS' && !t?.closest?.('[data-testid="music-overlay"]')) return;
  e.stopImmediatePropagation();
  if (Math.abs(e.deltaY) < 1) return;
  useMusic.setState((s) => ({ octave: clampOctave(s.octave + (e.deltaY < 0 ? 1 : -1)) }));
}

function onBlur(): void {
  accent = false;
  const p = useMusic.getState().pressed;
  for (const code of Object.keys(p)) noteUp(code);
}

if (typeof window !== 'undefined') {
  const w = window as Window & { __lsMusicKeys?: [(e: KeyboardEvent) => void, (e: MouseEvent) => void, (e: WheelEvent) => void, () => void] };
  if (w.__lsMusicKeys) {
    const [k, m, wh, b] = w.__lsMusicKeys;
    window.removeEventListener('keydown', k, true);
    window.removeEventListener('keyup', k, true);
    window.removeEventListener('mousedown', m, true);
    window.removeEventListener('mouseup', m, true);
    window.removeEventListener('wheel', wh, true);
    window.removeEventListener('blur', b);
  }
  w.__lsMusicKeys = [onKey, onMouse, onWheel, onBlur];
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
  window.addEventListener('mouseup', onMouse, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('blur', onBlur);
}

// ---- the overlay

const GOLD = '#ffd166';
const TEXT = '#f4efe2';
const panel: CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 18,
  transform: 'translateX(-50%)',
  width: 'min(760px, calc(100vw - 32px))',
  padding: '10px 14px 12px',
  borderRadius: 12,
  background: 'rgba(14,12,10,0.82)',
  border: '1px solid rgba(255,209,102,0.28)',
  boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
  color: TEXT,
  font: '13px system-ui, sans-serif',
  zIndex: 32,
  pointerEvents: 'auto',
  userSelect: 'none',
};
const btn: CSSProperties = { background: 'rgba(255,255,255,0.08)', color: TEXT, border: '1px solid rgba(255,255,255,0.18)', borderRadius: 6, padding: '2px 8px', font: '12px system-ui, sans-serif', cursor: 'pointer' };
const on: CSSProperties = { ...btn, background: 'rgba(255,209,102,0.22)', borderColor: GOLD, color: GOLD };
const sel: CSSProperties = { background: '#1d1a16', color: TEXT, border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, padding: '2px 4px', font: '12px system-ui, sans-serif' };

function useTicker(active: boolean, ms: number): number {
  const [t, setT] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setT(performance.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return t;
}

function Keyboard() {
  const st = useMusic();
  const scale = scaleByKey(st.scale);
  const def = instrumentDef(st.instrument);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
      {KEY_ROWS.map((row, ri) => (
        <div key={row.name} style={{ display: 'flex', gap: 4, paddingLeft: [0, 18, 28, 46][ri] }}>
          {row.codes.map((code, i) => {
            const midi = noteOfKey(code, false);
            const pressed = st.pressed[code] !== undefined;
            const isRoot = midi !== null && (((midi - st.root) % 12) + 12) % 12 === 0;
            const drum = def?.voice === 'drum';
            const label = midi === null ? '' : drum ? (midi < 48 ? 'bass' : midi < 72 ? 'tone' : 'slap') : pitchClassName(midi, st.root, scale);
            return (
              <div
                key={code}
                data-key={code}
                data-note={midi ?? ''}
                title={midi === null ? '' : noteName(midi, st.root, scale)}
                style={{
                  width: 50,
                  height: 40,
                  borderRadius: 6,
                  boxSizing: 'border-box',
                  border: `1px solid ${isRoot ? GOLD : 'rgba(255,255,255,0.16)'}`,
                  background: pressed ? 'rgba(255,209,102,0.55)' : isRoot ? 'rgba(255,209,102,0.12)' : 'rgba(255,255,255,0.05)',
                  boxShadow: pressed ? `0 0 10px ${GOLD}` : 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: '2px 5px',
                  transition: 'background 60ms',
                }}
              >
                <span style={{ fontSize: 10, opacity: 0.6 }}>{row.labels[i]}</span>
                <span style={{ fontWeight: 600, fontSize: drum ? 11 : 13, alignSelf: 'flex-end', color: isRoot ? GOLD : TEXT }}>{label}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Beat() {
  const jam = useMusic((s) => s.jam);
  const click = useMusic((s) => s.click);
  const now = useTicker(!!jam, 33);
  if (!jam) return null;
  const beatMs = 60000 / jam.bpm;
  const ph = (now - jam.epochLocal) / beatMs;
  const k = Math.max(0, 1 - (ph - Math.floor(ph)) * 4);
  const down = ((Math.floor(ph) % 4) + 4) % 4 === 0;
  return (
    <span data-testid="music-beat" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 5, background: down ? GOLD : '#9ad1ff', opacity: 0.25 + 0.75 * k, display: 'inline-block' }} />
      <span style={{ opacity: 0.85 }}>
        {jam.bpm} bpm · {jam.leaderName === 'You' ? 'your tempo' : `with ${jam.leaderName}`}
        {click ? '' : ' (click off)'}
      </span>
    </span>
  );
}

function Overlay() {
  const st = useMusic();
  const def = instrumentDef(st.instrument);
  const carried = carriedInstruments();
  const scale = scaleByKey(st.scale);
  const [lo, hi] = CONTENT.instruments.jam.bpm;
  if (!def) return null;
  return (
    <div data-testid="music-overlay" data-ui-panel style={panel}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <span style={{ font: '600 15px Georgia, serif', color: GOLD }}>♪ {def.name}</span>
        {carried.length > 1 &&
          carried.map((d) => (
            <button key={d.id} data-silent style={d.id === def.id ? on : btn} onClick={() => enterPlay(d.id)}>
              {d.name}
            </button>
          ))}
        <label>
          Key{' '}
          <select data-testid="music-root" style={sel} value={st.root} onChange={(e) => {
              useMusic.setState({ root: +e.target.value });
              e.target.blur(); // the keys play notes again
            }}>
            {ROOT_NAMES.map((n, i) => (
              <option key={n} value={i}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <select data-testid="music-scale" style={sel} value={st.scale} onChange={(e) => {
            useMusic.setState({ scale: e.target.value });
            e.target.blur();
          }}>
          {SCALES.map((x) => (
            <option key={x.key} value={x.key}>
              {x.name}
            </option>
          ))}
        </select>
        <span>
          Octave{' '}
          <button data-silent style={btn} onClick={() => useMusic.setState({ octave: clampOctave(st.octave - 1) })}>
            −
          </button>{' '}
          <b data-testid="music-octave">{st.octave}</b>{' '}
          <button data-silent style={btn} onClick={() => useMusic.setState({ octave: clampOctave(st.octave + 1) })}>
            +
          </button>
        </span>
        <span>
          {DYNAMICS.map((d) => (
            <button key={d.label} data-silent style={{ ...(st.dynamics === d.vel ? on : btn), fontStyle: 'italic', marginRight: 2 }} onClick={() => useMusic.setState({ dynamics: d.vel })}>
              {d.label}
            </button>
          ))}
        </span>
        <span>
          <button data-silent data-testid="music-click" style={st.click ? on : btn} onClick={() => setClick(!st.click)}>
            Click
          </button>{' '}
          <button data-silent style={btn} onClick={() => setTempo(Math.max(lo, st.bpm - 4))}>
            −
          </button>{' '}
          {st.bpm}{' '}
          <button data-silent style={btn} onClick={() => setTempo(Math.min(hi, st.bpm + 4))}>
            +
          </button>{' '}
          bpm
        </span>
      </div>
      <Keyboard />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, fontSize: 11, opacity: 0.8, gap: 10, flexWrap: 'wrap' }}>
        <span>
          {ROOT_NAMES[st.root]} {scale.name.toLowerCase()} · Shift: an octave up · Space: accent · wheel: octave · ←→ key · ↑↓ scale{carried.length > 1 ? ' · Tab: instrument' : ''} · Enter: click
        </span>
        <span>
          <Beat /> <b style={{ color: GOLD, marginLeft: 6 }}>Esc</b> puts it away
        </span>
      </div>
    </div>
  );
}

function Toast() {
  const t = useMusic((s) => s.toast);
  const now = useTicker(!!t, 250);
  if (!t || now - t.at > 3500) return null;
  return (
    <div data-testid="music-toast" style={{ position: 'fixed', left: '50%', bottom: useMusic.getState().active ? 312 : 120, transform: 'translateX(-50%)', padding: '6px 12px', borderRadius: 8, background: 'rgba(14,12,10,0.78)', border: '1px solid rgba(255,209,102,0.3)', color: TEXT, font: '13px system-ui, sans-serif', zIndex: 33, pointerEvents: 'none', maxWidth: '80vw', textAlign: 'center' }}>
      {t.text}
    </div>
  );
}

export function InstrumentHud() {
  const active = useMusic((s) => s.active);
  useEffect(() => {
    ensureMusicHook();
    const id = setInterval(ensureMusicHook, 500);
    return () => {
      clearInterval(id);
      exitPlay();
    };
  }, []);
  return (
    <>
      {active && <Overlay />}
      <Toast />
    </>
  );
}

if (DEBUG && typeof window !== 'undefined') {
  (window as unknown as { __lodestoneMusic?: unknown }).__lodestoneMusic = {
    state: () => {
      const s = useMusic.getState();
      return { active: s.active, instrument: s.instrument, scale: s.scale, root: s.root, octave: s.octave, dynamics: s.dynamics, played: s.played, jam: s.jam ? { bpm: s.jam.bpm, leader: s.jam.leader } : null, click: s.click, lastSong: s.lastSong, carried: carriedInstruments().map((d) => d.key) };
    },
    enter: (id?: number) => enterPlay(id),
    exit: () => exitPlay(),
    dev: () => devInstruments(),
    /** Press a note key for `ms` (as the keyboard would). */
    key: (code: string, ms = 180, shift = false) => {
      const m = noteDown(code, shift, false);
      setTimeout(() => noteUp(code), ms);
      return m;
    },
    set: (p: Partial<{ scale: string; root: number; octave: number; dynamics: number; bpm: number }>) => useMusic.setState(p),
    tempo: (bpm: number) => setTempo(bpm),
    click: (on: boolean) => setClick(on),
    toast: (t: string) => musicToast(t),
    audio: async () => (await loadMusicAudio()).musicAudioDebug(),
    /** Render an instrument's phrase offline: base64 WAV and its levels (reverb 0..1 through a cave). */
    render: async (key: string, reverb = 0) => {
      const r = await import('./render');
      const inst = r.instrumentByKey(key);
      if (!inst) return null;
      const buf = await r.renderPhrase(inst, r.phraseFor(inst), { reverb, radius: 10 });
      const wav = r.encodeWav(buf);
      let bin = '';
      for (let i = 0; i < wav.length; i += 0x8000) bin += String.fromCharCode(...wav.subarray(i, i + 0x8000));
      return { b64: btoa(bin), ...r.levels(buf), sampleRate: buf.sampleRate, channels: buf.numberOfChannels };
    },
  };
}
