// Spell cards (playtest 2, Nicole: "maybe we do spell cards instead of a
// dropdown and each of them shows deep info on hover but class and type on
// the spell card not on hover"). One look for spells everywhere:
//
// - SpellCardFace: name, school (colour + glyph), type, tier, mana, damage,
//   cooldown. Always visible.
// - SpellDetail: the deep info (every number from ../skills/tree spellFacts,
//   passive lines, "your hit" with the active build, which slots hold it).
//   The tooltip and the skill tree's sidebar both render it.
// - SlotCard: a loadout slot (a face, or an empty well); x clears it.
// - SpellBoard: the character panel's spell section: a loadout toggle, the
//   slots the level opened (CR 039: four, one more every ten levels, the
//   third loadout at 20; the next locked one shows when it opens) and the grid of known castable spells. Assign by click (pick a
//   card, then a slot), by dragging a card onto a slot (pointer drag with a
//   ghost card), or by keyboard (Enter picks, Enter on a slot places,
//   Delete clears). Assignment is the existing equipSpell Interact.

import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { spellHitWith } from '../skills/build';
import { equipSpell, type Char } from '../skills/char';
import { castable, namePending, needLine, nodeState, passiveLines, spellByKey, spellFacts, type NodeState } from '../skills/tree';
import { knownCards, SCHOOL_ICON, slotsHolding, spellCardData, type SpellCardData } from './card';
import { MAX_SPELL_SLOTS, hotbarKey, keyName, loadoutLevel, loadoutsOpen, slotLevel, spellSlots } from '../../combat/hotbar';
import { BORDER, BORDER_GOLD, CARD_BG, CARD_BG_HOT, GOLD, GREEN, MANA, PANEL_BG, RED, SLOT_BG, TEXT, TEXT_2, TEXT_3, WARN } from './theme';

// ---- pieces ----

export function SchoolIcon({ school, size = 14, color }: { school: string; size?: number; color: string }) {
  const icon = SCHOOL_ICON[school];
  if (!icon) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none', display: 'block' }}>
      <path d={icon.d} fill={icon.fill ? color : 'none'} stroke={color} strokeWidth={icon.fill ? 1 : 2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "Fire · tier 2" with the glyph, in the school's colour. */
export function SchoolLine({ d, size = 12 }: { d: SpellCardData; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: d.color, fontSize: size, fontWeight: 600, whiteSpace: 'nowrap' }}>
      <SchoolIcon school={d.school} size={size + 2} color={d.color} />
      {d.schoolLabel}
      <span style={{ color: TEXT_2, fontWeight: 400 }}>· T{d.tier}</span>
    </span>
  );
}

const STAT_ABBR: Record<string, string> = { Damage: 'DMG', Heals: 'HEAL', Shield: 'SHIELD', 'Ally hits': 'ALLY', Utility: 'DMG' };

function Num({ value, label, color = TEXT }: { value: string; label: string; color?: string }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span style={{ font: '700 12.5px system-ui, sans-serif', color, whiteSpace: 'nowrap' }}>{value}</span>
      <span style={{ fontSize: 10, color: TEXT_3, letterSpacing: 0.4 }}>{label}</span>
    </span>
  );
}

/** A spell card's face: everything a player needs to choose a spell, no hover needed. */
export function SpellCardFace({ d, compact }: { d: SpellCardData; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <div style={{ font: `600 ${compact ? 12 : 13}px/1.2 system-ui, sans-serif`, color: TEXT, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{d.name}</div>
      <SchoolLine d={d} size={11} />
      <div style={{ fontSize: 11, color: TEXT_2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <span style={{ color: TEXT, fontWeight: 600 }}>{d.kind}</span>
        {d.base && <span> · {d.base.toLowerCase()}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 2, borderTop: `1px solid ${BORDER}`, paddingTop: 3 }}>
        <Num value={d.stat.value} label={STAT_ABBR[d.stat.label]} color={d.stat.label === 'Damage' ? TEXT : GREEN} />
        <Num value={d.mana} label="MANA" color={MANA} />
        {d.cooldown && <Num value={d.cooldown} label="CD" />}
      </div>
    </div>
  );
}

function FactRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <>
      <span style={{ color: TEXT_2 }}>{label}</span>
      <span style={{ color: accent ?? TEXT }}>{value}</span>
    </>
  );
}

function Chip({ children, color = TEXT_2 }: { children: ReactNode; color?: string }) {
  return <span style={{ display: 'inline-block', padding: '0 6px', borderRadius: 3, border: `1px solid ${color}88`, color, fontSize: 10.5, lineHeight: '16px', whiteSpace: 'nowrap' }}>{children}</span>;
}

/** The context a spell's deep info needs (the skill screen's Char). */
export type CardCtx = Pick<Char, 'view' | 'activeLoadout' | 'knownSet' | 'loadouts' | 'level' | 'free'>;

/**
 * A spell's deep info: header (name, school, type, tier), every number the
 * skill tree tooltip computes (spellFacts), passive effects, the hit with
 * your build, and which slots hold it.
 */
export function SpellDetail({ k, c, st, compact }: { k: string; c: CardCtx; st?: NodeState; compact?: boolean }) {
  const s = spellByKey.get(k);
  const d = spellCardData(k);
  if (!s || !d) return null;
  const state = st ?? nodeState(s.tree, k, c.knownSet, c.level, c.free);
  const facts = spellFacts(s);
  const passive = s.type === 'passive' ? passiveLines(s) : [];
  const hit = spellHitWith(s, c.view, c.activeLoadout, c.knownSet);
  const inSlots = slotsHolding(k, c.loadouts);
  const need = needLine(state);
  return (
    <div data-testid={`spell-card-${k}`} style={{ font: '12px system-ui, sans-serif', lineHeight: 1.4, color: TEXT }}>
      <div style={{ font: '17px Georgia, serif', color: d.color }}>
        {d.name}
        {namePending(k) && (
          <span style={{ marginLeft: 6 }}>
            <Chip color={GOLD}>name pending</Chip>
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, margin: '2px 0 4px' }}>
        <SchoolLine d={d} />
        <Chip color={TEXT}>{d.kind}</Chip>
        {d.base && <Chip>{d.base}</Chip>}
        {d.traits.map((t) => (
          <Chip key={t} color={t === 'Kills demons' ? GOLD : TEXT_2}>
            {t}
          </Chip>
        ))}
        {state.status === 'learned' && <span style={{ color: GREEN, fontSize: 11 }}>learned</span>}
      </div>
      {state.needsLevel > 1 && state.status !== 'learned' && <div style={{ color: TEXT_2, fontSize: 11 }}>Tier {s.tier} opens at level {state.needsLevel}</div>}
      {need && <div style={{ color: state.status === 'learnable' ? GOLD : state.status === 'noPoints' ? WARN : RED, margin: '4px 0' }}>{need}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 1, marginTop: 4 }}>
        {facts.map((f, i) => (
          <FactRow key={i} label={f.label} value={f.value} accent={f.accent ? d.color : undefined} />
        ))}
        {hit > 0 && <FactRow label="Your hit" value={`about ${hit} (loadout ${c.activeLoadout + 1}, before the enemy's element)`} accent={GOLD} />}
      </div>
      {passive.map((p, i) => (
        <div key={i} style={{ marginTop: 3, color: p.active ? TEXT : TEXT_2 }}>
          {p.text}
          {!p.active && (
            <span style={{ marginLeft: 6 }}>
              <Chip>not in effect yet</Chip>
            </span>
          )}
        </div>
      ))}
      {!compact && s.ported && <div style={{ marginTop: 4, color: TEXT_2, fontSize: 11 }}>Adapted from Wizard Wars: {s.ported}</div>}
      {castable(k) && state.status === 'learned' && <div style={{ marginTop: 4, color: inSlots.length ? GREEN : TEXT_2, fontSize: 11 }}>{inSlots.length ? `In ${inSlots.join(', ')}` : 'Not in a slot'}</div>}
      {state.status === 'learned' && s.type === 'passive' && <div style={{ marginTop: 4, color: TEXT_2, fontSize: 11 }}>Passives work on their own: no slot needed.</div>}
    </div>
  );
}

const TIP_W = 300;

/** The deep-info tooltip, beside `anchor` (to the right of the panel `beside` when given, so it never covers the cards). */
export function SpellTooltip({ k, c, anchor, beside }: { k: string; c: CardCtx; anchor: DOMRect; beside?: DOMRect }) {
  const d = spellCardData(k);
  if (!d) return null;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const r = beside ?? anchor;
  const left = r.right + 10 + TIP_W < vw ? r.right + 10 : Math.max(8, anchor.left - 10 - TIP_W);
  const top = Math.max(8, Math.min(vh - 340, anchor.top - 6));
  return (
    <div data-testid="skill-tooltip" role="tooltip" style={{ position: 'fixed', left, top, width: TIP_W, padding: '10px 12px', zIndex: 60, pointerEvents: 'none', background: PANEL_BG, border: `1px solid ${d.color}aa`, borderRadius: 8, boxShadow: '0 16px 40px rgba(0,0,0,0.6)' }}>
      <SpellDetail k={k} c={c} compact />
    </div>
  );
}

// ---- slots ----

export interface SlotCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  k: string | null;
  index: number;
  loadout: number;
  /** A card is picked or dragged: this slot can take it. */
  target?: boolean;
  /** The drag is over this slot. */
  over?: boolean;
  onClear?: () => void;
  testid?: string;
}

/** One loadout slot: its number, the spell's face (or an empty well) and an x to clear it. */
export function SlotCard({ k, index, loadout, target, over, onClear, testid, style, ...rest }: SlotCardProps) {
  const d = k ? spellCardData(k) : null;
  const w = target || over ? 2 : 1;
  const edge = over ? GOLD : target ? BORDER_GOLD : d ? `${d.color}aa` : BORDER;
  return (
    <div
      data-testid={testid ?? `spell-slot-${loadout}-${index}`}
      data-spell-slot={`${loadout}:${index}`}
      role="button"
      tabIndex={0}
      aria-label={d ? `Slot ${index + 1}: ${d.name}, ${d.schoolLabel} ${d.kind}` : `Slot ${index + 1}: empty`}
      {...rest}
      style={{
        position: 'relative',
        boxSizing: 'border-box',
        minHeight: 88,
        padding: '6px 8px 6px 8px',
        borderRadius: 6,
        cursor: target || k ? 'pointer' : 'default',
        background: over ? CARD_BG_HOT : d ? CARD_BG : SLOT_BG,
        // Longhands only (React warns when shorthand and longhand borders mix across renders).
        borderStyle: d || over ? 'solid' : 'dashed',
        borderWidth: d && !over ? `3px ${w}px ${w}px` : `${w}px`,
        borderColor: d && !over ? `${d.color} ${edge} ${edge}` : edge,
        boxShadow: over ? `0 0 12px ${GOLD}aa` : target ? `0 0 6px ${GOLD}55` : undefined,
        userSelect: 'none',
        ...style,
      }}
    >
      <div title={`Slot ${index + 1}: ${keyName(hotbarKey(index))} casts it`} style={{ position: 'absolute', top: 4, right: onClear && d ? 22 : 6, font: '700 11px system-ui, sans-serif', color: GOLD }}>
        {index + 1}
        {keyName(hotbarKey(index)) !== String(index + 1) && <span style={{ color: TEXT_3, fontWeight: 400 }}> · {keyName(hotbarKey(index))}</span>}
      </div>
      {d ? (
        <div style={{ paddingRight: 26 }}>
          <SpellCardFace d={d} compact />
        </div>
      ) : (
        <div style={{ color: TEXT_3, fontSize: 12, paddingTop: 2 }}>
          Empty
          <div style={{ fontSize: 11, marginTop: 4 }}>{target ? 'Click to place here' : 'Drop a spell here'}</div>
        </div>
      )}
      {d && onClear && (
        <button
          aria-label={`clear slot ${index + 1}`}
          data-testid={`spell-slot-clear-${loadout}-${index}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          style={{ position: 'absolute', top: 2, right: 3, width: 18, height: 18, lineHeight: '14px', padding: 0, border: `1px solid ${BORDER}`, borderRadius: 3, background: SLOT_BG, color: TEXT, cursor: 'pointer', fontSize: 12 }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** CR 039: a slot the level has not opened yet: when it opens. */
export function LockedSlotCard({ index, loadout, level }: { index: number; loadout: number; level: number }) {
  return (
    <div data-testid={`spell-slot-locked-${loadout}-${index}`} aria-label={`Slot ${index + 1}: opens at level ${level}`} style={{ boxSizing: 'border-box', minHeight: 88, padding: '6px 8px', borderRadius: 6, border: `1px dashed ${BORDER}`, background: SLOT_BG, color: TEXT_3, fontSize: 12, position: 'relative' }}>
      <div style={{ position: 'absolute', top: 4, right: 6, font: '700 11px system-ui, sans-serif', color: TEXT_3 }}>{index + 1}</div>
      <LockGlyph />
      <div style={{ marginTop: 4, color: TEXT_2 }}>Opens at level {level}</div>
      <div style={{ fontSize: 11, marginTop: 2 }}>A new slot every ten levels</div>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke={TEXT_3} strokeWidth="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke={TEXT_3} strokeWidth="2" />
    </svg>
  );
}

// ---- the board (character panel) ----

interface DragState {
  key: string;
  /** Dragged out of a slot ("loadout:slot"), else from the grid. */
  from: string | null;
  x: number;
  y: number;
  over: string | null;
}

const slotAt = (x: number, y: number): string | null => {
  if (typeof document === 'undefined') return null;
  const el = document.elementFromPoint(x, y)?.closest('[data-spell-slot]');
  return el?.getAttribute('data-spell-slot') ?? null;
};

const isPick = (e: ReactKeyboardEvent) => e.key === 'Enter' || e.key === ' ';

/** The character panel's spells: loadout toggle, four slot cards, the known-spell grid. */
export function SpellBoard({ c }: { c: Char }) {
  const [shown, setShown] = useState(c.activeLoadout);
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<{ k: string; r: DOMRect; panel?: DOMRect } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const press = useRef<{ key: string; from: string | null; x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const online = c.online;
  // Follow X (the loadout swap) while the panel is open.
  useEffect(() => setShown(c.activeLoadout), [c.activeLoadout]);
  useEffect(() => {
    if (picked && !c.knownSet.has(picked)) setPicked(null);
  }, [picked, c.knownSet]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      const cur = dragRef.current;
      if (!cur && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      const next: DragState = { key: p.key, from: p.from, x: e.clientX, y: e.clientY, over: slotAt(e.clientX, e.clientY) };
      dragRef.current = next;
      setDrag(next);
      setHover(null);
    };
    const up = () => {
      const d = dragRef.current;
      press.current = null;
      dragRef.current = null;
      if (!d) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      setDrag(null);
      if (d.over && d.over !== d.from) {
        const [l, i] = d.over.split(':').map(Number);
        equipSpell(l, i, d.key);
        setPicked(null);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  const startPress = (e: ReactPointerEvent, key: string, from: string | null) => {
    if (!online || e.button !== 0) return;
    press.current = { key, from, x: e.clientX, y: e.clientY };
  };
  const showTip = (k: string, el: HTMLElement) => {
    if (dragRef.current) return;
    const panel = el.closest('[data-ui-panel]')?.getBoundingClientRect();
    setHover({ k, r: el.getBoundingClientRect(), panel });
  };
  const place = (slot: number) => {
    if (!picked || !online) return false;
    equipSpell(shown, slot, picked);
    setPicked(null);
    return true;
  };

  const lo = c.loadouts[shown];
  const open = spellSlots(c.level); // CR 039
  const cards = knownCards(c.known);
  const passives = c.known.filter((k) => !castable(k) && spellByKey.has(k));
  const dragging = !!drag;
  const inShown = new Map<string, number>();
  lo?.spells.forEach((k, i) => k && inShown.set(k, i));

  return (
    <div data-testid="spell-board" style={{ userSelect: 'none' }}>
      <div role="tablist" aria-label="Loadouts" style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {c.loadouts.map((l, i) => {
          const on = i === shown;
          if (i >= loadoutsOpen(c.level)) {
            // CR 039: the third loadout, before level 20
            return (
              <div key={i} data-testid={`spell-loadout-locked-${i}`} title={`Loadout ${i + 1} opens at level ${loadoutLevel(i)}`} style={{ flex: 1, font: '12px system-ui, sans-serif', padding: '5px 8px', borderRadius: 4, background: SLOT_BG, color: TEXT_3, border: `1px dashed ${BORDER}` }}>
                Loadout {i + 1} · level {loadoutLevel(i)}
              </div>
            );
          }
          return (
            <button
              key={i}
              role="tab"
              aria-selected={on}
              data-testid={`spell-loadout-${i}`}
              onClick={() => setShown(i)}
              style={{ flex: 1, font: '12px system-ui, sans-serif', padding: '5px 8px', borderRadius: 4, cursor: 'pointer', textAlign: 'left', background: on ? CARD_BG_HOT : SLOT_BG, color: on ? TEXT : TEXT_2, border: `1px solid ${on ? GOLD : BORDER}` }}
            >
              <b style={{ color: on ? GOLD : TEXT }}>Loadout {i + 1}</b> · {c.view.loadouts[i]?.weaponName ?? l.weapon}
              {i === c.activeLoadout && <span style={{ color: GREEN }}> · active</span>}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
        {Array.from({ length: Math.min(MAX_SPELL_SLOTS, open + 1) }, (_, i) => i).map((i) => {
          if (i >= open) return <LockedSlotCard key={i} index={i} loadout={shown} level={slotLevel(i)} />;
          const k = lo?.spells[i] ?? null;
          const id = `${shown}:${i}`;
          const target = online && ((!!picked && !dragging) || (dragging && drag.from !== id));
          return (
            <SlotCard
              key={i}
              k={k}
              index={i}
              loadout={shown}
              target={target}
              over={drag?.over === id && drag.from !== id}
              onClear={online ? () => equipSpell(shown, i, null) : undefined}
              onPointerDown={(e) => k && startPress(e, k, id)}
              onMouseEnter={(e) => k && showTip(k, e.currentTarget)}
              onMouseLeave={() => setHover(null)}
              onFocus={(e) => k && showTip(k, e.currentTarget)}
              onBlur={() => setHover(null)}
              onClick={() => {
                if (suppressClick.current) return;
                if (!place(i) && k) setPicked(picked === k ? null : k);
              }}
              onKeyDown={(e) => {
                if (isPick(e)) {
                  e.preventDefault();
                  if (!place(i) && k) setPicked(picked === k ? null : k);
                } else if ((e.key === 'Delete' || e.key === 'Backspace') && k && online) {
                  equipSpell(shown, i, null);
                }
              }}
              style={{ opacity: drag?.from === id ? 0.45 : 1 }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '10px 0 4px', fontSize: 11.5, color: TEXT_2 }}>
        <span style={{ color: TEXT, fontWeight: 600 }}>Your spells ({cards.length})</span>
        <span>{online ? (picked ? <span style={{ color: GOLD }}>Now click a slot above · click the card again to cancel</span> : 'Click a card then a slot, or drag it onto a slot') : <span style={{ color: WARN }}>Offline: connect to a zone to change slots</span>}</span>
      </div>
      <div data-testid="spell-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, maxHeight: 'min(360px, 44vh)', overflowY: 'auto', padding: 2 }}>
        {cards.map((d) => {
          const sel = picked === d.key;
          const slot = inShown.get(d.key);
          return (
            <div
              key={d.key}
              data-testid={`spell-grid-${d.key}`}
              role="button"
              tabIndex={0}
              aria-pressed={sel}
              aria-label={`${d.name}: ${d.schoolLabel} ${d.kind}, tier ${d.tier}, ${d.stat.label.toLowerCase()} ${d.stat.value}, ${d.mana} mana${d.cooldown ? `, cooldown ${d.cooldown}` : ''}`}
              onPointerDown={(e) => startPress(e, d.key, null)}
              onMouseEnter={(e) => showTip(d.key, e.currentTarget)}
              onMouseLeave={() => setHover(null)}
              onFocus={(e) => showTip(d.key, e.currentTarget)}
              onBlur={() => setHover(null)}
              onClick={() => !suppressClick.current && online && setPicked(sel ? null : d.key)}
              onKeyDown={(e) => {
                if (isPick(e) && online) {
                  e.preventDefault();
                  setPicked(sel ? null : d.key);
                }
              }}
              style={{
                position: 'relative',
                boxSizing: 'border-box',
                padding: '6px 8px',
                borderRadius: 6,
                cursor: online ? 'grab' : 'default',
                background: sel ? CARD_BG_HOT : CARD_BG,
                borderStyle: 'solid',
                borderWidth: `3px ${sel ? 2 : 1}px ${sel ? 2 : 1}px`,
                borderColor: `${d.color} ${sel ? GOLD : BORDER} ${sel ? GOLD : BORDER}`,
                boxShadow: sel ? `0 0 10px ${GOLD}88` : undefined,
                opacity: drag?.key === d.key && drag.from === null ? 0.45 : 1,
              }}
            >
              {slot !== undefined && (
                <span title={`In slot ${slot + 1}`} style={{ position: 'absolute', top: 4, right: 5, font: '700 10px system-ui, sans-serif', color: '#0c0e14', background: GREEN, borderRadius: 3, padding: '0 4px', lineHeight: '14px' }}>
                  {slot + 1}
                </span>
              )}
              <div style={{ paddingRight: slot !== undefined ? 16 : 0 }}>
                <SpellCardFace d={d} />
              </div>
            </div>
          );
        })}
        {cards.length === 0 && <div style={{ gridColumn: '1 / -1', color: TEXT_3 }}>No castable spells yet.</div>}
      </div>
      {passives.length > 0 && (
        <div style={{ fontSize: 11.5, color: TEXT_2, marginTop: 6 }}>
          Passives (always on, no slot): <span style={{ color: TEXT }}>{passives.map((k) => spellCardData(k)!.name).join(', ')}</span>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: TEXT_2, marginTop: 4 }}>New spells fill an empty slot by themselves. Cast with {Array.from({ length: open }, (_, i) => keyName(hotbarKey(i))).join(' ')} (Esc menu, Controls: change keys), or wheel to select and right-click. X swaps loadouts. A new slot every ten levels.</div>
      {hover && !drag && <SpellTooltip k={hover.k} c={c} anchor={hover.r} beside={hover.panel} />}
      {drag && <DragGhost d={spellCardData(drag.key)!} x={drag.x} y={drag.y} />}
    </div>
  );
}

function DragGhost({ d, x, y }: { d: SpellCardData; x: number; y: number }) {
  const style: CSSProperties = { position: 'fixed', left: x + 10, top: y + 8, width: 128, zIndex: 70, pointerEvents: 'none', padding: '6px 8px', borderRadius: 6, background: CARD_BG_HOT, borderStyle: 'solid', borderWidth: '3px 2px 2px', borderColor: `${d.color} ${GOLD} ${GOLD}`, boxShadow: '0 12px 28px rgba(0,0,0,0.7)', transform: 'rotate(-3deg)' };
  return (
    <div data-testid="spell-drag-ghost" style={style}>
      <SpellCardFace d={d} compact />
    </div>
  );
}
