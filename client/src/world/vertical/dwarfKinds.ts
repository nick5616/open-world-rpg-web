// Decoration kinds appended by genVersion 4 (CR 043, worldgen vertical `dk`
// 28..45), and the descriptor flag for interactive ones. Kept here so the
// shared worldgen/js table stays the golden-checked reader.

export const DW = {
  minecart: 28,
  rails: 29,
  support: 30,
  bones: 31,
  glowworms: 32,
  chest: 33,
  tablet: 34,
  brazier: 35,
  dwarfDoor: 36,
  dwarfPillar: 37,
  orePile: 38,
  runes: 39,
  statue: 40,
  banner: 41,
  secretDoor: 42,
  throne: 43,
  forgeglow: 44,
  collapse: 45,
} as const;

export const DECO_INTERACT = 4;

/** Chamber kinds of the dwarves (worldgen ck 6..8). */
export const CHAMBER_DWARF = 6;
export const isDwarfChamber = (kind: number) => kind >= CHAMBER_DWARF;

/** Kinds lit warm (torch orange) instead of by their tint. */
export const isWarmKind = (kind: number) =>
  kind === DW.brazier || kind === DW.dwarfDoor || kind === DW.secretDoor || kind === DW.throne || kind === DW.forgeglow;

/** Interact targetKinds (server CR 043) and Event kinds 1860-1863. */
export const INTERACT_CHEST = 160;
export const INTERACT_TABLET = 161;
export const EV_DWARF_DISCOVER = 1860;
export const EV_CHEST_OPENED = 1861;
export const EV_TABLET_READ = 1862;
export const EV_LOWER_HALLS = 1863;

/** A chest the server has opened for you stays closed for others and empty for you for this long (ms). */
export const CHEST_COOLDOWN_MS = 20 * 60 * 1000;

/** Live state of the dwarven set, shared by the manager (draws, prompts) and the event handler. */
export const dwarfRuntime: {
  /** Opened chests by descriptor index -> performance.now() when. */
  openedAt: Map<number, number>;
  /** Halls found this session (settlement site index). */
  found: Set<number>;
  openChest: (deco: number) => void;
  siteName: (site: number) => string | null;
} = { openedAt: new Map(), found: new Set(), openChest: () => undefined, siteName: () => null };
