// The crafting panel (WP14, spec 8 "smelting, forging, cooking"): opens when
// the zone says a station is open for you (WP20's Event 805 for a town forge
// or anvil, Event 404 for an inn hearth or campfire). Lists the station's
// recipes from contracts/items.yaml with have/need counts from the
// inventory and the blueprint requirement; Craft sends Interact 22/1 with
// the recipe id and the result arrives as 405 (shown at the bottom) + 400.
// Esc or Close hides it (the zone keeps the station open while you stay
// within 7 m).

import { useEffect } from 'react';
import type { RecipeDef } from '@lodestone/contracts';
import { ItemIcon } from './ItemIcon';
import { baseName, displayName, isHolo, rarityColor, recipeGroup, recipesFor, recipeStatus, type WireItem } from './items';
import { closeStation, pushToast, useInventory } from './store';
import { ensureInventoryStyles, GOLD, PANEL_BG, PANEL_BORDER, TEXT } from './styles';
import { isTextTarget } from '../../input/useKeyboard';

const TITLE = { forge: 'The forge', anvil: 'The anvil', cook: 'Cooking fire' } as const;
const SUB = { forge: 'Smelting and forging', anvil: 'Smelting and forging', cook: 'Cooking and brewing' } as const;

export function CraftPanel() {
  const station = useInventory((s) => s.station);
  useEffect(() => {
    ensureInventoryStyles();
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && !isTextTarget(e.target) && useInventory.getState().station) closeStation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!station) return null;
  return <Panel />;
}

function Panel() {
  const station = useInventory((s) => s.station)!;
  const items = useInventory((s) => s.inv?.items ?? EMPTY);
  const actions = useInventory((s) => s.actions);
  const last = useInventory((s) => s.lastCrafted);
  const recipes = recipesFor(station.kind);
  const groups = new Map<string, RecipeDef[]>();
  for (const r of recipes) groups.set(recipeGroup(r), [...(groups.get(recipeGroup(r)) ?? []), r]);
  const craft = (r: RecipeDef) => {
    if (!actions || station.offline) {
      pushToast('warn', '(offline) Connect to a zone to craft');
      return;
    }
    actions.craft(r.id);
  };
  return (
    <div
      data-testid="craft-panel"
      className="ls-inv"
      style={{ position: 'fixed', right: '3%', top: '50%', transform: 'translateY(-50%)', width: 'min(420px, 92vw)', maxHeight: '86vh', overflowY: 'auto', boxSizing: 'border-box', background: PANEL_BG, border: `1px solid ${PANEL_BORDER}`, borderRadius: 10, padding: '14px 16px', color: TEXT, font: '13px/1.4 system-ui, sans-serif', zIndex: 41, boxShadow: '0 12px 40px rgba(0,0,0,0.6)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div>
          <div style={{ font: '700 18px system-ui', color: GOLD }}>{TITLE[station.kind]}</div>
          <div style={{ opacity: 0.7, fontSize: 12 }}>
            {SUB[station.kind]}
            {station.level !== null ? ` · Smithing ${station.level}` : ''}
            {station.offline ? ' · offline' : ''}
          </div>
        </div>
        <button onClick={closeStation}>Close (Esc)</button>
      </div>
      {last && <LastCrafted item={last.item} qty={last.qty} />}
      {[...groups].map(([group, list]) => (
        <div key={group} style={{ marginTop: 12 }}>
          <div style={{ font: '600 12px system-ui', color: GOLD, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{group}</div>
          {list.map((r) => {
            const st = recipeStatus(r, items);
            return (
              <div key={r.key} data-testid={`recipe-${r.key}`} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #ffffff12', opacity: st.canCraft ? 1 : 0.78 }}>
                <div style={{ width: 32, height: 32, flex: 'none', border: '1px solid #3a342a', borderRadius: 6, background: '#1d1915', display: 'grid', placeItems: 'center' }}>
                  <ItemIcon itemKey={r.output} size={26} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {baseName(r.output)}
                    {r.qty > 1 && <span style={{ opacity: 0.7 }}> x{r.qty}</span>}
                    {r.sockets > 0 && <span style={{ opacity: 0.55, fontWeight: 400, fontSize: 12 }}> · {r.sockets} socket{r.sockets > 1 ? 's' : ''}</span>}
                  </div>
                  <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '0 10px' }}>
                    {st.inputs.map((i) => (
                      <span key={i.item} style={{ color: i.have >= i.need ? '#9fd38a' : '#ff8a7a' }}>
                        {Math.min(i.have, 999)}/{i.need} {i.name}
                      </span>
                    ))}
                    {st.blueprint && <span style={{ color: st.blueprint.have ? '#9fc7ff' : '#ff8a7a' }}>{st.blueprint.have ? '✓ ' : '✗ '}{st.blueprint.name}</span>}
                  </div>
                </div>
                <button data-recipe={r.id} disabled={!st.canCraft} onClick={() => craft(r)} title={st.canCraft ? `Craft (recipe ${r.id})` : st.blueprint && !st.blueprint.have ? 'Blueprint required' : 'Missing ingredients'}>
                  Craft
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const EMPTY: WireItem[] = [];

function LastCrafted({ item, qty }: { item: WireItem | null; qty: number }) {
  if (!item) return null;
  const holo = isHolo(item.r);
  return (
    <div data-testid="craft-last" style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 6, background: '#ffffff0c' }}>
      <ItemIcon itemKey={item.b} size={28} />
      <div>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Last crafted</div>
        <div className={holo ? 'ls-holo-text' : undefined} style={{ color: rarityColor(item.r), fontWeight: 700 }}>
          {qty > 1 ? `${qty} x ` : ''}
          {displayName(item)}
        </div>
      </div>
    </div>
  );
}
