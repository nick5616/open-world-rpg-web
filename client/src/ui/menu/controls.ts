// Playtest 2 (new player onboarding): the full key reference the Esc menu's
// Controls page shows. Movement comes straight from the movement key map
// (input/useKeyboard.ts KEY_MAP); every other row names the source file and
// the key code literal its handler tests, and menu.test.ts reads those
// files to check each binding still exists (a renamed or removed key fails
// the test instead of leaving the reference stale).

import { KEY_MAP } from '../../input/useKeyboard';
import type { HeldButtons } from '../../sim/inputFrame';

export interface ControlRow {
  /** Keys as shown ("W", "Shift", "Left mouse"). */
  keys: string[];
  action: string;
  note?: string;
  /** [file under client/src, code literal its handler tests] pairs (menu.test.ts). */
  src?: [string, string][];
}

export interface ControlGroup {
  title: string;
  rows: ControlRow[];
}

const LABEL: Record<string, string> = {
  Space: 'Space',
  ShiftLeft: 'Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Ctrl',
  AltLeft: 'Alt',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Escape: 'Esc',
  Enter: 'Enter',
  Delete: 'Delete',
  Equal: '=',
  Period: '.',
};

/** "KeyW" -> "W", "Digit1" -> "1", "ShiftLeft" -> "Shift". */
export function keyLabel(code: string): string {
  if (LABEL[code]) return LABEL[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

/** Codes bound to a movement button, in KEY_MAP order (letters first). */
export function movementKeys(button: keyof HeldButtons): string[] {
  const codes = Object.entries(KEY_MAP)
    .filter(([, b]) => b === button)
    .map(([c]) => c);
  // WASD before the arrows; one Shift is enough to show.
  codes.sort((a, b) => Number(a.startsWith('Arrow')) - Number(b.startsWith('Arrow')));
  const labels = codes.filter((c) => c !== 'ShiftRight').map(keyLabel);
  return [...new Set(labels)];
}

const C = 'combat/runtime.ts';

/**
 * Every control in the game, grouped. `debug` adds the dev-build tools;
 * `dev` (a zone in dev mode said so, CR 032) adds the dev console.
 */
export function controlGroups(debug: boolean, dev = false): ControlGroup[] {
  const mv = (b: keyof HeldButtons) => movementKeys(b);
  const groups: ControlGroup[] = [
    {
      title: 'Moving',
      rows: [
        { keys: [mv('forward')[0], mv('left')[0], mv('back')[0], mv('right')[0]], action: 'Walk', note: 'arrow keys work too' },
        { keys: ['Mouse'], action: 'Look around', note: 'click the game first to capture the mouse' },
        { keys: mv('sprint'), action: 'Sprint (hold)', note: 'uses stamina, the wheel by the crosshair' },
        { keys: mv('jump'), action: 'Jump', note: 'again in the air: double jump, then again: glide' },
        { keys: mv('glide'), action: 'Open or close the glider' },
        { keys: [mv('forward')[0]], action: 'Climb (hold into a cliff)', note: 'Space leaps up while climbing; uses stamina' },
        { keys: ['T', 'Middle mouse'], action: 'First / third person camera', src: [['hud/ViewHud.tsx', "'KeyT'"], ['hud/ViewHud.tsx', 'e.button !== 1']] },
      ],
    },
    {
      title: 'Fighting',
      rows: [
        { keys: ['Left mouse'], action: 'Attack with your weapon', note: 'a bow: hold to draw, let go to shoot (a full draw takes 1 s and hits hardest, fastest and farthest; a tap is a weak shot). Bows never run out of arrows', src: [[C, 'e.button === 0']] },
        { keys: ['Mouse wheel'], action: 'Pick what the right button uses', note: 'your weapon or a spell slot', src: [[C, 'onWheel']] },
        { keys: ['Right mouse'], action: 'Use the picked spell or weapon move', src: [[C, 'e.button === 2']] },
        { keys: ['Z'], action: 'Parry / charge / heavy (hold); a bow: lower the draw', note: "always your weapon's move, whatever the wheel picked; with a bow it lets the string down without shooting", src: [[C, "'KeyZ'"]] },
        { keys: ['1', '2', '3', '4'], action: 'Cast the spell in that slot', note: 'also picks it for the right button; hold for streams and charges', src: [[C, "'Digit1'"], [C, "'Digit4'"]] },
        { keys: ['F', 'Alt'], action: 'Dodge', note: 'a short moment nothing can hit you', src: [[C, "'KeyF'"], [C, "'AltLeft'"]] },
        { keys: ['Q'], action: 'Elemental form', note: 'with a gem socketed in your weapon', src: [[C, "'KeyQ'"]] },
        { keys: ['Tab'], action: 'Weapon technique', note: 'once your weapon skill has one (V is push to talk); with a panel open Tab moves between its buttons', src: [[C, "'Tab'"]] },
        { keys: ['R'], action: 'Drink a healing draught', src: [[C, "'KeyR'"]] },
        { keys: ['X'], action: 'Swap loadout (weapon + 4 spells)', src: [[C, "'KeyX'"]] },
      ],
    },
    {
      title: 'The world',
      rows: [
        {
          keys: ['E'],
          action: 'Talk, trade, open doors, use forges, mine, take loot, cook, read tablets, gather herbs, attune',
          note: 'does what the [E] line under the crosshair says, one thing at a time; in the saddle E gets off',
          src: [['world/buildings/townHud.ts', "'KeyE'"], ['ui/inventory/LootHud.tsx', "'KeyE'"], ['world/caves/caveManager.ts', "'KeyE'"], ['ui/content/ContentHud.tsx', "'KeyE'"], ['ui/progression/ProgressionHud.tsx', "'KeyE'"], ['input/interact.ts', 'E_ORDER']],
        },
        { keys: ['8'], action: 'Light or douse your torch', note: 'a torch from a general merchant (6 gold) or a workbench; it burns until the water puts it out, others see it and are lit by it. Familiar light spells (one per school of magic, learned early) float over your shoulder instead', src: [['world/lights/LightRig.tsx', 'TORCH_KEY']] },
        { keys: ['M'], action: 'Map', note: 'drag to pan, wheel to zoom, right-click to pin (Shift: for your party)', src: [['ui/map/ExplorationHud.tsx', "'KeyM'"]] },
        { keys: ['J'], action: 'Quest journal', note: 'bestiary, fish, lore, achievements, renown', src: [['ui/quests/QuestHud.tsx', "'KeyJ'"]] },
        { keys: ['.'], action: 'Guiding wisp', note: 'a glowing mote flies ahead toward your quest or map pin; press again to put it away (it also shows when a quest step begins)', src: [['world/guide/guideStore.ts', "'Period'"]] },
        { keys: ['Y'], action: 'Achievements', note: 'points, progress and the titles you can show; also in this menu and the character panel (with a duel challenge waiting, Y accepts it)', src: [['ui/achievements/AchievementsHud.tsx', "'KeyY'"]] },
        { keys: ['E', 'Space', 'Left mouse'], action: 'Fish: cast (E), strike, hold to reel', note: 'with a fishing rod, facing deep water; let go when the line strains', src: [['ui/fishing/FishingHud.tsx', "'KeyE'"], ['ui/fishing/FishingHud.tsx', "'Space'"]] },
      ],
    },
    {
      title: 'Photo mode',
      rows: [
        { keys: ['L'], action: 'Photo mode on / off', note: 'free camera, no HUD; Esc also leaves', src: [['ui/photo/PhotoMode.tsx', "'KeyL'"]] },
        { keys: ['E', 'Q'], action: 'Camera up / down', note: 'W A S D fly, Space / Ctrl also rise and sink, Alt slow, Shift fast', src: [['ui/photo/store.ts', 'KeyE:'], ['ui/photo/store.ts', 'KeyQ:']] },
        { keys: ['Z', 'C'], action: 'Roll the camera', src: [['ui/photo/store.ts', 'KeyZ:'], ['ui/photo/store.ts', 'KeyC:']] },
        { keys: ['Mouse wheel'], action: 'Zoom (field of view)', src: [['ui/photo/PhotoMode.tsx', 'onWheel']] },
        { keys: ['Enter'], action: 'Save a picture (PNG)', src: [['ui/photo/PhotoMode.tsx', 'SHOT_KEY']] },
        { keys: ['H'], action: 'Hide / show the photo panel', src: [['ui/photo/PhotoMode.tsx', "'KeyH'"]] },
      ],
    },
    {
      title: 'Playing music',
      rows: [
        { keys: ['U'], action: 'Play the instrument you carry', note: 'lute, flute, hand drum, handbells: merchants, a camp workbench, a forge', src: [['ui/music/InstrumentHud.tsx', "'KeyU'"]] },
        { keys: ['Q', 'W', 'E', '…'], action: 'Play notes of the scale', note: 'numbers an octave up, A S D… an octave down, Z X C… two down', src: [['ui/music/theory.ts', "'KeyQ'"], ['ui/music/theory.ts', "'Digit1'"]] },
        { keys: ['Shift'], action: 'A note an octave up (hold)', note: 'Space accents it', src: [['ui/music/InstrumentHud.tsx', "'Space'"]] },
        { keys: ['Mouse wheel'], action: 'Move the keyboard by octaves', src: [['ui/music/InstrumentHud.tsx', 'onWheel']] },
        { keys: ['←', '→', '↑', '↓'], action: 'Key (left / right), scale (up / down)', src: [['ui/music/InstrumentHud.tsx', "'ArrowLeft'"], ['ui/music/InstrumentHud.tsx', "'ArrowUp'"]] },
        { keys: ['Enter'], action: 'Metronome click', note: 'shared with players playing near you', src: [['ui/music/InstrumentHud.tsx', "'Enter'"]] },
        { keys: ['Tab'], action: 'Next instrument you carry', src: [['ui/music/InstrumentHud.tsx', "'Tab'"]] },
        { keys: ['Esc'], action: 'Put the instrument away', src: [['ui/music/InstrumentHud.tsx', "'instrument', () => exitPlay()"]] },
      ],
    },
    {
      title: 'Camping',
      rows: [
        { keys: ['P'], action: 'Camp menu: craft kits, place pieces', note: 'campfire, bedroll, chest, workbench, signpost', src: [['ui/camps/CampHud.tsx', "'KeyP'"]] },
        { keys: ['Mouse wheel', 'R'], action: 'Turn the piece you are placing', src: [['ui/camps/CampHud.tsx', 'onWheel'], ['ui/camps/CampHud.tsx', "'KeyR'"]] },
        { keys: ['Left mouse'], action: 'Place it (green only)', src: [['ui/camps/CampHud.tsx', 'e.button === 0']] },
        { keys: ['Right mouse', 'Esc'], action: 'Stop placing', src: [['ui/camps/CampHud.tsx', 'e.button === 2'], ['ui/camps/CampHud.tsx', "'camp-placing'"]] },
        { keys: ['E'], action: 'Use a piece: cook, rest, open, name', note: 'hold E on your own piece to pick it up', src: [['ui/camps/CampHud.tsx', "'KeyE'"]] },
      ],
    },
    {
      title: 'Chopping, breaking and digging',
      rows: [
        { keys: ['='], action: 'Cycle the work tool: chop and break, dig, fill, away', note: 'an axe for trees, a pickaxe for rocks, a shovel for the ground (you start with all three); the left mouse button swings it while one is up', src: [['world/edits/worldEdits.ts', "'Equal'"]] },
        { keys: ['Left mouse'], action: 'Swing the work tool (hold to keep going)', note: 'trees fall, rocks shatter, the ground gives up to 6 m either way; towns, roads, caves and water stay as they are', src: [['world/edits/worldEdits.ts', 'e.button !== 0']] },
      ],
    },
    {
      title: 'Building',
      rows: [
        { keys: ['9'], action: 'Hammer: the build menu; in build mode, leave it', note: 'walls, floors, roofs, furniture, a bed and a hearth: build a base', src: [['ui/build/BuildHud.tsx', "'Digit9'"]] },
        { keys: ['Left mouse'], action: 'Place the ghost piece (green only)', src: [['ui/build/BuildHud.tsx', 'e.button === 0']] },
        { keys: ['R', 'Mouse wheel'], action: 'Turn the piece', src: [['ui/build/BuildHud.tsx', "'KeyR'"]] },
        { keys: ['Tab'], action: 'Change the material (Shift: the category)', src: [['ui/build/BuildHud.tsx', "'Tab'"]] },
        { keys: ['Q', 'E'], action: 'Previous / next piece (1-9 pick one)', src: [['ui/build/BuildHud.tsx', "'KeyQ'"]] },
        { keys: ['X'], action: 'Hold on your piece: deconstruct it for most of its materials', src: [['ui/build/BuildHud.tsx', "'KeyX'"]] },
        { keys: ['F'], action: 'Repair the piece you aim at', src: [['ui/build/BuildHud.tsx', "'KeyF'"]] },
        { keys: ['Right mouse', 'Esc'], action: 'Leave build mode', src: [['ui/build/BuildHud.tsx', 'e.button === 2'], ['ui/build/BuildHud.tsx', "'build-mode'"]] },
      ],
    },
    {
      title: 'Riding',
      rows: [
        { keys: ['5'], action: 'Whistle for your spirit steed', note: 'needs a Spirit Whistle (general stores); C → Your steed: name, colour', src: [['ui/mounts/MountHud.tsx', "'Digit5'"]] },
        { keys: ['E'], action: 'Ride it / get off', note: 'Space at a standstill also gets off', src: [['ui/mounts/MountHud.tsx', "'KeyE'"]] },
        { keys: [mv('forward')[0], mv('back')[0]], action: 'Trot / rein in, brake, back up', note: 'steer with the mouse and A/D' },
        { keys: mv('sprint'), action: 'Spur: gallop, then a burst', note: 'a press, not a hold; each spur costs stamina' },
        { keys: mv('jump'), action: 'Jump fences and logs' },
      ],
    },
    {
      title: 'Taming and pets',
      rows: [
        { keys: ['E'], action: 'Feed a calm creature: tame it', note: 'weaken it while you carry a food it likes; stay close while the meter fills', src: [['ui/pets/PetHud.tsx', "'KeyE'"]] },
        { keys: ['6'], action: 'Send your pet at what you aim at', note: 'hold 6 for the pet wheel: attack, follow, stay, come, pet, feed (Esc cancels)', src: [['ui/pets/PetHud.tsx', "'Digit6'"]] },
        { keys: ['7'], action: 'Pet: stay here / follow me', src: [['ui/pets/PetHud.tsx', "'Digit7'"]] },
        { keys: ['E'], action: 'Pet your pet', note: 'beside it; C → Your pets: names, stats, the stable', src: [['ui/pets/PetHud.tsx', "'KeyE'"]] },
      ],
    },
    {
      title: 'Your character',
      rows: [
        { keys: ['I'], action: 'Inventory', src: [['ui/inventory/InventoryScreen.tsx', "'KeyI'"]] },
        { keys: ['G', 'Delete'], action: 'Drop the selected item', note: 'with the inventory open (G is the glider otherwise)', src: [['ui/inventory/InventoryScreen.tsx', "'KeyG'"], ['ui/inventory/InventoryScreen.tsx', "'Delete'"]] },
        { keys: ['C'], action: 'Character (level, stats, spells, PvP)', src: [['ui/progression/ProgressionHud.tsx', "'KeyC'"]] },
        { keys: ['Enter', 'Delete', 'Backspace'], action: 'Spell cards: pick the card, or clear the slot', note: 'click or drag works too; Tab moves between cards while the panel is open', src: [['ui/spellcards/SpellCards.tsx', "'Enter'"], ['ui/spellcards/SpellCards.tsx', "'Delete'"]] },
        { keys: ['N'], action: 'Skill tree: learn spells, fill slots', src: [['ui/skills/SkillScreen.tsx', "'KeyN'"]] },
        { keys: ['B'], action: 'Build overview', src: [['ui/skills/SkillScreen.tsx', "'KeyB'"]] },
      ],
    },
    {
      title: 'Other people',
      rows: [
        { keys: ['Enter'], action: 'Chat', note: '/ starts a command (/help)', src: [['social/ui/ChatPanel.tsx', "'Enter'"]] },
        { keys: ['H'], action: 'Emote wheel (hold)', note: 'tap for the last one, Esc cancels; /emote in chat', src: [['ui/emotes/EmoteWheel.tsx', "'KeyH'"]] },
        { keys: ['O'], action: 'Friends', src: [['social/ui/SocialOverlay.tsx', "'KeyO'"]] },
        { keys: ['V'], action: 'Push to talk (hold)', note: 'when voice is on push-to-talk; rebind it, or make it a toggle, in Voice settings', src: [['voice/keys.ts', "'KeyV'"]] },
        { keys: ['0'], action: 'Mute / unmute your microphone', note: 'rebindable in Voice settings (Esc > Voice)', src: [['voice/keys.ts', "'Digit0'"]] },
        { keys: ['Y', 'U'], action: 'Accept / decline a duel', note: 'while a challenge waits, even with an instrument out', src: [['ui/pvp/PvpHud.tsx', "'KeyY'"], ['ui/pvp/PvpHud.tsx', "'KeyU'"]] },
        { keys: ['E'], action: 'Raise a fallen friend (hold)', note: 'beside them, while they wait for you (CR 035)', src: [['ui/story/StoryHud.tsx', "'KeyE'"]] },
        { keys: ['Space'], action: 'While down: respawn now', note: 'instead of waiting for a friend to raise you', src: [['ui/story/StoryHud.tsx', "'Space'"]] },
      ],
    },
    {
      title: 'Menus',
      rows: [
        { keys: ['Esc'], action: 'Close the top panel, else this menu', note: 'one at a time: the newest panel, wheel or mode first', src: [['ui/menu/EscMenu.tsx', "'Escape'"], ['input/panelStack.ts', 'closeTopPanel']] },
        { keys: ['K'], action: 'Sound settings', src: [['audio/ui/AudioRoot.tsx', "'KeyK'"]] },
        { keys: ['F10'], action: 'Graphics settings', note: 'quality, style', src: [['ui/graphics/GraphicsPanel.tsx', "'F10'"]] },
      ],
    },
  ];
  if (debug) {
    groups.push({
      title: 'Developer (this build only)',
      rows: [
        { keys: ['F3'], action: 'Debug readout', src: [['hud/useDebugHotkeys.ts', "'F3'"]] },
        { keys: ['`'], action: 'Debug panel', src: [['hud/useDebugHotkeys.ts', "'Backquote'"]] },
        { keys: ['F4'], action: 'Chunk borders', src: [['hud/useDebugHotkeys.ts', "'F4'"]] },
        { keys: ['V'], action: 'Fly (offline only)', note: 'Space rises, Ctrl sinks', src: [['hud/useDebugHotkeys.ts', "'KeyV'"]] },
      ],
    });
  }
  if (debug && dev) {
    groups.push({
      title: 'Dev (local dev zone only)',
      rows: [
        {
          keys: ['F2'],
          action: 'Dev console',
          note: 'every item, spell and cheat: Items, Spells, Character, World tabs and a command line (/help); only on a zone started by npm run dev',
          src: [['ui/devconsole/DevConsole.tsx', "DEV_KEY = 'F2'"]],
        },
      ],
    });
  }
  return groups;
}
