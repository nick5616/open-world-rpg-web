// Progression state in the browser (playtest 1, CR 012): the zone's
// character stats (Event 900), the area you stand in (901), attunements
// (902/903), the level-up fanfare, area notices and the character panel.
// `reduceProgressionEvent` is pure and unit-tested.

import { create } from 'zustand';
import { COMBAT, type Event as ZoneEvent } from '@lodestone/contracts';
import { ATTUNE_REFUSED, decodeArea, decodeStats, PEV, STATS_REASON, type Area, type Stats } from './events';
import { gainLines } from './gains';
import { hotbarLines } from '../../combat/hotbar';
import { inRift } from '../../rift/store';

export interface Fanfare {
  id: number;
  level: number;
  prev: number;
  lines: string[];
  at: number;
  /** CR 039: the hotbar card (Event 900 reason 3) instead of a level-up. */
  hotbar?: boolean;
}

export interface Notice {
  id: number;
  kind: 'area' | 'danger' | 'safe' | 'attuned' | 'warn';
  title: string;
  detail?: string;
  at: number;
}

export interface ProgressionActions {
  attune(site: number): void;
  learn(spellId: number): void;
  /** Put a known spell in a loadout slot (spellId 0 empties it). */
  equipSpell(loadout: number, slot: number, spellId: number): void;
}

export interface ProgressionState {
  stats: Stats | null;
  area: Area | null;
  fanfare: Fanfare | null;
  notices: Notice[];
  panelOpen: boolean;
  /** Last attunement (Event 902): the moment the client can make grand. */
  attuned: { site: number; region: number; name: string; at: number } | null;
  actions: ProgressionActions | null;
}

let nextId = 1;
export const NOTICE_MS = 7000;
export const FANFARE_MS = 7000;

const utf8 = new TextDecoder();

function tierDetail(a: Area): string {
  const t = COMBAT.difficulty.tiers[a.tierIndex];
  if (!t) return '';
  if (a.haven) return 'Gentle creatures only. No demons ever walk here.';
  if (t.demons <= 0) return 'Beasts and slimes. Demons do not come here at night.';
  if (t.greater <= 0) return 'Demons walk here at night, but few and slow. Towns are safe.';
  return t.lords ? 'Elites, greater demons, and on new moons the demon lords.' : 'Elites roam, and greater demons rise at night.';
}

/** Pure: the state change for one zone Event (null = not ours). */
export function reduceProgressionEvent(s: ProgressionState, ev: ZoneEvent, now: number): Partial<ProgressionState> | null {
  const push = (n: Omit<Notice, 'id' | 'at'>): Notice[] => [...s.notices.filter((x) => now - x.at < NOTICE_MS), { ...n, id: nextId++, at: now }].slice(-3);
  switch (ev.kind) {
    case PEV.characterStats: {
      const st = decodeStats(ev.data);
      if (!st) return null;
      const patch: Partial<ProgressionState> = { stats: st };
      if (st.reason === STATS_REASON.levelUp && st.level > st.prevLevel) {
        patch.fanfare = { id: nextId++, level: st.level, prev: st.prevLevel, lines: gainLines(st.prevLevel, st.level), at: now };
      } else if (st.reason === STATS_REASON.hotbar && st.level > st.prevLevel) {
        const lines = hotbarLines(st.prevLevel, st.level);
        if (lines.length) patch.fanfare = { id: nextId++, level: st.level, prev: st.prevLevel, lines, at: now, hotbar: true };
      }
      return patch;
    }
    case PEV.area: {
      const a = decodeArea(ev);
      if (!a) return null;
      const prev = s.area;
      const patch: Partial<ProgressionState> = { area: a };
      // playtest 6 polish: a rift's arena hangs in the sky over the portal; its "area" is not a place you came to
      if (inRift()) return patch;
      if (a.byYou) {
        patch.notices = push({ kind: 'area', title: `First to set foot here: the land takes your measure`, detail: `Area level ${a.level} · ${a.tierName}. ${tierDetail(a)}` });
      } else if (!prev || prev.tierIndex !== a.tierIndex) {
        const kind = a.haven || COMBAT.difficulty.tiers[a.tierIndex]?.demons <= 0 ? 'safe' : 'danger';
        patch.notices = push({ kind, title: a.haven ? 'The Haven' : `${a.tierName} · area level ${a.level}`, detail: `${tierDetail(a)}${a.by && !a.haven ? ` First explored by ${a.by}.` : ''}` });
      }
      return patch;
    }
    case PEV.towerAttuned: {
      const name = ev.data.length ? utf8.decode(ev.data) : '';
      const lv = COMBAT.leveling.attune;
      return {
        attuned: { site: ev.targetId, region: ev.value, name, at: now },
        notices: push({ kind: 'attuned', title: `Crystal attuned${name ? `: ${name}` : ''}`, detail: `+${lv.stamina} stamina, +${lv.health} health, +${lv.skillPoints} skill point, +${lv.xp} XP. The crystal remembers you.` }),
      };
    }
    case PEV.attuneRefused:
      return { notices: push({ kind: 'warn', title: 'The crystal does not answer', detail: ATTUNE_REFUSED[ev.value] ?? `code ${ev.value}` }) };
    default:
      return null;
  }
}

const initial = (): Omit<ProgressionState, 'actions' | 'panelOpen'> => ({ stats: null, area: null, fanfare: null, notices: [], attuned: null });

export const useProgression = create<ProgressionState>(() => ({ ...initial(), panelOpen: false, actions: null }));

export function applyProgressionEvent(ev: ZoneEvent, now = performance.now()): void {
  const patch = reduceProgressionEvent(useProgression.getState(), ev, now);
  if (patch) useProgression.setState(patch);
}

export function setProgressionActions(a: ProgressionActions | null): void {
  useProgression.setState({ actions: a });
}

export function resetProgression(): void {
  useProgression.setState({ ...initial() });
}

export function setPanelOpen(open: boolean): void {
  useProgression.setState({ panelOpen: open });
}

/** holdFanfare: a discovery card is up; the level-up waits for it instead of expiring underneath (playtest 2). */
export function pruneProgression(now = performance.now(), holdFanfare = false): void {
  const s = useProgression.getState();
  const notices = s.notices.filter((x) => now - x.at < NOTICE_MS);
  const patch: Partial<ProgressionState> = {};
  if (notices.length !== s.notices.length) patch.notices = notices;
  if (s.fanfare && holdFanfare) patch.fanfare = { ...s.fanfare, at: now };
  else if (s.fanfare && now - s.fanfare.at > FANFARE_MS) patch.fanfare = null;
  if (Object.keys(patch).length) useProgression.setState(patch);
}

/** Is site's crystal attuned (from the latest stats)? */
export function isAttuned(site: number): boolean {
  const a = useProgression.getState().stats?.attuned;
  return !!a && site >= 0 && site >> 3 < a.length && (a[site >> 3] & (1 << (site & 7))) !== 0;
}
