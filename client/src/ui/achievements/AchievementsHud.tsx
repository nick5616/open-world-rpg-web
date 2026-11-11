// Achievements on the play screen (playtest 2, CR 031): the screen (Y, Esc
// closes it; also the Esc menu's "Achievements" row and the character
// panel's button) and the unlock toast with its fanfare.
//
// Y is the one letter no world binding used (input/bindings.ts). A pending
// duel challenge keeps Y for "accept" (ui/pvp/PvpHud.tsx): the screen
// leaves Y alone while one waits. The instrument takes every key while you
// play (its capture listener stops them; ui/music/InstrumentHud.tsx).
//
// The toast waits while another card or panel owns the middle of the screen
// (toasts.ts): the welcome / What's new card, a discovery card, the level-up
// fanfare, the Esc menu or any panel that freed the mouse. Its sound plays
// when it shows (audio TRIGGERS.achievement), so the fanfare never lands
// under the level-up sting.

import { useEffect } from 'react';
import { CONTENT } from '@lodestone/contracts';
import { DEBUG } from '../../config';
import { emitSound } from '../../audio/bridge';
import { notGameKey } from '../../input/useKeyboard';
import { uiPanelUp } from '../../input/interact';
import { BELOW_CLOCK } from '../../hud/layout';
import { useIntro } from '../intro/queue';
import { useProgression } from '../progression/store';
import { registerMenuEntry, useMenu } from '../menu/store';
import { usePvp } from '../pvp/store';
import { useContent } from '../content/store';
import { AchievementsScreen } from './AchievementsScreen';
import { openAchievements, setAchievementsOpen, tickAchievementToasts, toggleAchievements, useAchievements } from './store';
import { moreCount } from './toasts';
import { trackPanel } from '../../input/panelStack';

// Esc closes the screen when it is the top panel (input/panelStack.ts).
trackPanel(useAchievements, (s) => s.open, 'achievements', () => setAchievementsOpen(false));

const TICK_MS = 250;

/** Another card or panel owns the screen: a toast waits (or holds). */
export function toastBlocked(): boolean {
  if (useIntro.getState().current || useProgression.getState().fanfare || useMenu.getState().open) return true;
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('[data-testid="whatsnew"], [data-testid="levelup-fanfare"], [data-testid="discovery-intro"], [data-testid="fish-caught"]') || uiPanelUp();
}

function useAchievementKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (notGameKey(e) || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'KeyY') {
        if (usePvp.getState().challenge) return; // the duel's "accept" wins (ui/pvp/PvpHud.tsx)
        toggleAchievements();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

const CSS = `
@keyframes achIn { from { opacity: 0; transform: translate(-50%, -8px) } to { opacity: 1; transform: translate(-50%, 0) } }
.ach-toast { animation: achIn 0.35s ease-out }
`;

function Toast() {
  const q = useAchievements((s) => s.toasts);
  const t = q.current;
  const id = t?.id;
  useEffect(() => {
    const iv = setInterval(() => tickAchievementToasts(performance.now(), toastBlocked()), TICK_MS);
    return () => clearInterval(iv);
  }, []);
  const tierNow = t?.tier ?? 0;
  useEffect(() => {
    if (id) emitSound('achievement', { tier: tierNow }); // once per card, when it comes up
  }, [id, tierNow]);
  if (!t || toastBlocked()) return null;
  const tier = CONTENT.achievementTiers[t.tier] ?? CONTENT.achievementTiers[0];
  const more = moreCount(q);
  return (
    <div key={t.id} data-testid="achievement-toast" className="ach-toast" style={{ position: 'fixed', top: BELOW_CLOCK, left: '50%', transform: 'translateX(-50%)', zIndex: 21, pointerEvents: 'none', minWidth: 300, maxWidth: 'min(520px, 90vw)', padding: '10px 18px 10px 14px', display: 'flex', gap: 12, alignItems: 'center', background: 'rgba(14,12,8,0.94)', border: `2px solid ${tier.color}`, borderRadius: 8, boxShadow: `0 8px 26px rgba(0,0,0,0.6), 0 0 18px ${tier.color}55`, color: '#f6efe0' }}>
      <div style={{ flex: 'none', width: 44, height: 44, borderRadius: '50%', display: 'grid', placeItems: 'center', background: tier.color, color: '#1b1408', font: '700 20px Georgia, serif' }}>★</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ font: '700 11px system-ui, sans-serif', letterSpacing: 3, textTransform: 'uppercase', color: tier.color }}>
          {t.summary ? 'Achievements' : `Achievement unlocked · ${tier.name}`}
          {t.pts > 0 && <span style={{ color: '#f6efe0', letterSpacing: 1 }}> · +{t.pts} pts</span>}
        </div>
        <div data-testid="achievement-toast-name" style={{ font: '600 19px Georgia, serif', lineHeight: 1.25 }}>
          {t.name}
        </div>
        {t.desc && <div style={{ fontSize: 13, color: '#e4dccb' }}>{t.desc}</div>}
        {t.rewards.length > 0 && <div style={{ fontSize: 12, color: '#ffd98a', marginTop: 2 }}>{t.rewards.join(' · ')}</div>}
        {more > 0 && <div style={{ fontSize: 11.5, color: '#cfc6b4', marginTop: 2 }}>+{more} more</div>}
      </div>
    </div>
  );
}

function installHandle() {
  const handle = {
    state: () => ({ ...useAchievements.getState() }),
    open: (v = true) => setAchievementsOpen(v),
    sync: () => useContent.getState().sync,
  };
  (window as unknown as { __lodestoneAchievements: typeof handle }).__lodestoneAchievements = handle;
}

export function AchievementsHud() {
  const open = useAchievements((s) => s.open);
  useAchievementKeys();
  useEffect(() => registerMenuEntry({ id: 'achievements', label: 'Achievements', order: 15, open: openAchievements }), []);
  useEffect(() => {
    if (DEBUG) installHandle();
  }, []);
  return (
    <>
      <style>{CSS}</style>
      <Toast />
      {open && <AchievementsScreen />}
    </>
  );
}
