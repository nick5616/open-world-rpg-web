// Playtest 5 (CR 055): "How does Tammir know directly about the controls? It
// should toast the controls after exiting the conversation with Tammir."
//
// The people of the world say what to do in their own words (no key names in
// anything a giver says: server/zone/internal/quests inworld_test.go). When the
// conversation closes, the controls for what they just talked about appear as
// tip toasts, with the keys read from the live bindings (input/bindings.ts and
// the movement map), so a rebound key shows as rebound.
//
// Pure logic here (controlTips.test.ts); ControlToasts.tsx draws and
// controlLink.ts watches the conversation and the quest log.

import { BINDINGS } from '../../input/bindings';
import { movementKeys, keyLabel } from '../menu/controls';

/** A control a toast can name: its keys come from the bindings, never from a literal. */
export type ControlId =
  | 'attack'
  | 'spells'
  | 'dodge'
  | 'draught'
  | 'interact'
  | 'torch'
  | 'build'
  | 'whistle'
  | 'camp'
  | 'inventory'
  | 'map'
  | 'journal'
  | 'glider'
  | 'guide';

interface ControlDef {
  /** The handler file and key code in input/bindings.ts the control is bound to (the keys shown come from there). */
  bind?: { file: string; code: string }[];
  /** A movement button (KEY_MAP) instead. */
  move?: 'glide';
  /** Mouse buttons shown as keycaps, before any keys. */
  mouse?: string[];
  /** The line next to the keycaps. */
  text: string;
}

const CONTROLS: Record<ControlId, ControlDef> = {
  attack: { mouse: ['LMB'], text: 'swings your weapon.' },
  spells: { bind: [{ file: 'combat/runtime.ts', code: 'Digit1' }, { file: 'combat/runtime.ts', code: 'Digit4' }], text: 'cast the spells in your slots.' },
  dodge: { bind: [{ file: 'combat/runtime.ts', code: 'KeyF' }], text: 'dodges: a moment nothing can hit you.' },
  draught: { bind: [{ file: 'combat/runtime.ts', code: 'KeyR' }], text: 'drinks a healing draught.' },
  interact: { bind: [{ file: 'world/caves/caveManager.ts', code: 'KeyE' }], text: 'does what the line under the crosshair says: hold it to mine, chop, fish or climb on.' },
  torch: { bind: [{ file: 'world/lights/LightRig.tsx', code: 'Digit8' }], text: 'lights or douses your torch.' },
  build: { bind: [{ file: 'ui/build/BuildHud.tsx', code: 'Digit9' }], text: 'takes up the hammer: pick a piece and place it.' },
  whistle: { bind: [{ file: 'ui/mounts/MountHud.tsx', code: 'Digit5' }], text: 'blows the spirit whistle, in the open. Interact beside your steed to ride.' },
  camp: { bind: [{ file: 'ui/camps/CampHud.tsx', code: 'KeyP' }], text: 'opens the camp menu: lay out your bedroll.' },
  inventory: { bind: [{ file: 'ui/inventory/InventoryScreen.tsx', code: 'KeyI' }], text: 'opens your pack: wield, wear and use things.' },
  map: { bind: [{ file: 'ui/map/ExplorationHud.tsx', code: 'KeyM' }], text: 'opens the map.' },
  journal: { bind: [{ file: 'ui/quests/QuestHud.tsx', code: 'KeyJ' }], text: 'opens the journal.' },
  glider: { move: 'glide', text: 'opens the glider in the air.' },
  guide: { bind: [{ file: 'world/guide/guideStore.ts', code: 'Period' }], text: 'sends a guiding wisp ahead of you.' },
};

/** The key codes a control is bound to right now (bindings table, then the movement map). */
export function controlCodes(id: ControlId): string[] {
  const d = CONTROLS[id];
  if (d.move) return movementKeys(d.move);
  const out: string[] = [];
  for (const b of d.bind ?? []) {
    const hit = BINDINGS.find((x) => x.ctx === 'world' && x.file === b.file && x.code === b.code);
    if (hit) out.push(hit.code);
  }
  return out;
}

/** The keycaps for a control ("LMB", "1-4", "F"). */
export function controlKeys(id: ControlId): string[] {
  const d = CONTROLS[id];
  const keys: string[] = [...(d.mouse ?? [])];
  if (d.move) return [...keys, ...movementKeys(d.move)];
  const codes = controlCodes(id);
  const labels = codes.map(keyLabel);
  // Two digit keys that start and end a row read as a range: 1 and 4 -> "1-4".
  if (id === 'spells' && labels.length === 2) keys.push(`${labels[0]}-${labels[1]}`);
  else keys.push(...labels);
  return keys;
}

export interface ControlTip {
  id: ControlId;
  keys: string[];
  text: string;
}

export function controlTip(id: ControlId): ControlTip {
  return { id, keys: controlKeys(id), text: CONTROLS[id].text };
}

/** One toast: what they just talked about, and the controls for it. */
export interface ControlGroup {
  title: string;
  controls: ControlId[];
}

/** After the talk that gives the first deed (the step after the first talk, or the offer accepted). */
export const START: Record<string, ControlGroup> = {
  'story:meadows': { title: 'Fighting the slimes', controls: ['attack', 'spells', 'dodge', 'draught'] },
  'story:errand:ore': { title: 'Mining ore', controls: ['interact', 'torch'] },
  'story:errand:timber': { title: 'Timber and the hammer', controls: ['interact', 'build'] },
  'story:errand:torch': { title: 'The dark mouth', controls: ['torch'] },
  'story:errand:pond': { title: 'Fishing', controls: ['interact'] },
  'story:errand:steed': { title: 'Your steed', controls: ['whistle', 'interact'] },
  'story:errand:tower': { title: 'The tower', controls: ['interact', 'glider', 'map'] },
};

/** After handing the errand in: what they told you to do with the reward. */
export const DONE: Record<string, ControlGroup> = {
  'story:meadows': { title: 'Your reward', controls: ['inventory'] },
  'story:errand:ore': { title: 'Your new sword', controls: ['inventory'] },
  'story:errand:timber': { title: 'Your bedroll', controls: ['camp', 'interact'] },
  'story:errand:pond': { title: 'Your catch', controls: ['interact'] },
  'story:errand:tower': { title: 'The land opens', controls: ['map', 'journal', 'guide'] },
};

export interface LogQuest {
  key: string;
  step: number;
  /** The first step's text: a talk step starts "Talk to ". */
  first?: string;
}

export interface LogChange {
  key: string;
  kind: 'start' | 'done';
  at: number;
}

const startsWithTalk = (q: LogQuest) => /^Talk to /.test(q.first ?? '');

/**
 * What changed in the quest log between two snapshots: a quest that moved on
 * from its talk step (0 to 1), or appeared already on a deed (an offer taken
 * in a conversation), is a "start"; one that is gone (handed in) is "done".
 * A quest that merely appears on its talk step (the chain began it before you
 * met the giver) is nothing yet.
 */
export function logChanges(prev: readonly LogQuest[], now: readonly LogQuest[], at: number): LogChange[] {
  const out: LogChange[] = [];
  for (const q of now) {
    const was = prev.find((b) => b.key === q.key);
    if (!was ? !startsWithTalk(q) || q.step >= 1 : was.step === 0 && q.step >= 1) out.push({ key: q.key, kind: 'start', at });
  }
  for (const b of prev) if (!now.some((q) => q.key === b.key)) out.push({ key: b.key, kind: 'done', at });
  return out;
}

export interface Announcement {
  /** Remembered per character so a group shows once ("story:errand:ore#start"). */
  seenKey: string;
  group: ControlGroup;
}

/**
 * What a closed conversation should toast: the changes made since the
 * conversation began (`sinceMs`, with a little lead for a log that arrives
 * just before the first line), minus what was shown before (`seen`).
 */
export function announcements(changes: readonly LogChange[], seen: ReadonlySet<string>, sinceMs: number): Announcement[] {
  const out: Announcement[] = [];
  for (const c of changes) {
    if (c.at < sinceMs) continue;
    const seenKey = `${c.key}#${c.kind}`;
    const group = (c.kind === 'start' ? START : DONE)[c.key];
    if (group && !seen.has(seenKey) && !out.some((o) => o.seenKey === seenKey)) out.push({ seenKey, group });
  }
  return out;
}

/** The tip toasts (keys read now) for a group. */
export function groupTips(g: ControlGroup): ControlTip[] {
  return g.controls.map(controlTip);
}

/** Seconds a controls toast stays up, and the most shown together. */
export const CONTROL_TOAST_S = 12;
export const CONTROL_TOASTS_MAX = 2;
