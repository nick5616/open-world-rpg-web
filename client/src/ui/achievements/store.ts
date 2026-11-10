// Achievements in the browser (playtest 2, CR 031): whether the screen (Y)
// is open and the unlock toast queue (toasts.ts). What is earned lives in
// the content store's sync (ui/content/store.ts: Event 1000, 1002, 1241);
// ui/content/link.ts hands Events 1002 and 1241 here as toasts too.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { emptyQueue, enqueueToast, tickToasts, toastFromEvent, type ToastQueue } from './toasts';

export interface AchievementsState {
  open: boolean;
  toasts: ToastQueue;
}

export const useAchievements = create<AchievementsState>(() => ({ open: false, toasts: emptyQueue() }));

export function setAchievementsOpen(open: boolean): void {
  if (useAchievements.getState().open === open) return;
  useAchievements.setState({ open });
  // A panel that wants the mouse frees it (like the character panel).
  if (open && typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

export const openAchievements = (): void => setAchievementsOpen(true);
export const toggleAchievements = (): void => setAchievementsOpen(!useAchievements.getState().open);

/** Queue the toast for an Event 1002 / 1241 (anything else is ignored). */
export function pushAchievementEvent(ev: ZoneEvent): void {
  const t = toastFromEvent(ev);
  if (t) useAchievements.setState((s) => ({ toasts: enqueueToast(s.toasts, t) }));
}

export function tickAchievementToasts(now: number, blocked: boolean): void {
  const s = useAchievements.getState();
  if (!s.toasts.current && !s.toasts.queue.length) return;
  useAchievements.setState({ toasts: tickToasts(s.toasts, now, blocked) });
}

export function resetAchievements(): void {
  useAchievements.setState({ open: false, toasts: emptyQueue() });
}
