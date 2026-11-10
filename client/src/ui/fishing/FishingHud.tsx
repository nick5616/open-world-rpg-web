// Playtest 2 fishing HUD: the "[E] Cast your line" prompt (with a rod in
// your pack, facing deep water, nothing else to do with E there: the town,
// cave, loot and content prompts go first), the float's state while you
// wait (a nibble is not a bite: strike only when it goes under), the reel
// fight's tension and line bars, and the catch card.
//
// Controls: E casts. Strike with E, Space or the left button when the float
// goes under. In the fight hold E / Space / the left button to reel, let go
// when the fish surges (the tension bar reddens: the line snaps if it stays
// at the top). Walking away reels in. The keys are taken in the capture
// phase (before combat sees the button) only while a line is out.

import { useEffect, useState } from 'react';
import { CONTENT } from '@lodestone/contracts';
import { isTextTarget } from '../../input/useKeyboard';
import { localPlayer } from '../../state/live';
import { useInventory } from '../inventory/store';
import { countOf } from '../inventory/items';
import { photoActive } from '../photo/store';
import { fishById, rarityColor, rarityName, ROD, weightText } from './fish';
import { devRod, ensureFishingHook } from './link';
import { DEBUG } from '../../config';
import { findFishingSpot } from './FishingLayer';
import { cast, fishLive, floatState, press, release, useFishing } from './store';

function othersBusy(): boolean {
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  const busy = ['[data-testid="town-prompt"]', '[data-testid="cave-hud"]', '[data-testid="loot-prompt"]', '[data-testid="content-prompt"]', '[data-testid="camp-prompt"]'].some((sel) => !!q(sel)?.textContent);
  const townPanel = q('[data-testid="town-panel"]');
  return busy || (!!townPanel && townPanel.style.display !== 'none') || !!document.querySelector('[data-ui-panel]:not([style*="display: none"]), [data-testid="emote-wheel"]');
}

export function hasRod(): boolean {
  return countOf(useInventory.getState().inv?.items ?? [], ROD) > 0;
}

/** Would E cast now. */
function castReady(): boolean {
  const m = localPlayer.mode;
  return useFishing.getState().phase === 'idle' && !!fishLive.target && hasRod() && (m === 'idle' || m === 'walk') && !localPlayer.mounted && !photoActive() && !othersBusy(); // CR 027: E in the saddle gets off
}

const ACTIVE = new Set(['casting', 'waiting', 'hooking', 'fight', 'landing']);

function onKey(e: KeyboardEvent): void {
  if (isTextTarget(e.target) || e.repeat || photoActive()) return;
  if (e.code !== 'KeyE' && e.code !== 'Space') return;
  const ph = useFishing.getState().phase;
  if (e.type === 'keyup') {
    release();
    return;
  }
  if (ph === 'idle') {
    if (e.code === 'KeyE' && castReady() && cast()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return;
  }
  if (ACTIVE.has(ph) && press()) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

function onMouse(e: MouseEvent): void {
  if (e.button !== 0 || photoActive()) return;
  if (e.type === 'mouseup') {
    release();
    return;
  }
  if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS' || !document.pointerLockElement) return;
  const ph = useFishing.getState().phase;
  if (ACTIVE.has(ph) && press()) e.stopImmediatePropagation(); // no sword swing while you fish
}

if (typeof window !== 'undefined') {
  const w = window as Window & { __lsFishKeys?: [(e: KeyboardEvent) => void, (e: MouseEvent) => void] };
  if (w.__lsFishKeys) {
    window.removeEventListener('keydown', w.__lsFishKeys[0], true);
    window.removeEventListener('keyup', w.__lsFishKeys[0], true);
    window.removeEventListener('mousedown', w.__lsFishKeys[1], true);
    window.removeEventListener('mouseup', w.__lsFishKeys[1], true);
  }
  w.__lsFishKeys = [onKey, onMouse];
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
  window.addEventListener('mouseup', onMouse, true);
}

const text = { font: '14px system-ui, sans-serif', color: '#f4efe2', textShadow: '0 1px 2px #000, 0 0 6px #000' } as const;

function Bar({ value, color, label, marks }: { value: number; color: string; label: string; marks?: boolean }) {
  return (
    <div style={{ margin: '6px 0' }}>
      <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 2 }}>{label}</div>
      <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'rgba(0,0,0,0.55)', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.15)' }}>
        {marks && <div style={{ position: 'absolute', left: '80%', right: 0, top: 0, bottom: 0, background: 'rgba(255,80,60,0.25)' }} />}
        <div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, height: '100%', background: color, transition: 'width 40ms linear' }} />
      </div>
    </div>
  );
}

export function FishingHud() {
  const s = useFishing();
  const [, frame] = useState(0);
  const [prompt, setPrompt] = useState(false);

  useEffect(() => {
    ensureFishingHook();
    const iv = setInterval(() => {
      ensureFishingHook();
      const p = castReady();
      fishLive.canCast = p;
      setPrompt((old) => (old === p ? old : p));
    }, 150);
    return () => clearInterval(iv);
  }, []);
  // While a line is out the bars move every frame.
  useEffect(() => {
    if (!ACTIVE.has(s.phase)) return;
    let raf = 0;
    const loop = () => {
      frame((n) => (n + 1) % 1e6);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [s.phase]);

  const t = performance.now();
  const showNotice = s.notice && t - s.noticeAt < 2600;
  let body: JSX.Element | null = null;
  if (s.phase === 'idle' && prompt) {
    body = <div data-testid="fish-prompt" style={text}>[E] Cast your line</div>;
  } else if (s.phase === 'casting') {
    body = <div style={text}>Casting…</div>;
  } else if (s.phase === 'waiting' || s.phase === 'hooking') {
    const f = s.phase === 'hooking' ? 'bite' : floatState(s, t);
    body = (
      <div data-testid="fish-waiting" data-float={f} style={{ ...text, textAlign: 'center' }}>
        {f === 'bite' ? (
          <>
            <div style={{ font: '800 44px Georgia, serif', color: '#ffd43b', lineHeight: 1 }}>!</div>
            <div style={{ fontWeight: 700 }}>Strike! (E, Space or click)</div>
          </>
        ) : (
          <>
            <div style={{ opacity: 0.9 }}>{f === 'nibble' ? 'A nibble… wait for it' : `Waiting for a bite${s.water ? ` (${s.water})` : ''}…`}</div>
            <div style={{ fontSize: 11, opacity: 0.65 }}>strike when the float goes under · walk away to reel in</div>
          </>
        )}
      </div>
    );
  } else if (s.phase === 'fight' || s.phase === 'landing') {
    const f = fishLive.fight;
    const ten = f?.tension ?? 0;
    const tcol = ten > 0.85 ? '#ff5a4a' : ten > 0.6 ? '#ffc04a' : '#69db7c';
    body = (
      <div data-testid="fish-fight" style={{ ...text, width: 280, padding: '8px 12px', borderRadius: 8, background: 'rgba(10,12,18,0.55)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
          <span style={{ color: rarityColor(s.rarity) }}>{s.rarity >= 2 ? 'Something big!' : 'Fish on!'}</span>
          <span style={{ color: f?.surging ? '#ff8f6b' : '#adb5bd', fontWeight: 600, fontSize: 12 }}>{f?.surging ? "It's pulling! ease off" : 'reel it in'}</span>
        </div>
        <Bar value={ten} color={tcol} label="Line tension" marks />
        <Bar value={f?.progress ?? 0} color="#4dabf7" label="Reeled in" />
        <div style={{ fontSize: 11, opacity: 0.7 }}>hold E / Space / click to reel · let go when it pulls</div>
      </div>
    );
  } else if (s.phase === 'result') {
    const c = s.caught;
    if (c) {
      const def = fishById(c.id);
      body = (
        <div data-testid="fish-caught" style={{ ...text, minWidth: 260, padding: '10px 14px', borderRadius: 8, background: 'rgba(10,12,18,0.7)', border: `1px solid ${rarityColor(c.rarity)}`, textAlign: 'center' }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: rarityColor(c.rarity) }}>{rarityName(c.rarity)} catch</div>
          <div style={{ font: '600 20px Georgia, serif', color: '#ffe8cc' }}>{c.name}</div>
          <div>
            {weightText(c.weightG)} · {c.water}
            {c.first ? <span style={{ color: '#ffd43b', fontWeight: 700 }}> · New to your journal!</span> : c.record ? <span style={{ color: '#ffd43b', fontWeight: 700 }}> · Your biggest yet!</span> : null}
          </div>
          {def && <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4, maxWidth: 320 }}>{def.lore}</div>}
        </div>
      );
    } else body = <div data-testid="fish-lost" style={text}>{s.lostText}</div>;
  }

  return (
    <>
      {body && (
        // The fight sits beside the crosshair (your third-person body is under it), the catch card up under the compass.
        <div style={{ position: 'fixed', pointerEvents: 'none', zIndex: 20, ...(s.phase === 'fight' || s.phase === 'landing' ? { left: 'min(calc(50% + 200px), calc(100% - 300px))', top: '42%' } : { left: '50%', top: s.phase === 'result' ? '18%' : '62%', transform: 'translateX(-50%)' }) }}>{body}</div>
      )}
      {showNotice && (
        <div data-testid="fish-notice" style={{ ...text, position: 'fixed', left: '50%', top: '57%', transform: 'translateX(-50%)', color: '#ffd8a8', pointerEvents: 'none', zIndex: 20 }}>
          {s.notice}
        </div>
      )}
    </>
  );
}

/** Journal counts (the Fish tab): species caught of all. */
export const FISH_TOTAL = CONTENT.fishing.species.length;

if (DEBUG && typeof window !== 'undefined') {
  (window as unknown as { __lodestoneFishing?: unknown }).__lodestoneFishing = {
    state: () => {
      const s = useFishing.getState();
      const f = fishLive.fight;
      return { phase: s.phase, seq: s.seq, water: s.water, bobber: s.bobber, caught: s.caught, lost: s.lostText, notice: s.notice, target: fishLive.target, canCast: fishLive.canCast, rod: hasRod(), fight: f ? { tension: f.tension, progress: f.progress, pull: f.pull, surging: f.surging, t: f.t } : null };
    },
    devRod,
    findSpot: (x: number, z: number, r?: number) => findFishingSpot(x, z, r),
  };
}
