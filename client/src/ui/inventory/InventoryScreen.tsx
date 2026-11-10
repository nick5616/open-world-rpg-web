// The inventory screen (WP14, spec 8): 40 slots, a gem pouch and an ore
// pouch, the purse, and the equipment column (two loadout weapons, head,
// body, legs). Tiles are bordered in their rarity colour (Bitchin': the
// animated holographic border); hover or click an item for its card (name,
// rarity, level, affixes, uniques, sockets, tradeable / verified,
// provenance), and act on the selected one. Everything is an Interact 21 to
// the zone; the next Event 400 redraws the screen (no optimistic edits).
//
// Keys: I toggles, Esc closes, G or Delete drops the selected item (G is
// swallowed while the screen is open so it doesn't also open the glider).
// Ignored while typing in a text field. Opening releases the pointer lock
// (like the map); a click on the canvas takes it back.
//
// Mouse: drag an item out of the panel to drop it, onto an equipment slot to
// equip it, onto a bag/pouch cell to move it, a gem onto a weapon to socket
// it. Or select a weapon, press "Socket a gem" and click a gem.

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ITEM_ACT } from './events';
import { ItemIcon } from './ItemIcon';
import { affixLine, baseLine, baseName, defaultWeapon, displayName, EQ_LABEL, EQ_SLOTS, trainingWeaponName, gemEffect, INV_COLS, INV_SLOTS, isArmor, isConsumable, isEquipped, isGem, isHolo, isWeapon, itemDef, kindLabel, parseSlot, rarityColor, rarityDef, uniqueInfo, type EqSlot, type WireItem } from './items';
import { installInventoryDebug } from './dev';
import { pushToast, setInventoryOpen, useInventory } from './store';
import { ensureInventoryStyles, GOLD, PANEL_BG, PANEL_BORDER, TEXT } from './styles';
import { isTextTarget } from '../../input/useKeyboard';
import { useCombatHud } from '../../combat/store';
import { enterPlay, instrumentItem } from '../music/link';

const TILE = 52;
const GAP = 6;
const POUCH_MIN = INV_COLS;

function useActions() {
  const actions = useInventory((s) => s.actions);
  return (fn: (a: NonNullable<typeof actions>) => void) => {
    if (actions) fn(actions);
    else pushToast('warn', '(offline) Connect to a zone to use your items');
  };
}

function Tile({ item, selected, dropTarget, onPick, onHover, onDragStart, onDragEnd, onDrop, title }: { item: WireItem | null; selected?: boolean; dropTarget?: boolean; onPick?: () => void; onHover?: (h: number | null) => void; onDragStart?: () => void; onDragEnd?: () => void; onDrop?: () => void; title?: string }) {
  const [over, setOver] = useState(false);
  const holo = item ? isHolo(item.r) : false;
  const cls = ['ls-tile', item ? '' : 'ls-empty', selected ? 'ls-sel' : '', holo ? 'ls-holo-border' : '', over && dropTarget ? 'ls-drop' : ''].filter(Boolean).join(' ');
  const dropProps = onDrop
    ? {
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          onDrop();
        },
      }
    : {};
  return (
    <div
      className={cls}
      data-testid={item ? `inv-item-${item.h}` : undefined}
      title={title}
      style={item && !holo ? { borderColor: rarityColor(item.r) } : undefined}
      draggable={!!item}
      onClick={item ? onPick : undefined}
      onMouseEnter={item ? () => onHover?.(item.h) : undefined}
      onMouseLeave={item ? () => onHover?.(null) : undefined}
      onDragStart={
        item
          ? (e) => {
              e.dataTransfer.setData('text/plain', String(item.h));
              e.dataTransfer.effectAllowed = 'move';
              onDragStart?.();
            }
          : undefined
      }
      onDragEnd={onDragEnd}
      {...dropProps}
    >
      {item && <ItemIcon itemKey={item.b} />}
      {item && item.q > 1 && <span className="ls-qty">{item.q > 9999 ? `${Math.floor(item.q / 1000)}k` : item.q}</span>}
      {item?.k?.map((g, i) => <span key={i} className="ls-dot" style={{ left: 3 + i * 8, background: g ? '#fff' : 'transparent', borderColor: g ? '#000a' : '#fff8' }} />)}
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', font: '600 12px system-ui', color: GOLD, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 5 }}>
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

/** The item card: everything the item is (tooltip and details). */
export function ItemCard({ item, quick }: { item: WireItem; quick?: string }) {
  const def = itemDef(item.b);
  const rd = rarityDef(item.r);
  const holo = isHolo(item.r);
  const color = rarityColor(item.r);
  const line = baseLine(item.b);
  return (
    <div data-testid="inv-card" style={{ font: '13px/1.45 system-ui, sans-serif', color: TEXT }}>
      <div className={holo ? 'ls-holo-text' : undefined} style={{ font: '700 18px/1.2 system-ui, sans-serif', color }}>
        {displayName(item)}
      </div>
      {item.n && <div style={{ opacity: 0.75 }}>{baseName(item.b)}</div>}
      <div style={{ marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
        <span className={holo ? 'ls-holo-text' : undefined} style={{ color, fontWeight: 600 }}>
          {rd.name}
        </span>
        {kindLabel(item.b) && <span style={{ opacity: 0.75 }}>{kindLabel(item.b)}</span>}
        {(def?.kind === 'weapon' || def?.kind === 'armor') && <span style={{ opacity: 0.75 }}>Item level {item.l}</span>}
        {item.q > 1 && <span style={{ opacity: 0.75 }}>x{item.q}</span>}
      </div>
      {line && <div style={{ marginTop: 6, opacity: 0.9 }}>{line}</div>}
      {quick === item.b && <div style={{ marginTop: 4, color: '#9fd38a' }}>Your drink key (R) uses this</div>}
      {!!item.a?.length && (
        <div style={{ marginTop: 8 }}>
          {item.a.map((a, i) => {
            const l = affixLine(a);
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ color: '#9fc7ff' }}>{l.text}</span>
                <span style={{ opacity: 0.55, fontSize: 12 }}>{l.name}</span>
              </div>
            );
          })}
        </div>
      )}
      {!!item.u?.length && (
        <div style={{ marginTop: 8 }}>
          {item.u.map((u) => {
            const info = uniqueInfo(u);
            return (
              <div key={u} style={{ marginBottom: 3 }}>
                <span className={holo ? 'ls-holo-text' : undefined} style={{ color, fontWeight: 700 }}>
                  ✦ {info.name}
                </span>
                <span style={{ opacity: 0.85 }}> {info.lines.join(', ')}</span>
              </div>
            );
          })}
        </div>
      )}
      {!!item.k?.length && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Sockets</div>
          {item.k.map((g, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', border: '1px solid #fff8', background: g ? '#fff' : 'transparent', display: 'inline-block' }} />
              {g ? (
                <span>
                  {baseName(g)} <span style={{ opacity: 0.65, fontSize: 12 }}>{gemEffect(g).replace('Socketed: ', '')}</span>
                </span>
              ) : (
                <span style={{ opacity: 0.55 }}>Empty socket</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {!item.v && <span style={{ color: '#ffb36b' }}>Unverified — dropped by a local profile</span>}
        <span style={{ opacity: 0.7 }}>{item.t ? 'Tradeable' : 'Not tradeable'}</span>
        {item.p > 0 && <span style={{ opacity: 0.7 }}>Provenance: {item.p} {item.p === 1 ? 'hand' : 'hands'}</span>}
        {def && def.value > 0 && <span style={{ opacity: 0.55 }}>Worth about {def.value * Math.max(1, item.q)} gold</span>}
      </div>
    </div>
  );
}

export function InventoryScreen() {
  const open = useInventory((s) => s.invOpen);
  useEffect(() => {
    ensureInventoryStyles();
    return installInventoryDebug();
  }, []);
  useEffect(() => {
    // Capture phase: G (drop) must not reach the movement keys (glider) while the screen is open.
    const onKey = (e: KeyboardEvent) => {
      if (isTextTarget(e.target) || e.repeat) return;
      const s = useInventory.getState();
      if (e.code === 'KeyI') {
        setInventoryOpen(!s.invOpen);
        return;
      }
      if (!s.invOpen) return;
      if (e.code === 'Escape') setInventoryOpen(false);
      else if (e.code === 'KeyG' || e.code === 'Delete') {
        e.stopImmediatePropagation();
        const it = s.inv?.items.find((x) => x.h === s.selected);
        if (!it) return;
        if (s.actions) s.actions.item(it.h, ITEM_ACT.drop, 0);
        else pushToast('warn', '(offline) Connect to a zone to drop items');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return open ? <InventoryPanel /> : null;
}

function InventoryPanel() {
  const inv = useInventory((s) => s.inv);
  const selected = useInventory((s) => s.selected);
  const socketPick = useInventory((s) => s.socketPick);
  const online = useInventory((s) => !!s.actions);
  const act = useActions();
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<number | null>(null);
  const items = inv?.items ?? [];
  const byHandle = (h: number | null) => (h === null ? undefined : items.find((x) => x.h === h));
  const at = (slot: string) => items.find((x) => x.s === slot) ?? null;
  const pouch = (p: string) => items.filter((x) => parseSlot(x.s).pouch === p);
  const sel = byHandle(selected);
  const shown = byHandle(hover) ?? sel;

  const pick = (it: WireItem) => {
    // Socket mode: a gem click completes it.
    if (socketPick && isGem(it)) {
      act((a) => a.socket(socketPick.weapon, it.h, socketPick.socket));
      useInventory.setState({ socketPick: null, selected: socketPick.weapon });
      return;
    }
    useInventory.setState({ selected: it.h === selected ? null : it.h, socketPick: null });
  };
  const firstEmptySocket = (w: WireItem) => (w.k ?? []).findIndex((g) => !g);
  const socketInto = (w: WireItem, g: WireItem) => {
    const i = firstEmptySocket(w);
    if (i < 0) {
      pushToast('warn', `${displayName(w)} has no empty socket`);
      return;
    }
    act((a) => a.socket(w.h, g.h, i));
  };
  const dragged = () => byHandle(drag.current);
  const dropOnCell = (pouchName: string, index: number) => {
    const it = dragged();
    if (!it) return;
    if (isEquipped(it)) {
      act((a) => a.item(it.h, ITEM_ACT.unequip, EQ_SLOTS.indexOf(it.s as EqSlot)));
      return;
    }
    const p = parseSlot(it.s);
    if (p.pouch !== pouchName) {
      pushToast('warn', `That goes in the ${p.pouch === 'gem' ? 'gem pouch' : p.pouch === 'ore' ? 'ore pouch' : 'bag'}`);
      return;
    }
    if (p.index !== index) act((a) => a.item(it.h, ITEM_ACT.move, index));
  };
  const dropOnEq = (slot: EqSlot) => {
    const it = dragged();
    if (!it) return;
    const target = at(slot);
    if (isGem(it) && target && isWeapon(target)) {
      socketInto(target, it);
      return;
    }
    if (slot === 'eq:main0' || slot === 'eq:main1') {
      if (!isWeapon(it)) return pushToast('warn', 'Only weapons go in a main hand');
      act((a) => a.item(it.h, ITEM_ACT.equip, slot === 'eq:main0' ? 0 : 1));
    } else {
      if (!isArmor(it) || `eq:${itemDef(it.b)?.armor}` !== slot) return pushToast('warn', `That does not go on your ${slot.slice(3)}`);
      act((a) => a.item(it.h, ITEM_ACT.equip, 0));
    }
  };
  const dropOnItem = (target: WireItem) => {
    const it = dragged();
    if (!it || it.h === target.h) return;
    if (isGem(it) && isWeapon(target)) socketInto(target, it);
    else dropOnCell(parseSlot(target.s).pouch, parseSlot(target.s).index);
  };
  const dropOutside = () => {
    const it = dragged();
    if (!it) return;
    act((a) => a.item(it.h, ITEM_ACT.drop, 0));
  };

  const tileProps = (it: WireItem | null, onEmptyDrop?: () => void) => ({
    item: it,
    selected: !!it && it.h === selected,
    dropTarget: true,
    onPick: it ? () => pick(it) : undefined,
    onHover: setHover,
    onDragStart: it ? () => (drag.current = it.h) : undefined,
    onDragEnd: () => (drag.current = null),
    onDrop: it ? () => dropOnItem(it) : onEmptyDrop,
  });

  const pouchStrip = (name: 'gem' | 'ore') => {
    const list = pouch(name);
    const n = Math.max(POUCH_MIN, ...list.map((x) => parseSlot(x.s).index + 1));
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP, width: INV_COLS * (TILE + GAP) }}>
        {Array.from({ length: n }, (_, i) => {
          const it = at(`${name}:${i}`);
          return <Tile key={i} {...tileProps(it, () => dropOnCell(name, i))} title={it ? undefined : name === 'gem' ? 'Gem pouch' : 'Ore pouch'} />;
        })}
      </div>
    );
  };

  return (
    <div
      data-testid="inventory-backdrop"
      className="ls-inv"
      style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(6,5,4,0.35)' }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dropOutside();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useInventory.setState({ socketPick: null });
      }}
    >
      <div
        data-testid="inventory-panel" data-ui-panel
        style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', maxWidth: '97vw', maxHeight: '94vh', overflow: 'auto', boxSizing: 'border-box', background: PANEL_BG, border: `1px solid ${PANEL_BORDER}`, borderRadius: 10, padding: '14px 18px 16px', color: TEXT, font: '14px/1.4 system-ui, sans-serif', boxShadow: '0 12px 40px rgba(0,0,0,0.6)' }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16 }}>
          <div style={{ font: '700 19px system-ui', color: GOLD }}>Inventory</div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
            {!online && <span style={{ color: '#ffb36b' }}>offline</span>}
            {inv?.persist === 'local' && <span title="A local profile: items it drops are unverified">local profile</span>}
            <span>
              I / Esc close · G drop · drag out to drop
            </span>
            <button onClick={() => setInventoryOpen(false)}>Close</button>
          </div>
        </div>
        {!inv && <div style={{ marginTop: 10, opacity: 0.7 }}>{online ? 'Waiting for the zone…' : 'Your pack is empty (offline). Connect to a zone to see your items.'}</div>}
        <div style={{ display: 'flex', gap: 18, marginTop: 6, alignItems: 'flex-start' }}>
          {/* Equipment */}
          <div style={{ width: 196 }}>
            <Section title="Equipment">
              {EQ_SLOTS.map((slot) => {
                const it = at(slot);
                return (
                  <div key={slot} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Tile {...tileProps(it, () => dropOnEq(slot))} onDrop={() => dropOnEq(slot)} />
                    <div style={{ fontSize: 11, lineHeight: 1.25, minWidth: 0 }}>
                      <div style={{ opacity: 0.6 }}>{EQ_LABEL[slot]}</div>
                      {it ? (
                        <div className={isHolo(it.r) ? 'ls-holo-text' : undefined} style={{ color: rarityColor(it.r), fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 134 }}>
                          {displayName(it)}
                        </div>
                      ) : slot === 'eq:main0' || slot === 'eq:main1' ? (
                        <TrainingWeapon loadout={slot === 'eq:main0' ? 0 : 1} />
                      ) : (
                        <div style={{ opacity: 0.4 }}>empty</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </Section>
            <Section title="Purse">
              <div data-testid="inv-gold" style={{ display: 'flex', alignItems: 'center', gap: 6, font: '700 16px system-ui', color: '#f0c048' }}>
                <ItemIcon itemKey="currency:gold" size={24} />
                {(inv?.gold ?? 0).toLocaleString('en-US')} <span style={{ font: '12px system-ui', opacity: 0.7, color: TEXT }}>gold</span>
              </div>
            </Section>
          </div>
          {/* Bag and pouches */}
          <div>
            <Section title="Bag" right={<span style={{ opacity: 0.6, textTransform: 'none' }}>{pouch('inv').length} / {INV_SLOTS}</span>}>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${INV_COLS}, ${TILE}px)`, gap: GAP }}>
                {Array.from({ length: INV_SLOTS }, (_, i) => (
                  <Tile key={i} {...tileProps(at(`inv:${i}`), () => dropOnCell('inv', i))} />
                ))}
              </div>
            </Section>
            <Section title="Gem pouch" right={socketPick ? <span style={{ color: '#9fe6ff', textTransform: 'none' }}>Click a gem to socket it · click outside to cancel</span> : undefined}>
              {pouchStrip('gem')}
            </Section>
            <Section title="Ore pouch">{pouchStrip('ore')}</Section>
          </div>
          {/* Card and actions */}
          <div style={{ width: 290, minHeight: 300, borderLeft: '1px solid #ffffff18', paddingLeft: 16 }}>
            <Section title={shown && shown !== sel ? 'Item' : 'Selected'}>
              {shown ? <ItemCard item={shown} quick={inv?.quick} /> : <div style={{ opacity: 0.55, fontSize: 13 }}>Hover an item to inspect it; click to select it.</div>}
            </Section>
            {sel && <ItemActions item={sel} quick={inv?.quick ?? ''} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Playtest 2: an empty main hand wields the loadout's training weapon. Say
 * which, and offer the default (the starter sword) when an older zone or a
 * stale save left another training weapon there.
 */
function TrainingWeapon({ loadout }: { loadout: number }) {
  const act = useActions();
  const wielded = useCombatHud((s) => s.loadouts[loadout]?.weapon) ?? defaultWeapon(loadout);
  const def = defaultWeapon(loadout);
  return (
    <div data-testid={`inv-training-${loadout}`}>
      <div style={{ opacity: 0.75 }} title="Unequip a weapon to fight with this one">
        {trainingWeaponName(wielded)}
        {wielded === def ? ' (default)' : ''}
      </div>
      {wielded !== def && (
        <button data-act={`training${loadout}`} style={{ marginTop: 3, fontSize: 11 }} onClick={() => act((a) => a.trainingWeapon?.(loadout, def))}>
          Use {trainingWeaponName(def)}
        </button>
      )}
    </div>
  );
}

function ItemActions({ item, quick }: { item: WireItem; quick: string }) {
  const act = useActions();
  const def = itemDef(item.b);
  const eq = isEquipped(item);
  const send = (action: number, arg = 0) => act((a) => a.item(item.h, action, arg));
  const buttons: ReactNode[] = [];
  const b = (key: string, label: string, onClick: () => void, extra: { danger?: boolean; disabled?: boolean; title?: string } = {}) =>
    buttons.push(
      <button key={key} data-act={key} className={extra.danger ? 'ls-danger' : undefined} disabled={extra.disabled} title={extra.title} onClick={onClick}>
        {label}
      </button>,
    );
  if (eq && (item.s === 'eq:main0' || item.s === 'eq:main1')) {
    const lo = item.s === 'eq:main0' ? 0 : 1;
    b('unequip', `Unequip · use ${trainingWeaponName(defaultWeapon(lo))}`, () => send(ITEM_ACT.unequip, lo), { title: 'Back to your starting weapon; this one goes to the bag' });
  } else if (eq) b('unequip', 'Unequip', () => send(ITEM_ACT.unequip, EQ_SLOTS.indexOf(item.s as EqSlot)));
  else if (isWeapon(item)) {
    b('equip1', 'Equip · Loadout 1', () => send(ITEM_ACT.equip, 0));
    b('equip2', 'Equip · Loadout 2', () => send(ITEM_ACT.equip, 1));
  } else if (isArmor(item)) b('equip', 'Equip', () => send(ITEM_ACT.equip, 0));
  if (isConsumable(item)) {
    b('use', 'Use', () => send(ITEM_ACT.use));
    b('quick', quick === item.b ? 'Drink key ✓' : 'Set as drink', () => send(ITEM_ACT.quick), { disabled: quick === item.b, title: 'The drink key (R) uses this' });
  } else if (def?.kind === 'tome') b('use', 'Learn', () => send(ITEM_ACT.use));
  else if (def?.kind === 'ammo') b('use', 'Use arrows', () => send(ITEM_ACT.use));
  const ins = instrumentItem(item.b);
  if (ins)
    b('play', 'Play (U)', () => {
      setInventoryOpen(false);
      enterPlay(ins.id); // CR 028: the keyboard becomes the instrument (ui/music)
    });
  if (isWeapon(item) && (item.k ?? []).some((g) => !g)) {
    const i = (item.k ?? []).findIndex((g) => !g);
    b('socket', 'Socket a gem', () => useInventory.setState({ socketPick: { weapon: item.h, socket: i } }));
  }
  (item.k ?? []).forEach((g, i) => {
    if (g) b(`unsocket${i}`, `Unsocket ${baseName(g).split(' ').pop()}`, () => send(ITEM_ACT.unsocket, i), { title: 'Kept at a town forge or anvil, destroyed elsewhere' });
  });
  if (isGem(item) && !item.b.endsWith(':brilliant')) b('combine', 'Combine 3', () => send(ITEM_ACT.combine), { disabled: item.q < 3, title: 'Three of a cut make the next, at a waypoint' });
  if (item.s !== 'purse') {
    b('drop', item.q > 1 ? `Drop all (${item.q})` : 'Drop', () => send(ITEM_ACT.drop, 0), { danger: true });
    if (item.q > 1) b('drop1', 'Drop 1', () => send(ITEM_ACT.drop, 1), { danger: true });
  }
  return (
    <div data-testid="inv-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
      {buttons}
    </div>
  );
}
