// Building on screen (CR 041): the hammer.
//
//   - 9: build mode / the build menu. With nothing in hand 9 opens the menu
//     (pick a piece: categories, materials, costs with what you have and
//     what is missing); in build mode 9 leaves it. The camp menu (P) has a
//     Build button too.
//   - In build mode the ghost snaps to the grid and the sockets of what you
//     built (BuildLayer draws it green or red; the bar says why): R turns it,
//     Tab changes the material (Shift+Tab the category), Q / E or 1-9 pick the
//     piece, left mouse places it, right mouse or Esc leaves. Hold X on a
//     piece of yours (or your party's, when shared) to deconstruct it for
//     80 % of its materials; F repairs it.
//   - The base readout: pieces used of your budget, the comfort tier of your
//     bed, Return home, Share base with party.
//
// `window.__lodestoneBuild` (debug builds) drives it headless.

import { useEffect, useState, type CSSProperties } from 'react';
import { CAMPS } from '@lodestone/contracts';
import { DEBUG } from '../../config';
import { notGameKey } from '../../input/useKeyboard';
import { trackPanel } from '../../input/panelStack';
import { emitSound } from '../../audio/bridge';
import { localPlayer } from '../../state/live';
import { ItemIcon } from '../inventory/ItemIcon';
import { GOLD, PANEL_BG, PANEL_BORDER, TEXT } from '../inventory/styles';
import { BUILD_REFUSAL, CAMP_REFUSAL } from '../camps/events';
import { facingRot } from '../camps/placement';
import { ensureCampHook } from '../camps/link';
import { pushCampNote, useCamps } from '../camps/store';
import { CATALOGUE, CATEGORIES, baseOf, costLines, cycleMaterial, cyclePiece, inCategory, itemLabel, missingText, refundLines, repairLines, type Category } from './defs';
import { buildGhost, ghostOk, haveItem, updateBuildGhost } from './ghost';
import { pieceDef } from './geometry';
import { turnStep } from './snap';

const HOLD_MS = 900;
const TIP_KEY = 'lodestone_build_tip';

trackPanel(useCamps, (s) => !!s.building, 'build-mode', () => stopBuilding());
trackPanel(useCamps, (s) => s.buildMenu, 'build-menu', () => useCamps.setState({ buildMenu: false }));

function exitLock(): void {
  if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

/** Quarter-turn rotation (0, 2, 4, 6) that faces the piece's front toward the player. */
const evenRot = (yaw: number): number => facingRot(yaw) & 6;

function tipOnce(): void {
  try {
    if (localStorage.getItem(TIP_KEY)) return;
    localStorage.setItem(TIP_KEY, '1');
  } catch {
    /* private mode: show it every time */
  }
  pushCampNote('info', 'Build mode: aim at the ground and click to place. R turns, Tab changes the material, Q / E picks a piece, hold X deconstructs, F repairs, Esc leaves.');
}

export function startBuilding(kind: number): void {
  const wasBuilding = !!useCamps.getState().building;
  useCamps.setState({ building: { kind, rot: evenRot(localPlayer.yaw) }, buildMenu: false, placing: null, menu: false });
  if (!wasBuilding) {
    tipOnce();
    useCamps.getState().actions?.buildSync();
  }
}

export function stopBuilding(): void {
  useCamps.setState({ building: null });
}

export function setBuildKind(kind: number): void {
  const b = useCamps.getState().building;
  if (b) useCamps.setState({ building: { ...b, kind } });
}

export function turnBuilding(d: number): void {
  const b = useCamps.getState().building;
  if (!b) return;
  const step = turnStep(b.kind) * d;
  useCamps.setState({ building: { ...b, rot: (((b.rot + step) % 8) + 8) % 8 } });
}

/** The ghost's spot, sent to the zone (refused here when red or unaffordable). */
export function confirmBuild(): boolean {
  const s = useCamps.getState();
  const g = updateBuildGhost();
  if (!s.building || !g.active) return false;
  if (g.reason !== 0) {
    pushCampNote('refused', BUILD_REFUSAL[g.reason] ?? 'Not there');
    return false;
  }
  if (g.short.length) {
    pushCampNote('refused', missingText(g.lines));
    return false;
  }
  s.actions?.place(g.kind, g.rot, g.x / 100, g.z / 100, g.hasY ? g.y / 100 : null);
  emitSound('ui_click');
  return true;
}

export function deconstructAim(): void {
  const p = buildGhost.aim;
  const a = useCamps.getState().actions;
  if (!p || !a) return;
  if (!p.modify) return pushCampNote('refused', CAMP_REFUSAL[14]);
  a.pickup(p.id);
  emitSound('pickup');
}

export function repairAim(): void {
  const p = buildGhost.aim;
  const a = useCamps.getState().actions;
  if (!p || !a) return;
  if (!p.modify) return pushCampNote('refused', CAMP_REFUSAL[14]);
  if (p.cond >= 100) return pushCampNote('info', 'It is as good as new');
  a.repair(p.id);
}

function useTicker(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// ---- cost chips ----

function Chips({ lines }: { lines: { item: string; need: number; have: number }[] }) {
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '2px 8px' }}>
      {lines.map((l) => (
        <span key={l.item} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: l.have >= l.need ? '#a7dd93' : '#ff8a7a' }} title={`${itemLabel(l.item)}: ${l.have} of ${l.need}`}>
          <ItemIcon itemKey={l.item} size={16} />
          {Math.min(l.have, 999)}/{l.need}
        </span>
      ))}
    </span>
  );
}

// ---- the bar (in build mode) ----

function BuildBar() {
  useTicker(100);
  const building = useCamps((s) => s.building);
  const info = useCamps((s) => s.build);
  const [hold, setHold] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setHold(holdFrac), 50);
    return () => clearInterval(iv);
  }, []);
  if (!building) return null;
  const g = buildGhost;
  const def = pieceDef(building.kind);
  const base = baseOf(building.kind);
  const ok = ghostOk(g);
  const list = base ? inCategory(base.cat) : [];
  const aim = g.aim;
  const aimDef = aim ? pieceDef(aim.kind) : null;
  const refund = aim && aimDef?.build ? refundLines(aim.kind) : [];
  const repair = aim && aimDef?.build && aim.cond < 100 ? repairLines(aim.kind, aim.cond) : [];
  return (
    <div data-testid="build-bar" data-ui-panel style={{ position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', width: 'min(760px, 96vw)', textAlign: 'center', zIndex: 30, pointerEvents: 'none', color: TEXT, font: '13px system-ui, sans-serif' }}>
      {aim && aimDef?.build && (
        <div style={{ ...box, marginBottom: 6, display: 'inline-block' }}>
          <b>{aimDef.name}</b>
          {aim.cond < 100 && <span style={{ opacity: 0.8 }}> · condition {aim.cond}%</span>}
          {!aim.modify && <span style={{ color: '#ffb0a5' }}> · {aim.owner}&apos;s</span>}
          {aim.modify && (
            <span style={{ opacity: 0.85 }}>
              {' '}
              · hold X: deconstruct {refund.map((r) => `${r.qty} ${itemLabel(r.item)}`).join(', ')} back
              {repair.length > 0 && ` · F: repair ${repair.map((r) => `${r.qty} ${itemLabel(r.item)}`).join(', ')}`}
            </span>
          )}
          {hold > 0 && (
            <div style={{ margin: '4px auto 0', width: 140, height: 4, background: 'rgba(255,255,255,0.2)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${hold * 100}%`, height: '100%', background: '#ff8a5a' }} />
            </div>
          )}
        </div>
      )}
      <div style={{ ...box, border: `1px solid ${ok ? '#7dff8a88' : '#ff6a5a88'}` }}>
        <div style={{ font: '600 15px Georgia, serif', color: ok ? '#a8ffb0' : '#ffb0a5' }}>
          {def?.name}: {g.active ? (ok ? 'place it here' : g.text || 'finding a spot...') : 'aim at the ground'}
        </div>
        <div style={{ marginTop: 3 }}>
          <Chips lines={g.lines} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 4, margin: '6px 0 2px' }}>
          {list.map((b, i) => {
            const cur = b === base;
            return (
              <span key={b.base} style={{ padding: '2px 7px', borderRadius: 5, border: `1px solid ${cur ? GOLD : '#4a4234'}`, background: cur ? 'rgba(243,212,138,0.18)' : 'rgba(0,0,0,0.3)', color: cur ? GOLD : '#c9bfa8', fontSize: 12 }}>
                {i < 9 ? `${i + 1} ` : ''}
                {b.name}
              </span>
            );
          })}
        </div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>
          {base?.cat} · R turn · Tab material{base && base.variants.length > 1 ? ` (${CAMPS.build.materials[pieceDef(building.kind)?.build?.mat ?? 0]?.name})` : ''} · Shift+Tab category · Q / E piece · click place · hold X deconstruct · F repair · Esc leave
          {info && ` · ${info.pieces}/${info.budget} pieces`}
          {typeof document !== 'undefined' && !document.pointerLockElement ? ' · click the world to capture the mouse' : ''}
        </div>
      </div>
    </div>
  );
}

const box: CSSProperties = { padding: '7px 14px', borderRadius: 8, background: 'rgba(14,12,10,0.8)', border: '1px solid rgba(232,196,106,0.3)', display: 'inline-block', maxWidth: '100%', boxSizing: 'border-box' };

// ---- the menu ----

function BuildMenu() {
  const info = useCamps((s) => s.build);
  const actions = useCamps((s) => s.actions);
  const [cat, setCat] = useState<Category>('Structure');
  const [mat, setMat] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  useTicker(500);
  const list = inCategory(cat);
  const shown = CATALOGUE.find((b) => b.base === hover) ?? list[0];
  const cd = info ? Math.max(0, info.homeCdMs - (performance.now() - (info.at ?? performance.now()))) : 0;
  return (
    <div data-testid="build-menu" data-ui-panel style={{ ...panel, left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(680px, 96vw)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div>
          <div style={{ font: '700 18px Georgia, serif', color: GOLD }}>Build</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {info ? `${info.pieces}/${info.budget} pieces` : 'Pick a piece'} · gather logs, stone and resin from the world · 9: build mode
          </div>
        </div>
        <button onClick={() => useCamps.setState({ buildMenu: false })}>Close (Esc)</button>
      </div>
      {info && (
        <div data-testid="build-home" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '8px 0', padding: '6px 8px', borderRadius: 6, background: '#1d1915', border: '1px solid #3a342a' }}>
          <span title={`Comfort ${info.comfort.score}/${info.comfort.max}: furnishings near your bed lengthen Rested and speed health regeneration`}>
            Comfort: <b style={{ color: GOLD }}>{info.comfort.tier}</b> ({info.comfort.score}/{info.comfort.max}){info.comfort.next ? ` · ${info.comfort.next.score - info.comfort.score} more for ${info.comfort.next.name}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button disabled={!info.home || cd > 0} onClick={() => actions?.home()} title={info.home ? 'Travel to your bed' : 'Rest in a bed first'}>
            Return home{cd > 0 ? ` (${Math.ceil(cd / 1000)} s)` : ''}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }} title="Party members may build next to, use, repair and deconstruct your pieces">
            <input type="checkbox" checked={info.share} onChange={(e) => actions?.share(e.target.checked)} /> Share base with party
          </label>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, margin: '8px 0' }}>
        {CATEGORIES.map((c) => (
          <button key={c} data-testid={`build-cat-${c}`} onClick={() => setCat(c)} style={{ flex: 1, borderColor: c === cat ? GOLD : undefined, color: c === cat ? GOLD : undefined }}>
            {c}
          </button>
        ))}
      </div>
      {list.some((b) => b.variants.length > 1) && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, fontSize: 12 }}>
          Material:
          {CAMPS.build.materials.map((m) => (
            <button key={m.key} data-testid={`build-mat-${m.key}`} onClick={() => setMat(m.index)} style={{ borderColor: m.index === mat ? GOLD : undefined, color: m.index === mat ? GOLD : undefined }}>
              {m.name}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 6 }}>
        {list.map((b) => {
          const v = b.variants[Math.min(mat, b.variants.length - 1)];
          const lines = costLines(v.id, haveItem);
          const short = lines.some((l) => l.have < l.need);
          return (
            <button
              key={b.base}
              data-testid={`build-piece-${v.key}`}
              onClick={() => startBuilding(v.id)}
              onMouseEnter={() => setHover(b.base)}
              onFocus={() => setHover(b.base)}
              title={`${v.name}: ${b.desc}`}
              style={{ textAlign: 'left', padding: '6px 8px', border: `1px solid ${short ? '#5a3a34' : '#4a4234'}`, borderRadius: 6, background: '#1d1915', color: TEXT, cursor: 'pointer' }}
            >
              <div style={{ fontWeight: 700 }}>{b.name}</div>
              <Chips lines={lines} />
            </button>
          );
        })}
      </div>
      {shown && (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85, minHeight: 34 }} data-testid="build-desc">
          <b>{shown.name}</b>: {shown.desc}
          {(() => {
            const v = shown.variants[Math.min(mat, shown.variants.length - 1)];
            const m = missingText(costLines(v.id, haveItem));
            return m ? <span style={{ color: '#ff9a8a' }}> · {m}</span> : null;
          })()}
        </div>
      )}
    </div>
  );
}

const panel: CSSProperties = { position: 'fixed', boxSizing: 'border-box', maxHeight: '88vh', overflowY: 'auto', background: PANEL_BG, border: `1px solid ${PANEL_BORDER}`, borderRadius: 10, padding: '14px 16px', color: TEXT, font: '13px/1.4 system-ui, sans-serif', zIndex: 42, boxShadow: '0 12px 40px rgba(0,0,0,0.6)' };

// ---- keys and the mouse ----

let holdFrac = 0;

function useBuildKeys(): void {
  useEffect(() => {
    let lastWheel = 0;
    let holdStart = 0;
    let holding = false;
    let fired = false;
    const iv = setInterval(() => {
      if (!holding) return;
      holdFrac = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
      if (holdFrac >= 1 && !fired) {
        fired = true;
        deconstructAim();
      }
    }, 40);
    const onKey = (e: KeyboardEvent) => {
      if (notGameKey(e) || e.repeat) return;
      const s = useCamps.getState();
      if (e.code === 'Digit9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (s.building) stopBuilding();
        else if (s.buildMenu) useCamps.setState({ buildMenu: false });
        else {
          useCamps.setState({ buildMenu: true, menu: false, chest: null, placing: null });
          exitLock();
          s.actions?.buildSync();
        }
        return;
      }
      const b = s.building;
      if (!b) return;
      const eat = () => {
        e.stopImmediatePropagation();
        e.preventDefault();
      };
      if (e.code === 'KeyR') {
        eat();
        turnBuilding(1);
        emitSound('ui_click');
      } else if (e.code === 'Tab') {
        eat();
        if (e.shiftKey) {
          const base = baseOf(b.kind);
          const ci = CATEGORIES.indexOf(base?.cat ?? 'Structure');
          const next = inCategory(CATEGORIES[(ci + 1) % CATEGORIES.length])[0];
          if (next) setBuildKind(next.variants[Math.min(Math.max(pieceDef(b.kind)?.build?.mat ?? 0, 0), next.variants.length - 1)].id);
        } else setBuildKind(cycleMaterial(b.kind));
        emitSound('ui_click');
      } else if (e.code === 'KeyQ' || e.code === 'KeyE') {
        eat();
        setBuildKind(cyclePiece(b.kind, e.code === 'KeyE' ? 1 : -1));
        emitSound('ui_click');
      } else if (e.code.startsWith('Digit') && Number(e.code.slice(5)) >= 1) {
        const base = baseOf(b.kind);
        const pick = base ? inCategory(base.cat)[Number(e.code.slice(5)) - 1] : undefined;
        if (pick) {
          eat();
          setBuildKind(pick.variants[Math.min(Math.max(pieceDef(b.kind)?.build?.mat ?? 0, 0), pick.variants.length - 1)].id);
          emitSound('ui_click');
        }
      } else if (e.code === 'KeyX') {
        eat();
        holding = true;
        fired = false;
        holdStart = performance.now();
      } else if (e.code === 'KeyF') {
        eat();
        repairAim();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyX') {
        holding = false;
        holdFrac = 0;
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (!useCamps.getState().building || (e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
      if (e.button === 2) {
        e.stopImmediatePropagation();
        e.preventDefault();
        stopBuilding();
      } else if (e.button === 0) {
        if (!document.pointerLockElement) return; // the first click only captures the mouse
        e.stopImmediatePropagation();
        confirmBuild();
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!useCamps.getState().building || (e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
      e.stopImmediatePropagation();
      const now = performance.now();
      if (now - lastWheel < 90 || Math.abs(e.deltaY) < 1) return;
      lastWheel = now;
      turnBuilding(e.deltaY > 0 ? 1 : -1);
    };
    let lockTimer = 0;
    const onLock = () => {
      // Esc with a captured mouse frees it: that leaves build mode too (a little after the Esc menu looked for a panel).
      if (!document.pointerLockElement && useCamps.getState().building) {
        clearTimeout(lockTimer);
        lockTimer = window.setTimeout(() => {
          if (!document.pointerLockElement) stopBuilding();
        }, 400);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    document.addEventListener('pointerlockchange', onLock);
    return () => {
      clearInterval(iv);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointerlockchange', onLock);
      clearTimeout(lockTimer);
    };
  }, []);
}

function installHandle() {
  const handle = {
    ghost: () => ({ ...updateBuildGhost() }),
    start: (kind: number, rot?: number) => {
      startBuilding(kind);
      if (rot !== undefined) useCamps.setState({ building: { kind, rot } });
    },
    stop: stopBuilding,
    turn: turnBuilding,
    confirm: confirmBuild,
    menu: (open = true) => useCamps.setState({ buildMenu: open }),
    deconstruct: deconstructAim,
    repair: repairAim,
    place: (kind: number, rot: number, x: number, z: number, y: number | null) => useCamps.getState().actions?.place(kind, rot, x, z, y),
    kinds: () => Object.fromEntries(CAMPS.pieces.filter((p) => p.build).map((p) => [p.key, p.id])),
    info: () => useCamps.getState().build,
  };
  (window as unknown as { __lodestoneBuild: typeof handle }).__lodestoneBuild = handle;
}

export function BuildHud() {
  const menu = useCamps((s) => s.buildMenu);
  useBuildKeys();
  useEffect(() => {
    ensureCampHook();
    if (DEBUG) installHandle();
  }, []);
  return (
    <>
      {menu && <BuildMenu />}
      <BuildBar />
    </>
  );
}
