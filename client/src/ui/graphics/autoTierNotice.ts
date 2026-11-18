// The one-time notice when Auto quality has picked a tier (playtest 5, CR 057):
// "Graphics set to High; F10 to change". Shown once per tier the player has not
// been told about (the told tier is persisted as `autoNoticed`), never for an
// explicit choice.

import { create } from 'zustand';
import { useQualityStore, type QualityTier } from '../../stores/qualityStore';

export const NOTICE_MS = 9000;

export const useAutoTierNotice = create<{ text: string | null; at: number; clear: () => void }>((set) => ({ text: null, at: 0, clear: () => set({ text: null }) }));

export function noticeText(tier: QualityTier): string {
  return `Graphics set to ${tier[0].toUpperCase()}${tier.slice(1)}; F10 to change`;
}

/** Called when the governor settles. Shows the notice only when Auto is still in charge and this tier is news. */
export function announceAutoTier(tier: QualityTier): boolean {
  const q = useQualityStore.getState();
  if (q.setting !== 'auto' || q.autoNoticed === tier) return false;
  q.setAutoNoticed(tier);
  useAutoTierNotice.setState({ text: noticeText(tier), at: Date.now() });
  return true;
}
