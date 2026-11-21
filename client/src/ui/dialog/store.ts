// Conversation state in the browser (CR 049). The zone says what the person
// says and what you can answer (Event 1910); nothing here invents a line. The
// reducer is pure and unit-tested, as are the key map and the typewriter.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { decodeNode, DLG_EV, END_REASON, REFUSAL, type DialogNode } from './events';

/** One line of the transcript. */
export interface TranscriptEntry {
  who: 'npc' | 'you';
  text: string;
  /** Your answer's tag ([Barter], [Mage]...). */
  tag?: string;
  low?: boolean;
  /** A check their line answered. */
  check?: { tag: string; pass: boolean };
}

const HISTORY_MAX = 60;

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
  /** This conversation so far (CR 053): their lines and your answers, oldest first; the current line is not in it yet. */
  history: TranscriptEntry[];
  /** Lines heard this session (stats, tests). */
  lines: number;
  /** performance.now() of the last thing that moved the conversation on (asked, a node, a choice, parked or unparked): the watchdog's clock. */
  at: number;
}

const initial = (): DialogState => ({ open: false, parked: false, awaitingWork: false, key: null, focus: null, node: null, lineAt: 0, toast: null, offline: false, history: [], lines: 0, at: 0 });

export const useDialog = create<DialogState>(() => initial());

/** Pure: the change one zone Event makes (null = not ours). */
export function reduceDialogEvent(s: DialogState, ev: ZoneEvent, now: number): Partial<DialogState> | null {
  switch (ev.kind) {
    case DLG_EV.node: {
      const n = decodeNode(ev.data);
      if (!n) return null;
      // The line they just finished joins the transcript; the new one types out below it.
      const history = s.node ? pushHistory(s.history, { who: 'npc', text: s.node.line, check: s.node.check }) : s.history;
      return { open: true, parked: s.awaitingWork, awaitingWork: false, key: s.key ?? n.npc.id, node: n, lineAt: now, history, lines: s.lines + 1, at: now };
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

/** Pure: the transcript with one more entry (capped). */
export function pushHistory(h: TranscriptEntry[], e: TranscriptEntry): TranscriptEntry[] {
  const out = [...h, e];
  return out.length > HISTORY_MAX ? out.slice(out.length - HISTORY_MAX) : out;
}

/** You said this: it joins the transcript. */
export function recordAnswer(c: { text: string; tag?: string; low?: boolean }): void {
  const s = useDialog.getState();
  useDialog.setState({ history: pushHistory(s.history, { who: 'you', text: c.text, tag: c.tag, low: c.low }) });
}

/** What a speech bubble shows of a long line: the first sentences up to ~110 characters (the box has all of it). */
export function bubbleText(line: string, max = 110): string {
  if (line.length <= max) return line;
  const sentences = line.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [line];
  let out = '';
  for (const s of sentences) {
    if (out && out.length + s.length > max) break;
    out += s;
  }
  out = out.trim();
  if (out.length > max + 30) out = out.slice(0, max).replace(/\s+\S*$/, '') + '…';
  else if (out.length < line.trim().length) out += ' …';
  return out;
}

/** A check chip's words: "[Mage] passed", "[Level 10] too low". */
export function checkWords(c: { tag: string; pass: boolean }): string {
  return `[${c.tag}] ${c.pass ? 'passed' : notMet(c.tag)}`;
}

/**
 * Why a check is not met, in the check's own terms (playtest 6 polish: every unmet one said "too low",
 * also "[Sunsteel] too low" and "[Mage] too low"): a level is too low, warmth is not there yet,
 * an item is not in your pack, a class is not yours (your weapon decides it).
 */
export function notMet(tag: string): string {
  if (tag.startsWith('Level')) return 'too low';
  if (tag.startsWith('Warmth')) return 'not yet';
  if (tag === 'Sunsteel') return 'none on you';
  if (/^(Knight|Lancer|Archer|Mage)$/.test(tag)) return 'not your weapon';
  return 'not yet';
}

export function applyDialogEvent(ev: ZoneEvent, now = performance.now()): void {
  const patch = reduceDialogEvent(useDialog.getState(), ev, now);
  if (patch) useDialog.setState(patch);
}

export function resetDialog(): void {
  useDialog.setState(initial());
}

/** How long a conversation may wait for something before the client lets go of it (playtest 5, "E stopped working"). */
export const DIALOG_STALE = {
  /** E was pressed and the zone has not answered with a first line (or a refusal). */
  noAnswerMs: 5000,
  /** The services panel was asked for but never opened, or closed without telling us. */
  parkedMs: 3000,
  /** Nobody picked an answer: the zone ends it itself at 90 s (dialogIdle), this is a little behind it. */
  idleMs: 100_000,
} as const;

/**
 * Pure: what the watchdog should do to a conversation that has gone quiet.
 *   'close'  : let go (the zone never answered, or its End event never came);
 *   'unpark' : show the conversation again (its services panel is not there);
 *   null     : leave it.
 * A conversation that is stuck on is not harmless: it holds the camera, the movement lock and the person's
 * attention, and the zone-side may have long forgotten it.
 */
export function staleDialogAction(s: Pick<DialogState, 'open' | 'parked' | 'awaitingWork' | 'node' | 'at'>, now: number, panelUp: boolean): 'close' | 'unpark' | null {
  if (!s.open) return null;
  const quiet = now - s.at;
  if (!s.node && !s.parked) return quiet > DIALOG_STALE.noAnswerMs ? 'close' : null;
  if (s.parked || s.awaitingWork) {
    if (panelUp) return null; // the shop or board is on screen: take your time
    return quiet > DIALOG_STALE.parkedMs ? 'unpark' : null;
  }
  return quiet > DIALOG_STALE.idleMs ? 'close' : null;
}

/** The number keys that pick an answer, in order. */
export const CHOICE_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'] as const;

/** The choice index a key picks (null: not a choice key, or out of range). */
export function choiceForKey(code: string, count: number): number | null {
  const i = (CHOICE_KEYS as readonly string[]).indexOf(code);
  return i >= 0 && i < count ? i : null;
}

/** What E, Space, Enter and a click on the line do: skip the typing; once shown, go on if there is only one thing to say. */
export function advanceAction(typed: boolean, choices: { id: number; kind?: string }[], bye = false): { kind: 'skip' } | { kind: 'choose'; id: number } | { kind: 'close' } | { kind: 'none' } {
  if (!typed) return { kind: 'skip' };
  if (bye) return { kind: 'close' }; // the farewell has been read: press on to close at once
  // Only a "go on" besides the way out: E goes on (never E on the goodbye itself).
  const rest = choices.filter((c) => c.kind !== 'leave');
  if (rest.length === 1 && rest[0].kind === 'more') return { kind: 'choose', id: rest[0].id };
  if (choices.length === 1 && choices[0].kind !== 'leave') return { kind: 'choose', id: choices[0].id };
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
