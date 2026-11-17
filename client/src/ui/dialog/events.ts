// Conversations with townsfolk (playtest 4, CR 049): the wire. Interact 180
// and Events 1910-1913 (contracts/events.md); the zone's words come from
// server/zone/internal/dialog and server/zone/internal/game/dialog.go.

export const DLG_EV = { node: 1910, end: 1911, refused: 1912, mark: 1913 } as const;
export const DLG_INTERACT = 180;
export const DLG_ACT = { open: 1, choose: 2, close: 3 } as const;

/** What a choice does (colours the line and picks the little glyph). */
export type ChoiceKind = 'topic' | 'rumour' | 'work' | 'mark' | 'quest' | 'more' | 'leave';

export interface DialogChoice {
  id: number;
  text: string;
  kind: ChoiceKind | string;
}

export interface DialogQuest {
  id: number;
  title: string;
  gold?: number;
  xp?: number;
  rep?: number;
  repTown?: string;
  items?: number;
}

export interface DialogNode {
  npc: { id: number; name: string; role: number; title: string; town?: string };
  seq: number;
  /** A small note under the line ("Marked on your map: ..."). */
  note?: string;
  quest?: DialogQuest;
  /** Affinity: how warm they are to you. */
  aff: number;
  /** You have talked before. */
  met: boolean;
  line: string;
  /** A gesture hint: warm, stern, uneasy, bright, tired, lean, wry, proud. */
  mood?: string;
  choices: DialogChoice[];
  rumour?: { Key: string; Kind: string; Name: string; X: number; Z: number; Pos: boolean };
}

const dec = new TextDecoder();

export function decodeNode(data: Uint8Array): DialogNode | null {
  try {
    const n = JSON.parse(dec.decode(data)) as DialogNode;
    if (!n || typeof n.line !== 'string' || !Array.isArray(n.choices)) return null;
    return n;
  } catch {
    return null;
  }
}

/** Event 1911 reasons. */
export const END_REASON: Record<number, string> = {
  0: '',
  1: 'You walked away.',
  2: 'They had to get back to work.',
  3: 'They are gone.',
  4: '',
};

/** Event 1912 reasons. */
export const REFUSAL: Record<number, string> = {
  1: 'There is nobody there to talk to.',
  2: 'Too far away to talk.',
  3: 'The conversation has ended.',
  4: 'That is not something you can say.',
  5: 'They are not here any more.',
};
