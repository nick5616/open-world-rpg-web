// Quest HUD (playtest 1): the tracked quest under the compass on the right
// (step, count, distance and direction to its marker), short notes for new
// quests, steps and completions, the offer card ("where will this take
// me?": every step's place with distance/direction, a small map preview and
// a full-map preview) and the journal (J) with track / show on map / hand
// in / abandon. Everything authoritative comes from Events 950-955.

import { useEffect, useRef, useState } from 'react';
import { notGameKey } from '../../input/useKeyboard';
import { DEBUG } from '../../config';
import { localPlayer } from '../../state/live';
import { setMapOpen, useExploration } from '../map/store';
import { headingOf } from '../map/Compass';
import { ensureQuestHook } from './link';
import { netRuntime } from '../../net/netStore';
import { distanceText, whereText, QUEST_KIND, QUEST_KIND_LABEL, type QuestMarker, type QuestView } from './events';
import { ITEMS } from '@lodestone/contracts';
import { JournalContentTab, JournalTabBar, type JournalTab } from '../content/JournalTabs';
import { liveMarkers } from './live';
import { StoryJournalBar, StoryPartyLine } from '../story/StoryHud'; // CR 035
import { dismissOffer, noteTtl, holdNotes, offerMarkers, pruneNotes, setJournalOpen, setQuestPreview, trackedQuest, useQuests } from './store';
import { ToastBar } from '../toast/ToastBar';
import { trackPanel } from '../../input/panelStack';
import { hudActivity, NOTES_MAX_IMMERSIVE, trackerExpanded, useHudSettings } from '../../hud/immersive';

// Esc closes the top one (input/panelStack.ts): the journal or a quest offer, not both at once.
trackPanel(useQuests, (s) => s.journalOpen, 'journal', () => setJournalOpen(false));
trackPanel(useQuests, (s) => !!s.offer, 'quest-offer', () => dismissOffer());

const GOLD = '#ffd166';
const PANEL: React.CSSProperties = { background: 'rgba(14,12,10,0.9)', border: '1px solid rgba(255,209,102,0.45)', borderRadius: 8, color: '#f1ead8', boxShadow: '0 8px 28px rgba(0,0,0,0.5)', font: '14px/1.4 system-ui, sans-serif' };

/** Nearest marker of a quest to the player. */
function nearest(q: QuestView): QuestMarker | null {
  let best: QuestMarker | null = null;
  let bd = Infinity;
  for (const m of liveMarkers(q)) {
    const d = Math.hypot(m.x - localPlayer.pos.x, m.z - localPlayer.pos.z) - (m.r ?? 0);
    if (d < bd) {
      best = m;
      bd = d;
    }
  }
  return best;
}

function useTicker(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

/** CR 052: the tracked quest's step changed (or a quest began): the tracker opens for a few seconds. */
let stepKey = '';
useQuests.subscribe((s) => {
  const q = trackedQuest(s);
  const k = q ? `${q.id}:${q.step}` : '';
  if (k && k !== stepKey) hudActivity.stepAt = performance.now();
  stepKey = k;
});

function Tracker() {
  useTicker(250);
  const q = useQuests((s) => trackedQuest(s));
  const count = useQuests((s) => s.log.quests.length);
  const journalOpen = useQuests((s) => s.journalOpen);
  const immersive = useHudSettings((s) => s.immersive);
  if (!q) return null;
  const m = nearest(q);
  const inside = m && Math.hypot(m.x - localPlayer.pos.x, m.z - localPlayer.pos.z) <= (m.r ?? 0);
  // Immersive HUD (CR 052): the card collapses to the compass diamond (and the guiding wisp) unless the step just changed, Tab is held or J is open.
  const open = trackerExpanded({ immersive, now: performance.now(), stepAt: hudActivity.stepAt, tabHeld: hudActivity.tabHeld, journalOpen });
  return (
    <div data-testid="quest-tracker" data-open={open ? 'true' : 'false'} className="ls-quest-tracker" style={{ position: 'fixed', top: 62, right: 14, width: 'min(300px, 34vw)', pointerEvents: 'none', zIndex: 12, color: '#f1ead8', textShadow: '0 1px 3px #000, 0 0 6px rgba(0,0,0,0.7)', font: '13px/1.35 system-ui, sans-serif', opacity: open ? 1 : 0, transition: 'opacity 500ms ease' }}>
      <div style={{ font: '600 14px Georgia, serif', color: GOLD, letterSpacing: 0.3 }}>◆ {q.title}</div>
      <div style={{ marginTop: 2 }}>
        {q.text}
        {q.need > 0 && <span style={{ color: GOLD }}> ({q.progress}/{q.need})</span>}
      </div>
      {m && (
        <div data-testid="quest-tracker-where" style={{ fontSize: 12, opacity: 0.85 }}>
          {inside ? `You are in the marked area: ${m.label}` : `${m.label}: ${whereText(localPlayer.pos.x, localPlayer.pos.z, m)}`}
        </div>
      )}
      <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>J journal{count > 1 ? ` · ${count} quests` : ''} · M map · . guide me</div>
      <StoryPartyLine />
    </div>
  );
}

function Notes() {
  const all = useQuests((s) => s.notes);
  const immersive = useHudSettings((s) => s.immersive);
  useEffect(() => {
    // a note that arrives mid-conversation (a quest handed in) waits until you walk away
    const id = setInterval(() => (document.querySelector('[data-testid="dialog"]') ? holdNotes(500) : pruneNotes()), 500);
    return () => clearInterval(id);
  }, []);
  // CR 052: fewer notices; a step's news is the tracker opening, so its note is dropped.
  const notes = immersive ? all.filter((n) => n.kind !== 'step').slice(-NOTES_MAX_IMMERSIVE) : all;
  if (!notes.length) return null;
  return (
    <div data-testid="quest-notes" style={{ position: 'fixed', top: 168, right: 14, width: 'min(300px, 34vw)', display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'none', zIndex: 13 }}>
      {notes.map((n) => (
        <div key={n.id} data-testid={`quest-note-${n.kind}`} className="ls-timed" style={{ ...PANEL, position: 'relative', overflow: 'hidden', padding: '7px 11px 9px', borderColor: n.kind === 'done' ? '#9fd38a' : n.kind === 'refused' ? '#ff922b' : 'rgba(255,209,102,0.55)', animation: 'lsQuestNote 0.3s ease-out' }}>
          <div style={{ font: '600 13px Georgia, serif', color: n.kind === 'done' ? '#b8f0a0' : GOLD }}>{n.title}</div>
          {n.text && <div style={{ fontSize: 12, opacity: 0.85 }}>{n.text}</div>}
          <ToastBar at={n.at} durationMs={noteTtl()} color={n.kind === 'done' ? '#9fd38a' : n.kind === 'refused' ? '#ff922b' : undefined} />
        </div>
      ))}
      <style>{'@keyframes lsQuestNote { from { opacity: 0; transform: translateX(12px) } to { opacity: 1; transform: none } }'}</style>
    </div>
  );
}

/** A small map of markers around you (paper, grid, areas, your arrow). */
export function MiniMap({ markers, size = 220 }: { markers: QuestMarker[]; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = localPlayer.pos.x;
    const pz = localPlayer.pos.z;
    const xs = [px, ...markers.map((m) => m.x)];
    const zs = [pz, ...markers.map((m) => m.z)];
    const pad = Math.max(60, ...markers.map((m) => (m.r ?? 0) + 20));
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + pad * 2;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
    const k = size / span;
    const sx = (x: number) => (x - cx) * k + size / 2;
    const sy = (z: number) => (z - cz) * k + size / 2;
    ctx.fillStyle = '#e9dcc0';
    ctx.fillRect(0, 0, size, size);
    // A 100 m grid (or 500 m when zoomed out).
    const step = span > 2500 ? 500 : 100;
    ctx.strokeStyle = 'rgba(110,90,60,0.18)';
    ctx.lineWidth = 1;
    for (let x = Math.floor((cx - span / 2) / step) * step; x < cx + span / 2; x += step) {
      ctx.beginPath();
      ctx.moveTo(sx(x), 0);
      ctx.lineTo(sx(x), size);
      ctx.stroke();
    }
    for (let z = Math.floor((cz - span / 2) / step) * step; z < cz + span / 2; z += step) {
      ctx.beginPath();
      ctx.moveTo(0, sy(z));
      ctx.lineTo(size, sy(z));
      ctx.stroke();
    }
    markers.forEach((m, i) => {
      const x = sx(m.x);
      const y = sy(m.z);
      const r = (m.r ?? 0) * k;
      if (r > 3) {
        ctx.fillStyle = 'rgba(214,150,20,0.22)';
        ctx.strokeStyle = '#b07a0c';
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = '#d99a14';
      ctx.strokeStyle = '#2b1d08';
      ctx.beginPath();
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x + 5, y);
      ctx.lineTo(x, y + 7);
      ctx.lineTo(x - 5, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2b1d08';
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x, y - 10);
    });
    // You.
    const h = headingOf(localPlayer.yaw);
    ctx.save();
    ctx.translate(sx(px), sy(pz));
    ctx.rotate(h);
    ctx.fillStyle = '#2c7be5';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // North and the scale.
    ctx.fillStyle = '#7a2e12';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('N ↑', 6, 14);
    ctx.fillStyle = '#4a3a22';
    ctx.textAlign = 'right';
    ctx.fillText(`${distanceText(span)} across`, size - 6, size - 6);
  }, [markers, size]);
  return <canvas ref={ref} data-testid="quest-minimap" style={{ width: size, height: size, borderRadius: 6, border: '1px solid #6b5537', display: 'block' }} />;
}

function OfferCard() {
  const offer = useQuests((s) => s.offer);
  const actions = useQuests((s) => s.actions);
  if (!offer) return null;
  const q = offer.quest;
  const markers = offerMarkers(q);
  const px = localPlayer.pos.x;
  const pz = localPlayer.pos.z;
  return (
    <div data-testid="quest-offer" data-ui-panel style={{ ...PANEL, position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(560px, 92vw)', maxHeight: '86vh', overflowY: 'auto', padding: '16px 18px', zIndex: 35 }}>
      <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: GOLD, opacity: 0.8 }}>Quest offered</div>
      <div style={{ font: '600 22px Georgia, serif', color: '#f6e7c0' }}>{q.title}</div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>{q.giver}</div>
      {q.say && (
        <div data-testid="quest-offer-say" style={{ font: 'italic 15px/1.5 Georgia, serif', color: '#f3e3bd', borderLeft: '3px solid rgba(255,209,102,0.6)', padding: '4px 0 4px 12px', margin: '0 0 12px' }}>
          &ldquo;{q.say}&rdquo;
        </div>
      )}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <ol style={{ flex: '1 1 240px', margin: 0, paddingLeft: 20, fontSize: 13 }}>
          {q.steps.map((s, i) => {
            const ms = q.stepMarkers?.[i] ?? [];
            return (
              <li key={i} style={{ marginBottom: 6 }}>
                {s.text}
                {ms.map((m, j) => (
                  <div key={j} data-testid="quest-offer-where" style={{ fontSize: 12, color: '#d9c79c' }}>
                    ◈ {m.label}: {whereText(px, pz, m)}
                    {m.r ? ` (area ~${Math.round(m.r)} m)` : ''}
                  </div>
                ))}
              </li>
            );
          })}
        </ol>
        {markers.length > 0 && <MiniMap markers={markers} />}
      </div>
      <div style={{ marginTop: 10, fontSize: 13 }}>
        Reward: <span style={{ color: GOLD }}>{rewardText(q)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button data-testid="quest-offer-map" onClick={() => { setQuestPreview({ title: q.title, markers, from: 'offer' }); setMapOpen(true); }} style={btn(false)}>Show on map</button>
        <button onClick={() => dismissOffer()} style={btn(false)}>Not now</button>
        <button data-testid="quest-offer-accept" disabled={!actions} onClick={() => { actions?.accept(q.id); dismissOffer(); }} style={btn(true)}>Accept</button>
      </div>
    </div>
  );
}

/** "30 gold · 200 XP · +12 renown with Draedmore · a rolled rare" */
export function rewardText(q: Pick<QuestView, 'gold' | 'xp' | 'rep' | 'repTown' | 'items' | 'rollItems'>): string {
  const parts = [`${q.gold} gold`, `${q.xp} XP`];
  for (const it of q.items ?? []) parts.push(`${it.qty > 1 ? `${it.qty} x ` : ''}${ITEMS.items.find((x) => x.key === it.item)?.name ?? it.item}`);
  if (q.rollItems) parts.push(q.rollItems > 1 ? `${q.rollItems} pieces of gear` : 'a piece of gear');
  if (q.rep) parts.push(`+${q.rep} renown${q.repTown ? ` with ${q.repTown}` : ''}`);
  return parts.join(' · ');
}

function btn(primary: boolean): React.CSSProperties {
  return { font: '600 13px system-ui, sans-serif', padding: '6px 14px', borderRadius: 5, border: `1px solid ${primary ? '#e0b44c' : '#8a7550'}`, background: primary ? '#7a5a1c' : '#3a3226', color: '#f6e7c0', cursor: 'pointer' };
}

function Journal() {
  const open = useQuests((s) => s.journalOpen);
  const log = useQuests((s) => s.log);
  const actions = useQuests((s) => s.actions);
  const [sel, setSel] = useState<number | null>(null);
  const [tab, setTab] = useState<JournalTab>('quests');
  useEffect(() => {
    if (open && document.pointerLockElement) document.exitPointerLock();
  }, [open]);
  if (!open) return null;
  if (tab !== 'quests') {
    return (
      <div data-testid="quest-journal" data-ui-panel style={{ ...PANEL, position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(760px, 94vw)', height: 'min(560px, 88vh)', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 36, padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <JournalTabBar tab={tab} setTab={setTab} />
          <button onClick={() => setJournalOpen(false)} style={btn(false)}>Close</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <JournalContentTab tab={tab} />
        </div>
      </div>
    );
  }
  const q = log.quests.find((x) => x.id === sel) ?? log.quests.find((x) => x.id === log.tracked) ?? log.quests[0];
  const px = localPlayer.pos.x;
  const pz = localPlayer.pos.z;
  return (
    <div data-testid="quest-journal" data-ui-panel style={{ ...PANEL, position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(760px, 94vw)', height: 'min(520px, 86vh)', display: 'grid', gridTemplateColumns: 'minmax(160px, 240px) 1fr', overflow: 'hidden', zIndex: 36 }}>
      <div style={{ borderRight: '1px solid rgba(255,209,102,0.25)', overflowY: 'auto', padding: 10 }}>
        <div style={{ font: '600 18px Georgia, serif', color: GOLD, marginBottom: 6 }}>Journal</div>
        <JournalTabBar tab={tab} setTab={setTab} />
        <StoryJournalBar />
        {log.quests.length === 0 && <div style={{ opacity: 0.7, fontSize: 13 }}>No quests. Bounty boards and townsfolk have work.</div>}
        {log.quests.map((x) => (
          <div key={x.id} onClick={() => setSel(x.id)} style={{ padding: '6px 8px', borderRadius: 4, cursor: 'pointer', background: x.id === q?.id ? 'rgba(255,209,102,0.15)' : 'transparent', marginBottom: 2 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{x.id === log.tracked ? '◆ ' : ''}{x.title}</div>
            <div style={{ fontSize: 11, opacity: 0.65 }}>{QUEST_KIND_LABEL[x.kind] ?? 'Quest'} · step {Math.min(x.step + 1, x.steps.length)}/{x.steps.length}</div>
          </div>
        ))}
      </div>
      <div style={{ padding: 14, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 11, opacity: 0.6 }}>J or Esc to close</div>
          <button onClick={() => setJournalOpen(false)} style={btn(false)}>Close</button>
        </div>
        {q && (
          <>
            <div style={{ font: '600 20px Georgia, serif', color: '#f6e7c0', marginTop: 4 }}>{q.title}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{q.giver}</div>
            <ol style={{ paddingLeft: 20, fontSize: 13 }}>
              {q.steps.map((s, i) => (
                <li key={i} style={{ opacity: s.done ? 0.5 : 1, textDecoration: s.done ? 'line-through' : 'none', fontWeight: i === q.step ? 600 : 400 }}>
                  {s.text}
                  {i === q.step && q.need > 0 ? ` (${q.progress}/${q.need})` : ''}
                </li>
              ))}
            </ol>
            {q.note && <p style={{ fontSize: 13, fontStyle: 'italic', color: '#e6d6ae' }}>{q.note}</p>}
            {q.markers.map((m, i) => (
              <div key={i} style={{ fontSize: 12, color: '#d9c79c' }}>
                ◆ {m.label}: {whereText(px, pz, m)}
              </div>
            ))}
            <div style={{ fontSize: 13, margin: '8px 0' }}>
              Reward: <span style={{ color: GOLD }}>{rewardText(q)}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button disabled={!actions || q.id === log.tracked} onClick={() => actions?.track(q.id)} style={btn(true)}>{q.id === log.tracked ? 'Tracked' : 'Track'}</button>
              {q.markers.length > 0 && <button onClick={() => { setQuestPreview({ title: q.title, markers: q.markers, from: 'quest' }); setJournalOpen(false); setMapOpen(true); }} style={btn(false)}>Show on map</button>}
              {q.turnIn && <button disabled={!actions} onClick={() => actions?.turnIn(q.id)} style={btn(false)}>Hand in</button>}
              {q.kind !== QUEST_KIND.main && <button disabled={!actions} onClick={() => { if (window.confirm(`Abandon "${q.title}"?`)) actions?.abandon(q.id); }} style={btn(false)}>Abandon</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function installQuestHandle() {
  const handle = {
    state: () => ({ ...useQuests.getState(), actions: !!useQuests.getState().actions }),
    tracked: () => trackedQuest(),
    journal: (v = true) => setJournalOpen(v),
    preview: (title: string, markers: QuestMarker[]) => {
      setQuestPreview({ title, markers, from: 'quest' });
      setMapOpen(true);
    },
    /** Any Interact on the live session (headless scripts: talk, read a board, abandon...). */
    send: (kind: number, id: string | number, action: number, arg = 0) => netRuntime.session?.sendInteract(kind, BigInt(id), action, arg),
  };
  (window as unknown as { __lodestoneQuests: typeof handle }).__lodestoneQuests = handle;
}

export function QuestHud() {
  useEffect(() => {
    ensureQuestHook();
    const id = setInterval(ensureQuestHook, 1000);
    if (DEBUG) installQuestHandle();
    const onKey = (e: KeyboardEvent) => {
      if (notGameKey(e) || e.repeat) return;
      if (e.code === 'KeyJ') setJournalOpen(!useQuests.getState().journalOpen);
    };
    window.addEventListener('keydown', onKey);
    // A map preview lasts while the map is open.
    const unsub = useExploration.subscribe((s, prev) => {
      if (prev.mapOpen && !s.mapOpen && useQuests.getState().preview) setQuestPreview(null);
    });
    return () => {
      clearInterval(id);
      unsub();
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <>
      <Tracker />
      <Notes />
      <OfferCard />
      <Journal />
    </>
  );
}
