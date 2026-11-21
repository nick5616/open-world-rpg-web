// Loot HUD (WP14): item toasts coloured by rarity (401 granted, 403 refused,
// 405 crafted, 408 dropped, 409 boss lockout, 410 gems combined, 411 taken),
// the Bitchin' banner (402, spec 8: "a holographic announcement"), and the
// "[E] Open chest" / "[E] Take Iron Sword" prompt for loot containers (406)
// and dropped items (public pickups) right next to you.
//
// E arbitration: E is shared with WP20's townHud (talk, boards, forges),
// WP09's caveManager (mining) and the playtest 2 features; the order is
// input/interact.ts E_ORDER. This HUD only claims E when a container or
// pickup is within CLAIM_M (2.5 m, closer than the 4 m the others reach for)
// AND nothing above it in that order shows a prompt, no panel is open and
// you are not riding. Its own prompt hides whenever another prompt is up, so
// the screen never offers two E actions.
//
// Renders nothing harmful offline: the prompt still appears for mock
// containers and E answers with an "(offline)" toast.

import { useEffect, useState } from 'react';
import { netRuntime } from '../../net/netStore';
import { localPlayer } from '../../state/live';
import { notGameKey } from '../../input/useKeyboard';
import { eFree } from '../../input/interact';
import { baseName, CONTAINER_LABEL, isHolo, rarityColor } from './items';
import { ensureInventoryHook } from './link';
import { BITCHIN_MS, openStationOffline, pushToast, TOAST_MS, useInventory, type LootToast } from './store';
import { CORNER_BOTTOM_RIGHT } from '../../hud/layout'; // playtest 1: clear of the lifted voice corner
import { worldDebug } from '../../world/debug/worldDebug';
import { ensureInventoryStyles } from './styles';
import { ToastBar } from '../toast/ToastBar';

export const CLAIM_M = 2.5;

export type LootTarget = { kind: 'container'; id: bigint; label: string } | { kind: 'pickup'; id: number; label: string; rarity: number } | { kind: 'cook'; id: bigint; label: string };

// Cooking stations (inn hearths, camp campfires) from the towns buffer, per runtime.
const PROP_HEARTH = 4;
const PROP_CAMPFIRE = 22;
let cookCache: { towns: unknown; list: { id: bigint; x: number; y: number; z: number; kind: number }[] } = { towns: null, list: [] };
function cookStations() {
  const towns = worldDebug.runtime?.towns ?? null;
  if (towns !== cookCache.towns) cookCache = { towns, list: towns ? towns.props.filter((p) => p.kind === PROP_HEARTH || p.kind === PROP_CAMPFIRE).map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, kind: p.kind })) : [] };
  return cookCache.list;
}

/** The nearest container (not yet opened), pickup or cooking station within CLAIM_M of the player's chest. */
export function findLootTarget(): LootTarget | null {
  const p = localPlayer.pos;
  const cx = p.x, cy = p.y + 0.9, cz = p.z;
  let best: LootTarget | null = null;
  let bestD = CLAIM_M;
  for (const c of cookStations()) {
    if (Math.abs(c.x - cx) > CLAIM_M || Math.abs(c.z - cz) > CLAIM_M) continue;
    const d = Math.hypot(c.x - cx, c.y + 0.4 - cy, c.z - cz);
    if (d < bestD) {
      bestD = d;
      best = { kind: 'cook', id: c.id, label: c.kind === PROP_HEARTH ? 'Cook at the hearth' : 'Cook at the campfire' };
    }
  }
  for (const c of useInventory.getState().containers) {
    if (c.opened) continue;
    const d = Math.hypot(c.x - cx, c.y + 0.4 - cy, c.z - cz);
    if (d < bestD) {
      bestD = d;
      best = { kind: 'container', id: c.id, label: CONTAINER_LABEL[c.kind] ?? 'container' };
    }
  }
  const s = netRuntime.session;
  const ents = s && s.phase === 'playing' ? (s.latestFrame?.ents ?? []) : [];
  for (const e of ents) {
    if (e.kind !== 4) continue; // EntityKind.pickup: name = item key, level = qty, typeId = rarity
    const d = Math.hypot(e.x / 100 - cx, e.y / 100 - cy, e.z / 100 - cz);
    if (d < bestD) {
      bestD = d;
      best = { kind: 'pickup', id: e.id, label: `${e.level > 1 ? `${e.level} x ` : ''}${baseName(e.name)}`, rarity: e.typeId };
    }
  }
  return best;
}

// Playtest 2 integration QA: who else wants E (town, cave, a tower crystal),
// an open panel and the saddle are input/interact.ts's call now.
function othersBusy(): boolean {
  return !eFree('loot');
}

function promptText(t: LootTarget): string {
  return t.kind === 'container' ? `[E] Open ${t.label}` : t.kind === 'cook' ? `[E] ${t.label}` : `[E] Take ${t.label}`;
}

export function LootHud() {
  const toasts = useInventory((s) => s.toasts);
  const bitchin = useInventory((s) => s.bitchin);
  const stationOpen = useInventory((s) => !!s.station);
  const [target, setTarget] = useState<LootTarget | null>(null);

  useEffect(() => {
    ensureInventoryStyles();
    let last: LootTarget | null = null;
    const iv = window.setInterval(() => {
      ensureInventoryHook();
      const s = useInventory.getState();
      const t = s.invOpen || s.station || othersBusy() ? null : findLootTarget();
      if (t?.kind !== last?.kind || t?.id !== last?.id || t?.label !== last?.label) {
        last = t;
        setTarget(t);
      }
      // Expire toasts / the banner (playtest 6 polish: they wait while a conversation is open,
      // where a quest's reward items arrive).
      const now = performance.now();
      if (s.toasts.length && document.querySelector('[data-testid="dialog"]')) {
        useInventory.setState({ toasts: s.toasts.map((x) => ({ ...x, at: x.at + 120 })) });
      } else if (s.toasts.some((x) => now - x.at >= TOAST_MS) || (s.bitchin && now - s.bitchin.at >= BITCHIN_MS)) {
        useInventory.setState({ toasts: s.toasts.filter((x) => now - x.at < TOAST_MS), bitchin: s.bitchin && now - s.bitchin.at < BITCHIN_MS ? s.bitchin : null });
      }
    }, 120);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyE' || e.repeat || notGameKey(e)) return;
      const s = useInventory.getState();
      if (s.invOpen || s.station || othersBusy()) return;
      const t = findLootTarget();
      if (!t) return;
      e.stopImmediatePropagation(); // one press, one thing (input/interact.ts)
      if (t.kind === 'cook') {
        // Online the zone answers with Event 404 (the panel opens then); offline the panel opens with crafting disabled.
        if (s.actions) s.actions.openCook(t.id);
        else openStationOffline('cook');
        return;
      }
      if (!s.actions) {
        pushToast('warn', `(offline) Connect to a zone to ${t.kind === 'container' ? 'open containers' : 'take items'}`);
        return;
      }
      if (t.kind === 'container') s.actions.openContainer(t.id);
      else s.actions.takePickup(t.id);
    };
    // Capture phase: decide on the state before townHud / caveManager react to the same key.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  return (
    <>
      {target && (
        <div data-testid="loot-prompt" style={{ position: 'fixed', left: '50%', top: '62%', transform: 'translateX(-50%)', color: '#f4efe2', font: '14px system-ui, sans-serif', textShadow: '0 1px 2px #000, 0 0 6px #000', pointerEvents: 'none', zIndex: 20 }}>
          {target.kind === 'pickup' ? (
            <>
              [E] Take <span className={isHolo(target.rarity) ? 'ls-holo-text' : undefined} style={{ color: rarityColor(target.rarity), fontWeight: 700 }}>{target.label}</span>
            </>
          ) : (
            promptText(target)
          )}
        </div>
      )}
      {toasts.length > 0 && (
        <div data-testid="loot-toasts" style={{ position: 'fixed', right: stationOpen ? 'calc(3% + min(420px, 92vw) + 14px)' : 18, bottom: `max(24%, calc(${CORNER_BOTTOM_RIGHT} + 96px))`, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', pointerEvents: 'none', zIndex: 22 }}>
          {toasts.map((t) => (
            <Toast key={t.id} t={t} />
          ))}
        </div>
      )}
      {bitchin && <Banner key={bitchin.at} text={bitchin.text} />}
    </>
  );
}

function Toast({ t }: { t: LootToast }) {
  const color = t.kind === 'warn' ? '#ff9a7a' : (t.color ?? '#ffe9b0');
  return (
    <div className="ls-toast ls-timed" style={{ position: 'relative', overflow: 'hidden', background: 'rgba(16,14,12,0.82)', borderLeft: `3px solid ${t.holo ? '#ff6be6' : color}`, borderRadius: 4, padding: '5px 12px 5px 10px', font: '600 14px system-ui, sans-serif', color: '#efe6d2', textShadow: '0 1px 2px #000', maxWidth: 360 }}>
      <span className={t.holo ? 'ls-holo-text' : undefined} style={{ color }}>
        {t.text}
      </span>
      {t.detail && <span style={{ opacity: 0.6, fontWeight: 400, fontSize: 12 }}> · {t.detail}</span>}
      <ToastBar at={t.at} durationMs={TOAST_MS} color={color} />
    </div>
  );
}

function Banner({ text }: { text: string }) {
  return (
    <div data-testid="bitchin-banner" className="ls-banner" style={{ position: 'fixed', left: '50%', top: '13%', transform: 'translateX(-50%)', zIndex: 45, pointerEvents: 'none', textAlign: 'center', ['--ls-banner-ms' as string]: `${BITCHIN_MS}ms`, width: 'min(92vw, 980px)' }}>
      <div className="ls-holo-bar" style={{ height: 3, borderRadius: 2, margin: '0 auto 10px', width: '70%', opacity: 0.9 }} />
      <div className="ls-holo-text ls-banner-text" style={{ font: '900 46px/1.1 system-ui, sans-serif', letterSpacing: 1, textTransform: 'uppercase' }}>
        Bitchin&apos;!
      </div>
      <div className="ls-holo-text ls-banner-text" style={{ font: '800 22px/1.3 system-ui, sans-serif', marginTop: 6 }}>
        {text}
      </div>
      <div className="ls-holo-bar" style={{ height: 3, borderRadius: 2, margin: '10px auto 0', width: '70%', opacity: 0.9 }} />
    </div>
  );
}
