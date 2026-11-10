// Camps on screen (playtest 2, CR 025):
//
//   - P: the camp menu (the five pieces: what they do, their kit's recipe
//     with have/need, Craft a kit, Place one).
//   - Placement mode: the ghost in front of you (CampLayer draws it green or
//     red); mouse wheel or R turns it 45 degrees, left mouse places it, right
//     mouse or Esc cancels. The bar at the bottom says why it is red.
//   - [E] near a piece: cook / light the campfire, rest in a bedroll, open a
//     chest or the workbench, read or rename a signpost; hold E on your own
//     piece to pick it up (its kit comes back).
//   - The storage chest panel (16 slots; click to take, click your items to
//     put them in; owner: share with the party), the signpost name dialog,
//     the campfire's fuel strip beside the cooking panel, Rested and "safe by
//     the fire" badges, notes.
//
// `window.__lodestoneCamps` (debug builds) drives it headless
// (dev/camp-shots.ts).

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CAMPS, DAY_LENGTH_S, ITEMS } from '@lodestone/contracts';
import { DEBUG } from '../../config';
import { isTextTarget } from '../../input/useKeyboard';
import { eFree } from '../../input/interact';
import { localPlayer, worldClock } from '../../state/live';
import { emitSound } from '../../audio/bridge';
import { ItemIcon } from '../inventory/ItemIcon';
import { baseName, displayName, rarityColor, recipeStatus } from '../inventory/items';
import { useInventory } from '../inventory/store';
import { GOLD, PANEL_BG, PANEL_BORDER, TEXT } from '../inventory/styles';
import { CAMP_REFUSAL, PIECE, type CampPiece } from './events';
import { campGhost, kitCount, updateGhost } from './ghost';
import { ensureCampHook } from './link';
import { distTo, facingRot, footprint } from './placement';
import { pruneCampNotes, pushCampNote, safeByFire, useCamps } from './store';

const USE_M = 2.4; // from the footprint's edge
const HOLD_MS = 800;
const PLACE_DIST = 2.6;

function exitLock(): void {
  if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

export function startPlacing(kind: number): void {
  useCamps.setState({ placing: { kind, rot: facingRot(localPlayer.yaw), dist: PLACE_DIST }, menu: false });
}

export function stopPlacing(): void {
  useCamps.setState({ placing: null });
}

/** Turn the ghost by `d` 45 degree steps. */
export function turnGhost(d: number): void {
  const p = useCamps.getState().placing;
  if (p) useCamps.setState({ placing: { ...p, rot: (((p.rot + d) % 8) + 8) % 8 } });
}

/** Place the ghost where it stands (refused on the client when it is red). */
export function confirmPlace(): boolean {
  const s = useCamps.getState();
  const g = updateGhost();
  if (!s.placing || !g.active) return false;
  if (g.reason !== 0) {
    pushCampNote('refused', CAMP_REFUSAL[g.reason] ?? 'Not there');
    return false;
  }
  s.actions?.place(g.kind, g.rot, g.x, g.z);
  emitSound('ui_confirm');
  stopPlacing();
  return true;
}

export type CampTarget = { piece: CampPiece; label: string; hold: boolean };

/** The nearest piece you can use, with its prompt (pure over the store). */
export function findCampTarget(pieces: Record<number, CampPiece>, px: number, py: number, pz: number, now = performance.now()): CampTarget | null {
  let best: CampPiece | null = null;
  let bd = USE_M;
  for (const p of Object.values(pieces)) {
    if (Math.abs(p.y - py) > 3) continue;
    const d = distTo(footprint(p.kind, p.rot, p.x, p.z), px, pz);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  if (!best) return null;
  const p = best;
  const hold = p.mine ? ' · hold E to pick up' : '';
  const lit = p.burning && p.burnEnd > now;
  let label = '';
  if (p.kind === PIECE.campfire) label = lit ? `[E] Cook (burns ${hoursLeft(p.burnEnd - now)})` : '[E] Light the campfire (firewood)';
  else if (p.kind === PIECE.bedroll) label = p.mine || p.party ? '[E] Rest' : `${p.owner}'s bedroll`;
  else if (p.kind === PIECE.chest) label = p.mine || (p.shared && p.party) ? `[E] Open the chest (${p.used}/${CAMPS.chest.slots})` : `${p.owner}'s chest (locked)`;
  else if (p.kind === PIECE.workbench) label = '[E] Use the workbench';
  else if (p.kind === PIECE.signpost) label = p.mine ? `[E] Name the signpost${p.label ? `: ${p.label}` : ''}` : `[E] Read: ${p.label || `${p.owner}'s camp`}`;
  return { piece: p, label: label + hold, hold: p.mine };
}

function hoursLeft(ms: number): string {
  const h = ms / 1000 / (DAY_LENGTH_S / 24); // in-game hours
  return h >= 1.5 ? `${Math.round(h)} h` : h >= 0.75 ? '1 h' : `${Math.max(1, Math.round(h * 60))} min`;
}

// Playtest 2 integration QA: town, cave, tower, loot and content prompts, an
// open panel and the saddle take E first (input/interact.ts E_ORDER).
function othersBusy(): boolean {
  return !eFree('camp');
}

function useTicker(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// ---- the camp menu (P) ----

function CampMenu() {
  const items = useInventory((s) => s.inv?.items ?? []);
  const mine = useCamps((s) => s.mine);
  const craft = (id: number) => useInventory.getState().actions?.craft(id);
  return (
    <div data-testid="camp-menu" data-ui-panel style={{ ...panel, left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(560px, 94vw)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <div style={{ font: '700 18px Georgia, serif', color: GOLD }}>Make camp</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Your camp: {mine.pieces.length}/{mine.max} pieces within {CAMPS.limits.campRadiusM} m · gather firewood from fallen branches
          </div>
        </div>
        <button onClick={() => useCamps.setState({ menu: false })}>Close (P)</button>
      </div>
      {CAMPS.pieces.map((p) => {
        const r = ITEMS.recipes.find((x) => x.output === p.kit);
        const st = r ? recipeStatus(r, items) : null;
        const kits = kitCount(p.id);
        const placed = mine.pieces.filter((x) => x.kind === p.id).length;
        return (
          <div key={p.key} data-testid={`camp-piece-${p.key}`} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #ffffff14' }}>
            <div style={{ width: 34, height: 34, flex: 'none', border: '1px solid #3a342a', borderRadius: 6, background: '#1d1915', display: 'grid', placeItems: 'center' }}>
              <ItemIcon itemKey={p.kit} size={28} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>
                {p.name} <span style={{ fontWeight: 400, fontSize: 12, opacity: 0.6 }}>· placed {placed}/{p.max} · kits {kits}</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{p.desc}</div>
              {st && (
                <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '0 10px' }}>
                  {st.inputs.map((i) => (
                    <span key={i.item} style={{ color: i.have >= i.need ? '#9fd38a' : '#ff8a7a' }}>
                      {Math.min(i.have, 999)}/{i.need} {i.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button disabled={!st?.canCraft} onClick={() => r && craft(r.id)} title="Pack a kit from the materials">
              Craft kit
            </button>
            <button data-testid={`camp-place-${p.key}`} disabled={kits < 1} onClick={() => startPlacing(p.id)} title="Place it in front of you">
              Place
            </button>
          </div>
        );
      })}
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 8 }}>Placing: wheel or R turns it, left mouse places it, right mouse or Esc cancels. Hold E on your piece to pick it up again.</div>
    </div>
  );
}

// ---- the placement bar ----

function PlacementBar() {
  useTicker(100);
  const placing = useCamps((s) => s.placing);
  if (!placing) return null;
  const def = CAMPS.pieces[placing.kind - 1];
  const g = campGhost;
  const ok = g.active && g.reason === 0;
  return (
    <div data-testid="camp-placing" data-ui-panel style={{ position: 'fixed', left: '50%', bottom: 96, transform: 'translateX(-50%)', padding: '8px 14px', borderRadius: 8, background: 'rgba(14,12,10,0.78)', border: `1px solid ${ok ? '#7dff8a88' : '#ff6a5a88'}`, color: TEXT, font: '13px system-ui, sans-serif', textAlign: 'center', zIndex: 30, pointerEvents: 'none' }}>
      <div style={{ font: '600 15px Georgia, serif', color: ok ? '#a8ffb0' : '#ffb0a5' }}>
        {def?.name}: {ok ? 'place it here' : (CAMP_REFUSAL[g.reason] ?? 'finding ground...')}
      </div>
      <div style={{ fontSize: 12, opacity: 0.75 }}>Wheel or R: turn · Left mouse: place · Right mouse or Esc: cancel{typeof document !== 'undefined' && !document.pointerLockElement ? ' · click the world to capture the mouse' : ''}</div>
    </div>
  );
}

// ---- the chest ----

function ChestPanel() {
  const chest = useCamps((s) => s.chest);
  const pieces = useCamps((s) => s.pieces);
  const actions = useCamps((s) => s.actions);
  const items = useInventory((s) => s.inv?.items ?? []);
  if (!chest) return null;
  const p = pieces[chest.piece];
  const close = () => useCamps.setState({ chest: null });
  const pack = items.filter((it) => !it.s.startsWith('eq:') && it.s !== 'purse');
  return (
    <div data-testid="camp-chest" data-ui-panel style={{ ...panel, left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(640px, 96vw)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div>
          <div style={{ font: '700 18px Georgia, serif', color: GOLD }}>{chest.mine ? 'Your storage chest' : `${chest.owner}'s storage chest`}</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {chest.slots.filter(Boolean).length}/{chest.slots.length} slots · {chest.shared ? 'shared with your party' : 'locked to its owner'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {chest.mine && (
            <button data-testid="camp-chest-share" onClick={() => actions?.lock(chest.piece, !chest.shared)}>
              {chest.shared ? 'Lock to me' : 'Share with party'}
            </button>
          )}
          <button onClick={close}>Close (Esc)</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 6, marginTop: 10 }}>
        {chest.slots.map((it, i) => (
          <button
            key={i}
            data-testid={`camp-chest-slot-${i}`}
            disabled={!it}
            onClick={() => it && actions?.take(chest.piece, i)}
            title={it ? `Take ${displayName(it)}` : 'Empty'}
            style={{ height: 58, padding: 2, border: `1px solid ${it ? rarityColor(it.r) + '88' : '#3a342a'}`, borderRadius: 6, background: '#1d1915', position: 'relative', display: 'grid', placeItems: 'center' }}
          >
            {it && <ItemIcon itemKey={it.b} size={34} />}
            {it && it.q > 1 && <span style={{ position: 'absolute', right: 4, bottom: 2, fontSize: 11, color: TEXT }}>{it.q}</span>}
          </button>
        ))}
      </div>
      <div style={{ font: '600 12px system-ui', color: GOLD, textTransform: 'uppercase', letterSpacing: 0.5, margin: '12px 0 4px' }}>Your pack (click to store)</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
        {pack.map((it) => (
          <button key={it.h} data-testid={`camp-pack-${it.b}`} onClick={() => actions?.put(chest.piece, it.h)} title={`Store ${displayName(it)}`} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', border: '1px solid #3a342a', borderRadius: 6, background: '#1d1915', color: rarityColor(it.r) }}>
            <ItemIcon itemKey={it.b} size={22} />
            <span style={{ fontSize: 12 }}>
              {it.q > 1 ? `${it.q} x ` : ''}
              {baseName(it.b)}
            </span>
          </button>
        ))}
      </div>
      {!p && <div style={{ fontSize: 12, color: '#ff9a8a', marginTop: 6 }}>The chest is gone.</div>}
    </div>
  );
}

// ---- the signpost name ----

function LabelDialog() {
  const id = useCamps((s) => s.labeling);
  const piece = useCamps((s) => (id ? s.pieces[id] : undefined));
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (id) {
      setText(piece?.label ?? '');
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [id]);
  if (!id) return null;
  const save = () => {
    useCamps.getState().actions?.label(id, text.trim());
    useCamps.setState({ labeling: null });
  };
  return (
    <div data-testid="camp-label" data-ui-panel style={{ ...panel, left: '50%', top: '40%', transform: 'translate(-50%, -50%)', width: 'min(360px, 92vw)' }}>
      <div style={{ font: '700 16px Georgia, serif', color: GOLD }}>Name your signpost</div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>It shows on your map and your party&apos;s.</div>
      <input
        ref={ref}
        maxLength={24}
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\x20-\x7e]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') useCamps.setState({ labeling: null });
        }}
        style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', font: '14px system-ui', background: '#1d1915', color: TEXT, border: '1px solid #5a4e3a', borderRadius: 6 }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
        <button onClick={() => useCamps.setState({ labeling: null })}>Cancel</button>
        <button onClick={save}>Save</button>
      </div>
    </div>
  );
}

// ---- the campfire's fuel strip (beside the cooking panel) ----

function FireStrip() {
  useTicker(500);
  const station = useInventory((s) => s.station);
  const pieces = useCamps((s) => s.pieces);
  if (!station || station.kind !== 'cook') return null;
  const p = pieces[Number(station.prop)];
  if (!p || p.kind !== PIECE.campfire) return null;
  const now = performance.now();
  const lit = p.burning && p.burnEnd > now;
  const wood = kitWood();
  return (
    <div data-testid="camp-fire-strip" style={{ position: 'fixed', right: '3%', top: 'calc(50% - 43vh - 46px)', width: 'min(420px, 92vw)', boxSizing: 'border-box', ...strip }}>
      <span style={{ color: lit ? '#ffcf8a' : '#bbb' }}>{lit ? `The campfire burns ${hoursLeft(p.burnEnd - now)} more` : 'The campfire is out'}</span>
      <button disabled={wood < 1} onClick={() => useCamps.getState().actions?.fuel(p.id, 1)}>
        Add firewood ({wood})
      </button>
    </div>
  );
}

function kitWood(): number {
  let n = 0;
  for (const it of useInventory.getState().inv?.items ?? []) if (it.b === CAMPS.fire.wood) n += it.q;
  return n;
}

// ---- badges, prompt, notes ----

function Badges() {
  useTicker(1000);
  const rested = useCamps((s) => s.rested);
  const pieces = useCamps((s) => s.pieces);
  const now = performance.now();
  const hour = ((worldClock.timeOfDayS / 3600) * 24) % 24;
  const night = hour >= 18.5 || hour < 6;
  const fire = night ? safeByFire(pieces, localPlayer.pos.x, localPlayer.pos.z, now) : null;
  const left = rested ? Math.max(0, Math.ceil((rested.until - now) / 1000)) : 0;
  if (!left && !fire) return null;
  return (
    <div style={{ position: 'fixed', left: 16, bottom: 150, display: 'flex', flexDirection: 'column', gap: 4, pointerEvents: 'none', zIndex: 12, font: '12px system-ui, sans-serif' }}>
      {left > 0 && rested && (
        <div data-testid="camp-rested" style={strip} title={`+${rested.info.staminaBonus} stamina, x${rested.info.regenMult} health regeneration`}>
          <span style={{ color: '#ffd98a', fontWeight: 700 }}>Rested</span> {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · +{rested.info.staminaBonus} stamina · x{rested.info.regenMult} regen
        </div>
      )}
      {fire && (
        <div data-testid="camp-safe" style={strip}>
          <span style={{ color: '#ffb35a', fontWeight: 700 }}>By the fire</span> · demons keep away
        </div>
      )}
    </div>
  );
}

function Prompt() {
  const [t, setT] = useState<CampTarget | null>(null);
  const [hold, setHold] = useState(0);
  useEffect(() => {
    let last = '';
    let holdStart = 0;
    let holdFor: CampPiece | null = null;
    let fired = false;
    const current = (): CampTarget | null => {
      const s = useCamps.getState();
      if (s.placing || s.menu || s.chest || s.labeling || othersBusy()) return null;
      return findCampTarget(s.pieces, localPlayer.pos.x, localPlayer.pos.y, localPlayer.pos.z);
    };
    const iv = setInterval(() => {
      ensureCampHook();
      pruneCampNotes();
      const next = current();
      const k = next ? `${next.piece.id}:${next.label}` : '';
      if (k !== last) {
        last = k;
        setT(next);
      }
      if (holdFor && !fired) {
        const f = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
        setHold(f);
        if (f >= 1) {
          fired = true;
          useCamps.getState().actions?.pickup(holdFor.id);
          emitSound('pickup');
        }
      }
    }, 50);
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'KeyE' || e.repeat || isTextTarget(e.target)) return;
      const target = current();
      // A piece you can't use (someone else's bedroll, a locked chest) shows a line, not an "[E]": E stays free.
      if (!target || !target.label.startsWith('[E]')) return;
      e.stopImmediatePropagation(); // one press, one thing (input/interact.ts)
      holdStart = performance.now();
      holdFor = target.hold ? target.piece : null;
      fired = false;
      if (!target.hold) use(target.piece);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'KeyE') return;
      const p = holdFor;
      holdFor = null;
      setHold(0);
      if (p && !fired && performance.now() - holdStart < HOLD_MS) use(p);
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      clearInterval(iv);
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);
  if (!t) return null;
  return (
    <div data-testid="camp-prompt" style={{ position: 'fixed', left: '50%', top: '62%', transform: 'translateX(-50%)', color: t.label.startsWith('[E]') ? '#f4efe2' : '#d9c79c', font: '14px system-ui, sans-serif', textShadow: '0 1px 2px #000, 0 0 6px #000', pointerEvents: 'none', zIndex: 20, textAlign: 'center' }}>
      {t.label}
      {hold > 0 && (
        <div style={{ margin: '4px auto 0', width: 120, height: 4, background: 'rgba(255,255,255,0.2)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${hold * 100}%`, height: '100%', background: GOLD }} />
        </div>
      )}
    </div>
  );
}

/** E on a piece. */
export function use(p: CampPiece): void {
  const s = useCamps.getState();
  if (p.kind === PIECE.signpost && p.mine) {
    exitLock();
    useCamps.setState({ labeling: p.id });
    return;
  }
  if (p.kind === PIECE.chest) emitSound('chest_open');
  s.actions?.use(p.id);
}

function Notes() {
  const notes = useCamps((s) => s.notes);
  if (!notes.length) return null;
  return (
    <div style={{ position: 'fixed', left: '50%', top: '22%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center', pointerEvents: 'none', zIndex: 18 }}>
      {notes.slice(-3).map((n) => (
        <div key={n.id} data-testid="camp-note" style={{ ...strip, color: n.kind === 'refused' ? '#ffb0a5' : n.kind === 'fire' ? '#ffd2a0' : n.kind === 'rest' ? '#ffe7a8' : TEXT, maxWidth: 'min(560px, 90vw)', textAlign: 'center' }}>
          {n.text}
        </div>
      ))}
    </div>
  );
}

const panel: CSSProperties = { position: 'fixed', boxSizing: 'border-box', maxHeight: '88vh', overflowY: 'auto', background: PANEL_BG, border: `1px solid ${PANEL_BORDER}`, borderRadius: 10, padding: '14px 16px', color: TEXT, font: '13px/1.4 system-ui, sans-serif', zIndex: 42, boxShadow: '0 12px 40px rgba(0,0,0,0.6)' };
const strip: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 10px', borderRadius: 6, background: 'rgba(14,12,10,0.72)', border: '1px solid rgba(232,196,106,0.3)', color: TEXT, font: '12px system-ui, sans-serif', textShadow: '0 1px 2px #000' };

// ---- keys and the mouse while placing ----

function useCampKeys(): void {
  useEffect(() => {
    let lastWheel = 0;
    const onKey = (e: KeyboardEvent) => {
      if (isTextTarget(e.target) || e.repeat) return;
      const s = useCamps.getState();
      if (s.placing) {
        if (e.code === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          stopPlacing();
          return;
        }
        if (e.code === 'KeyR') {
          e.stopImmediatePropagation(); // not the drink key while placing
          turnGhost(1);
          emitSound('ui_click');
          return;
        }
      }
      if (e.code === 'Escape' && (s.chest || s.menu)) {
        useCamps.setState({ chest: null, menu: false });
        return;
      }
      if (e.code === 'KeyP' && !e.ctrlKey && !e.metaKey) {
        if (s.placing) stopPlacing();
        const open = !s.menu;
        useCamps.setState({ menu: open, chest: null });
        if (open) {
          exitLock();
          useCamps.getState().actions?.sync();
        }
      }
    };
    const onMouse = (e: MouseEvent) => {
      const s = useCamps.getState();
      if (!s.placing) return;
      if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
      if (e.button === 2) {
        e.stopImmediatePropagation();
        e.preventDefault();
        stopPlacing();
        return;
      }
      if (e.button === 0) {
        // The first click only captures the mouse; a captured click places.
        if (!document.pointerLockElement) return;
        e.stopImmediatePropagation();
        confirmPlace();
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!useCamps.getState().placing || (e.target as HTMLElement | null)?.tagName !== 'CANVAS') return; // a panel or the map scrolls as usual
      e.stopImmediatePropagation(); // not the spell selection while placing
      const now = performance.now();
      if (now - lastWheel < 90 || Math.abs(e.deltaY) < 1) return;
      lastWheel = now;
      turnGhost(e.deltaY > 0 ? 1 : -1);
    };
    let lockTimer = 0;
    const onLock = () => {
      // Esc with a captured mouse frees it instead of sending a key: that cancels too.
      // A little later than the Esc menu looks for an open panel (the placement
      // bar counts as one), so cancelling does not also open the menu.
      if (!document.pointerLockElement && useCamps.getState().placing) {
        clearTimeout(lockTimer);
        lockTimer = window.setTimeout(() => {
          if (!document.pointerLockElement) stopPlacing();
        }, 400);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    document.addEventListener('pointerlockchange', onLock);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointerlockchange', onLock);
      clearTimeout(lockTimer);
    };
  }, []);
}

function installHandle() {
  const handle = {
    state: () => ({ ...useCamps.getState(), actions: !!useCamps.getState().actions }),
    ghost: () => ({ ...updateGhost() }),
    target: () => findCampTarget(useCamps.getState().pieces, localPlayer.pos.x, localPlayer.pos.y, localPlayer.pos.z),
    menu: (open = true) => useCamps.setState({ menu: open }),
    startPlacing: (kind: number, rot?: number, dist?: number) => {
      startPlacing(kind);
      const p = useCamps.getState().placing!;
      useCamps.setState({ placing: { ...p, rot: rot ?? p.rot, dist: dist ?? p.dist } });
    },
    stopPlacing,
    turn: turnGhost,
    confirm: confirmPlace,
    place: (kind: number, rot: number, x: number, z: number) => useCamps.getState().actions?.place(kind, rot, x, z),
    use: (id: number) => {
      const p = useCamps.getState().pieces[id];
      if (p) use(p);
    },
    pickup: (id: number) => useCamps.getState().actions?.pickup(id),
    fuel: (id: number, n = 1) => useCamps.getState().actions?.fuel(id, n),
    put: (piece: number, handle: number, qty = 0) => useCamps.getState().actions?.put(piece, handle, qty),
    take: (piece: number, slot: number) => useCamps.getState().actions?.take(piece, slot),
    label: (piece: number, text: string) => useCamps.getState().actions?.label(piece, text),
    lock: (piece: number, party: boolean) => useCamps.getState().actions?.lock(piece, party),
    dev: () => useCamps.getState().actions?.dev(),
    kinds: () => Object.fromEntries(CAMPS.pieces.map((p) => [p.key, p.id])),
  };
  (window as unknown as { __lodestoneCamps: typeof handle }).__lodestoneCamps = handle;
}

export function CampHud() {
  const menu = useCamps((s) => s.menu);
  useCampKeys();
  useEffect(() => {
    ensureCampHook();
    if (DEBUG) installHandle();
  }, []);
  return (
    <>
      {menu && <CampMenu />}
      <PlacementBar />
      <ChestPanel />
      <LabelDialog />
      <FireStrip />
      <Badges />
      <Prompt />
      <Notes />
    </>
  );
}
