// Achievements view model (playtest 2, CR 031; contracts/achievements.yaml).
// Pure functions over the zone's content sync (Event 1000: `feats` earned in
// earn order, `earned` key -> unix ms, `progress` key -> counter) and the
// generated table: what the Achievements screen (Y), the journal tab and
// the character panel's title list show. Unit-tested in
// achievements.test.ts; the zone stays the truth for what is earned.

import { CONTENT, type AchievementDef } from '@lodestone/contracts';

/** The part of the content sync the achievements need (ui/content/events.ts ContentSync). */
export interface AchSync {
  feats: string[];
  earned?: Record<string, number>;
  progress: Record<string, number>;
  title: string;
}

export type AchFilter = 'all' | 'earned' | 'unearned' | 'hidden';

export interface AchView {
  def: AchievementDef;
  earned: boolean;
  /** Unix ms it was earned (0: earned before CR 031, or not earned). */
  at: number;
  /** Counter clamped to [0, n] (n once earned). */
  progress: number;
  /** 0..1 */
  pct: number;
  /** A hidden achievement not earned yet: "???" and its hint. */
  masked: boolean;
  name: string;
  desc: string;
  /** "I", "II", "III" for a chain step, else "". */
  roman: string;
  tierName: string;
  tierColor: string;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
export const MASK = '???';

export const roman = (step: number): string => ROMAN[step] ?? String(step);

export function tierOf(def: AchievementDef) {
  return CONTENT.achievementTiers[def.tier] ?? { key: 'bronze', name: 'Bronze', pts: 10, gold: 0, xp: 0, color: '#c8875a', announce: false };
}

export function achView(def: AchievementDef, sync: AchSync): AchView {
  const earned = sync.feats.includes(def.key);
  const raw = earned ? def.n : (sync.progress[def.key] ?? 0);
  const progress = Math.max(0, Math.min(def.n, raw));
  const masked = def.hidden && !earned;
  const t = tierOf(def);
  return {
    def,
    earned,
    at: earned ? (sync.earned?.[def.key] ?? 0) : 0,
    progress,
    pct: def.n > 0 ? progress / def.n : 0,
    masked,
    name: masked ? MASK : def.name,
    desc: masked ? def.hint || 'A secret. Keep playing.' : def.desc,
    roman: def.step ? roman(def.step) : '',
    tierName: t.name,
    tierColor: t.color,
  };
}

/** Matches the text the player can see: a masked achievement only matches "???". */
export function matchesSearch(v: AchView, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  if (v.masked) return MASK.includes(s);
  return v.name.toLowerCase().includes(s) || v.desc.toLowerCase().includes(s) || (v.def.title ? v.def.title.toLowerCase().includes(s) : false);
}

export function matchesFilter(v: AchView, f: AchFilter): boolean {
  switch (f) {
    case 'earned':
      return v.earned;
    case 'unearned':
      return !v.earned;
    case 'hidden':
      return v.def.hidden;
    default:
      return true;
  }
}

export interface ListOpts {
  /** Category index (CONTENT.achievementCats), -1 all. */
  cat?: number;
  filter?: AchFilter;
  search?: string;
  /** A chain shows its earned steps and only its next unearned one (default true; off while searching). */
  collapseChains?: boolean;
}

/** The rows to show, in table order (chain steps in count order where they stand). */
export function achList(sync: AchSync, opts: ListOpts = {}, defs: readonly AchievementDef[] = CONTENT.achievements): AchView[] {
  const { cat = -1, filter = 'all', search = '' } = opts;
  const collapse = opts.collapseChains ?? !search.trim();
  const views = defs.map((d) => achView(d, sync));
  // A chain's next step: its lowest unearned one.
  const next = new Map<string, string>();
  if (collapse) {
    for (const v of [...views].sort((a, b) => a.def.n - b.def.n)) {
      if (v.def.chain && !v.earned && !next.has(v.def.chain)) next.set(v.def.chain, v.def.key);
    }
  }
  return views.filter((v) => {
    if (cat >= 0 && v.def.cat !== cat) return false;
    if (collapse && v.def.chain && !v.earned && next.get(v.def.chain) !== v.def.key) return false;
    return matchesFilter(v, filter) && matchesSearch(v, search);
  });
}

export interface PointsSummary {
  earned: number;
  total: number;
  count: number;
  of: number;
}

export function points(sync: AchSync, defs: readonly AchievementDef[] = CONTENT.achievements): PointsSummary {
  let earned = 0;
  let total = 0;
  let count = 0;
  for (const d of defs) {
    total += d.pts;
    if (sync.feats.includes(d.key)) {
      earned += d.pts;
      count++;
    }
  }
  return { earned, total, count, of: defs.length };
}

export interface CatSummary extends PointsSummary {
  cat: number;
  key: string;
  name: string;
}

/** Per category: achievements and points earned of total. */
export function catSummaries(sync: AchSync, defs: readonly AchievementDef[] = CONTENT.achievements): CatSummary[] {
  return CONTENT.achievementCats.map((c, cat) => ({ cat, key: c.key, name: c.name, ...points(sync, defs.filter((d) => d.cat === cat)) }));
}

/**
 * The newest earned, by earn time (earned before CR 031 has no time: those
 * come after, newest-earned order kept from `feats`).
 */
export function recentEarned(sync: AchSync, k = 5, defs: readonly AchievementDef[] = CONTENT.achievements): AchView[] {
  const order = new Map(sync.feats.map((key, i) => [key, i]));
  return defs
    .filter((d) => order.has(d.key))
    .map((d) => achView(d, sync))
    .sort((a, b) => b.at - a.at || (order.get(b.def.key) ?? 0) - (order.get(a.def.key) ?? 0))
    .slice(0, k);
}

/** Earned achievements that grant a title (the nameplate choices). */
export function earnedTitles(sync: AchSync, defs: readonly AchievementDef[] = CONTENT.achievements): AchievementDef[] {
  return defs.filter((d) => d.title && sync.feats.includes(d.key));
}

export function achByKey(key: string): AchievementDef | undefined {
  return CONTENT.achievements.find((a) => a.key === key);
}

export function achById(id: number): AchievementDef | undefined {
  return CONTENT.achievements[id - 1]?.id === id ? CONTENT.achievements[id - 1] : CONTENT.achievements.find((a) => a.id === id);
}

/** The shown title's text ("" none). */
export function titleText(sync: AchSync): string {
  return sync.title ? (achByKey(sync.title)?.title ?? '') : '';
}

/** "12,345" */
export const fmt = (n: number): string => n.toLocaleString('en-US');
