// Playtest 2 (new player onboarding): draws one contextual tip at a time
// right above the hotbar. Samples the game at 4 Hz (no per-frame work):
// the movement state, the drawn enemies, health, the clock, the "[E] Talk"
// prompt, skill points and the tracked quest. Logic in tips.ts.

import { useEffect, useState } from 'react';
import { localPlayer, worldClock } from '../../state/live';
import { worldDebug } from '../../world/debug/worldDebug';
import { drawnRemotes, netRuntime, useNetStore } from '../../net/netStore';
import { combatRuntime } from '../../combat/link';
import { useCombatHud } from '../../combat/store';
import { useProgression } from '../progression/store';
import { trackedQuest } from '../quests/store';
import { useSocialStore } from '../../social/store';
import { isNight } from '../../systems/clock';
import { useMenu } from '../menu/store';
import { ABOVE_HOTBAR } from '../../hud/layout';
import { browserKV, cliffAhead, IDLE_CONTEXT, loadSeen, nextTip, saveSeen, settled, tipById, type TipContext, type TipId } from './tips';
import { useTips } from './store';

const ENEMY = 2;
const DEMON = 6;

/** Any panel that freed the mouse on purpose (hud/layout.ts uses the same test). */
function panelUp(): boolean {
  return !!document.querySelector('[data-ui-panel]:not([style*="display: none"])');
}

function sample(startedAt: number, hurtUntil: number): TipContext {
  const now = performance.now();
  const p = localPlayer;
  const self = netRuntime.session?.latestFrame?.self;
  const health = self && self.healthMax > 0 ? self.health / self.healthMax : 1;
  const c = useCombatHud.getState();
  let enemyNear = now < hurtUntil;
  if (!enemyNear) {
    for (const v of drawnRemotes.views) {
      if ((v.kind === ENEMY || v.kind === DEMON) && v.healthPct > 0 && Math.hypot(v.x - p.pos.x, v.z - p.pos.z) < 18) {
        enemyNear = true;
        break;
      }
    }
  }
  const ground = combatRuntime.current?.ground;
  const onFoot = p.mode === 'idle' || p.mode === 'walk' || p.mode === 'sprint' || p.mode === 'slide';
  const cliff = p.mode === 'climb' || (onFoot && !!ground && cliffAhead((x, z) => ground.heightAt(x, z), p.pos.x, p.pos.y, p.pos.z, p.yaw));
  const prompt = document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '';
  return {
    ...IDLE_CONTEXT,
    playingS: (now - startedAt) / 1000,
    busy: panelUp() || useMenu.getState().open || useSocialStore.getState().open || c.downedUntil > 0,
    questTracked: !!trackedQuest(),
    nearPerson: /^\[E\] Talk/.test(prompt),
    enemyNear,
    health,
    draughts: c.charges,
    night: isNight(worldClock.timeOfDayS),
    cliff,
    falling: p.mode === 'glide' || (p.mode === 'air' && p.vel.y < -11),
    freePoints: c.active ? c.skillPoints : (useProgression.getState().stats?.skillFree ?? 0),
  };
}

export function TipsHud() {
  const enabled = useTips((s) => s.enabled);
  const current = useTips((s) => s.current);
  const epoch = useTips((s) => s.epoch);
  const character = useNetStore((s) => s.ready?.character.id ?? 'offline');
  const [, force] = useState(0);

  useEffect(() => {
    useTips.setState({ character, current: null });
    if (!enabled) return;
    const kv = browserKV();
    const seen = loadSeen(kv, character);
    let startedAt = 0;
    let lastClosed = -1e9;
    let hurtUntil = 0;
    let lastHealth = 1;
    let showing = false;
    const id = setInterval(() => {
      if (worldDebug.firstPlayableMs === null) return;
      const now = performance.now();
      if (showing && !useTips.getState().current) {
        showing = false; // dismissed with x
        lastClosed = now;
      }
      if (!startedAt) startedAt = now;
      const ctx = sample(startedAt, hurtUntil);
      if (ctx.health < lastHealth - 0.001) hurtUntil = now + 5000;
      lastHealth = ctx.health;
      const cur = useTips.getState().current;
      if (cur) {
        if (ctx.busy || settled(cur.id, ctx, (now - cur.at) / 1000)) {
          // A panel that opened over a tip that had barely shown (the What's new welcome) doesn't use it up.
          if (ctx.busy && now - cur.at < 4000) {
            seen.delete(cur.id);
            saveSeen(kv, character, seen);
          }
          useTips.setState({ current: null });
          showing = false;
          lastClosed = now;
        }
        return;
      }
      const next = nextTip(ctx, seen, (now - lastClosed) / 1000);
      if (!next) return;
      seen.add(next);
      saveSeen(kv, character, seen);
      useTips.setState({ current: { id: next, at: now } });
      showing = true;
    }, 250);
    return () => {
      clearInterval(id);
      useTips.setState({ current: null });
    };
  }, [enabled, character, epoch]);

  // Re-render once a second while a tip is up (nothing per frame).
  useEffect(() => {
    if (!current) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [current]);

  if (!enabled || !current) return null;
  const tip = tipById(current.id);
  return <TipCard id={current.id} title={tip.title} keys={tip.keys} text={tip.text} />;
}

const CAP: React.CSSProperties = { display: 'inline-block', minWidth: 14, padding: '0 5px', marginRight: 4, border: '1px solid rgba(255,255,255,0.45)', borderBottomWidth: 2, borderRadius: 4, background: 'rgba(255,255,255,0.08)', font: '600 11px/17px system-ui, sans-serif', textAlign: 'center' };

function TipCard({ id, title, keys, text }: { id: TipId; title: string; keys: string[]; text: string }) {
  return (
    <div
      data-testid="tip"
      data-tip={id}
      style={{ position: 'fixed', left: '50%', bottom: `calc(${ABOVE_HOTBAR} + var(--ls-hint-h, 0px) + 10px)`, transform: 'translateX(-50%)', width: 'max-content', maxWidth: 'min(460px, calc(100vw - 32px))', boxSizing: 'border-box', padding: '7px 30px 8px 12px', borderRadius: 6, background: 'rgba(10,13,20,0.82)', border: '1px solid rgba(255,209,102,0.35)', color: '#e9ecef', font: '13px/1.4 system-ui, sans-serif', zIndex: 13, pointerEvents: 'auto', animation: 'lsTipIn 220ms ease-out' }}
    >
      <style>{'@keyframes lsTipIn { from { opacity: 0; transform: translate(-50%, 6px) } to { opacity: 1; transform: translate(-50%, 0) } }'}</style>
      <div style={{ color: '#ffd166', font: '600 11px system-ui, sans-serif', letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 2 }}>Tip · {title}</div>
      <div>
        {keys.map((k) => (
          <span key={k} style={CAP}>
            {k}
          </span>
        ))}
        {text}
      </div>
      <button
        data-testid="tip-close"
        aria-label="Dismiss tip"
        title="Dismiss (Esc menu: turn tips off)"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => useTips.setState({ current: null })}
        style={{ position: 'absolute', top: 4, right: 6, border: 'none', background: 'none', color: '#adb5bd', cursor: 'pointer', font: '15px system-ui, sans-serif', padding: '0 4px' }}
      >
        ×
      </button>
    </div>
  );
}
