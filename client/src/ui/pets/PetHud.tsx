// Taming and pets on screen (playtest 2, CR 029).
//
// Keys (every letter is bound; 5 is the steed's whistle, so the pets take
// the next number keys): **6** tapped sends your pet at the creature under
// the crosshair (nothing there: it comes to heel); **held**, the pet wheel
// (follow, stay, attack, come here, pet, feed: move the mouse toward one and
// let go). **7** toggles stay / follow. **E** beside a calm creature feeds it
// (the taming meter starts: stay close, don't get hurt); E beside your pet
// pets it. The prompts, the meter under the crosshair, a pet card on the
// left (name, level, health, what it is doing), notes, and the pet panel
// (Character (C) → Your pets: every pet, rename, take out / stable at a
// stable, release, feed, how taming works). `window.__lodestonePets` in
// debug builds (evidence runs).

import { useEffect, useRef, useState } from 'react';
import { isTextTarget } from '../../input/useKeyboard';
import { lookRouter } from '../../input/lookRouter';
import { localPlayer, view } from '../../state/live';
import { drawnRemotes } from '../../net/netStore';
import { countOf } from '../inventory/items';
import { useInventory } from '../inventory/store';
import { clampCursor, pickSector, sectorCenter } from '../emotes/emotes';
import { localEmote, setEmote, SELF } from '../emotes/store';
import { EMOTE_PET } from '../../net/avatarAnim';
import { photoActive } from '../photo/store';
import { useMusic } from '../music/store';
import { abilityOf, clock, foodName, foodsText, likedFood, meterFill, MODE, pickAlong, PET_CMD, species, speciesName, speciesOfId, TAMING, variantLabel, WHEEL, type PetInfo, type WheelKey } from './events';
import { ensurePetHook } from './link';
import { petOut, usePets } from './store';

export const PET_KEY = 'Digit6';
export const STAY_KEY = 'Digit7';
const TAP_MS = 230;
const R = 140;
const GOLD = '#ffd166';
const TEXT = '#f4efe2';
const panelCss: React.CSSProperties = { position: 'fixed', padding: '14px 18px', borderRadius: 10, background: 'rgba(14,16,24,0.92)', border: '1px solid rgba(255,214,120,0.35)', color: TEXT, font: '13px system-ui, sans-serif', zIndex: 36, pointerEvents: 'auto' };
const btn: React.CSSProperties = { padding: '5px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.08)', color: TEXT, cursor: 'pointer', font: '13px system-ui, sans-serif' };

/** Open or close the pet panel (the character panel's "Your pets" button). */
export function openPetPanel(open = true): void {
  usePets.setState({ panel: open });
  if (open && typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

function panelOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[data-ui-panel]')].some((el) => el.getClientRects().length > 0);
}

const have = (item: string) => countOf(useInventory.getState().inv?.items ?? [], item);

/** The calm creature you could feed now (within reach), with the food you would give. */
export function feedable(): { id: number; sp: ReturnType<typeof speciesOfId>; food: { item: string; fav: boolean } | null } | null {
  const s = usePets.getState();
  const p = localPlayer.pos;
  let best: { id: number; d: number } | null = null;
  const now = performance.now();
  for (const c of Object.values(s.calm)) {
    if (c.until < now) continue;
    const v = drawnRemotes.views.find((x) => x.id === c.id);
    const x = v?.x ?? c.x;
    const z = v?.z ?? c.z;
    const d = Math.hypot(x - p.x, z - p.z);
    if (d <= TAMING.feedReachM + 0.4 && (!best || d < best.d)) best = { id: c.id, d };
  }
  if (!best) return null;
  const sp = speciesOfId(s.calm[best.id].species);
  return { id: best.id, sp, food: sp ? likedFood(sp, have) : null };
}

/** Your pet when it is beside you (petting reach), else null. */
function petNear(): { info: PetInfo; d: number } | null {
  const info = petOut(usePets.getState());
  if (!info) return null;
  const v = drawnRemotes.views.find((x) => x.id === info.out);
  if (!v) return null;
  const p = localPlayer.pos;
  const d = Math.hypot(v.x - p.x, v.z - p.z);
  return d <= 3.6 ? { info, d } : null;
}

function lookDir() {
  const cp = Math.cos(localPlayer.pitch);
  return { x: -Math.sin(localPlayer.yaw) * cp, y: Math.sin(localPlayer.pitch), z: -Math.cos(localPlayer.yaw) * cp };
}

/** The creature under the crosshair (0 none). */
function aimedCreature(): number {
  const eye = view.eye.x || view.eye.z ? view.eye : { x: localPlayer.pos.x, y: localPlayer.pos.y + 1.6, z: localPlayer.pos.z };
  return pickAlong(drawnRemotes.views, eye, lookDir(), 32, 10);
}

function doWheel(k: WheelKey): void {
  const s = usePets.getState();
  const a = s.actions;
  if (!a) return;
  switch (k) {
    case 'attack': {
      const t = aimedCreature();
      if (t) a.command(PET_CMD.attack, t);
      else a.command(PET_CMD.follow);
      return;
    }
    case 'follow':
      a.command(PET_CMD.follow);
      return;
    case 'stay':
      a.command(PET_CMD.stay);
      return;
    case 'come':
      a.command(PET_CMD.come);
      return;
    case 'pet':
      petIt();
      return;
    case 'feed':
      a.feedPet();
  }
}

function petIt(): void {
  const s = usePets.getState();
  const info = petOut(s);
  s.actions?.pet();
  if (info) {
    const f = view.feet;
    setEmote(SELF, EMOTE_PET, info.out, f.x, f.y, f.z);
    localEmote.id = EMOTE_PET;
    localEmote.n++;
    localEmote.at = performance.now();
  }
}

function useTicker(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function PetHud() {
  useTicker(100);
  const s = usePets();
  const [wheel, setWheel] = useState(false);
  const [sel, setSel] = useState(-1);
  const st = useRef({ down: false, open: false, at: 0, cx: 0, cy: 0, sel: -1, timer: 0 as ReturnType<typeof setTimeout> | 0 });

  useEffect(() => {
    ensurePetHook();
    const iv = setInterval(ensurePetHook, 1000);
    const w = st.current;
    const move = (dx: number, dy: number) => {
      w.cx += dx;
      w.cy += dy;
      const c = { x: w.cx, y: w.cy };
      clampCursor(c, R);
      w.cx = c.x;
      w.cy = c.y;
      const k = pickSector(w.cx, w.cy, WHEEL.length);
      if (k !== w.sel) {
        w.sel = k;
        setSel(k);
      }
    };
    const openWheel = () => {
      if (!w.down || w.open) return;
      w.open = true;
      w.cx = w.cy = 0;
      w.sel = -1;
      setSel(-1);
      setWheel(true);
      lookRouter.sink = move;
    };
    const closeWheel = (act: boolean) => {
      if (w.timer) clearTimeout(w.timer);
      w.timer = 0;
      const wasOpen = w.open;
      w.down = false;
      w.open = false;
      if (lookRouter.sink === move) lookRouter.sink = null;
      setWheel(false);
      if (!act) return;
      if (wasOpen) {
        if (w.sel >= 0) doWheel(WHEEL[w.sel].key);
      } else doWheel('attack'); // a tap: attack what you aim at (or heel)
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || isTextTarget(e.target) || e.ctrlKey || e.metaKey) return;
      const ps = usePets.getState();
      if (e.code === 'Escape') {
        if (w.open) {
          closeWheel(false);
          e.stopPropagation();
        } else if (ps.panel) {
          e.stopPropagation();
          openPetPanel(false);
        }
        return;
      }
      if (panelOpen() || photoActive() || useMusic.getState().active) return; // CR 028: the keyboard plays notes
      if (e.code === PET_KEY) {
        if (!petOut(ps)) {
          usePets.setState({ notes: [...ps.notes, { id: Date.now(), text: ps.mine?.pets.length ? 'No pet out with you (Character, C → Your pets).' : 'You have no pet. Weaken a creature while you carry a food it likes, then feed it (E).', at: performance.now(), bad: true }] });
          return;
        }
        w.down = true;
        w.at = performance.now();
        w.timer = setTimeout(openWheel, TAP_MS);
        return;
      }
      if (e.code === STAY_KEY) {
        const out = petOut(ps);
        if (out) ps.actions?.command(ps.mine?.mode === MODE.stay ? PET_CMD.follow : PET_CMD.stay);
        return;
      }
      if (e.code !== 'KeyE' || localPlayer.mounted) return;
      const f = feedable();
      if (f && f.food) {
        e.stopPropagation();
        ps.actions?.feed(f.id);
        return;
      }
      if (!ps.meter && petNear()) {
        e.stopPropagation();
        petIt();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === PET_KEY && w.down) closeWheel(true);
    };
    const onMouse = (e: MouseEvent) => {
      if (!w.open || document.pointerLockElement) return;
      w.cx = e.clientX - window.innerWidth / 2;
      w.cy = e.clientY - window.innerHeight / 2;
      move(0, 0);
    };
    const onBlur = () => closeWheel(false);
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp);
    window.addEventListener('mousemove', onMouse);
    window.addEventListener('blur', onBlur);
    const dbg = {
      state: () => {
        const p = usePets.getState();
        return { mine: p.mine, calm: p.calm, meter: p.meter, tamed: p.tamed, notes: p.notes.map((n) => n.text), acts: p.acts, selfId: p.selfId, feedable: feedable(), aimed: aimedCreature() };
      },
      actions: () => usePets.getState().actions,
      panel: openPetPanel,
    };
    (window as unknown as { __lodestonePets?: unknown }).__lodestonePets = dbg;
    return () => {
      clearInterval(iv);
      closeWheel(false);
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('mousemove', onMouse);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const now = performance.now();
  const notes = s.notes.filter((n) => now - n.at < 5000);
  const f = !s.meter && !localPlayer.mounted ? feedable() : null;
  const near = !f && !s.meter ? petNear() : null;
  const out = petOut(s);
  const outView = out ? drawnRemotes.views.find((v) => v.id === out.out) : undefined;
  const fill = s.meter ? meterFill(s.meter, now) : 0;
  const meterSp = s.meter ? species(s.meter.sp) : undefined;
  return (
    <>
      {f && (
        <div data-testid="tame-prompt" style={{ position: 'fixed', left: '50%', top: '62%', transform: 'translateX(-50%)', color: TEXT, font: '14px system-ui, sans-serif', textShadow: '0 1px 2px #000, 0 0 6px #000', pointerEvents: 'none', zIndex: 20, textAlign: 'center' }}>
          {f.food ? (
            <>
              [E] Feed {foodName(f.food.item)} to the {nice(f.sp?.key)}
              {f.food.fav && <span style={{ color: GOLD }}> · its favourite!</span>}
            </>
          ) : (
            <span style={{ color: '#ffb3a8' }}>It sniffs at you. It wants: {f.sp ? foodsText(f.sp) : '?'}</span>
          )}
        </div>
      )}
      {near && (
        <div data-testid="pet-prompt" style={{ position: 'fixed', left: '50%', top: '62%', transform: 'translateX(-50%)', color: TEXT, font: '14px system-ui, sans-serif', textShadow: '0 1px 2px #000, 0 0 6px #000', pointerEvents: 'none', zIndex: 20 }}>
          [E] Pet {near.info.name}
        </div>
      )}
      {s.meter && (
        <div data-testid="tame-meter" style={{ position: 'fixed', left: '50%', top: 'calc(50% + 44px)', transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 21, textAlign: 'center', font: '12px system-ui, sans-serif', color: TEXT, textShadow: '0 1px 2px #000' }}>
          <div style={{ marginBottom: 4, font: '600 13px system-ui, sans-serif' }}>
            Taming the {nice(meterSp?.key)}… <span style={{ opacity: 0.75, fontWeight: 400 }}>stay close, don't get hurt</span>
          </div>
          <div style={{ width: 220, height: 10, borderRadius: 5, background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,214,120,0.5)', overflow: 'hidden', margin: '0 auto' }}>
            <div style={{ width: `${(fill * 100).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #ff9fb2, #ffd166)', boxShadow: '0 0 8px #ffd166' }} />
          </div>
          <div style={{ marginTop: 3, opacity: 0.8 }}>
            {foodName(s.meter.food)}
            {s.meter.fav ? ' (its favourite)' : ''} · {Math.round(fill * 100)}%
          </div>
        </div>
      )}
      {out && (
        <div data-testid="pet-card" style={{ position: 'fixed', left: 16, top: '42%', width: 190, padding: '7px 10px', borderRadius: 8, background: 'rgba(14,16,24,0.62)', border: '1px solid rgba(255,214,120,0.25)', color: TEXT, font: '12px system-ui, sans-serif', pointerEvents: 'none', zIndex: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b style={{ color: '#ffe9a8' }}>{out.name}</b>
            <span style={{ opacity: 0.75 }}>Lv {out.lv}</span>
          </div>
          <div style={{ height: 6, marginTop: 4, borderRadius: 3, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
            <div style={{ width: `${outView ? outView.healthPct : Math.round(out.hp * 100)}%`, height: '100%', background: '#5fd16b' }} />
          </div>
          <div style={{ marginTop: 4, opacity: 0.75 }}>{s.mine?.mode === MODE.stay ? 'Staying put' : 'Following'} · 6 command · 7 {s.mine?.mode === MODE.stay ? 'follow' : 'stay'}</div>
        </div>
      )}
      {wheel && <Wheel sel={sel} />}
      {notes.length > 0 && (
        <div data-testid="pet-notes" style={{ position: 'fixed', left: '50%', top: '28%', transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 22, textAlign: 'center' }}>
          {notes.slice(-2).map((n) => (
            <div key={n.id} style={{ color: n.bad ? '#ffb3a8' : '#ffe9a8', font: '600 15px system-ui, sans-serif', textShadow: '0 1px 3px #000', marginTop: 4 }}>
              {n.text}
            </div>
          ))}
        </div>
      )}
      {s.panel && <PetPanel />}
    </>
  );
}

function nice(key: string | undefined): string {
  return speciesName(key, true);
}
function Wheel({ sel }: { sel: number }) {
  const n = WHEEL.length;
  return (
    <div data-testid="pet-wheel" style={{ position: 'fixed', left: '50%', top: '50%', width: R * 2 + 120, height: R * 2 + 120, transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: 30 }}>
      <svg width="100%" height="100%" viewBox={`${-R - 60} ${-R - 60} ${R * 2 + 120} ${R * 2 + 120}`} style={{ position: 'absolute', inset: 0 }}>
        <circle r={R + 40} fill="rgba(10,12,18,0.55)" stroke="rgba(255,214,120,0.2)" strokeWidth={2} />
        <circle r={44} fill="rgba(10,12,18,0.7)" stroke="rgba(255,255,255,0.2)" />
        {WHEEL.map((e, i) => {
          const a0 = ((i - 0.5) / n) * Math.PI * 2;
          const a1 = ((i + 0.5) / n) * Math.PI * 2;
          const r0 = 48;
          const r1 = R + 38;
          const p = (r: number, a: number) => `${(Math.sin(a) * r).toFixed(1)} ${(-Math.cos(a) * r).toFixed(1)}`;
          return <path key={e.key} d={`M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`} fill={i === sel ? 'rgba(255,196,92,0.35)' : 'rgba(255,255,255,0.03)'} stroke="rgba(255,255,255,0.12)" />;
        })}
      </svg>
      {WHEEL.map((e, i) => {
        const c = sectorCenter(i, n);
        return (
          <div key={e.key} style={{ position: 'absolute', left: `calc(50% + ${c.x * (R - 6)}px)`, top: `calc(50% + ${c.y * (R - 6)}px)`, transform: 'translate(-50%, -50%)', textAlign: 'center', color: i === sel ? GOLD : TEXT, font: '600 13px system-ui, sans-serif', textShadow: '0 1px 2px #000' }}>
            {e.label}
            {e.hint && <div style={{ font: '11px system-ui, sans-serif', opacity: 0.6 }}>{e.hint}</div>}
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', color: TEXT, font: '12px system-ui, sans-serif', opacity: 0.8 }}>Pet</div>
    </div>
  );
}

function PetPanel() {
  const s = usePets();
  const m = s.mine;
  const a = s.actions;
  const [sel, setSel] = useState<number>(m?.active || m?.pets[0]?.id || 0);
  const pet = m?.pets.find((p) => p.id === sel) ?? m?.pets[0];
  const [name, setName] = useState(pet?.name ?? '');
  useEffect(() => setName(pet?.name ?? ''), [pet?.id, pet?.name]);
  const now = performance.now();
  return (
    <div data-testid="pet-panel" data-ui-panel style={{ ...panelCss, left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(640px, 94vw)', maxHeight: '86vh', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ font: '20px Georgia, serif' }}>Your pets</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span data-testid="pet-stable" style={{ color: m?.stable ? '#9fe8a8' : 'rgba(255,255,255,0.55)' }}>{m?.stable ? '● At a stable' : '○ Stable: near your camp or in a town'}</span>
          <button style={btn} onClick={() => openPetPanel(false)}>
            Close <span style={{ opacity: 0.6 }}>Esc</span>
          </button>
        </div>
      </div>
      {!m || m.pets.length === 0 ? (
        <HowTo />
      ) : (
        <div style={{ display: 'flex', gap: 14, marginTop: 12 }}>
          <div style={{ width: 200, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {m.pets.map((p) => {
              const ko = p.koMs - (now - m.at);
              return (
                <button key={p.id} data-testid={`pet-row-${p.id}`} onClick={() => setSel(p.id)} style={{ ...btn, textAlign: 'left', borderColor: p.id === pet?.id ? GOLD : 'rgba(255,255,255,0.2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <b>{p.name}</b>
                    <span style={{ opacity: 0.7 }}>Lv {p.lv}</span>
                  </div>
                  <div style={{ font: '11px system-ui, sans-serif', opacity: 0.75 }}>
                    {p.active ? (p.out ? 'With you' : ko > 0 ? `Recovering · ${clock(ko)}` : 'Coming') : ko > 0 ? `Recovering · ${clock(ko)}` : 'In the stable'}
                    {p.variant ? ` · ${variantLabel(p.variant, p.el)}` : ''}
                  </div>
                </button>
              );
            })}
            <div style={{ opacity: 0.6, font: '11px system-ui, sans-serif' }}>
              {m.pets.length} / {m.max} · one out with you, the rest wait in the stable
            </div>
          </div>
          {pet && <PetDetail pet={pet} sync={m} name={name} setName={setName} actions={a} />}
        </div>
      )}
    </div>
  );
}

function PetDetail({ pet, sync, name, setName, actions: a }: { pet: PetInfo; sync: NonNullable<ReturnType<typeof usePets.getState>['mine']>; name: string; setName: (v: string) => void; actions: ReturnType<typeof usePets.getState>['actions'] }) {
  const sp = species(pet.sp);
  const ab = abilityOf(sp);
  const xpPct = pet.next > 0 ? Math.min(100, (100 * pet.xp) / pet.next) : 100;
  const ko = pet.koMs - (performance.now() - sync.at);
  return (
    <div data-testid="pet-detail" style={{ flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ font: '18px Georgia, serif', color: '#ffe9a8' }}>{pet.name}</span>
        <span style={{ opacity: 0.7 }}>
          {nice(pet.sp)} · level {pet.lv}
          {pet.variant ? <b style={{ color: pet.variant === 1 ? GOLD : '#9fd0ff' }}> · {variantLabel(pet.variant, pet.el)}</b> : null}
        </span>
      </div>
      {sp && <div style={{ marginTop: 4, opacity: 0.8, fontStyle: 'italic' }}>{sp.blurb}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', marginTop: 10 }}>
        <span style={{ opacity: 0.7 }}>Health</span>
        <span>
          {Math.round(pet.hp * pet.hpMax)} / {pet.hpMax}
        </span>
        <span style={{ opacity: 0.7 }}>Bite</span>
        <span>{pet.dmg}</span>
        <span style={{ opacity: 0.7 }}>Experience</span>
        <span>
          <span style={{ display: 'inline-block', width: 120, height: 7, borderRadius: 4, background: 'rgba(255,255,255,0.12)', overflow: 'hidden', verticalAlign: 'middle' }}>
            <span style={{ display: 'block', width: `${xpPct}%`, height: '100%', background: GOLD }} />
          </span>{' '}
          {pet.next > 0 ? `${pet.xp} / ${pet.next}` : 'max level'}
        </span>
        <span style={{ opacity: 0.7 }}>Defeated</span>
        <span>{pet.kills}</span>
        {sp && (
          <>
            <span style={{ opacity: 0.7 }}>Favourite food</span>
            <span>{foodsText(sp)}</span>
          </>
        )}
      </div>
      {ab && (
        <div style={{ marginTop: 10, padding: '6px 8px', borderRadius: 6, background: 'rgba(255,214,120,0.08)', border: '1px solid rgba(255,214,120,0.2)' }}>
          <b style={{ color: GOLD }}>{ab.name}</b> <span style={{ opacity: 0.6 }}>· every {ab.cooldownS} s</span>
          <div style={{ opacity: 0.85, marginTop: 2 }}>{ab.desc}</div>
        </div>
      )}
      {ko > 0 && <div style={{ marginTop: 8, color: '#ffb3a8' }}>Knocked out: recovering at home for {clock(ko)}, then it comes back to you.</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <input data-testid="pet-name" value={name} maxLength={16} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9 '-]/g, ''))} style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(0,0,0,0.35)', color: TEXT, font: '14px system-ui, sans-serif' }} />
        <button style={btn} disabled={!name.trim() || name === pet.name} onClick={() => a?.name(pet.id, name.trim())}>
          Rename
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {pet.active ? (
          <>
            <button style={btn} disabled={!sync.stable} title={sync.stable ? '' : 'Only at a stable'} onClick={() => a?.stable()}>
              Send to the stable
            </button>
            <button style={btn} disabled={!pet.out} onClick={() => a?.feedPet()}>
              Feed (heals)
            </button>
            <button style={btn} disabled={!pet.out} onClick={() => a?.command(sync.mode === MODE.stay ? PET_CMD.follow : PET_CMD.stay)}>
              {sync.mode === MODE.stay ? 'Follow me' : 'Stay'} <span style={{ opacity: 0.6 }}>7</span>
            </button>
          </>
        ) : (
          <button data-testid="pet-takeout" style={btn} disabled={!sync.stable} title={sync.stable ? '' : 'Only at a stable'} onClick={() => a?.takeOut(pet.id)}>
            Take out
          </button>
        )}
        <button style={{ ...btn, marginLeft: 'auto', color: '#ffb3a8' }} onClick={() => confirm(`Let ${pet.name} go back to the wild? This can't be undone.`) && a?.release(pet.id)}>
          Release
        </button>
      </div>
      <div style={{ marginTop: 10, opacity: 0.65, lineHeight: 1.45, font: '12px system-ui, sans-serif' }}>
        6 sends it at what you aim at (hold 6: the pet wheel), 7 tells it to stay or follow, E beside it pets it. It joins fights that come to you, learns from every creature it helps defeat and is knocked out, not killed: it limps home to recover, then comes back.
      </div>
    </div>
  );
}

function HowTo() {
  return (
    <div data-testid="pet-howto" style={{ marginTop: 10, lineHeight: 1.5 }}>
      No pets yet. To tame a creature:
      <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
        <li>Carry a food it likes (the bestiary in your journal, J, says which).</li>
        <li>Weaken it below half its health. If you carry its food, it stops fighting and sniffs the air.</li>
        <li>Walk up and feed it (E). Stay close and don't get hurt while the taming meter fills.</li>
      </ol>
      <div style={{ marginTop: 8, opacity: 0.75 }}>
        Tameable: {TAMING.species.map((sp) => nice(sp.key)).join(', ')}. Some turn out shiny or elemental.
      </div>
    </div>
  );
}
