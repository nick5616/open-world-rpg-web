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

/** Every control in the game, grouped. `debug` adds the dev-build tools. */
export function controlGroups(debug: boolean): ControlGroup[] {
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
        { keys: ['Left mouse'], action: 'Attack with your weapon', src: [[C, 'e.button === 0']] },
        { keys: ['Mouse wheel'], action: 'Pick what the right button uses', note: 'your weapon or a spell slot', src: [[C, 'onWheel']] },
        { keys: ['Right mouse'], action: 'Use the picked spell or weapon move', src: [[C, 'e.button === 2']] },
        { keys: ['Z'], action: 'Parry / draw / charge / heavy (hold)', note: 'your weapon\'s move, whatever is picked', src: [[C, "'KeyZ'"]] },
        { keys: ['1', '2', '3', '4'], action: 'Cast the spell in that slot', src: [[C, "'Digit1'"], [C, "'Digit4'"]] },
        { keys: ['F', 'Alt'], action: 'Dodge', note: 'a short moment nothing can hit you', src: [[C, "'KeyF'"], [C, "'AltLeft'"]] },
        { keys: ['Q'], action: 'Elemental form', note: 'with a gem socketed in your weapon', src: [[C, "'KeyQ'"]] },
        { keys: ['V'], action: 'Weapon technique', note: 'once your weapon skill has one', src: [[C, "'KeyV'"]] },
        { keys: ['R'], action: 'Drink a healing draught', src: [[C, "'KeyR'"]] },
        { keys: ['X'], action: 'Swap loadout (weapon + 4 spells)', src: [[C, "'KeyX'"]] },
      ],
    },
    {
      title: 'The world',
      rows: [
        { keys: ['E'], action: 'Talk, trade, open doors, use forges, mine, pick up', src: [['world/buildings/townHud.ts', "'KeyE'"], ['ui/inventory/LootHud.tsx', "'KeyE'"], ['world/caves/caveManager.ts', "'KeyE'"]] },
        { keys: ['M'], action: 'Map', src: [['ui/map/ExplorationHud.tsx', "'KeyM'"]] },
        { keys: ['J'], action: 'Quest journal', src: [['ui/quests/QuestHud.tsx', "'KeyJ'"]] },
      ],
    },
    {
      title: 'Your character',
      rows: [
        { keys: ['I'], action: 'Inventory', note: 'G or Delete drops the selected item', src: [['ui/inventory/InventoryScreen.tsx', "'KeyI'"], ['ui/inventory/InventoryScreen.tsx', "'Delete'"]] },
        { keys: ['C'], action: 'Character (level, stats, PvP)', src: [['ui/progression/ProgressionHud.tsx', "'KeyC'"]] },
        { keys: ['N'], action: 'Skill tree: learn spells, fill slots', src: [['ui/skills/SkillScreen.tsx', "'KeyN'"]] },
        { keys: ['B'], action: 'Build overview', src: [['ui/skills/SkillScreen.tsx', "'KeyB'"]] },
      ],
    },
    {
      title: 'Other people',
      rows: [
        { keys: ['Enter'], action: 'Chat', note: '/ starts a command (/help)', src: [['social/ui/ChatPanel.tsx', "'Enter'"]] },
        { keys: ['O'], action: 'Friends', src: [['social/ui/SocialOverlay.tsx', "'KeyO'"]] },
        { keys: ['V'], action: 'Push to talk (hold)', note: 'when voice is on push-to-talk', src: [['voice/runtime.ts', "'KeyV'"]] },
        { keys: ['Y', 'U'], action: 'Accept / decline a duel', src: [['ui/pvp/PvpHud.tsx', "'KeyY'"], ['ui/pvp/PvpHud.tsx', "'KeyU'"]] },
      ],
    },
    {
      title: 'Menus',
      rows: [
        { keys: ['Esc'], action: 'Close the open panel, else this menu', src: [['ui/menu/EscMenu.tsx', "'Escape'"]] },
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
      ],
    });
  }
  return groups;
}
