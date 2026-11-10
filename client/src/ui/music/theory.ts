// Playtest 2 instruments (CR 028): what a key plays. Pure, unit-tested
// (music.test.ts): scales, roots, the keyboard rows as scale degrees,
// octaves, and folding a note into an instrument's range.
//
// The keyboard is four rows of a scale, like a tracker or a launchpad in
// scale mode: the letter row (Q W E R ...) starts at the root, the number
// row is the same notes an octave up, the home row (A S D ...) an octave
// down and the bottom row (Z X C ...) two down. Shift raises a key an
// octave; the mouse wheel moves the whole keyboard by octaves.

export interface ScaleDef {
  key: string;
  name: string;
  /** Semitones above the root, ascending, starting at 0. */
  steps: number[];
}

export const SCALES: ScaleDef[] = [
  { key: 'major', name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { key: 'minor', name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { key: 'pentatonic', name: 'Pentatonic', steps: [0, 2, 4, 7, 9] },
  { key: 'minor_pentatonic', name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { key: 'dorian', name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { key: 'mixolydian', name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { key: 'phrygian', name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { key: 'lydian', name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { key: 'harmonic_minor', name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { key: 'blues', name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  { key: 'chromatic', name: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

export function scaleByKey(key: string): ScaleDef {
  return SCALES.find((s) => s.key === key) ?? SCALES[0];
}

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
/** Roots spelled the way most players read them (B♭ and E♭, not A♯ and D♯). */
export const ROOT_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Keys whose scales are written with flats (F, B♭, E♭, A♭, D♭ major and their relatives). */
function usesFlats(root: number, scale: ScaleDef): boolean {
  const minorish = scale.steps.includes(3) && !scale.steps.includes(4);
  const major = minorish ? (root + 3) % 12 : root; // the relative major's key signature
  return [5, 10, 3, 8, 1].includes(major);
}

/** "C4", "F♯3", "B♭5": MIDI 60 is C4. */
export function noteName(midi: number, root = 0, scale: ScaleDef = SCALES[0]): string {
  const m = Math.round(midi);
  const names = usesFlats(root, scale) ? FLAT : SHARP;
  return `${names[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** The name without the octave. */
export function pitchClassName(midi: number, root = 0, scale: ScaleDef = SCALES[0]): string {
  return noteName(midi, root, scale).replace(/-?\d+$/, '');
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** One row of keys: KeyboardEvent.code values, low to high, and the row's octave against the letter row. */
export interface KeyRow {
  name: string;
  codes: string[];
  /** What the overlay prints on the keycap. */
  labels: string[];
  octave: number;
}

export const KEY_ROWS: KeyRow[] = [
  { name: 'numbers', codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'], labels: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='], octave: 1 },
  { name: 'letters', codes: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'], labels: ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']'], octave: 0 },
  { name: 'home', codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'], labels: ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'"], octave: -1 },
  { name: 'bottom', codes: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'], labels: ['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/'], octave: -2 },
];

const BY_CODE = new Map<string, { row: number; index: number }>();
KEY_ROWS.forEach((r, row) => r.codes.forEach((c, index) => BY_CODE.set(c, { row, index })));

/** Is this key a note key? */
export function isNoteKey(code: string): boolean {
  return BY_CODE.has(code);
}

/** Where a key sits: row and index (null: not a note key). */
export function keyPlace(code: string): { row: number; index: number } | null {
  return BY_CODE.get(code) ?? null;
}

/**
 * Scale degree -> MIDI: degree 0 is the root in `octave` (C4 = 60 at octave
 * 4), each `steps.length` degrees climb an octave; negative degrees go down.
 */
export function degreeToMidi(degree: number, scale: ScaleDef, root: number, octave: number): number {
  const n = scale.steps.length;
  const oct = Math.floor(degree / n);
  const step = scale.steps[((degree % n) + n) % n];
  return 12 * (octave + 1) + root + 12 * oct + step;
}

/**
 * The note a key plays: its index in its row is the scale degree, the row
 * shifts it by octaves (letters 0, numbers +1, home -1, bottom -2), Shift
 * adds an octave. Null for a key that isn't a note.
 */
export function keyToMidi(code: string, scale: ScaleDef, root: number, octave: number, shift = false): number | null {
  const p = BY_CODE.get(code);
  if (!p) return null;
  const n = scale.steps.length;
  const row = KEY_ROWS[p.row];
  // The rows repeat the scale per octave; a 12-key row of a pentatonic scale spans more than two octaves.
  return degreeToMidi(p.index + row.octave * n, scale, root, octave) + (shift ? 12 : 0);
}

/** Move a note by octaves into [lo, hi] (a note an octave wide range or more never fails). */
export function foldIntoRange(midi: number, range: readonly [number, number]): number {
  let m = midi;
  while (m < range[0]) m += 12;
  while (m > range[1]) m -= 12;
  return m < range[0] ? range[0] : m;
}

/** A sensible starting octave for an instrument: its letter row starts inside the lower half of its range. */
export function defaultOctave(range: readonly [number, number]): number {
  const mid = range[0] + Math.min(12, (range[1] - range[0]) / 3);
  return Math.floor(mid / 12) - 1;
}

export const OCTAVE_MIN = 1;
export const OCTAVE_MAX = 7;

export function clampOctave(o: number): number {
  return Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.round(o)));
}

/** Velocity (1-7 on the wire) from the dynamics setting and a held Space (an accent, louder). */
export function velocityOf(dynamics: number, accent: boolean): number {
  return Math.max(1, Math.min(7, Math.round(dynamics) + (accent ? 2 : 0)));
}

/** Dynamics presets (the overlay's buttons). */
export const DYNAMICS: { label: string; vel: number }[] = [
  { label: 'p', vel: 3 },
  { label: 'mf', vel: 5 },
  { label: 'f', vel: 7 },
];
