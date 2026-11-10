// Content state in the browser (playtest 2, CR 023): the zone's content
// sync (codex kills, tablets read, achievements earned (CR 031), title, reputation, vaults found),
// the places near you (lore tablets and herb patches by area), world events
// in range, live vaults, the tablet being read, short notes (others'
// gold+ achievements (CR 031),
// reputation, codex, vault lines, event results) and other players' titles.
// `reduceContentEvent` is pure and unit-tested; the zone is the truth.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { COMBAT, CONTENT } from '@lodestone/contracts';
import { CEV, CONTENT_REFUSAL, EVENT_PHASE, decodeJSON, decodePlaces, decodeSync, decodeText, decodeVault, decodeWorldEvent, type ContentSync, type HerbPatch, type TabletPlace, type VaultView, type WorldEventView } from './events';
import { playerTitles } from './titles';

export interface ContentNote {
  id: number;
  kind: 'feat' | 'rep' | 'codex' | 'vault' | 'event' | 'herb' | 'refused' | 'say' | 'lore';
  title: string;
  text: string;
  at: number;
}

export interface TabletReading {
  site: number;
  id: number;
  title: string;
  text: string;
  place: string;
  isNew: boolean;
}

export interface ContentActions {
  sync(): void;
  read(site: number): void;
  forage(id: number): void;
  vault(site: number, part: number): void;
  /** Show achievement id's title on your nameplate (0 = none). */
  title(achievementId: number): void;
  devEvent(kind: number): void;
}

export interface ContentState {
  sync: ContentSync;
  tablets: Record<number, TabletPlace>;
  patches: Record<number, HerbPatch>;
  events: Record<number, WorldEventView>;
  vaults: Record<number, VaultView>;
  reading: TabletReading | null;
  notes: ContentNote[];
  actions: ContentActions | null;
  stats: { events: number; places: number; feats: number };
}

const NOTE_MS = 6500;
const EVENT_LINGER_MS = 9000;
let noteId = 1;

export const emptySync = (): ContentSync => ({ kills: {}, tablets: [], feats: [], earned: {}, points: 0, title: '', stats: {}, regions: 0, rep: [], vaults: [], progress: {}, fish: {} });

const initial = (): Omit<ContentState, 'actions'> => ({
  sync: emptySync(),
  tablets: {},
  patches: {},
  events: {},
  vaults: {},
  reading: null,
  notes: [],
  stats: { events: 0, places: 0, feats: 0 },
});

const enemyName = (key: string) => COMBAT.enemies.find((e) => e.key === key)?.name ?? key.replace(/_/g, ' ');

/** Pure: the state change for one zone Event (null = not ours). */
export function reduceContentEvent(s: ContentState, ev: ZoneEvent, now: number, selfId = 0): Partial<ContentState> | null {
  const push = (n: Omit<ContentNote, 'id' | 'at'>) => [...s.notes.filter((x) => now - x.at < NOTE_MS), { ...n, id: noteId++, at: now }].slice(-4);
  switch (ev.kind) {
    case CEV.sync:
      return { sync: decodeSync(ev.data) };
    case CEV.codex: {
      const key = decodeText(ev.data);
      const kills = { ...s.sync.kills, [key]: Math.max(1, s.sync.kills[key] ?? 0) };
      return { sync: { ...s.sync, kills }, notes: push({ kind: 'codex', title: 'New codex entry', text: enemyName(key) }) };
    }
    case CEV.achievement: {
      // CR 031: the unlock card is the achievements toast (ui/achievements, fed by link.ts), not a note here.
      const j = decodeJSON<{ key: string; title?: string; at?: number }>(ev.data);
      if (!j?.key) return null;
      const feats = s.sync.feats.includes(j.key) ? s.sync.feats : [...s.sync.feats, j.key];
      const earned = { ...s.sync.earned, [j.key]: j.at ?? Date.now() };
      return { sync: { ...s.sync, feats, earned, points: ev.value || s.sync.points, title: s.sync.title || (j.title ? j.key : '') }, stats: { ...s.stats, feats: s.stats.feats + 1 } };
    }
    case CEV.achievementAnnounce: {
      // Someone near you or in your party earned a gold or platinum achievement: a short line, not the big card.
      const def = CONTENT.achievements.find((a) => a.id === ev.targetId);
      if (!def) return null;
      const tier = CONTENT.achievementTiers[ev.value]?.name ?? '';
      const who = decodeText(ev.data) || 'Someone';
      return { notes: push({ kind: 'feat', title: `${who} earned an achievement`, text: `${def.name}${tier ? ` (${tier})` : ''}` }) };
    }
    case CEV.achievementsCaughtUp: {
      // A pre-CR 031 character's first join: everything its old counters had already earned, at once (one toast, ui/achievements).
      const j = decodeJSON<{ keys?: string[]; pts?: number }>(ev.data);
      const add = (j?.keys ?? []).filter((k) => !s.sync.feats.includes(k));
      const earned = { ...s.sync.earned };
      for (const k of add) earned[k] = 0;
      return { sync: { ...s.sync, feats: [...s.sync.feats, ...add], earned } };
    }
    case CEV.tablet: {
      const j = decodeJSON<{ site: number; id: number; title: string; text: string; new: boolean; place: string }>(ev.data);
      if (!j) return null;
      const tablets = s.sync.tablets.includes(j.id) ? s.sync.tablets : [...s.sync.tablets, j.id].sort((a, b) => a - b);
      const near = s.tablets[j.site] ? { ...s.tablets, [j.site]: { ...s.tablets[j.site], read: true } } : s.tablets;
      return { reading: { site: j.site, id: j.id, title: j.title, text: j.text, place: j.place, isNew: j.new }, sync: { ...s.sync, tablets }, tablets: near, notes: j.new ? push({ kind: 'lore', title: 'Lore tablet read', text: j.title }) : s.notes };
    }
    case CEV.rep: {
      const j = decodeJSON<{ town: string; rep: number; gain: number; tier: number; tierName: string; up: boolean }>(ev.data);
      if (!j) return null;
      const rep = [...s.sync.rep.filter((r) => r.town !== ev.targetId), { town: ev.targetId, name: j.town, rep: j.rep, tier: j.tier }].sort((a, b) => a.town - b.town);
      return { sync: { ...s.sync, rep }, notes: push({ kind: 'rep', title: j.up ? `${j.town}: ${j.tierName}!` : `Renown with ${j.town}`, text: j.up ? 'Merchants there have better wares for you now.' : `+${j.gain} (${j.rep}, ${j.tierName})` }) };
    }
    case CEV.title: {
      const t = decodeText(ev.data);
      if (t) playerTitles.set(ev.entityId, t);
      else playerTitles.delete(ev.entityId);
      return ev.entityId === selfId ? { sync: { ...s.sync } } : {};
    }
    case CEV.refused:
      return { notes: push({ kind: 'refused', title: 'Hm.', text: CONTENT_REFUSAL[ev.value] ?? `Refused (${ev.value})` }) };
    case CEV.places: {
      const p = decodePlaces(ev.data, now);
      if (!p) return null;
      const tablets = { ...s.tablets };
      for (const t of p.tablets) tablets[t.site] = t;
      const patches = { ...s.patches };
      for (const h of p.patches) patches[h.id] = h;
      return { tablets, patches, stats: { ...s.stats, places: s.stats.places + 1 } };
    }
    case CEV.picked: {
      const h = s.patches[ev.targetId];
      const herb = CONTENT.forage.herbs.find((x) => x.item === decodeText(ev.data));
      return { patches: h ? { ...s.patches, [ev.targetId]: { ...h, readyAt: now + ev.value } } : s.patches, notes: push({ kind: 'herb', title: 'Gathered', text: herb?.name ?? decodeText(ev.data) }) };
    }
    case CEV.say:
      return { notes: push({ kind: 'say', title: 'Lost villager', text: decodeText(ev.data) }) };
    case CEV.worldEvent: {
      const w = decodeWorldEvent(ev.data, ev.value === EVENT_PHASE.updated ? EVENT_PHASE.active : ev.value, now);
      if (!w) return null;
      const events: Record<number, WorldEventView> = {};
      for (const [k, v] of Object.entries(s.events)) if (v.phase === EVENT_PHASE.active || now - v.at < EVENT_LINGER_MS) events[Number(k)] = v;
      const first = !s.events[w.id];
      events[w.id] = w;
      const notes = first && w.phase === EVENT_PHASE.active ? push({ kind: 'event', title: w.name, text: w.text }) : w.phase !== EVENT_PHASE.active && s.events[w.id]?.phase === EVENT_PHASE.active ? push({ kind: 'event', title: `${w.name}: ${w.phase === EVENT_PHASE.won ? 'won' : 'over'}`, text: w.text }) : s.notes;
      return { events, notes, stats: { ...s.stats, events: s.stats.events + 1 } };
    }
    case CEV.eventPrize: {
      const j = decodeJSON<{ name: string; gold: number; xp: number; ore?: number; gems?: number }>(ev.data);
      if (!j) return null;
      return { notes: push({ kind: 'event', title: `${j.name}: your share`, text: [`+${j.gold} gold`, `+${j.xp} XP`, j.ore ? `${j.ore} starmetal ore` : '', j.gems ? `${j.gems} gems` : ''].filter(Boolean).join(' · ') }) };
    }
    case CEV.vault: {
      const v = decodeVault(ev.data, ev.value);
      if (!v) return null;
      return { vaults: { ...s.vaults, [v.site]: v } };
    }
    case CEV.vaultFound: {
      const j = decodeJSON<{ site: number; name: string; x: number; z: number }>(ev.data);
      if (!j) return null;
      const vaults = s.sync.vaults.some((x) => x.site === j.site) ? s.sync.vaults : [...s.sync.vaults, j];
      return { sync: { ...s.sync, vaults }, notes: push({ kind: 'vault', title: 'Sealed vault found', text: `${j.name} is marked on your map.` }) };
    }
    case CEV.vaultNote:
      return { notes: push({ kind: 'vault', title: s.vaults[ev.targetId]?.name ?? 'The vault', text: decodeText(ev.data) }) };
    default:
      return null;
  }
}

export const useContent = create<ContentState>(() => ({ ...initial(), actions: null }));

let selfId = 0;
export function setContentSelf(id: number): void {
  selfId = id;
}

export function applyContentEvent(ev: ZoneEvent, now = performance.now()): void {
  const patch = reduceContentEvent(useContent.getState(), ev, now, selfId);
  if (patch) useContent.setState(patch);
}

export function resetContent(): void {
  useContent.setState({ ...initial() });
  playerTitles.clear();
}

export function setContentActions(a: ContentActions | null): void {
  useContent.setState({ actions: a });
}

export function closeTablet(): void {
  useContent.setState({ reading: null });
}

export function pruneContentNotes(now = performance.now()): void {
  const s = useContent.getState();
  const keep = s.notes.filter((x) => now - x.at < NOTE_MS);
  const events: Record<number, WorldEventView> = {};
  let changed = keep.length !== s.notes.length;
  for (const [k, v] of Object.entries(s.events)) {
    if (v.phase === EVENT_PHASE.active ? v.endsAt + 5000 > now : now - v.at < EVENT_LINGER_MS) events[Number(k)] = v;
    else changed = true;
  }
  if (changed) useContent.setState({ notes: keep, events });
}

/** The active world event nearest (x, z), if any. */
export function nearestEvent(s: Pick<ContentState, 'events'>, x: number, z: number): WorldEventView | null {
  let best: WorldEventView | null = null;
  let bd = Infinity;
  for (const e of Object.values(s.events)) {
    const d = Math.hypot(e.x - x, e.z - z);
    if (d < bd) {
      best = e;
      bd = d;
    }
  }
  return best;
}

/** A creature's codex view (the zone counts kills; the tables tell the rest). */
export function codexEntries(sync: ContentSync) {
  return CONTENT.codex.map((c) => ({ ...c, kills: sync.kills[c.key] ?? 0, unlocked: (sync.kills[c.key] ?? 0) > 0 }));
}
