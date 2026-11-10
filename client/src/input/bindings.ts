// Playtest 2 integration QA: every keyboard binding in the client, by the
// situation it works in. A dozen features landed in one night, each picking
// keys on its own (E for nine things, V for the technique and push-to-talk,
// U for the instrument and a duel's "no", H for emotes and photo mode's
// panel...). bindings.test.ts reads every handler file and fails when a key
// code shows up that is not declared here, or when one context binds a key
// twice without a rule for who wins (SHARED). Declare a new key here, with
// its context, and add it to the Esc menu's Controls (ui/menu/controls.ts).

import { KEY_MAP } from './useKeyboard';
import { PHOTO_KEYS } from '../ui/photo/store';

/**
 * When a binding applies. The exclusive modes (instrument, photo, menu)
 * take the keyboard over (their handlers run first and stop the event), so
 * a key may mean something else there than in the world.
 */
export type BindContext =
  | 'world' // walking around, no mode active
  | 'instrument' // playing an instrument (U): every key is a note or a control
  | 'photo' // photo mode (L)
  | 'menu' // the Esc menu is open: only movement and Esc reach the game
  | 'fishing' // a line is out: E / Space strike and reel
  | 'placing' // placing a camp piece
  | 'duel' // a duel challenge is waiting for your answer
  | 'inventory' // the inventory is open
  | 'skills' // the skill screen is open (other screens' keys close it)
  | 'wheel' // the emote or pet wheel is held open
  | 'debug' // debug builds only
  | 'focus' // a focused card or button in a panel (its own onKeyDown; chat and jump leave it alone)
  | 'title'; // the title screen

export interface Binding {
  code: string;
  ctx: BindContext;
  /** Handler file under client/src. */
  file: string;
  does: string;
}

/** Keys several handlers in one context share on purpose, and the rule that picks one. */
export const SHARED: Record<string, string> = {
  KeyE: 'one owner at a time: input/interact.ts E_ORDER (in the saddle E only gets off)',
  Escape: 'closes the open panel or mode; with none open it opens the Esc menu (ui/menu/EscMenu.tsx)',
};

const W = (code: string, file: string, does: string): Binding => ({ code, ctx: 'world', file, does });
const COMBAT = 'combat/runtime.ts';

const movement: Binding[] = Object.entries(KEY_MAP).map(([code, b]) => ({ code, ctx: b === 'crouch' ? 'debug' : 'world', file: 'input/useKeyboard.ts', does: b === 'crouch' ? 'fly down (debug fly)' : b }));

export const BINDINGS: Binding[] = [
  ...movement,
  // fighting
  W('KeyF', COMBAT, 'dodge'),
  W('AltLeft', COMBAT, 'dodge'),
  W('Digit1', COMBAT, 'cast slot 1 (hold: streams, charges)'),
  W('Digit2', COMBAT, 'cast slot 2'),
  W('Digit3', COMBAT, 'cast slot 3'),
  W('Digit4', COMBAT, 'cast slot 4'),
  W('KeyZ', COMBAT, "the weapon's secondary (hold)"),
  W('KeyQ', COMBAT, 'elemental form'),
  W('Tab', COMBAT, 'weapon technique'),
  W('KeyR', COMBAT, 'drink a draught'),
  W('KeyX', COMBAT, 'swap loadout'),
  // E: one owner (SHARED)
  W('KeyE', 'world/buildings/townHud.ts', 'talk, trade, doors, forge, anvil, shaft'),
  W('KeyE', 'world/caves/caveManager.ts', 'mine'),
  W('KeyE', 'ui/progression/ProgressionHud.tsx', 'attune a tower crystal'),
  W('KeyE', 'ui/inventory/LootHud.tsx', 'take loot, open a container, cook'),
  W('KeyE', 'ui/content/ContentHud.tsx', 'lore tablet, herb, vault part'),
  W('KeyE', 'ui/camps/CampHud.tsx', 'use a camp piece (hold: pick it up)'),
  W('KeyE', 'ui/fishing/FishingHud.tsx', 'cast a line'),
  W('KeyE', 'ui/mounts/MountHud.tsx', 'ride / get off'),
  W('KeyE', 'ui/pets/PetHud.tsx', 'feed a calm creature, pet your pet'),
  // screens and the world
  W('KeyT', 'hud/ViewHud.tsx', 'first / third person'),
  W('KeyM', 'ui/map/ExplorationHud.tsx', 'map'),
  W('KeyJ', 'ui/quests/QuestHud.tsx', 'journal'),
  W('KeyY', 'ui/achievements/AchievementsHud.tsx', 'achievements screen'), // CR 031; a pending duel keeps Y ('duel')
  W('KeyI', 'ui/inventory/InventoryScreen.tsx', 'inventory'),
  W('KeyC', 'ui/progression/ProgressionHud.tsx', 'character'),
  W('KeyN', 'ui/skills/SkillScreen.tsx', 'skill tree'),
  W('KeyB', 'ui/skills/SkillScreen.tsx', 'build overview'),
  W('KeyK', 'audio/ui/AudioRoot.tsx', 'sound settings'),
  W('F10', 'ui/graphics/GraphicsPanel.tsx', 'graphics settings'),
  W('KeyO', 'social/ui/SocialOverlay.tsx', 'friends'),
  W('Enter', 'social/ui/ChatPanel.tsx', 'chat'),
  W('KeyV', 'voice/runtime.ts', 'push to talk'),
  W('KeyH', 'ui/emotes/EmoteWheel.tsx', 'emote wheel (hold)'),
  W('KeyL', 'ui/photo/PhotoMode.tsx', 'photo mode'),
  W('KeyU', 'ui/music/InstrumentHud.tsx', 'play your instrument'),
  W('KeyP', 'ui/camps/CampHud.tsx', 'camp menu'),
  W('Digit5', 'ui/mounts/MountHud.tsx', 'whistle for your steed'),
  W('Digit6', 'ui/pets/PetHud.tsx', 'send your pet (hold: pet wheel)'),
  W('Digit7', 'ui/pets/PetHud.tsx', 'pet: stay / follow'),
  // Esc: SHARED (closes the top thing, else the menu)
  ...[
    'ui/menu/EscMenu.tsx',
    'ui/achievements/AchievementsHud.tsx',
    'audio/ui/AudioSettingsPanel.tsx',
    'social/ui/ChatPanel.tsx',
    'social/ui/SocialOverlay.tsx',
    'ui/camps/CampHud.tsx',
    'ui/content/ContentHud.tsx',
    'ui/graphics/GraphicsPanel.tsx',
    'ui/inventory/CraftPanel.tsx',
    'ui/inventory/InventoryScreen.tsx',
    'ui/map/ExplorationHud.tsx',
    'ui/mounts/MountHud.tsx',
    'ui/pets/PetHud.tsx',
    'ui/progression/ProgressionHud.tsx',
    'ui/quests/QuestHud.tsx',
    'ui/skills/SkillScreen.tsx',
    'ui/whatsnew/WhatsNew.tsx',
    'world/buildings/townHud.ts',
  ].map((file) => W('Escape', file, 'close this panel')),
  // modes
  { code: 'KeyU', ctx: 'instrument', file: 'ui/music/InstrumentHud.tsx', does: 'every letter, digit and punctuation key is a note (ui/music/theory.ts)' },
  ...['Space', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'Enter'].map((code): Binding => ({ code, ctx: 'instrument', file: 'ui/music/InstrumentHud.tsx', does: 'instrument control' })),
  ...Object.keys(PHOTO_KEYS).map((code): Binding => ({ code, ctx: 'photo', file: 'ui/photo/store.ts', does: `camera ${PHOTO_KEYS[code]}` })),
  { code: 'Escape', ctx: 'photo', file: 'ui/photo/PhotoMode.tsx', does: 'leave photo mode' },
  { code: 'Enter', ctx: 'photo', file: 'ui/photo/PhotoMode.tsx', does: 'save a picture' },
  { code: 'KeyH', ctx: 'photo', file: 'ui/photo/PhotoMode.tsx', does: 'hide the photo panel' },
  { code: 'Tab', ctx: 'photo', file: 'ui/photo/PhotoMode.tsx', does: '(swallowed: no focus jumps)' },
  { code: 'KeyE', ctx: 'fishing', file: 'ui/fishing/FishingHud.tsx', does: 'strike, hold to reel' },
  { code: 'Space', ctx: 'fishing', file: 'ui/fishing/FishingHud.tsx', does: 'strike, hold to reel' },
  { code: 'KeyR', ctx: 'placing', file: 'ui/camps/CampHud.tsx', does: 'turn the piece' },
  { code: 'Escape', ctx: 'placing', file: 'ui/camps/CampHud.tsx', does: 'stop placing' },
  { code: 'KeyY', ctx: 'duel', file: 'ui/pvp/PvpHud.tsx', does: 'accept the duel' },
  { code: 'KeyU', ctx: 'duel', file: 'ui/pvp/PvpHud.tsx', does: 'decline the duel' },
  { code: 'KeyG', ctx: 'inventory', file: 'ui/inventory/InventoryScreen.tsx', does: 'drop the selected item' },
  { code: 'Delete', ctx: 'inventory', file: 'ui/inventory/InventoryScreen.tsx', does: 'drop the selected item' },
  ...['KeyC', 'KeyI', 'KeyJ', 'KeyM'].map((code): Binding => ({ code, ctx: 'skills', file: 'ui/skills/SkillScreen.tsx', does: 'close the skill screen as that screen opens' })),
  { code: 'Escape', ctx: 'wheel', file: 'ui/emotes/EmoteWheel.tsx', does: 'cancel the emote wheel' },
  { code: 'Escape', ctx: 'wheel', file: 'ui/pets/PetHud.tsx', does: 'cancel the pet wheel' },
  { code: 'F3', ctx: 'debug', file: 'hud/useDebugHotkeys.ts', does: 'debug readout' },
  { code: 'F4', ctx: 'debug', file: 'hud/useDebugHotkeys.ts', does: 'chunk borders' },
  { code: 'Backquote', ctx: 'debug', file: 'hud/useDebugHotkeys.ts', does: 'debug panel' },
  { code: 'KeyV', ctx: 'debug', file: 'hud/useDebugHotkeys.ts', does: 'fly (offline only)' },
  { code: 'Enter', ctx: 'debug', file: 'hud/DebugPanel.tsx', does: 'teleport (in its text box)' },
  { code: 'Enter', ctx: 'focus', file: 'ui/spellcards/SpellCards.tsx', does: 'pick the focused spell card (Space too)' },
  { code: 'Delete', ctx: 'focus', file: 'ui/spellcards/SpellCards.tsx', does: 'clear the focused spell slot' },
  { code: 'Backspace', ctx: 'focus', file: 'ui/spellcards/SpellCards.tsx', does: 'clear the focused spell slot' },
  { code: 'Enter', ctx: 'title', file: 'screens/TitleScreen.tsx', does: 'start' },
  { code: 'Space', ctx: 'title', file: 'screens/TitleScreen.tsx', does: 'start' },
];

/**
 * Files that name key codes without binding them, or bind them inside a
 * text field (React onKeyDown on an input), with why.
 */
export const NOT_HANDLERS: Record<string, string> = {
  'input/bindings.ts': 'this table',
  'ui/menu/controls.ts': "the Esc menu's key reference",
  'ui/music/theory.ts': "the instrument's note rows (context 'instrument': every key is a note)",
  'ui/tips/tips.ts': 'key names in tip text',
  'ui/camps/CampHud.tsx#Enter': "the signpost name box's Enter (a text field)",
  'social/ui/ChatPanel.tsx#Tab': "the chat box's name completion (a text field)",
  'ui/music/InstrumentHud.tsx#KeyY': "lets a pending duel's Y / U through to ui/pvp/PvpHud.tsx while you play",
};
