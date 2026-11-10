// Combat HUD (WP13): health and mana, the active loadout's weapon and four
// spell slots with cooldown sweeps, drink charges, the boss bar with its
// phase, toasts ("Dodged!", phase changes) and the downed overlay. Health
// and cooldowns are read on the HUD's own rAF (refs, not React state), like
// the debug HUD, so combat never re-renders React per frame.

import { useEffect, useRef } from 'react';
import { COMBAT } from '@lodestone/contracts';
import { localPlayer } from '../state/live';
import { combatRuntime } from './link';
import { useCombatHud } from './store';
import { DownedOverlay } from './DownedOverlay';
import { spellById } from './timeline';
import { netRuntime } from '../net/netStore';
import { useHudHeight } from '../hud/layout';
import { useInventory } from '../ui/inventory/store';
import { loadoutWeaponLabel } from '../ui/inventory/items';

const spellByKey = new Map(COMBAT.spells.map((s) => [s.key, s]));
const KEYS = ['1', '2', '3', '4'];

/** Playtest 1 controls (client/src/combat/README.md "Controls"). */
export const COMBAT_HINT = 'LMB attack (bow: hold to draw) · Wheel select · RMB use selected · Z parry/charge/lower the bow · 1-4 cast · F dodge · Q form · N skills · B build';
const SECONDARY: Record<string, string> = { sword: 'parry', spear: 'charge', bow: 'lower', staff: 'heavy', wand: 'heavy' };
const SELECTED_STYLE: React.CSSProperties = { border: '1px solid #ffd166', boxShadow: '0 0 0 2px rgba(255,209,102,0.55), 0 0 12px rgba(255,209,102,0.45)', transform: 'translateY(-3px)', transition: 'transform 90ms ease-out, box-shadow 90ms' };

function RmbBadge() {
  return (
    <div data-testid="rmb-badge" style={{ position: 'absolute', top: -9, right: -6, padding: '0 4px', borderRadius: 3, background: '#ffd166', color: '#1a1408', font: '700 9px/13px system-ui, sans-serif', letterSpacing: 0.3, pointerEvents: 'none' }}>
      RMB
    </div>
  );
}

function Bar({ id, color, width, label }: { id: string; color: string; width: number; label?: React.ReactNode }) {
  return (
    <div style={{ position: 'relative', width, height: 13, background: 'rgba(0,0,0,0.55)', borderRadius: 3, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.25)' }}>
      <div data-bar={id} style={{ width: '100%', height: '100%', background: color, transformOrigin: 'left', transition: 'transform 80ms linear' }} />
      {label && <div style={{ position: 'absolute', inset: 0, textAlign: 'center', font: '600 10px/13px system-ui, sans-serif', textShadow: '0 1px 2px #000' }}>{label}</div>}
    </div>
  );
}

export function CombatHud() {
  const active = useCombatHud((s) => s.active);
  const loadouts = useCombatHud((s) => s.loadouts);
  const activeLoadout = useCombatHud((s) => s.activeLoadout);
  const boss = useCombatHud((s) => s.boss);
  const toastMsg = useCombatHud((s) => s.toast);
  const charges = useCombatHud((s) => s.charges);
  const selected = useCombatHud((s) => s.selected);
  const invItems = useInventory((s) => s.inv?.items);
  const root = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  useHudHeight(stack, '--ls-hotbar-h', active);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = root.current;
      const rt = combatRuntime.current;
      const s = netRuntime.session;
      if (!el || !rt) return;
      const self = s?.latestFrame?.self;
      const hp = self ? self.health / Math.max(1, self.healthMax) : 1;
      const mana = rt.timeline.mana / Math.max(1, rt.timeline.manaMax);
      const set = (id: string, k: number) => {
        const b = el.querySelector<HTMLDivElement>(`[data-bar="${id}"]`);
        if (b) b.style.transform = `scaleX(${Math.max(0, Math.min(1, k))})`;
      };
      set('hp', hp);
      set('mana', mana);
      const txt = el.querySelector<HTMLSpanElement>('[data-hp]');
      if (txt && self) txt.textContent = `${self.health} / ${self.healthMax}`;
      const lo = rt.timeline.loadout;
      lo.spells.forEach((k, i) => {
        const sp = k ? spellByKey.get(k) : undefined;
        const cd = el.querySelector<HTMLDivElement>(`[data-cd="${i}"]`);
        if (!cd) return;
        const left = sp ? rt.timeline.cooldownLeft(sp.id) : 0;
        const total = sp ? Math.max(1, rt.timeline.cooldownSteps(sp.cooldownSteps)) : 1;
        cd.style.height = `${(left / total) * 100}%`;
      });
      void localPlayer;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  if (!active) return null;
  const lo = loadouts[activeLoadout];
  const now = performance.now();
  return (
    <div ref={root} data-testid="combat-hud" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 12, font: '13px system-ui, sans-serif', color: '#e9ecef' }}>
      {boss && (
        <div data-testid="boss-bar" style={{ position: 'absolute', top: 54, left: '50%', transform: 'translateX(-50%)', width: 520, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600, textShadow: '0 0 4px #000' }}>
            {boss.name} <span style={{ opacity: 0.7, fontWeight: 400 }}>· phase {boss.phase}/{boss.phases}</span>
          </div>
          <div style={{ height: 12, background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
            <div style={{ width: `${boss.pct}%`, height: '100%', background: 'linear-gradient(#ff5a4a, #b01e14)' }} />
          </div>
        </div>
      )}
      {/* Playtest 1 layout (hud/layout.ts): one centre stack at the bottom, measured into --ls-hotbar-h so the lock hint, chat and voice stack around it. */}
      <div ref={stack} data-testid="combat-stack" style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, maxWidth: 'calc(2 * var(--ls-center-half, 260px))', width: 'max-content', paddingTop: 10 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <div data-testid="slot-weapon" data-selected={selected < 0 ? 'true' : 'false'} style={{ position: 'relative', padding: '6px 10px', background: 'rgba(8,10,16,0.6)', borderRadius: 4, minWidth: 74, textAlign: 'center', boxSizing: 'border-box', ...(selected < 0 ? SELECTED_STYLE : { border: '1px solid transparent' }) }} title="X swaps loadouts · Z (or right mouse while selected): parry / draw / charge / heavy">
            {selected < 0 && <RmbBadge />}
            <div data-testid="weapon-name" style={{ fontWeight: 600, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lo ? loadoutWeaponLabel(lo.weapon, activeLoadout, invItems) : '-'}</div>
            <div style={{ opacity: 0.6, fontSize: 11 }}>{SECONDARY[lo?.weapon ?? ''] ?? 'secondary'} · Z</div>
          </div>
          {(lo?.spells ?? []).map((k, i) => {
            const sp = k ? spellByKey.get(k) : undefined;
            const sel = selected === i && !!sp;
            return (
              <div key={i} data-testid={`slot-spell-${i}`} data-selected={sel ? 'true' : 'false'} style={{ position: 'relative', width: 66, height: 46, background: 'rgba(8,10,16,0.6)', border: `1px solid ${sp?.color ?? 'rgba(255,255,255,0.15)'}`, borderRadius: 4, padding: 3, boxSizing: 'border-box', ...(sel ? SELECTED_STYLE : {}) }}>
                <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 4 }}>
                  <div data-cd={i} style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: 0, background: 'rgba(0,0,0,0.6)' }} />
                </div>
                {sel && <RmbBadge />}
                <div style={{ position: 'relative', fontSize: 10, opacity: 0.6 }}>{KEYS[i]}</div>
                <div style={{ position: 'relative', fontSize: 11, lineHeight: '12px' }}>{sp?.name ?? ''}</div>
              </div>
            );
          })}
          <div style={{ padding: '6px 10px', background: 'rgba(8,10,16,0.6)', borderRadius: 4, textAlign: 'center' }} title="R drinks a healing draught">
            <div style={{ fontWeight: 600 }}>{charges}</div>
            <div style={{ opacity: 0.6, fontSize: 11 }}>draught · R</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Bar id="hp" color="linear-gradient(#e05050, #a02020)" width={250} label={<span data-hp />} />
          <Bar id="mana" color="linear-gradient(#5aa0ff, #2050c0)" width={170} />
        </div>
        <div data-testid="combat-hint" style={{ opacity: 0.6, fontSize: 11, lineHeight: '14px', textAlign: 'center', textShadow: '0 1px 2px #000' }}>{COMBAT_HINT}</div>
      </div>
      {toastMsg && now - toastMsg.at < 1500 && (
        <div key={toastMsg.at} style={{ position: 'absolute', top: '38%', left: '50%', transform: 'translateX(-50%)', fontSize: 20, fontWeight: 700, textShadow: '0 0 6px #000' }}>
          {toastMsg.text}
        </div>
      )}
      <DownedOverlay />
    </div>
  );
}

void spellById;
