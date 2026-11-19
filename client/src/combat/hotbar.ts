// Playtest 2 (CR 039, "Hotbar slots"): every ten character levels open one
// more spell slot in every loadout (5 at level 10, 6 at 20, 7 at 30, 8 at
// 40) and level 20 opens a third weapon loadout. The numbers are combat.yaml
// `leveling.hotbar`, the same table the zone checks (combatdefs SpellSlots,
// LoadoutsOpen), so the HUD never offers a slot the zone would refuse.
//
// Keys: slots 1-4 stay on 1-4. 5-7 belong to the steed's whistle and the
// pet, the letters are all taken, so slots 5-8 default to 8, 9, - and =
// (the rest of the number row) and every slot key can be changed in the Esc
// menu's Controls (stored in this browser; a mouse side button works too).
//
// Wire: castSlot 0-3 name slots 1-4, 4 and 5 are the elemental form and the
// technique, so slots 5-8 travel as 6-9 (combat.CastSlotOf in the zone).

import { COMBAT, MAX_EQUIPPED_SPELLS, MAX_SPELL_SLOTS, MAX_LOADOUTS } from '@lodestone/contracts';
import { isChatShortcut } from '../input/useKeyboard';

const HB = COMBAT.leveling.hotbar;

/** Spell slots a loadout has at a character level. */
export function spellSlots(level: number): number {
  return Math.min(HB.maxSlots, HB.baseSlots + Math.floor(Math.max(0, level) / Math.max(1, HB.slotEveryLevels)));
}

/** Weapon loadouts open at a character level (two, the third at 20). */
export function loadoutsOpen(level: number): number {
  return Math.max(2, HB.loadoutLevels.filter((l) => level >= l).length);
}

/** The character level spell slot i (0-based) opens at. */
export function slotLevel(i: number): number {
  return i < HB.baseSlots ? 1 : (i - HB.baseSlots + 1) * Math.max(1, HB.slotEveryLevels);
}

/** The character level loadout i (0-based) opens at. */
export function loadoutLevel(i: number): number {
  return HB.loadoutLevels[i] ?? 1;
}

/** castSlot 6: spell slot 5 (castSlot 4 and 5 are the form and the technique). */
export const CAST_SLOT_EXTRA = 6;

/** The castSlot a cast from spell slot i (0-based) sends. */
export function castSlotOf(i: number): number {
  return i < MAX_EQUIPPED_SPELLS ? i : i - MAX_EQUIPPED_SPELLS + CAST_SLOT_EXTRA;
}

/** The spell slot a castSlot names (-1: the form, the technique, anything else). */
export function spellSlotOf(c: number): number {
  if (c < MAX_EQUIPPED_SPELLS) return c;
  if (c >= CAST_SLOT_EXTRA && c < CAST_SLOT_EXTRA + MAX_SPELL_SLOTS - MAX_EQUIPPED_SPELLS) return c - CAST_SLOT_EXTRA + MAX_EQUIPPED_SPELLS;
  return -1;
}

/** Hotbar unlocks between two levels, as fanfare lines. */
export function hotbarLines(from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = spellSlots(from); i < spellSlots(to); i++) out.push(`New spell slot! Slot ${i + 1} (${keyName(hotbarKey(i))})`);
  for (let i = loadoutsOpen(from); i < loadoutsOpen(to); i++) out.push(`New weapon loadout! Loadout ${i + 1} (X cycles)`);
  return out;
}

export { MAX_SPELL_SLOTS, MAX_LOADOUTS };

// ---- keys (rebindable) ----

/** Mouse side buttons as key codes (MouseEvent.button 3 and 4; the voice keys' spelling, voice/keys.ts). */
export const MOUSE_BACK = 'Mouse3';
export const MOUSE_FORWARD = 'Mouse4';

/** Default slot keys: 1-4, then - [ ] and \ (5-9 and = are the whistle, the pet, the torch, the hammer and the work tool). */
export const DEFAULT_KEYS: readonly string[] = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Minus', 'BracketLeft', 'BracketRight', 'Backslash'];

const STORE = 'lodestone.hotbarKeys';
let keys: string[] = load();
const listeners = new Set<() => void>();

function load(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE) : null;
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(v) && v.length === MAX_SPELL_SLOTS && v.every((x) => typeof x === 'string' && x.length < 32)) return v as string[];
  } catch {
    // private window, blocked storage: the defaults
  }
  return [...DEFAULT_KEYS];
}

/** The key code that casts spell slot i. */
export function hotbarKey(i: number): string {
  return keys[i] ?? DEFAULT_KEYS[i] ?? '';
}

/** Every slot's key code. */
export function hotbarKeys(): readonly string[] {
  return keys;
}

/** The spell slot a key code casts (-1 none). */
export function slotForKey(code: string): number {
  return keys.indexOf(code);
}

/** The spell slot a key press casts (-1 none; "/" typed on any layout is chat's, never a slot). */
export function slotForEvent(e: KeyboardEvent): number {
  return isChatShortcut(e) ? -1 : keys.indexOf(e.code);
}

/**
 * Keys the rebinding refuses: what the world already uses for something
 * else (movement, E, the screens, the whistle and pet, push to talk...).
 * Filled by the Controls page from input/bindings.ts (kept out of this
 * module so the combat runtime does not import the binding table).
 */
export type KeyCheck = (code: string) => string | null;

/** Bind slot i to code; another slot holding it gets slot i's old key (a swap). Null = done, else why not. */
export function setHotbarKey(i: number, code: string, taken: KeyCheck = () => null): string | null {
  if (i < 0 || i >= MAX_SPELL_SLOTS || !code) return 'no such slot';
  if (code === 'Escape') return 'Esc opens the menu';
  const other = keys.indexOf(code);
  if (other < 0) {
    const why = taken(code);
    if (why) return why;
  }
  const next = [...keys];
  if (other >= 0) next[other] = next[i];
  next[i] = code;
  keys = next;
  save();
  return null;
}

/** Back to 1-4, 8, 9, -, =. */
export function resetHotbarKeys(): void {
  keys = [...DEFAULT_KEYS];
  save();
}

function save(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(keys));
  } catch {
    // not stored: lasts this session
  }
  for (const l of listeners) l();
}

/** Called after any key change (the HUD's labels, the Controls page). */
export function onHotbarKeys(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

const NAMES: Record<string, string> = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', CapsLock: 'Caps', [MOUSE_BACK]: 'Mouse back', [MOUSE_FORWARD]: 'Mouse fwd' };

/** A key code as a keycap label ("Digit1" -> "1", "Minus" -> "-", "Mouse3" -> "Mouse back"). */
export function keyName(code: string): string {
  if (NAMES[code]) return NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

/** The key code for a mouse button (side buttons only; null otherwise). */
export function mouseCode(button: number): string | null {
  return button === 3 ? MOUSE_BACK : button === 4 ? MOUSE_FORWARD : null;
}

/** Test hook: forget stored keys. */
export function _resetForTest(): void {
  keys = [...DEFAULT_KEYS];
}
