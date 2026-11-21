// Rift runs HUD (playtest 2, CR 040): the "[E] Enter the rift" prompt at a
// portal (with its chapter's best runs), and inside a run: the room line
// (chapter, room n/50, a gem event or a boss), foes left, a boss bar, your
// spoils and bank, the perks you hold, perk cards to pick (they free the
// mouse), stage rewards, the door hint (and the way out at a checkpoint),
// and the summary when you leave. The camera goes third person, a little
// higher and further back, while you are in a rift (you need to see the
// shots behind you); your own view comes back when you leave.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { DEBUG } from '../config';
import { eFree } from '../input/interact';
import { usePanelEsc } from '../input/panelStack';
import { notGameKey } from '../input/useKeyboard';
import { drawnRemotes } from '../net/netStore';
import { localPlayer } from '../state/live';
import { useViewStore } from '../stores/viewStore';
import { ensureRiftHook } from './link';
import { EXIT_X, STAGES } from './layout';
import { LEFT, STAGE_KIND, useRift, type RiftPortal } from './store';

const GOLD = '#ffd166';
const SERIF = 'Georgia, serif';
const PANEL: CSSProperties = { background: 'rgba(10,12,20,0.88)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 8, color: '#f1f3f5', boxShadow: '0 4px 18px rgba(0,0,0,0.5)' };
export const PORTAL_REACH_M = 6;
/** The rift camera: third person this far back (the room is 20 x 28 m). */
export const RIFT_CAMERA_DISTANCE = 7.5;

function useNow(ms: number, on = true): number {
  const [n, set] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => set(performance.now()), ms);
    return () => clearInterval(id);
  }, [ms, on]);
  return n;
}

/** The nearest open rift within reach of (x, z), if any. */
export function portalInReach(portals: readonly RiftPortal[], x: number, z: number, y: number): RiftPortal | null {
  let best: RiftPortal | null = null;
  let bd = PORTAL_REACH_M;
  for (const p of portals) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d <= bd && Math.abs(p.y - y) < 8) {
      best = p;
      bd = d;
    }
  }
  return best;
}

export function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What a left-run summary says. */
export function leftLine(reason: number, best: number, banked: number): string {
  switch (reason) {
    case LEFT.died:
      return `You fell. Deepest room cleared: ${best}. Unbanked spoils lost; ${banked} gold banked is yours.`;
    case LEFT.exit:
      return `You walked out at room ${best} with everything: ${banked} gold banked.`;
    case LEFT.victory:
      return `Chapter cleared! All ${STAGES} rooms. ${banked} gold banked.`;
    case LEFT.disconnect:
      return `You left the rift at room ${best}. Unbanked spoils lost; ${banked} gold banked.`;
    default:
      return `Out of the rift (room ${best}).`;
  }
}

// ---- the portal prompt ----

function PortalPrompt() {
  const portals = useRift((s) => s.portals);
  const stage = useRift((s) => s.stage);
  const boards = useRift((s) => s.boards);
  useNow(250, portals.length > 0 && !stage);
  const p = stage ? null : portalInReach(portals, localPlayer.pos.x, localPlayer.pos.z, localPlayer.pos.y);
  const asked = useRef(0);
  useEffect(() => {
    if (p && asked.current !== p.chapter) {
      asked.current = p.chapter;
      useRift.getState().actions?.board(p.chapter);
    }
  }, [p]);
  useEffect(() => {
    const down = (ev: KeyboardEvent) => {
      if (ev.code !== 'KeyE' || ev.repeat || notGameKey(ev)) return;
      const st = useRift.getState();
      if (st.stage || !st.actions) return;
      const q = portalInReach(st.portals, localPlayer.pos.x, localPlayer.pos.z, localPlayer.pos.y);
      if (!q || !eFree('rift')) return;
      st.actions.enter(q.id);
      ev.stopPropagation();
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, []);
  if (!p) return null;
  const free = eFree('rift');
  const board = boards.find((b) => b.chapter === p.chapter);
  return (
    <div data-testid="rift-prompt" style={{ position: 'fixed', left: '50%', top: '58%', transform: 'translateX(-50%)', textAlign: 'center', pointerEvents: 'none', zIndex: 14, visibility: free ? 'visible' : 'hidden' }}>
      <div style={{ font: `600 18px ${SERIF}`, color: p.color, textShadow: '0 0 10px rgba(0,0,0,0.9)' }}>[E] Enter the rift</div>
      <div style={{ fontSize: 13, color: '#e9ecef', textShadow: '0 1px 3px #000' }}>
        Chapter {p.chapter}: {p.name} · level {p.level} · {STAGES} rooms
      </div>
      <div style={{ fontSize: 12, opacity: 0.8, textShadow: '0 1px 3px #000' }}>Party members near you come along · closes in {fmtMs(Math.max(0, p.endsInMs - (performance.now() - p.at)))}</div>
      {board && (board.rows?.length ?? 0) > 0 && (
        <div data-testid="rift-board" style={{ ...PANEL, display: 'inline-block', marginTop: 6, padding: '6px 10px', fontSize: 12, textAlign: 'left' }}>
          <div style={{ color: GOLD, fontWeight: 600, marginBottom: 2 }}>Deepest runs · {board.name}</div>
          {board.rows!.slice(0, 5).map((r, i) => (
            <div key={r.name + i}>
              {i + 1}. {r.name} · room {r.stage} · {fmtMs(r.ms)}
            </div>
          ))}
          {board.you > 0 && <div style={{ opacity: 0.8 }}>Your best: room {board.you}</div>}
        </div>
      )}
    </div>
  );
}

// ---- in a run ----

function RunHud() {
  const stage = useRift((s) => s.stage);
  const cleared = useRift((s) => s.cleared);
  const door = useRift((s) => s.door);
  const spoils = useRift((s) => s.spoils);
  const banked = useRift((s) => s.banked);
  const taken = useRift((s) => s.taken);
  const reward = useRift((s) => s.reward);
  const notes = useRift((s) => s.notes);
  const now = useNow(200, !!stage);
  if (!stage) return null;
  const foes = stage.foes ?? [];
  const views = drawnRemotes.views;
  const alive = views.filter((v) => (v.kind === 2 || v.kind === 6) && v.healthPct > 0).length;
  const boss = foes.find((f) => (f.boss ?? 0) > 0);
  const bossView = boss ? views.find((v) => v.id === boss.id) : undefined;
  const special = stage.kind !== STAGE_KIND.fight;
  const kindColor = stage.kind >= STAGE_KIND.gemVault ? '#7cf3ff' : '#ff8f6b';
  return (
    <div data-testid="rift-hud" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 13, color: '#f1f3f5', font: '13px system-ui, sans-serif' }}>
      <div data-testid="rift-room" style={{ position: 'absolute', top: 54, left: '50%', transform: 'translateX(-50%)', textAlign: 'center', textShadow: '0 1px 3px #000, 0 0 8px rgba(0,0,0,0.7)' }}>
        <div style={{ font: '700 11px system-ui', letterSpacing: 3, textTransform: 'uppercase', color: stage.color }}>
          Chapter {stage.chapter} · {stage.chapterName}
        </div>
        <div style={{ font: `600 22px ${SERIF}` }}>
          Room {stage.stage} <span style={{ opacity: 0.6, fontSize: 15 }}>/ {stage.stages}</span>
          {special && <span style={{ color: kindColor, fontSize: 16 }}> · {stage.kindName}</span>}
        </div>
        <div style={{ fontSize: 12, opacity: 0.9 }}>{cleared ? (door === 2 ? 'Checkpoint! The door goes on; the green arch on the left walks out with everything' : door === 1 ? 'Clear! The door to the north is open: walk through it' : 'Clear! Choose a boon') : stage.kind === STAGE_KIND.gemShower ? 'Gems are falling: dodge the impacts, walk over the gems' : `${alive} left · dodge (F) through anything`}</div>
      </div>
      {boss && bossView && !cleared && (
        <div data-testid="rift-boss" style={{ position: 'absolute', top: 128, left: '50%', transform: 'translateX(-50%)', width: 420, textAlign: 'center' }}>
          <div style={{ font: `600 15px ${SERIF}`, textShadow: '0 0 4px #000' }}>{boss.name}</div>
          <div style={{ height: 10, background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 3, overflow: 'hidden', marginTop: 3 }}>
            <div style={{ width: `${bossView.healthPct}%`, height: '100%', background: `linear-gradient(${stage.color}, #7a2a1a)`, transition: 'width 150ms linear' }} />
          </div>
        </div>
      )}
      <div data-testid="rift-spoils" style={{ ...PANEL, position: 'absolute', top: 54, right: 14, padding: '7px 11px', minWidth: 170 }}>
        <div>
          Spoils <b style={{ color: GOLD }}>{spoils}</b> gold <span style={{ opacity: 0.7, fontSize: 11 }}>(lost if you fall)</span>
        </div>
        <div>
          Banked <b style={{ color: '#8ce99a' }}>{banked}</b> gold <span style={{ opacity: 0.7, fontSize: 11 }}>(yours)</span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.75 }}>Banks after every 10th room</div>
        {Object.keys(taken).length > 0 && (
          <div data-testid="rift-perks-held" style={{ marginTop: 4, fontSize: 11.5, color: '#c7d2fe' }}>
            {Object.entries(taken)
              .map(([k, n]) => `${perkName(k)}${n > 1 ? ` x${n}` : ''}`)
              .join(' · ')}
          </div>
        )}
        <button data-testid="rift-leave" style={{ pointerEvents: 'auto', marginTop: 6, font: '11px system-ui', padding: '2px 8px', background: 'rgba(255,255,255,0.06)', color: '#e9ecef', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, cursor: 'pointer' }} onClick={() => useRift.getState().actions?.leave()}>
          Leave the rift (lose unbanked spoils)
        </button>
      </div>
      {reward && now - reward.at < 6000 && (
        <div data-testid="rift-reward" style={{ ...PANEL, position: 'absolute', top: 160, right: 14, padding: '7px 11px', maxWidth: 260, borderColor: GOLD }}>
          <div style={{ color: GOLD, fontWeight: 600 }}>Room {reward.stage} reward</div>
          <div>+{reward.gold} gold to your spoils</div>
          {(reward.items?.length ?? 0) > 0 && <div>{reward.items!.length} item{reward.items!.length > 1 ? 's' : ''} by the door (luck x{reward.luck})</div>}
          {reward.gems > 0 && <div>{reward.gems} gems</div>}
        </div>
      )}
      <div style={{ position: 'absolute', bottom: 'calc(var(--ls-hotbar-h, 120px) + 16px)', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
        {notes
          .filter((n) => now - n.at < 3500)
          .map((n) => (
            <div key={n.id} style={{ ...PANEL, padding: '3px 10px', fontSize: 12.5, color: n.tone === 'good' ? '#b2f2bb' : n.tone === 'warn' ? '#ffc078' : '#e9ecef' }}>
              {n.text}
            </div>
          ))}
      </div>
      {door === 2 && <div style={{ position: 'absolute', bottom: 'calc(var(--ls-hotbar-h, 120px) + 60px)', left: '50%', transform: 'translateX(-50%)', fontSize: 12, color: '#8ce99a', textShadow: '0 1px 3px #000' }}>Way out: the green arch, {Math.abs(EXIT_X)} m left of the door</div>}
    </div>
  );
}

const PERK_NAMES: Record<string, string> = {};
export function perkName(k: string): string {
  return PERK_NAMES[k] ?? k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function PerkCards() {
  const perks = useRift((s) => s.perks);
  const now = useNow(250, !!perks);
  if (!perks) return null;
  for (const c of perks.cards) PERK_NAMES[c.key] = c.name;
  const left = Math.max(0, Math.ceil((perks.until - now) / 1000));
  return (
    <div data-testid="rift-perk-cards" data-ui-panel style={{ position: 'fixed', top: '24%', left: '50%', transform: 'translateX(-50%)', zIndex: 30, textAlign: 'center' }}>
      <div style={{ font: `600 20px ${SERIF}`, color: GOLD, textShadow: '0 1px 4px #000' }}>Choose a boon</div>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8, textShadow: '0 1px 3px #000' }}>It lasts until this run ends · the first is taken for you in {left} s</div>
      <div style={{ display: 'flex', gap: 12 }}>
        {perks.cards.map((c) => (
          <button
            key={c.i}
            data-testid={`rift-perk-${c.key}`}
            onClick={() => useRift.getState().actions?.pick(c.i)}
            style={{ ...PANEL, width: 190, minHeight: 120, padding: '12px 12px', cursor: 'pointer', textAlign: 'left', borderColor: 'rgba(255,209,102,0.55)' }}
          >
            <div style={{ font: `600 16px ${SERIF}`, color: GOLD }}>{c.name}</div>
            {c.have > 0 && <div style={{ fontSize: 11, color: '#8ce99a' }}>You have {c.have}</div>}
            <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.35 }}>{c.text}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function LeftCard() {
  const left = useRift((s) => s.left);
  const boards = useRift((s) => s.boards);
  const close = () => useRift.setState({ left: null });
  usePanelEsc('rift-left', !!left, close);
  useEffect(() => {
    if (left) useRift.getState().actions?.board(left.chapter);
  }, [left]);
  if (!left) return null;
  const board = boards.find((b) => b.chapter === left.chapter);
  return (
    <div data-testid="rift-left" data-ui-panel style={{ ...PANEL, position: 'fixed', top: '22%', left: '50%', transform: 'translateX(-50%)', zIndex: 30, padding: '14px 18px', width: 'min(440px, 90vw)', textAlign: 'center' }}>
      <div style={{ font: '700 11px system-ui', letterSpacing: 3, textTransform: 'uppercase', color: left.reason === LEFT.died ? '#ff8787' : '#8ce99a' }}>{left.reason === LEFT.died ? 'The rift threw you out' : left.reason === LEFT.victory ? 'Chapter cleared' : 'Out of the rift'}</div>
      <div style={{ font: `600 20px ${SERIF}`, margin: '2px 0 6px' }}>{left.chapterName}</div>
      <div style={{ fontSize: 13.5 }}>{leftLine(left.reason, left.best, left.banked)}</div>
      <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>Time {fmtMs(left.ms)}</div>
      {board && (board.rows?.length ?? 0) > 0 && (
        <div style={{ marginTop: 8, fontSize: 12.5, textAlign: 'left' }}>
          <div style={{ color: GOLD, fontWeight: 600 }}>Deepest runs</div>
          {board.rows!.slice(0, 8).map((r, i) => (
            <div key={r.name + i}>
              {i + 1}. {r.name} · room {r.stage} · {fmtMs(r.ms)}
            </div>
          ))}
        </div>
      )}
      <button data-testid="rift-left-close" onClick={close} style={{ marginTop: 10, font: '13px system-ui', padding: '4px 14px', background: 'rgba(255,255,255,0.08)', color: '#f1f3f5', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4, cursor: 'pointer' }}>
        Close (Esc)
      </button>
    </div>
  );
}

/** Third person while in a rift; the player's own view back after. */
function useRiftCamera() {
  const inRun = useRift((s) => !!s.stage);
  const saved = useRef<{ mode: 'first' | 'third'; distance: number } | null>(null);
  useEffect(() => {
    const v = useViewStore;
    if (inRun && !saved.current) {
      const s = v.getState();
      saved.current = { mode: s.mode, distance: s.distance };
      v.setState({ mode: 'third', distance: RIFT_CAMERA_DISTANCE });
    } else if (!inRun && saved.current) {
      v.setState({ mode: saved.current.mode, distance: saved.current.distance });
      saved.current = null;
    }
  }, [inRun]);
}

function installRiftHandle() {
  const handle = {
    state: () => ({ ...useRift.getState(), actions: !!useRift.getState().actions }),
    enter: (id: number) => useRift.getState().actions?.enter(id),
    pick: (i: number) => useRift.getState().actions?.pick(i),
    leave: () => useRift.getState().actions?.leave(),
    board: (c = 0) => useRift.getState().actions?.board(c),
  };
  (window as unknown as { __lodestoneRift: typeof handle }).__lodestoneRift = handle;
}

export function RiftHud() {
  useEffect(() => {
    ensureRiftHook();
    const id = setInterval(ensureRiftHook, 1000);
    if (DEBUG) installRiftHandle();
    return () => clearInterval(id);
  }, []);
  useRiftCamera();
  return (
    <>
      <PortalPrompt />
      <RunHud />
      <PerkCards />
      <LeftCard />
    </>
  );
}
