// Conversation state in the browser (CR 049). The zone says what the person
// says and what you can answer (Event 1910); nothing here invents a line. The
// reducer is pure and unit-tested, as are the key map and the typewriter.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { decodeNode, DLG_EV, END_REASON, REFUSAL, type DialogNode } from './events';

export interface DialogState {
  /** A conversation is on (a node is shown, or the request is out). */
  open: boolean;
  /** The services panel (shop, board) is up: the conversation waits, hidden. */
  parked: boolean;
  /** A service (shop, board) was just asked for: the next node arrives parked, behind its panel. */
  awaitingWork: boolean;
  /** The person's entity id (online) or -1 - record index (offline); the npcFocus key. */
  key: number | null;
  /** Where their face is (the camera frames it). */
  focus: { x: number; y: number; z: number } | null;
  node: DialogNode | null;
  /** performance.now() when the line started typing. */
  lineAt: number;
  /** Why it ended / what was refused, shown briefly. */
  toast: { text: string; at: number } | null;
  offline: boolean;
  /** Lines heard this session (stats, tests). */
  lines: number;
}

const initial = (): DialogState => ({ open: false, parked: false, awaitingWork: false, key: null, focus: null, node: null, lineAt: 0, toast: null, offline: false, lines: 0 });

export const useDialog = create<DialogState>(() => initial());

/** Pure: the change one zone Event makes (null = not ours). */
export function reduceDialogEvent(s: DialogState, ev: ZoneEvent, now: number): Partial<DialogState> | null {
  switch (ev.kind) {
    case DLG_EV.node: {
      const n = decodeNode(ev.data);
      if (!n) return null;
      return { open: true, parked: s.awaitingWork, awaitingWork: false, key: s.key ?? n.npc.id, node: n, lineAt: now, lines: s.lines + 1 };
    }
    case DLG_EV.end: {
      const text = END_REASON[ev.value] ?? '';
      return { ...initial(), lines: s.lines, toast: text ? { text, at: now } : null };
    }
    case DLG_EV.refused:
      if (ev.value === 4) return { toast: { text: REFUSAL[4], at: now } }; // a bad choice leaves the conversation on
      return { ...initial(), lines: s.lines, toast: { text: REFUSAL[ev.value] ?? `Refused (${ev.value})`, at: now } };
    case DLG_EV.mark:
      return null;
    default:
      return null;
  }
}

export function applyDialogEvent(ev: ZoneEvent, now = performance.now()): void {
  const patch = reduceDialogEvent(useDialog.getState(), ev, now);
  if (patch) useDialog.setState(patch);
}

export function resetDialog(): void {
  useDialog.setState(initial());
}


/** The number keys that pick an answer, in order. */
export const CHOICE_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'] as const;

/** The choice index a key picks (null: not a choice key, or out of range). */
export function choiceForKey(code: string, count: number): number | null {
  const i = (CHOICE_KEYS as readonly string[]).indexOf(code);
  return i >= 0 && i < count ? i : null;
}

/** What E, Space, Enter and a click on the line do: skip the typing; once shown, go on if there is only one thing to say. */
export function advanceAction(typed: boolean, choices: { id: number }[]): { kind: 'skip' } | { kind: 'choose'; id: number } | { kind: 'none' } {
  if (!typed) return { kind: 'skip' };
  if (choices.length === 1) return { kind: 'choose', id: choices[0].id };
  return { kind: 'none' };
}

/** Characters shown t ms after the line started (cps characters a second; punctuation lingers a little). */
export function typedChars(text: string, elapsedMs: number, cps = 48): number {
  if (elapsedMs <= 0) return 0;
  let shown = 0;
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    t += 1000 / cps + (c === ',' ? 70 : c === '.' || c === '!' || c === '?' ? 150 : 0);
    if (t > elapsedMs) break;
    shown = i + 1;
  }
  return shown;
}
