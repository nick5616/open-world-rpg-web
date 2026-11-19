// Content HUD (playtest 2, CR 023): the world event tracker (nearest event
// in range: name, what to do, its clock, distance and direction), short
// notes (feats, renown, codex entries, vault lines, event results), the
// lore tablet reader, the sealed vault panel (its seal, the inscription,
// the keeper), and the "[E]" prompt for lore tablets, herb patches and
// vault levers / doors / chests right next to you.
//
// E arbitration (input/interact.ts E_ORDER): this HUD only claims E for a
// target within CLAIM_M when no town, cave, tower or loot prompt is showing,
// no panel is open and you are not riding; its own prompt carries
// data-testid="content-prompt" so the ones below it yield.

import { useEffect, useRef, useState } from 'react';
import { BELOW_CLOCK, EVENT_CHIP_TOP, useHudHeight } from '../../hud/layout';
import { CONTENT } from '@lodestone/contracts';
import { DEBUG } from '../../config';
import { notGameKey } from '../../input/useKeyboard';
import { eFree } from '../../input/interact';
import { localPlayer } from '../../state/live';
import { distanceText, compassWord } from '../quests/events';
import { ensureContentHook } from './link';
import { EVENT_PHASE, GLYPHS, eventStatus, type VaultPart, type VaultView } from './events';
import { closeTablet, eventCardMode, nearestEvent, pruneContentNotes, useContent, type EventCardMemo } from './store';
import { trackPanel } from '../../input/panelStack';

// Esc closes the tablet when it is the top panel (input/panelStack.ts).
trackPanel(useContent, (s) => !!s.reading, 'tablet', () => closeTablet());

const GOLD = '#ffd166';
const PANEL: React.CSSProperties = { background: 'rgba(14,12,10,0.88)', border: '1px solid rgba(255,209,102,0.45)', borderRadius: 8, color: '#f1ead8', boxShadow: '0 8px 28px rgba(0,0,0,0.5)', font: '14px/1.4 system-ui, sans-serif' };
const CLAIM_M = 2.8;
const EYE = 1.6;

type Target =
  | { kind: 'tablet'; id: number; label: string }
  | { kind: 'herb'; id: number; label: string }
  | { kind: 'vault'; site: number; part: number; label: string }
  | { kind: 'hint'; label: string };

function partVerb(v: VaultView, p: VaultPart): Target {
  switch (p.kind) {
    case 'lever':
      return { kind: 'vault', site: v.site, part: p.id, label: p.on ? `The lever of the ${GLYPHS[p.glyph]} is down` : `[E] Pull the lever of the ${GLYPHS[p.glyph]}` };
    case 'door':
      return v.phase === 0 ? { kind: 'vault', site: v.site, part: p.id, label: '[E] Examine the vault door' } : { kind: 'hint', label: 'The vault door stands open' };
    case 'chest':
      return v.phase === 2 && !v.opened ? { kind: 'vault', site: v.site, part: p.id, label: '[E] Open the vault chest' } : { kind: 'hint', label: v.opened ? 'The chest is empty (for you, today)' : 'The vault chest is sealed' };
    case 'plate':
      return { kind: 'hint', label: p.on ? 'The stone is pressed down' : 'A pressure stone: stand on it' };
    case 'brazier':
      return { kind: 'hint', label: p.on ? 'The brazier burns' : 'A cold brazier: give it fire magic' };
    case 'font':
      return { kind: 'hint', label: p.on ? 'The font is still and frozen' : 'A weeping font: still it with ice magic' };
  }
}

/** The nearest content thing you can use (pure over the store, for tests). */
export function findContentTarget(s = useContent.getState(), px = localPlayer.pos.x, py = localPlayer.pos.y, pz = localPlayer.pos.z, now = performance.now()): Target | null {
  let best: Target | null = null;
  let bd = CLAIM_M;
  const consider = (x: number, y: number, z: number, t: () => Target, reach = CLAIM_M) => {
    const d = Math.hypot(x - px, y + 0.8 - (py + EYE * 0.6), z - pz);
    if (d < bd && d <= reach) {
      bd = d;
      best = t();
    }
  };
  for (const t of Object.values(s.tablets)) {
    const def = CONTENT.tablets[t.id - 1];
    consider(t.x, t.y, t.z, () => ({ kind: 'tablet', id: t.site, label: `[E] Read the tablet${def && s.sync.tablets.includes(t.id) ? `: ${def.title}` : ''}` }), 3.2);
  }
  for (const h of Object.values(s.patches)) {
    if (h.readyAt > now) continue;
    const herb = CONTENT.forage.herbs[h.herb - 1];
    consider(h.x, h.y - 0.6, h.z, () => ({ kind: 'herb', id: h.id, label: `[E] Gather ${herb?.name ?? 'herbs'}` }), CONTENT.forage.reachM);
  }
  for (const v of Object.values(s.vaults)) {
    if (Math.hypot(v.x - px, v.z - pz) > v.r + 60) continue;
    for (const p of v.parts) consider(p.x, p.y, p.z, () => partVerb(v, p), p.kind === 'plate' ? 1.8 : 3.4);
  }
  return best;
}

// Playtest 2 integration QA: town, cave, tower and loot prompts, an open
// panel and the saddle take E first (input/interact.ts E_ORDER). The open
// tablet reader is handled before this is asked.
function othersBusy(): boolean {
  return !eFree('content');
}

function useTicker(ms: number) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

function EventTracker() {
  useTicker(500);
  const events = useContent((s) => s.events);
  const memo = useRef<EventCardMemo | null>(null);
  const now = performance.now();
  const e = nearestEvent({ events }, localPlayer.pos.x, localPlayer.pos.z);
  if (!e) return null;
  const d = Math.hypot(e.x - localPlayer.pos.x, e.z - localPlayer.pos.z);
  // Playtest 2 (co-op): the full card only for a few seconds (it appears, is won or over, you walk in); else a chip in the left column.
  const card = eventCardMode(e, d, now, memo.current);
  memo.current = card.memo;
  if (card.mode === 'hidden') return null;
  const done = e.phase !== EVENT_PHASE.active;
  const color = done ? (e.phase === EVENT_PHASE.won ? '#9fe08a' : '#ff9a7a') : '#ff8f6b';
  if (card.mode === 'chip') {
    const where = d > e.r ? `${distanceText(d)} ${compassWord(localPlayer.pos.x, localPlayer.pos.z, e.x, e.z)}` : eventStatus(e, now);
    return (
      <div data-testid="world-event-chip" style={{ ...PANEL, position: 'fixed', top: EVENT_CHIP_TOP, left: 14, maxWidth: 'min(300px, 34vw)', padding: '3px 10px', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none', zIndex: 13, borderColor: color }}>
        <span style={{ color }}>✦</span> {e.name}
        {done ? ` · ${e.phase === EVENT_PHASE.won ? 'won' : 'over'}` : ` · ${where}`}
      </div>
    );
  }
  return (
    <div data-testid="world-event" style={{ position: 'fixed', top: BELOW_CLOCK, left: '50%', transform: 'translateX(-50%)', width: 'min(440px, 70vw)', textAlign: 'center', pointerEvents: 'none', zIndex: 14, color: '#f8efe0', textShadow: '0 1px 3px #000, 0 0 8px rgba(0,0,0,0.8)' }}>
      <div style={{ font: '700 12px system-ui', letterSpacing: 3, textTransform: 'uppercase', color }}>{done ? (e.phase === EVENT_PHASE.won ? 'World event won' : 'World event over') : 'World event'}</div>
      <div style={{ font: '600 20px Georgia, serif', color: '#ffe2c4' }}>✦ {e.name}</div>
      <div style={{ fontSize: 13, opacity: 0.92 }}>{e.text}</div>
      <div style={{ fontSize: 12, color: GOLD, marginTop: 2 }}>
        {eventStatus(e, now)}
        {!done && d > e.r ? ` · ${distanceText(d)} ${compassWord(localPlayer.pos.x, localPlayer.pos.z, e.x, e.z)}` : ''}
      </div>
      {!done && e.progress >= 0 && (
        <div style={{ margin: '4px auto 0', width: 220, height: 6, background: 'rgba(0,0,0,0.55)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.max(0, Math.min(100, e.kind === 'caravan' ? (e.hp ?? e.progress) : e.progress))}%`, height: '100%', background: e.kind === 'caravan' ? '#7fc97f' : '#ff7b54' }} />
        </div>
      )}
    </div>
  );
}

function Notes() {
  const notes = useContent((s) => s.notes);
  useEffect(() => {
    const id = setInterval(() => pruneContentNotes(), 500);
    return () => clearInterval(id);
  }, []);
  if (!notes.length) return null;
  const color: Record<string, string> = { feat: '#ffd166', rep: '#8fd3ff', codex: '#c7a6ff', vault: '#e8c47a', event: '#ff9f80', herb: '#9fe08a', refused: '#ff922b', say: '#f1ead8', lore: '#e6d6ae' };
  return (
    <div data-testid="content-notes" style={{ position: 'fixed', top: 150, left: 14, width: 'min(300px, 34vw)', display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'none', zIndex: 13 }}>
      {notes.map((n) => (
        <div key={n.id} data-testid={`content-note-${n.kind}`} style={{ ...PANEL, padding: '7px 11px', borderColor: color[n.kind] ?? GOLD }}>
          <div style={{ font: '600 13px Georgia, serif', color: color[n.kind] ?? GOLD }}>{n.title}</div>
          {n.text && <div style={{ fontSize: 12, opacity: 0.9, fontStyle: n.kind === 'say' ? 'italic' : 'normal' }}>{n.kind === 'say' ? `"${n.text}"` : n.text}</div>}
        </div>
      ))}
    </div>
  );
}

function TabletReader() {
  const r = useContent((s) => s.reading);
  const read = useContent((s) => s.sync.tablets.length);
  useEffect(() => {
    if (r && document.pointerLockElement) document.exitPointerLock();
  }, [r]);
  if (!r) return null;
  return (
    <div data-testid="tablet-reader" data-ui-panel style={{ position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(520px, 92vw)', padding: '22px 26px', zIndex: 36, borderRadius: 6, color: '#2b2116', background: 'linear-gradient(180deg, #e9dcc0, #d8c39b)', border: '2px solid #6b5537', boxShadow: '0 14px 40px rgba(0,0,0,0.6)', font: '15px/1.6 Georgia, serif' }}>
      <div style={{ fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: '#7a5a2a' }}>Lore tablet{r.place ? ` · ${r.place}` : ''}</div>
      <div style={{ font: '600 24px Georgia, serif', margin: '4px 0 10px', color: '#3a2a14' }}>{r.title}</div>
      <div data-testid="tablet-text" style={{ whiteSpace: 'pre-wrap' }}>{r.text}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, fontSize: 12, color: '#6b5537' }}>
        <span>{r.isNew ? 'New lore · ' : ''}{read} of {CONTENT.tablets.length} tablets read</span>
        <button onClick={() => closeTablet()} style={{ font: '600 13px system-ui', padding: '5px 14px', borderRadius: 4, border: '1px solid #6b5537', background: '#6b5537', color: '#f6e7c0', cursor: 'pointer' }}>Close (E / Esc)</button>
      </div>
    </div>
  );
}

function VaultPanel() {
  useTicker(400);
  const vaults = useContent((s) => s.vaults);
  const px = localPlayer.pos.x;
  const pz = localPlayer.pos.z;
  const v = Object.values(vaults).find((x) => Math.hypot(x.x - px, x.z - pz) <= x.r + 45);
  // Playtest 2 integration QA: your pet's card sits under this panel (hud/layout.ts --ls-vault-h).
  const ref = useRef<HTMLDivElement>(null);
  useHudHeight(ref, '--ls-vault-h', !!v);
  if (!v) return null;
  const phase = ['Sealed', 'The keeper is awake', 'Cleared'][v.phase] ?? '';
  return (
    <div ref={ref} data-testid="vault-panel" style={{ ...PANEL, position: 'fixed', left: 14, top: 'min(46vh, 420px)', width: 'min(300px, 34vw)', padding: '10px 12px', zIndex: 12, pointerEvents: 'none' }}>
      <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: GOLD, opacity: 0.85 }}>Sealed vault · {phase}</div>
      <div style={{ font: '600 16px Georgia, serif', color: '#f6e7c0' }}>{v.name}</div>
      {v.phase === 0 && (
        <>
          <div style={{ font: '600 13px Georgia, serif', color: '#e8c47a', marginTop: 4 }}>{v.title}</div>
          <div data-testid="vault-hint" style={{ fontSize: 12, fontStyle: 'italic', color: '#e6d6ae' }}>{v.hint}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {v.parts
              .filter((p) => p.kind !== 'door' && p.kind !== 'chest')
              .map((p) => (
                <span key={p.id} data-testid="vault-part" style={{ fontSize: 12, padding: '2px 7px', borderRadius: 10, border: `1px solid ${p.on ? '#9fe08a' : '#8a7550'}`, color: p.on ? '#c9f5b5' : '#d9c79c' }}>
                  {p.kind === 'lever' ? `${['☀', '☾', '✦'][p.glyph]} ${GLYPHS[p.glyph]}` : p.kind === 'plate' ? 'stone' : p.kind} {p.on ? '✓' : '·'}
                </span>
              ))}
          </div>
        </>
      )}
      {v.phase === 1 && v.keeper >= 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12 }}>The Vault Keeper · {v.keeper}%</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>Step out of its burning sigil.</div>
        </div>
      )}
      {v.phase === 2 && <div style={{ fontSize: 12, marginTop: 6, color: v.opened ? '#bbb' : '#9fe08a' }}>{v.opened ? 'You have emptied the chest for today.' : 'The vault chest stands open to you.'}</div>}
    </div>
  );
}

function Prompt() {
  const [t, setT] = useState<Target | null>(null);
  useEffect(() => {
    let last = '';
    const iv = setInterval(() => {
      ensureContentHook();
      const next = othersBusy() ? null : findContentTarget();
      const k = next ? `${next.kind}:${next.label}` : '';
      if (k !== last) {
        last = k;
        setT(next);
      }
    }, 120);
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || notGameKey(e)) return;
      const s = useContent.getState();
      if (e.code !== 'KeyE') return;
      if (s.reading) {
        closeTablet();
        e.stopImmediatePropagation();
        return;
      }
      if (othersBusy()) return;
      const target = findContentTarget();
      if (!target || target.kind === 'hint' || !s.actions) return;
      e.stopImmediatePropagation(); // one press, one thing (input/interact.ts)
      if (target.kind === 'tablet') s.actions.read(target.id);
      else if (target.kind === 'herb') s.actions.forage(target.id);
      else s.actions.vault(target.site, target.part);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearInterval(iv);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  if (!t) return null;
  return (
    <div data-testid="content-prompt" style={{ position: 'fixed', left: '50%', top: '62%', transform: 'translateX(-50%)', color: t.kind === 'hint' ? '#d9c79c' : '#f4efe2', font: '14px system-ui, sans-serif', textShadow: '0 1px 2px #000, 0 0 6px #000', pointerEvents: 'none', zIndex: 20 }}>
      {t.label}
    </div>
  );
}

function installHandle() {
  const handle = {
    state: () => ({ ...useContent.getState(), actions: !!useContent.getState().actions }),
    target: () => findContentTarget(),
    read: (site: number) => useContent.getState().actions?.read(site),
    forage: (id: number) => useContent.getState().actions?.forage(id),
    vault: (site: number, part: number) => useContent.getState().actions?.vault(site, part),
    sync: () => useContent.getState().actions?.sync(),
    title: (achievementId: number) => useContent.getState().actions?.title(achievementId),
    /** Dev builds (zone dev ticket): start world event kind (1 starfall, 2 caravan, 3 behemoth, 4 wild hunt, 5 glintfox) ahead of you. */
    devEvent: (kind: number) => useContent.getState().actions?.devEvent(kind),
  };
  (window as unknown as { __lodestoneContent: typeof handle }).__lodestoneContent = handle;
}

export function ContentHud() {
  useEffect(() => {
    ensureContentHook();
    if (DEBUG) installHandle();
  }, []);
  return (
    <>
      <EventTracker />
      <Notes />
      <VaultPanel />
      <Prompt />
      <TabletReader />
    </>
  );
}
