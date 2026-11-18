// Playtest 5 (CR 055): watches the conversation and the quest log and toasts
// the controls when a conversation that moved a quest on closes (controlTips.ts
// decides what; the keys come from the live bindings). Read-only on the dialog
// store: nothing in ui/dialog is touched.

import { useDialog } from '../dialog/store';
import { useQuests } from '../quests/store';
import { announcements, logChanges, type LogChange, type LogQuest } from './controlTips';
import { browserKV, type KV } from './tips';
import { useTips } from './store';

/** A quest log arrives a moment before the conversation's first line; changes this long before it opened still belong to it. */
export const LEAD_MS = 2500;
/** After the conversation closes, a quest update still in flight (the server answers a step after the close) is picked up for this long. */
export const GRACE_MS = 4000;

const seenKey = (character: string) => `lodestone_controls_seen:${character}`;

export function loadControlsSeen(kv: KV | null, character: string): Set<string> {
  try {
    const raw = kv?.getItem(seenKey(character));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveControlsSeen(kv: KV | null, character: string, seen: ReadonlySet<string>): void {
  try {
    kv?.setItem(seenKey(character), JSON.stringify([...seen]));
  } catch {
    /* private mode: shown again next session, nothing worse */
  }
}

const snapshot = (): LogQuest[] => useQuests.getState().log.quests.map((q) => ({ key: q.key, step: q.step, first: q.steps[0]?.text }));

/**
 * Start watching for `character`; returns the stop function. `now` and `kv`
 * are injectable for the tests.
 */
export function installControlLink(character: string, kv: KV | null = browserKV(), now: () => number = () => performance.now()): () => void {
  const seen = loadControlsSeen(kv, character);
  let prev = snapshot();
  let changes: LogChange[] = [];
  let openedAt = -1; // when the open conversation began (-1: none)
  let closedAt = -1e9;

  const flush = () => {
    const t = now();
    // Only while a conversation is open or has just closed; announce once it has closed.
    if (openedAt >= 0 || t - closedAt > GRACE_MS) return;
    const list = announcements(changes, seen, sinceOpen);
    for (const a of list) {
      seen.add(a.seenKey);
      if (useTips.getState().enabled) useTips.getState().pushControls(a.group, t);
    }
    if (list.length) saveControlsSeen(kv, character, seen);
  };
  let sinceOpen = 0;

  const unQuests = useQuests.subscribe(() => {
    const cur = snapshot();
    const found = logChanges(prev, cur, now());
    prev = cur;
    if (found.length) {
      changes = [...changes.filter((c) => now() - c.at < 60000), ...found];
      flush();
    }
  });
  const unDialog = useDialog.subscribe((s, p) => {
    if (!p.open && s.open) {
      openedAt = now();
      sinceOpen = openedAt - LEAD_MS;
    } else if (p.open && !s.open && openedAt >= 0) {
      openedAt = -1;
      closedAt = now();
      flush();
    }
  });
  return () => {
    unQuests();
    unDialog();
  };
}
