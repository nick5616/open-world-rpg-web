// The main story on screen (playtest 2, CR 035): what the story's speakers
// say (subtitles over the hotbar), your party's progress (a line in the
// quest tracker and a bar in the journal, with "Catch up" when you are
// behind), the finale's mechanics (the shroud, the bells, the endless
// night's countdown and the wells), the Hush's entrance (letterbox and a
// title card in the discovery intro style), revives (hold E over a fallen
// friend; while down, Space respawns at once) and the ending (lines over a
// sunrise, then the credits). README.md in this folder.

import { useEffect, useRef, useState } from 'react';
import { DEBUG } from '../../config';
import { localPlayer } from '../../state/live';
import { ABOVE_HOTBAR, BELOW_CLOCK } from '../../hud/layout';
import { eFree } from '../../input/interact';
import { useCombatHud } from '../../combat/store';
import { FINALE, memberLine, roman, secsLeft } from './events';
import { closeEnding, endCinematic, pruneStory, reviveTarget, useStory } from './store';
import { ensureStoryHook } from './link';
import { creditRoll } from './credits';

const GOLD = '#ffd166';
const SERIF = '"Fraunces", Georgia, serif';
const CREAM = '#f3ead2';

function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function useNow(ms: number, on = true): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(id);
  }, [ms, on]);
  return now;
}

/** The party's progress, inside the quest tracker. */
export function StoryPartyLine() {
  const party = useStory((s) => s.party);
  if (!party) return null;
  return (
    <div data-testid="story-party" style={{ marginTop: 4, fontSize: 12, color: '#cfe6ff' }}>
      {party.members.map((m) => (
        <div key={m.id}>
          ◇ {memberLine(m)}
          {m.dist > 0 ? ` · ${m.dist} m` : ''}
        </div>
      ))}
      {party.behind && <div style={{ color: GOLD }}>You are behind your party: J journal to catch up</div>}
    </div>
  );
}

/** The journal's story bar: the acts, catching up, the vow. */
export function StoryJournalBar() {
  const sync = useStory((s) => s.sync);
  const party = useStory((s) => s.party);
  const actions = useStory((s) => s.actions);
  if (!sync) return null;
  const beaten = sync.beaten > 0;
  return (
    <div data-testid="story-journal" style={{ border: '1px solid rgba(255,209,102,0.35)', borderRadius: 6, padding: '6px 8px', margin: '6px 0 8px', fontSize: 12 }}>
      <div style={{ font: `600 14px ${SERIF}`, color: GOLD }}>{sync.title}</div>
      <div style={{ display: 'flex', gap: 3, margin: '4px 0' }}>
        {sync.acts.map((a) => (
          <div key={a.n} title={`Act ${roman(a.n)}: ${a.title}${a.level ? ` (level ${a.level})` : ''}`} style={{ flex: 1, height: 6, borderRadius: 2, background: a.done ? GOLD : a.n === sync.act ? 'rgba(255,209,102,0.45)' : 'rgba(255,255,255,0.15)' }} />
        ))}
      </div>
      <div style={{ opacity: 0.8 }}>{beaten ? `The dawn came${sync.together ? ', together' : ''}. The world carries on.` : sync.act > 0 ? `Act ${roman(sync.act)}: ${sync.acts[sync.act - 1]?.title ?? ''}` : 'It begins after "Ward against the night".'}</div>
      {party?.behind && (
        <button data-testid="story-catch-up" disabled={!actions} onClick={() => actions?.catchUp()} style={btn(true)}>
          Catch up with your party
        </button>
      )}
      {beaten && (
        <button data-testid="story-vow" disabled={!actions} onClick={() => actions?.vow(!sync.vow)} style={btn(sync.vow)} title="Harder nights, a harder Hush (the hard-mode achievements)">
          {sync.vow ? 'Renounce the Starless Vow' : 'Take the Starless Vow (hard mode)'}
        </button>
      )}
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return { font: '600 12px system-ui, sans-serif', padding: '4px 10px', marginTop: 6, marginRight: 6, borderRadius: 5, border: `1px solid ${primary ? '#e0b44c' : '#8a7550'}`, background: primary ? '#7a5a1c' : '#3a3226', color: '#f6e7c0', cursor: 'pointer' };
}

function Lines() {
  const lines = useStory((s) => s.lines);
  if (!lines.length) return null;
  return (
    <div data-testid="story-lines" style={{ position: 'fixed', left: '50%', bottom: `calc(${ABOVE_HOTBAR} + 64px)`, transform: 'translateX(-50%)', width: 'min(760px, 92vw)', textAlign: 'center', pointerEvents: 'none', zIndex: 16 }}>
      {lines.map((l) => (
        <div key={l.id} style={{ font: `${l.speaker ? 'italic 18px' : '15px'}/1.4 ${SERIF}`, color: l.speaker ? CREAM : '#e8d6a8', textShadow: '0 1px 3px #000, 0 0 10px rgba(0,0,0,0.8)', marginTop: 4, animation: 'lsStoryLine 0.4s ease-out' }}>
          {l.speaker ? <span style={{ color: l.speaker === 'The Hush' ? '#c9a6ff' : GOLD, fontStyle: 'normal', fontWeight: 600 }}>{l.speaker}: </span> : null}
          {l.speaker ? `“${l.text}”` : l.text}
        </div>
      ))}
      <style>{'@keyframes lsStoryLine { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }'}</style>
    </div>
  );
}

/** The finale's mechanics under the boss bar. */
function FinalePanel() {
  const f = useStory((s) => s.finale);
  const now = useNow(200, !!f && f.phase !== FINALE.idle);
  if (!f || f.phase === FINALE.idle || f.phase === FINALE.intro || f.phase === FINALE.won) return null;
  const left = (ms: number) => ms - (now - f.at);
  const rows: { key: string; text: string; color: string; bar?: number }[] = [];
  if (f.shroud > 0 && left(f.shroudMs) > 0) rows.push({ key: 'shroud', text: `The shroud: break it with sunsteel or Light · ${secsLeft(left(f.shroudMs))}`, color: '#c9a6ff', bar: f.shroud });
  if (f.phase === FINALE.choir) rows.push({ key: 'bells', text: `The choir: ${f.bells} Hollow Bell${f.bells === 1 ? '' : 's'} tolling. Shatter them (sunsteel or Light)`, color: '#d0b8ff' });
  if (f.stagger) rows.push({ key: 'stagger', text: 'The Hush reels: strike now!', color: GOLD });
  if (f.phase === FINALE.night && f.nightMs > 0 && left(f.nightMs) > 0)
    rows.push({ key: 'night', text: `The endless night falls in ${secsLeft(left(f.nightMs))}: stand in a well of dawn, one each`, color: '#ff8a6a' });
  if (f.hard) rows.push({ key: 'hard', text: 'Starless Vow', color: '#9fb8ff' });
  if (!rows.length) return null;
  return (
    <div data-testid="finale-panel" style={{ position: 'fixed', top: `calc(${BELOW_CLOCK} + 44px)`, left: '50%', transform: 'translateX(-50%)', width: 520, textAlign: 'center', pointerEvents: 'none', zIndex: 13, font: '600 13px system-ui, sans-serif', textShadow: '0 1px 3px #000' }}>
      {rows.map((r) => (
        <div key={r.key} style={{ color: r.color, marginTop: 3 }}>
          {r.text}
          {r.bar !== undefined && (
            <div style={{ height: 5, background: 'rgba(0,0,0,0.6)', borderRadius: 3, marginTop: 2, overflow: 'hidden' }}>
              <div style={{ width: `${r.bar}%`, height: '100%', background: '#8f5bff' }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** The Hush's entrance: letterbox bars, the title card, its lines. */
function Cinematic() {
  const c = useStory((s) => s.cinematic);
  const now = useNow(100, !!c);
  useEffect(() => {
    if (!c) return;
    const id = setTimeout(() => endCinematic(), c.ms + 600);
    return () => clearTimeout(id);
  }, [c]);
  if (!c) return null;
  const t = now - c.at;
  const inK = Math.min(1, t / 700);
  const outK = Math.min(1, Math.max(0, (c.ms - t) / 600));
  const k = Math.min(inK, outK);
  const per = c.ms / Math.max(1, c.lines.length + 1);
  const shown = c.lines.filter((_, i) => t > per * (i + 0.8));
  return (
    <div data-testid="finale-cinematic" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 40 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${11 * k}vh`, background: '#000' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${11 * k}vh`, background: '#000' }} />
      <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(ellipse at 50% 40%, rgba(40,10,60,${0.15 * k}) 0%, rgba(0,0,0,${0.45 * k}) 100%)` }} />
      <div style={{ position: 'absolute', top: '20vh', left: 0, right: 0, textAlign: 'center', opacity: k, color: CREAM, textShadow: '0 2px 12px rgba(0,0,0,0.9), 0 0 30px rgba(120,60,200,0.5)' }}>
        <div style={{ font: `600 15px ${SERIF}`, letterSpacing: '0.24em', textTransform: 'lowercase', fontVariant: 'small-caps', opacity: 0.85 }}>{c.eyebrow}</div>
        <div style={{ font: `600 clamp(44px, 7vw, 82px)/1.05 ${SERIF}`, fontVariant: 'small-caps', letterSpacing: `${0.03 + 0.2 * (1 - inK)}em`, margin: '6px 0' }}>{c.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, margin: '6px auto', width: 'min(520px, 70vw)' }}>
          <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, #f3ead2)' }} />
          <div style={{ width: 8, height: 8, transform: 'rotate(45deg)', border: '1px solid #f3ead2', background: c.hard ? '#9fb8ff' : '#8f5bff', boxShadow: '0 0 10px #8f5bff' }} />
          <div style={{ flex: 1, height: 1, background: 'linear-gradient(270deg, transparent, #f3ead2)' }} />
        </div>
        <div style={{ font: `600 17px ${SERIF}`, letterSpacing: '0.18em', fontVariant: 'small-caps', opacity: 0.85 }}>{c.subtitle}</div>
      </div>
      <div style={{ position: 'absolute', bottom: '15vh', left: 0, right: 0, textAlign: 'center', opacity: k }}>
        {shown.map((l, i) => (
          <div key={i} style={{ font: `italic 19px/1.5 ${SERIF}`, color: '#d9c6ff', textShadow: '0 1px 4px #000' }}>
            “{l}”
          </div>
        ))}
      </div>
    </div>
  );
}

/** The ending: lines over a sunrise, then the credits roll. */
function Ending() {
  const e = useStory((s) => s.ending);
  const now = useNow(80, !!e);
  const roll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!e) return;
    if (document.pointerLockElement) document.exitPointerLock();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code === 'Escape' || ev.code === 'Enter') {
        ev.stopPropagation();
        closeEnding();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [e]);
  if (!e) return null;
  const t = now - e.at;
  const LINE_MS = 3600;
  const linesEnd = 2500 + e.lines.length * LINE_MS;
  const sun = Math.min(1, t / (linesEnd + 2000));
  const credits = creditRoll(e.names);
  const rollT = Math.max(0, t - linesEnd - 1500);
  const sky = `linear-gradient(180deg, ${mix('#070914', '#3d6fb0', sun)} 0%, ${mix('#120a1e', '#f39a4f', sun)} 62%, ${mix('#1b0e14', '#ffd27a', sun)} 100%)`;
  return (
    <div data-testid="story-ending" data-ui-panel style={{ position: 'fixed', inset: 0, zIndex: 60, background: sky, overflow: 'hidden', color: CREAM, textAlign: 'center', cursor: 'default' }}>
      <div style={{ position: 'absolute', left: '50%', bottom: `${-30 + 42 * sun}vh`, width: '46vh', height: '46vh', marginLeft: '-23vh', borderRadius: '50%', background: 'radial-gradient(circle, #fff6d8 0%, #ffd27a 45%, rgba(255,160,80,0) 70%)', opacity: 0.25 + 0.75 * sun }} />
      {t < linesEnd + 1200 && (
        <div style={{ position: 'absolute', top: '16vh', left: '50%', transform: 'translateX(-50%)', width: 'min(760px, 88vw)' }}>
          <div style={{ font: `600 15px ${SERIF}`, letterSpacing: '0.24em', fontVariant: 'small-caps', opacity: Math.min(1, t / 1200) * 0.85 }}>{e.hard ? 'The Last Song · Starless' : 'The Last Song'}</div>
          {e.lines.map((l, i) => {
            const at = 2500 + i * LINE_MS;
            const k = Math.max(0, Math.min(1, (t - at) / 900));
            return (
              <div key={i} style={{ font: `italic clamp(18px, 2.2vw, 26px)/1.5 ${SERIF}`, marginTop: 14, opacity: k, transform: `translateY(${(1 - k) * 8}px)`, textShadow: '0 1px 8px rgba(0,0,0,0.6)' }}>
                {l}
              </div>
            );
          })}
        </div>
      )}
      {rollT > 0 && (
        <div ref={roll} data-testid="story-credits" style={{ position: 'absolute', left: '50%', top: `${100 - rollT / 90}vh`, transform: 'translateX(-50%)', width: 'min(640px, 86vw)', textShadow: '0 1px 6px rgba(0,0,0,0.55)' }}>
          {credits.map((b, i) => (
            <div key={i} style={{ marginBottom: 34 }}>
              <div style={{ font: `600 14px ${SERIF}`, letterSpacing: '0.2em', fontVariant: 'small-caps', opacity: 0.8 }}>{b.heading}</div>
              {b.lines.map((l, j) => (
                <div key={j} style={{ font: `${i < 5 ? '600 22px' : '15px'}/1.45 ${SERIF}`, marginTop: 4 }}>
                  {l}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {e.first && t > 4000 && (
        <div style={{ position: 'absolute', top: 18, left: 0, right: 0, font: `600 13px ${SERIF}`, letterSpacing: '0.16em', opacity: 0.75 }}>
          You have beaten Lodestone{e.together ? ', together' : ''}. Title earned: {e.earned}.
        </div>
      )}
      <button data-testid="story-ending-close" onClick={() => closeEnding()} style={{ position: 'absolute', right: 18, bottom: 18, font: '600 13px system-ui, sans-serif', padding: '7px 14px', borderRadius: 6, border: '1px solid rgba(255,240,200,0.6)', background: 'rgba(30,20,10,0.35)', color: CREAM, cursor: 'pointer' }}>
        {rollT > 0 ? 'Back to the world (Esc)' : 'Skip (Esc)'}
      </button>
    </div>
  );
}

function mix(a: string, b: string, k: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * k)).join(',')})`;
}

/** "[E] Raise Friend (hold)" over a fallen friend, and the hold's progress. */
function Revive() {
  const downed = useStory((s) => s.downed);
  const reviving = useStory((s) => s.reviving);
  const self = useStory((s) => s.self);
  const now = useNow(100, Object.keys(downed).length > 0 || !!reviving);
  const held = useRef(0);
  useEffect(() => {
    const down = (ev: KeyboardEvent) => {
      if (ev.code !== 'KeyE' || ev.repeat || isTextTarget(ev.target)) return;
      const st = useStory.getState();
      const t = reviveTarget(st, localPlayer.pos.x, localPlayer.pos.z);
      if (!t || !st.actions || !eFree('revive')) return;
      held.current = t.id;
      st.actions.revive(t.id, true);
      ev.stopPropagation();
    };
    const up = (ev: KeyboardEvent) => {
      if (ev.code !== 'KeyE' || !held.current) return;
      useStory.getState().actions?.revive(held.current, false);
      held.current = 0;
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, []);
  void now;
  const t = reviveTarget({ downed }, localPlayer.pos.x, localPlayer.pos.z);
  const mine = reviving && reviving.by === self ? reviving : null;
  if (!t && !mine) return null;
  const pct = mine ? Math.min(100, ((performance.now() - mine.at) / mine.ms) * 100) : 0;
  return (
    <div data-testid="revive-prompt" style={{ position: 'fixed', left: '50%', top: '58%', transform: 'translateX(-50%)', color: '#f4efe2', font: '14px system-ui, sans-serif', textShadow: '0 1px 2px #000, 0 0 6px #000', pointerEvents: 'none', zIndex: 21, textAlign: 'center' }}>
      {mine ? `Raising ${t?.name ?? 'your friend'}…` : `[E] Raise ${t?.name ?? 'your friend'} (hold)`}
      {mine && (
        <div style={{ width: 160, height: 6, margin: '4px auto 0', background: 'rgba(0,0,0,0.6)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: GOLD }} />
        </div>
      )}
    </div>
  );
}

/** While you are down and a friend may raise you. */
function ReviveSelf() {
  const until = useStory((s) => s.reviveUntil);
  const reviving = useStory((s) => s.reviving);
  const self = useStory((s) => s.self);
  const downed = useCombatHud((s) => s.downedUntil) > 0;
  useNow(250, until > 0);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code !== 'Space' || ev.repeat || isTextTarget(ev.target)) return;
      const st = useStory.getState();
      if (st.reviveUntil > performance.now() && useCombatHud.getState().downedUntil > 0) st.actions?.respawn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!until || !downed) return null;
  const being = reviving && reviving.target === self;
  return (
    <div data-testid="revive-self" style={{ position: 'fixed', left: '50%', top: '64%', transform: 'translateX(-50%)', zIndex: 31, color: '#ffe9b0', font: '600 15px system-ui, sans-serif', textShadow: '0 1px 3px #000', textAlign: 'center', pointerEvents: 'none' }}>
      {being ? 'A friend is raising you…' : `A friend can raise you: they hold E beside you (${secsLeft(until - performance.now())})`}
      <div style={{ fontWeight: 400, fontSize: 13, opacity: 0.8 }}>Space: respawn now</div>
    </div>
  );
}

function installStoryHandle() {
  const handle = {
    state: () => ({ ...useStory.getState(), actions: !!useStory.getState().actions }),
    catchUp: () => useStory.getState().actions?.catchUp(),
    vow: (on = true) => useStory.getState().actions?.vow(on),
    respawn: () => useStory.getState().actions?.respawn(),
    revive: (id: number, on = true) => useStory.getState().actions?.revive(id, on),
    sync: () => useStory.getState().actions?.sync(),
    closeEnding: () => closeEnding(),
  };
  (window as unknown as { __lodestoneStory: typeof handle }).__lodestoneStory = handle;
}

export function StoryHud() {
  useEffect(() => {
    ensureStoryHook();
    const id = setInterval(() => {
      ensureStoryHook();
      const { actions, ...rest } = useStory.getState();
      const next = pruneStory(rest, performance.now());
      if (next) useStory.setState({ ...next, actions });
    }, 500);
    if (DEBUG) installStoryHandle();
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <Lines />
      <FinalePanel />
      <Revive />
      <ReviveSelf />
      <Cinematic />
      <Ending />
    </>
  );
}
