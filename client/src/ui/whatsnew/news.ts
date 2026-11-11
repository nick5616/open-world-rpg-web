// Playtest 2: "What's new since you last played". The player-facing
// changelog lives in changelog.json (newest first; add an entry with
// `node scripts/whatsnew.mjs add`, see client/src/ui/whatsnew/README.md).
// This browser remembers the newest entry id it has shown
// (localStorage SEEN_KEY); after login the panel lists only the entries
// above that id. A first-time player gets a short welcome instead of the
// whole history. Pure except the storage helpers (news.test.ts).
//
// Fail-safe: entries are validated here, a malformed one is dropped (and
// reported by `node scripts/whatsnew.mjs check` and the vitest), never
// thrown, so a bad changelog can't stop the game from loading.

export interface ChangelogEntry {
  /** Unique, stable: what the browser remembers. */
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  title: string;
  /** Short, friendly, player-facing lines. */
  items: string[];
}

export const SEEN_KEY = 'lodestone_whatsnew_seen';
/** At most this many entries in the "since you last played" panel. */
export const MAX_SHOWN = 8;

/** After the world is up, once the arrival cards are done (at most MAX_WAIT_MS for those). */
export const SHOW_AFTER_MS = 2500;
export const MAX_WAIT_MS = 25000;
/** Playtest 2 polish: the card waits until you have stood still this long (it came up mid-walk)... */
export const STILL_MS = 1200;
/** ...for at most this long after the world is up. */
export const MOVING_MAX_WAIT_MS = 180000;

/**
 * Whether the welcome / What's new card may come up now: never over a
 * panel; after the arrival cards, the menu and being downed (or after
 * MAX_WAIT_MS of them); and only once you stand still (or after
 * MOVING_MAX_WAIT_MS of walking), so it never stops a walk.
 */
export function cardMayShow(s: { sinceReadyMs: number; panelUp: boolean; busy: boolean; stillMs: number }): boolean {
  if (s.sinceReadyMs < SHOW_AFTER_MS || s.panelUp) return false;
  if (s.busy && s.sinceReadyMs < MAX_WAIT_MS) return false;
  return s.stillMs >= STILL_MS || s.sinceReadyMs >= MOVING_MAX_WAIT_MS;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One problem per malformed entry (empty = all good). */
export function changelogProblems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['the changelog is not a list'];
  const out: string[] = [];
  const ids = new Set<string>();
  let prevDate = '9999-99-99';
  raw.forEach((e, i) => {
    const at = `entry ${i}${e && typeof e === 'object' && typeof (e as ChangelogEntry).id === 'string' ? ` (${(e as ChangelogEntry).id})` : ''}`;
    if (!e || typeof e !== 'object') return out.push(`${at}: not an object`);
    const c = e as Partial<ChangelogEntry>;
    if (typeof c.id !== 'string' || !ID.test(c.id)) out.push(`${at}: id must be lowercase letters, digits, . _ - (got ${JSON.stringify(c.id)})`);
    else if (ids.has(c.id)) out.push(`${at}: duplicate id`);
    else ids.add(c.id);
    if (typeof c.date !== 'string' || !DATE.test(c.date) || Number.isNaN(Date.parse(c.date))) out.push(`${at}: date must be YYYY-MM-DD`);
    else if (c.date > prevDate) out.push(`${at}: newer than the entry above it (newest first)`);
    else prevDate = c.date;
    if (typeof c.title !== 'string' || !c.title.trim()) out.push(`${at}: no title`);
    if (!Array.isArray(c.items) || c.items.length === 0 || c.items.some((s) => typeof s !== 'string' || !s.trim())) out.push(`${at}: items must be a non-empty list of lines`);
  });
  return out;
}

/** The well-formed entries, newest first (malformed ones dropped, never thrown). */
export function validEntries(raw: unknown): ChangelogEntry[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const out: ChangelogEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const c = e as Partial<ChangelogEntry>;
    if (typeof c.id !== 'string' || !ID.test(c.id) || ids.has(c.id)) continue;
    if (typeof c.date !== 'string' || !DATE.test(c.date)) continue;
    if (typeof c.title !== 'string' || !c.title.trim()) continue;
    if (!Array.isArray(c.items)) continue;
    const items = c.items.filter((s): s is string => typeof s === 'string' && !!s.trim());
    if (!items.length) continue;
    ids.add(c.id);
    out.push({ id: c.id, date: c.date, title: c.title, items });
  }
  return out;
}

export type WhatsNew = { kind: 'none' } | { kind: 'welcome'; newest: string } | { kind: 'news'; entries: ChangelogEntry[]; newest: string; /** Newer entries left out by the cap (shown in the Esc menu's full list). */ more: number };

/**
 * What to show after login.
 * - seen: the id this browser remembers (null: never stored);
 * - returning: whether this browser played before the changelog existed
 *   (it has older Lodestone settings): it gets every entry, not a welcome.
 * An id that is no longer in the list (removed, or from a newer build)
 * falls back to the entries dated after nothing we know: the newest few.
 */
export function whatsNew(entries: readonly ChangelogEntry[], seen: string | null, returning: boolean): WhatsNew {
  if (!entries.length) return { kind: 'none' };
  const newest = entries[0].id;
  if (seen === null) return returning ? { kind: 'news', entries: entries.slice(0, MAX_SHOWN), newest, more: Math.max(0, entries.length - MAX_SHOWN) } : { kind: 'welcome', newest };
  if (seen === newest) return { kind: 'none' };
  const at = entries.findIndex((e) => e.id === seen);
  const fresh = at < 0 ? entries.slice(0, Math.min(3, MAX_SHOWN)) : entries.slice(0, Math.min(at, MAX_SHOWN));
  const more = at < 0 ? 0 : Math.max(0, at - fresh.length);
  return fresh.length ? { kind: 'news', entries: fresh, newest, more } : { kind: 'none' };
}

// ---- storage (per browser; every access guarded: private windows throw)

export function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function writeSeen(id: string): void {
  try {
    localStorage.setItem(SEEN_KEY, id);
  } catch {
    /* nothing to remember with: the panel shows again next time */
  }
}

/** Keys this release itself writes: their presence doesn't mean an earlier visit. */
const NEW_KEYS = [SEEN_KEY, 'lodestone_tips_enabled', 'lodestone_tips_seen:'];

/** Whether this browser has Lodestone settings from before (a returning player). */
export function hasOlderSettings(keys: readonly string[]): boolean {
  return keys.some((k) => /^lodestone[._:-]/.test(k) && !NEW_KEYS.some((n) => k.startsWith(n)));
}

function storageKeys(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

/** Taken once when this module loads (before this session writes any settings). */
export const RETURNING_AT_LOAD = typeof localStorage !== 'undefined' && hasOlderSettings(storageKeys());
