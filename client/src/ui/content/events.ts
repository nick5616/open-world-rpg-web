// Content wire glue (playtest 2, CR 023): Event kinds 1000-1029 and
// Interact 80 (contracts/events.md). JSON for the rare, wordy ones; Event
// 1007 (lore tablets and herb patches of an area) is binary because a
// player walking about receives it for every new area.

export const CEV = {
  sync: 1000,
  codex: 1001,
  feat: 1002,
  tablet: 1003,
  rep: 1004,
  title: 1005,
  refused: 1006,
  places: 1007,
  picked: 1008,
  say: 1009,
  worldEvent: 1010,
  eventPrize: 1011,
  vault: 1020,
  vaultFound: 1021,
  vaultNote: 1022,
} as const;

export const CONTENT_INTERACT = 80;
export const CONTENT_ACT = { sync: 1, read: 2, forage: 3, vault: 4, title: 5, devEvent: 9 } as const;

export const CONTENT_REFUSAL: Record<number, string> = {
  1: 'Nothing to do there',
  2: 'Too far away',
  3: 'Already picked: it will grow back',
  4: 'Your pack is full',
  5: 'The vault is still sealed',
  6: 'Not now',
  7: 'You already opened this chest today',
  8: 'You have not earned that title',
};

/** World event phases (1010 value). */
export const EVENT_PHASE = { active: 1, won: 2, failed: 3, updated: 4 } as const;

export interface ContentSync {
  kills: Record<string, number>;
  tablets: number[];
  feats: string[];
  title: string;
  stats: Record<string, number>;
  regions: number;
  rep: { town: number; name: string; rep: number; tier: number }[];
  vaults: { site: number; name: string; x: number; z: number }[];
  progress: Record<string, number>;
}

export interface TabletPlace {
  site: number;
  id: number;
  x: number;
  y: number;
  z: number;
  read: boolean;
}

export interface HerbPatch {
  id: number;
  herb: number;
  x: number;
  y: number;
  z: number;
  /** performance.now() when it is ready again for you (0 = ready). */
  readyAt: number;
}

export interface WorldEventView {
  id: number;
  kind: string;
  name: string;
  text: string;
  phase: number;
  endsAt: number; // performance.now() ms
  progress: number;
  x: number;
  y: number;
  z: number;
  r: number;
  wave?: number;
  waves?: number;
  hp?: number;
  at: number;
}

export interface VaultPart {
  id: number;
  kind: 'lever' | 'plate' | 'brazier' | 'font' | 'door' | 'chest';
  label: string;
  x: number;
  y: number;
  z: number;
  on: boolean;
  glyph: number;
}

export interface VaultView {
  site: number;
  name: string;
  phase: number;
  opened: boolean;
  puzzle: string;
  title: string;
  hint: string;
  parts: VaultPart[];
  keeper: number;
  x: number;
  z: number;
  r: number;
  element?: string;
}

const utf8 = new TextDecoder();

export function decodeJSON<T>(data: Uint8Array): T | null {
  try {
    return JSON.parse(utf8.decode(data)) as T;
  } catch {
    return null;
  }
}

export function decodeText(data: Uint8Array): string {
  return utf8.decode(data);
}

export function decodeSync(data: Uint8Array): ContentSync {
  const j = decodeJSON<Partial<ContentSync>>(data) ?? {};
  return {
    kills: j.kills ?? {},
    tablets: j.tablets ?? [],
    feats: j.feats ?? [],
    title: j.title ?? '',
    stats: j.stats ?? {},
    regions: j.regions ?? 0,
    rep: j.rep ?? [],
    vaults: j.vaults ?? [],
    progress: j.progress ?? {},
  };
}

/** Event 1007: u8 version | u16 ax | u16 az | u16 n x tablet | u16 n x patch. */
export function decodePlaces(data: Uint8Array, now: number): { ax: number; az: number; tablets: TabletPlace[]; patches: HerbPatch[] } | null {
  if (data.length < 7 || data[0] !== 1) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 1;
  const ax = dv.getUint16(o, true);
  const az = dv.getUint16(o + 2, true);
  o += 4;
  const nt = dv.getUint16(o, true);
  o += 2;
  const tablets: TabletPlace[] = [];
  for (let i = 0; i < nt && o + 16 <= data.length; i++) {
    tablets.push({ site: dv.getUint16(o, true), id: data[o + 2], x: dv.getInt32(o + 3, true) / 100, y: dv.getInt32(o + 7, true) / 100, z: dv.getInt32(o + 11, true) / 100, read: data[o + 15] === 1 });
    o += 16;
  }
  const patches: HerbPatch[] = [];
  if (o + 2 <= data.length) {
    const np = dv.getUint16(o, true);
    o += 2;
    for (let i = 0; i < np && o + 21 <= data.length; i++) {
      const left = dv.getUint32(o + 17, true);
      patches.push({ id: dv.getUint32(o, true), herb: data[o + 4], x: dv.getInt32(o + 5, true) / 100, y: dv.getInt32(o + 9, true) / 100, z: dv.getInt32(o + 13, true) / 100, readyAt: left > 0 ? now + left : 0 });
      o += 21;
    }
  }
  return { ax, az, tablets, patches };
}

export function decodeWorldEvent(data: Uint8Array, phase: number, now: number): WorldEventView | null {
  const j = decodeJSON<{ id: number; kind: string; name: string; text: string; endsInMs: number; progress: number; x: number; y: number; z: number; r: number; wave?: number; waves?: number; hp?: number }>(data);
  if (!j) return null;
  return { id: j.id >>> 0, kind: j.kind, name: j.name, text: j.text, phase, endsAt: now + (j.endsInMs ?? 0), progress: j.progress ?? -1, x: j.x, y: j.y, z: j.z, r: j.r ?? 25, wave: j.wave, waves: j.waves, hp: j.hp, at: now };
}

export function decodeVault(data: Uint8Array, value: number): VaultView | null {
  const j = decodeJSON<Omit<VaultView, 'opened'>>(data);
  if (!j) return null;
  return { ...j, parts: j.parts ?? [], phase: value & 0xf, opened: (value & 0x10) !== 0 };
}

/** Lever glyph names (the inscription words). */
export const GLYPHS = ['sun', 'moon', 'star'] as const;

/** What a world event is doing, in a line for the HUD. */
export function eventStatus(e: WorldEventView, now: number): string {
  const left = Math.max(0, Math.round((e.endsAt - now) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  if (e.phase === EVENT_PHASE.won) return 'Victory';
  if (e.phase === EVENT_PHASE.failed) return 'Failed';
  switch (e.kind) {
    case 'caravan':
      return `Caravan ${Math.max(0, e.hp ?? e.progress)}%${e.waves ? ` · wave ${Math.max(1, e.wave ?? 0)}/${e.waves}` : ''} · ${clock}`;
    case 'glintfox':
      return `Catch it! · ${clock}`;
    case 'behemoth':
      return `${e.progress >= 0 ? `Behemoth ${e.progress}% · ` : ''}${clock}`;
    default:
      return `${e.progress >= 0 ? `${e.progress}% remain · ` : ''}${clock}`;
  }
}
