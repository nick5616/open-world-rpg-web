// PvP and duel HUD (playtest 2, CR 019): your PvP indicator (crossed
// swords, "turning off in 7 s", the safe zone you stand in), the duel
// challenge prompt (Y accept / U decline), the 3-2-1 countdown, the "back
// into the ring" warning, the duel clock, the result banner and the kill
// feed. Mounted by the play screen; renders nothing until PvP is touched.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { COMBAT } from '@lodestone/contracts';
import { notGameKey } from '../../input/useKeyboard';
import { emitSound } from '../../audio/bridge';
import { DUEL_PHASE } from './events';
import { prunePvp, usePvp, type Banner } from './store';
import { SwordsIcon } from './icons';
import { BORDER, BORDER_GOLD, BTN_BG, TEXT, TEXT_2 } from '../spellcards/theme';

const RED = '#ff5d5d';
const GOLD = '#ffd166';
const GREEN = '#69db7c';
const PANEL: CSSProperties = { background: 'rgba(12,14,20,0.88)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, color: '#f1f3f5', boxShadow: '0 8px 24px rgba(0,0,0,0.45)', font: '13px system-ui, sans-serif' };

/** Re-render every `ms` while `on` (countdowns). */
function useTicker(on: boolean, ms = 200): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(id);
  }, [on, ms]);
  // The state can be stale on the first render after `on` flips (it was last
  // set whenever the previous countdown stopped): never count from the past.
  return on ? Math.max(now, performance.now()) : now;
}

const secs = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
const clock = (ms: number) => {
  const s = secs(ms);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Top-left: you are flagged / turning off / in a safe zone / dueling. */
function Indicator() {
  const flagged = usePvp((s) => s.flagged);
  const turningOff = usePvp((s) => s.turningOff);
  const offAt = usePvp((s) => s.offAt);
  const safe = usePvp((s) => s.safe);
  const safeName = usePvp((s) => s.safeName);
  const duel = usePvp((s) => s.duel);
  const now = useTicker(turningOff || !!duel, 250);
  if (!flagged && !duel) return null;
  return (
    <div data-testid="pvp-indicator" style={{ position: 'fixed', left: 12, top: 12, zIndex: 22, display: 'flex', flexDirection: 'column', gap: 4, pointerEvents: 'none' }}>
      {flagged && (
        <div style={{ ...PANEL, display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderColor: safe ? 'rgba(105,219,124,0.6)' : 'rgba(255,93,93,0.7)' }}>
          <SwordsIcon size={18} color={safe ? GREEN : RED} />
          <span style={{ fontWeight: 700, color: safe ? GREEN : RED, letterSpacing: 0.5 }}>PvP</span>
          {turningOff && <span data-testid="pvp-turning-off" style={{ opacity: 0.8 }}>off in {secs(offAt - now)} s</span>}
          {safe && <span data-testid="pvp-safe" style={{ color: GREEN, opacity: 0.9 }}>safe zone · {safeName}</span>}
        </div>
      )}
      {duel && duel.phase >= DUEL_PHASE.countdown && (
        <div data-testid="duel-indicator" style={{ ...PANEL, display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderColor: 'rgba(255,209,102,0.6)' }}>
          <SwordsIcon size={18} color={GOLD} />
          <span style={{ fontWeight: 700, color: GOLD }}>Duel</span>
          <span>vs {duel.opponentName}</span>
          {duel.phase === DUEL_PHASE.fighting && <span style={{ opacity: 0.75 }}>{clock(duel.phaseEnd - now)}</span>}
        </div>
      )}
      {duel && duel.phase === DUEL_PHASE.waiting && (
        <div data-testid="duel-waiting" style={{ ...PANEL, padding: '5px 10px', opacity: 0.9 }}>
          Duel challenge sent to {duel.opponentName} · {secs(duel.phaseEnd - now)} s
        </div>
      )}
    </div>
  );
}

/** "Ash challenges you to a duel": Y accept, U decline. */
function ChallengePrompt() {
  const ch = usePvp((s) => s.challenge);
  const actions = usePvp((s) => s.actions);
  const now = useTicker(!!ch, 200);
  useEffect(() => {
    if (!ch) return; // the challenge's sound is the zone event's (audio/triggers.ts 994)
    const onKey = (e: KeyboardEvent) => {
      if (notGameKey(e) || e.repeat) return;
      if (e.code === 'KeyY') actions?.answer(true, ch.fromId);
      else if (e.code === 'KeyU') actions?.answer(false, ch.fromId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ch, actions]);
  if (!ch) return null;
  const total = COMBAT.pvp.duel.answerS * 1000;
  const left = Math.max(0, ch.until - now);
  return (
    <div data-testid="duel-challenge" style={{ ...PANEL, position: 'fixed', left: '50%', top: '24%', transform: 'translateX(-50%)', zIndex: 41, padding: '12px 16px', minWidth: 300, textAlign: 'center', borderColor: 'rgba(255,209,102,0.6)', pointerEvents: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, font: '600 16px Georgia, serif' }}>
        <SwordsIcon size={20} color={GOLD} />
        <span>
          <b style={{ color: GOLD }}>{ch.fromName}</b> challenges you to a duel
        </span>
      </div>
      <div style={{ fontSize: 12, opacity: 0.7, margin: '4px 0 8px' }}>To 1 health, inside a {COMBAT.pvp.duel.ringRadiusM} m ring. Health and mana come back after.</div>
      <div style={{ height: 3, background: 'rgba(255,255,255,0.12)', borderRadius: 2, overflow: 'hidden', marginBottom: 10 }}>
        <div style={{ width: `${(100 * left) / total}%`, height: '100%', background: GOLD }} />
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button data-testid="duel-accept" onClick={() => actions?.answer(true, ch.fromId)} style={{ font: '600 13px system-ui, sans-serif', padding: '5px 14px', cursor: 'pointer' }}>
          Accept <span style={{ opacity: 0.6 }}>Y</span>
        </button>
        <button data-testid="duel-decline" onClick={() => actions?.answer(false, ch.fromId)} style={{ font: '13px system-ui, sans-serif', padding: '5px 14px', cursor: 'pointer' }}>
          Decline <span style={{ opacity: 0.6 }}>U</span>
        </button>
      </div>
    </div>
  );
}

/** 3-2-1, Fight!, and the "back into the ring" warning. */
function Countdown() {
  const duel = usePvp((s) => s.duel);
  const counting = !!duel && duel.phase === DUEL_PHASE.countdown;
  const now = useTicker(!!duel && (counting || duel.forfeitAt > 0 || duel.phase === DUEL_PHASE.fighting), 100);
  const [fightAt, setFightAt] = useState(0);
  const lastCount = useRef(0);
  const n = counting ? secs(duel.phaseEnd - now) : 0;
  useEffect(() => {
    if (counting && n > 0 && n !== lastCount.current) {
      lastCount.current = n;
      emitSound('duel_count');
    }
  }, [counting, n]);
  const phase = duel?.phase ?? 0;
  useEffect(() => {
    if (phase === DUEL_PHASE.fighting) {
      setFightAt(performance.now());
      lastCount.current = 0;
    }
  }, [phase]);
  if (!duel) return null;
  const big: CSSProperties = { position: 'fixed', left: '50%', top: '30%', transform: 'translate(-50%, -50%)', zIndex: 40, pointerEvents: 'none', font: '800 96px Georgia, serif', color: GOLD, textShadow: '0 4px 18px rgba(0,0,0,0.7)' };
  return (
    <>
      {counting && n > 0 && (
        <div data-testid="duel-countdown" key={n} className="pvp-pop" style={big}>
          {n}
        </div>
      )}
      {duel.phase === DUEL_PHASE.fighting && now - fightAt < 900 && (
        <div data-testid="duel-fight" className="pvp-pop" style={{ ...big, fontSize: 72 }}>
          Fight!
        </div>
      )}
      {duel.forfeitAt > 0 && (
        <div data-testid="duel-outside" style={{ ...PANEL, position: 'fixed', left: '50%', top: '38%', transform: 'translateX(-50%)', zIndex: 40, padding: '8px 14px', borderColor: RED, color: RED, fontWeight: 700, pointerEvents: 'none' }}>
          Back into the ring! You forfeit in {secs(duel.forfeitAt - now)} s
        </div>
      )}
    </>
  );
}

function ResultBanner({ b }: { b: Banner }) {
  const [head, line] = b.text.includes('|') ? b.text.split('|') : ['', b.text];
  const color = b.kind === 'won' ? GOLD : b.kind === 'lost' ? RED : '#dee2e6';
  return (
    <div data-testid="duel-result" data-kind={b.kind} className="pvp-pop" style={{ position: 'fixed', left: '50%', top: '22%', transform: 'translateX(-50%)', zIndex: 40, pointerEvents: 'none', textAlign: 'center' }}>
      {head && <div style={{ font: '800 54px Georgia, serif', color, textShadow: '0 4px 18px rgba(0,0,0,0.7)' }}>{head}</div>}
      <div style={{ ...PANEL, display: 'inline-block', padding: '6px 14px', marginTop: 4, fontSize: 15 }}>{line}</div>
    </div>
  );
}

/** Kill feed under the indicator. */
function KillFeed() {
  const feed = usePvp((s) => s.feed);
  if (!feed.length) return null;
  return (
    <div data-testid="pvp-killfeed" style={{ position: 'fixed', left: 12, top: 84, zIndex: 22, display: 'flex', flexDirection: 'column', gap: 3, pointerEvents: 'none' }}>
      {feed.map((f) => (
        <div key={f.id} className="pvp-feed" style={{ ...PANEL, padding: '3px 9px', display: 'flex', alignItems: 'center', gap: 6, borderColor: f.mine ? 'rgba(255,93,93,0.6)' : undefined }}>
          <SwordsIcon size={13} color={RED} />
          <span>{f.text}</span>
        </div>
      ))}
    </div>
  );
}

const CSS = `
@keyframes pvpPop { 0% { opacity: 0; transform: translate(-50%, -50%) scale(1.35) } 18% { opacity: 1; transform: translate(-50%, -50%) scale(1) } 100% { opacity: 1 } }
[data-testid="duel-countdown"].pvp-pop, [data-testid="duel-fight"].pvp-pop { animation: pvpPop 0.45s ease-out }
@keyframes pvpIn { from { opacity: 0; transform: translate(-50%, -8px) } to { opacity: 1; transform: translate(-50%, 0) } }
[data-testid="duel-result"].pvp-pop { animation: pvpIn 0.35s ease-out }
`;

export function PvpHud() {
  const banner = usePvp((s) => s.banner);
  useEffect(() => {
    const id = setInterval(() => prunePvp(), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <style>{CSS}</style>
      <Indicator />
      <KillFeed />
      <ChallengePrompt />
      <Countdown />
      {banner && <ResultBanner b={banner} />}
    </>
  );
}

/** Character panel (C) section: the PvP toggle and how duels work. */
export function PvpPanelSection() {
  const flagged = usePvp((s) => s.flagged);
  const turningOff = usePvp((s) => s.turningOff);
  const safe = usePvp((s) => s.safe);
  const safeName = usePvp((s) => s.safeName);
  const actions = usePvp((s) => s.actions);
  const p = COMBAT.pvp;
  const on = flagged && !turningOff;
  return (
    <div data-testid="pvp-panel" style={{ marginTop: 12 }}>
      <div style={{ font: '600 12px system-ui, sans-serif', letterSpacing: 1, textTransform: 'uppercase', color: GOLD, marginBottom: 4 }}>PvP</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SwordsIcon size={20} color={on ? RED : TEXT_2} />
        <span style={{ flex: 1 }}>
          {on ? <b style={{ color: RED }}>Flagged for PvP</b> : turningOff ? <span>Turning off…</span> : <span style={{ color: TEXT_2 }}>Not flagged</span>}
          {flagged && safe && <span style={{ color: GREEN, fontSize: 11, marginLeft: 6 }}>safe zone · {safeName}</span>}
        </span>
        <button data-testid="pvp-toggle" disabled={!actions} onClick={() => actions?.setFlag(!on)} style={{ font: '12px system-ui, sans-serif', padding: '3px 12px', cursor: actions ? 'pointer' : 'default', borderRadius: 4, background: BTN_BG, color: actions ? TEXT : TEXT_2, border: `1px solid ${actions ? BORDER_GOLD : BORDER}` }}>
          {on ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: TEXT_2, marginTop: 4, lineHeight: 1.45 }}>
        Flagged players outside your party can fight each other anywhere but towns and the Haven, at {Math.round(p.damageMult * 100)}% damage; nothing is lost on death. Turning off takes {p.flagOffDelayS} s (longer if you keep fighting); not within {p.combatLockS} s of a fight. Party members duel instead: the Duel button in the party frame, or /duel Name.
      </div>
    </div>
  );
}
