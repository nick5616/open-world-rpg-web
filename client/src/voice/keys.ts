// Playtest 2 voice settings: the two voice keys (push to talk, mute your
// microphone), rebindable in the Voice settings and checked against every
// other key the game binds (input/bindings.ts), so a rebind can never steal
// a key that already does something.
//
// A voice key is a keyboard code ("KeyV") or a mouse side button
// ("Mouse3" = back, "Mouse4" = forward), the usual push-to-talk buttons.

import { BINDINGS, type Binding } from '../input/bindings';
import { isChatShortcut, isTextTarget } from '../input/useKeyboard';
import { keyLabel } from '../ui/menu/controls';

export type VoiceKeyRole = 'ptt' | 'mute';

/** Hold (or tap, in toggle mode) to talk. */
export const DEFAULT_PTT_KEY = 'KeyV';
/** Mute / unmute your microphone (a free key in the world: 8, 9 and 0 bind nothing). */
export const DEFAULT_MUTE_KEY = 'Digit0';

/** Keys a voice action may take: letters, digits, F keys, numpad, punctuation, a few navigation keys and the mouse side buttons. */
const BINDABLE = /^(Key[A-Z]|Digit\d|F([1-9]|1[0-2])|Numpad\w+|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Comma|Period|Minus|Equal|Insert|Home|End|PageUp|PageDown|CapsLock|Mouse[34])$/;

export const ROLE_LABEL: Record<VoiceKeyRole, string> = { ptt: 'push to talk', mute: 'mute your microphone' };

/** "KeyV" -> "V", "Mouse3" -> "Mouse back". */
export function voiceKeyLabel(code: string): string {
  if (code === 'Mouse3') return 'Mouse back';
  if (code === 'Mouse4') return 'Mouse forward';
  return keyLabel(code);
}

export type KeyCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `code` may be the key for `role`: a bindable key, not the other
 * voice key, and not bound to anything in the world or the menu by another
 * feature (input/bindings.ts; the voice's own two entries don't count).
 */
export function validateVoiceKey(code: string, role: VoiceKeyRole, otherVoiceKey: string, bindings: Binding[] = BINDINGS): KeyCheck {
  if (!BINDABLE.test(code)) return { ok: false, reason: `${voiceKeyLabel(code)} can't be a voice key (Esc, Enter, Tab, Space, Shift, Ctrl, Alt and the arrows are reserved).` };
  if (code === otherVoiceKey) return { ok: false, reason: `${voiceKeyLabel(code)} is already your key to ${ROLE_LABEL[role === 'ptt' ? 'mute' : 'ptt']}.` };
  const clash = bindings.find((b) => b.code === code && (b.ctx === 'world' || b.ctx === 'menu') && !b.file.startsWith('voice/'));
  if (clash) return { ok: false, reason: `${voiceKeyLabel(code)} already does "${clash.does}". Pick another key.` };
  return { ok: true };
}

/** A stored key that is no longer valid (a feature took it since) falls back to the default. */
export function sanitizeVoiceKey(code: unknown, role: VoiceKeyRole, otherVoiceKey: string): string {
  const fallback = role === 'ptt' ? DEFAULT_PTT_KEY : DEFAULT_MUTE_KEY;
  if (typeof code !== 'string') return fallback;
  return validateVoiceKey(code, role, otherVoiceKey).ok ? code : fallback;
}

/** The voice key a keyboard event is, if any ("" when it is not a voice key event: typing, chat "/", modifiers). */
export function keyEventCode(e: KeyboardEvent, down: boolean): string {
  if (down && (e.ctrlKey || e.metaKey || e.altKey)) return '';
  // Typing a letter in chat is not a push; a release always counts (focus
  // may have moved into a text field while the key was held).
  if (down && (isTextTarget(e.target) || isChatShortcut(e))) return '';
  return e.code;
}

/** "Mouse3" / "Mouse4" for the side buttons, "" otherwise. */
export function mouseEventCode(e: MouseEvent): string {
  return e.button === 3 || e.button === 4 ? `Mouse${e.button}` : '';
}
