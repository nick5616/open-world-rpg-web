// Town interaction HUD (WP20): the "[E] Talk to Mira (blacksmith)" prompt,
// the conversation / shop / bounty / station panel and toasts, as a DOM
// overlay like the cave HUD. Online every action is an Interact to the zone
// (targetKind 30 npc, 31 board, 32 station, 33 shaft; contracts/events.md)
// and the panel fills from its Events 800-807; offline (solo) the prompt
// works the same and the panel shows a local "(offline)" line from the
// towns buffer, so the flow can be seen without servers.
//
// While a panel is open the pointer lock is released so its buttons can be
// clicked (same rule as the map screen: client/src/ui/map/README.md); a
// click on the canvas takes the lock back. Esc or E closes it.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import type { ZoneSession } from '../../net/zoneSession';
import { netRuntime } from '../../net/netStore';
import { promptFor, type Candidate } from './interact';
import { escapeHtml } from './npcs';
import { openStationOffline } from '../../ui/inventory/store'; // WP14
// Playtest 1: bounty locations and map previews.
import { localPlayer } from '../../state/live';
import { isTextTarget } from '../../input/useKeyboard';
import { eFree } from '../../input/interact';
import { hidePanel, syncPanel } from '../../input/panelStack';
import { useMapWorld } from '../../ui/map/world';
import { setMapOpen } from '../../ui/map/store';
import { setQuestPreview } from '../../ui/quests/store';
import { whereText, type QuestMarker } from '../../ui/quests/events';
import { ACT, BOUNTY_KIND_LABEL, decodeBounties, decodeShop, EV, INTERACT, itemName, MERCHANT_LABEL, NPC_ROLE_LABEL, REFUSAL, utf8, type Bounty, type ShopItem } from './townEvents';

interface PanelState {
  title: string;
  sub: string;
  line: string;
  /** NPC panels: the entity talked to (online). */
  npcEntityId: number | null;
  role: number;
  shop: ShopItem[] | null;
  bounties: { list: Bounty[]; board: bigint | null; keeper: number | null } | null;
  station: string | null;
  canRest: boolean;
  offline: boolean;
}

const OFFLINE_LINES: Record<number, string[]> = {
  0: ['Fine day for a walk, traveller.', 'Mind the road after dark. The demons keep to the wilds, mostly.', 'The well water is the sweetest this side of the hills.'],
  1: ['Have a look, have a look! Fair prices for fair folk.', 'Fresh stock this morning, straight off the cart.'],
  2: ['Bring me ore and I will make it worth carrying.', 'Careful, the forge bites.'],
  3: ['A warm bed and a hot meal: that is all anyone needs.', 'Rest a while, the road will keep.'],
  4: ['The board is full again. Folk need brave hands.', 'Bandits to the north, a demon by the mill... take your pick.'],
  5: ['The barley is coming in nicely this year.', 'Crows again. Always the crows.'],
  6: ['Keep the peace and we will get along.', 'Move along, nothing to see.'],
};

/**
 * Playtest 1: where a board job takes you (distance and direction from
 * here) and its map marker: the target site's area, or for a delivery the
 * board itself. Null when the atlas isn't loaded.
 */
function bountyPlace(b: Bounty, board: Candidate | null): { text: string; marker: QuestMarker } | null {
  const px = localPlayer.pos.x;
  const pz = localPlayer.pos.z;
  if (b.site >= 0) {
    const site = useMapWorld.getState().data?.sites[b.site];
    if (!site) return null;
    const marker: QuestMarker = { x: site.x, z: site.z, r: Math.max(30, site.radius + 10), label: site.name ?? 'Bounty target' };
    return { text: `${site.name ?? 'Target'}: ${whereText(px, pz, marker)}`, marker };
  }
  if (b.kind === 1) {
    // A delivery is handed in where you read it (this board, or the keeper beside it).
    const marker: QuestMarker = { x: board?.x ?? px, z: board?.z ?? pz, label: 'Hand in at this board' };
    return { text: 'Hand in here, at this town\'s bounty board', marker };
  }
  return null;
}

const hashStr = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export class TownHud {
  target: Candidate | null = null;
  private panel: PanelState | null = null;
  private pending: Candidate | null = null;
  private readonly prompt: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private readonly panelEl: HTMLDivElement;
  private toasts: { text: string; until: number }[] = [];
  private hooked: ZoneSession | null = null;
  private readonly listener = (e: ZoneEvent) => this.onEvent(e);
  /** Last action (headless scripts check what E did). */
  lastAction: string | null = null;
  /** E on a door (TownsManager: DoorSync.toggle; Interact 34 online, local offline). */
  doorAct: ((door: number) => void) | null = null;

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.repeat || isTextTarget(e.target)) return; // typing in chat: E is the text box's
    if (e.code !== 'KeyE') return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    if (this.panel) this.close();
    else if (this.target && eFree('town')) this.act(this.target); // not in the saddle or under a panel (input/interact.ts)
  };

  private readonly onClick = (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const b0 = b;
    const a = b.dataset.act;
    const s = this.session();
    const p = this.panel;
    if (a === 'close') this.close();
    else if (a === 'preview' && p?.bounties) {
      // Playtest 1: show where the job is on the map before accepting.
      const b = p.bounties.list.find((x) => x.id === Number(b0.dataset.arg));
      const where = b ? bountyPlace(b, this.pending) : null;
      if (b && where) {
        setQuestPreview({ title: b.text, markers: [where.marker], from: 'bounty' });
        setMapOpen(true);
      }
    } else if (!s || !p) this.toast('(offline) Connect to a zone to trade and take bounties');
    else if (a === 'buy' && p.npcEntityId !== null) {
      s.sendInteract(INTERACT.npc, BigInt(p.npcEntityId), ACT.buy, Number(b.dataset.arg));
      this.lastAction = `buy ${b.dataset.arg}`;
    } else if (a === 'accept' && p.bounties) {
      const id = Number(b.dataset.arg);
      if (p.bounties.board !== null) s.sendInteract(INTERACT.board, p.bounties.board, ACT.acceptFromBoard, id);
      else if (p.bounties.keeper !== null) s.sendInteract(INTERACT.npc, BigInt(p.bounties.keeper), ACT.acceptFromKeeper, id);
      this.lastAction = `accept ${id}`;
    } else if (a === 'rest' && p.npcEntityId !== null) {
      s.sendInteract(INTERACT.npc, BigInt(p.npcEntityId), ACT.rest, 0);
      this.lastAction = 'rest';
    }
  };

  constructor() {
    this.prompt = document.createElement('div');
    this.prompt.dataset.testid = 'town-prompt';
    Object.assign(this.prompt.style, { position: 'fixed', left: '50%', top: '60%', transform: 'translateX(-50%)', color: '#f4efe2', font: '14px system-ui, sans-serif', textShadow: '0 1px 2px #000, 0 0 6px #000', pointerEvents: 'none', zIndex: '20', textAlign: 'center', whiteSpace: 'pre-line' });
    this.toastEl = document.createElement('div');
    this.toastEl.dataset.testid = 'town-toast';
    Object.assign(this.toastEl.style, { position: 'fixed', left: '50%', top: '18%', transform: 'translateX(-50%)', color: '#ffe9b0', font: '600 15px system-ui, sans-serif', textShadow: '0 1px 3px #000', pointerEvents: 'none', zIndex: '21', textAlign: 'center' });
    this.panelEl = document.createElement('div');
    this.panelEl.dataset.testid = 'town-panel';
    this.panelEl.dataset.uiPanel = ''; // hides the pointer-lock hint while open (hud/layout.ts)
    Object.assign(this.panelEl.style, {
      position: 'fixed',
      right: '4%',
      top: '50%',
      transform: 'translateY(-50%)',
      width: 'min(380px, 86vw)',
      maxHeight: '70vh',
      overflowY: 'auto',
      background: 'rgba(24,20,16,0.88)',
      border: '1px solid rgba(232,196,106,0.55)',
      borderRadius: '8px',
      padding: '14px 16px',
      color: '#efe6d2',
      font: '14px/1.4 system-ui, sans-serif',
      zIndex: '30',
      display: 'none',
      boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
    });
    document.body.append(this.prompt, this.toastEl, this.panelEl);
    window.addEventListener('keydown', this.onKey);
    this.panelEl.addEventListener('click', this.onClick);
  }

  get panelOpen(): boolean {
    return this.panel !== null;
  }

  private session(): ZoneSession | null {
    const s = netRuntime.session;
    return s && s.phase === 'playing' ? s : null;
  }

  /** Per frame: the current target (picked by the manager), session hook, prompt and toasts. */
  update(target: Candidate | null): void {
    this.target = target;
    const s = netRuntime.session;
    if (s && s !== this.hooked) {
      this.hooked?.eventListeners.delete(this.listener);
      s.eventListeners.add(this.listener);
      this.hooked = s;
    }
    const text = !this.panel && target && eFree('town') ? promptFor(target, (r) => NPC_ROLE_LABEL[r] ?? 'villager') : '';
    if (this.prompt.textContent !== text) this.prompt.textContent = text;
    const now = performance.now();
    if (this.toasts.length) {
      this.toasts = this.toasts.filter((t) => t.until > now);
      const tt = this.toasts.map((t) => t.text).join('  ·  ');
      if (this.toastEl.textContent !== tt) this.toastEl.textContent = tt;
    } else if (this.toastEl.textContent) this.toastEl.textContent = '';
  }

  toast(text: string): void {
    this.toasts.push({ text, until: performance.now() + 3000 });
  }

  /** E on a target: Interact online, a local line offline. */
  act(c: Candidate): void {
    if (c.kind === 'sign') return;
    if (c.kind === 'door') {
      this.doorAct?.(c.index);
      this.lastAction = `door ${c.index} ${c.role === 1 ? 'close' : 'open'}`;
      return;
    }
    const s = this.session();
    this.pending = c;
    if (s) {
      switch (c.kind) {
        case 'npc':
          if (c.entityId === null) break;
          s.sendInteract(INTERACT.npc, BigInt(c.entityId), ACT.talk, 0);
          this.open(this.npcPanel(c, '...', false));
          break;
        case 'board':
          s.sendInteract(INTERACT.board, c.stableId, ACT.read, 0);
          this.open({ ...this.blank('Bounty board', 'Notices pinned in the square'), line: 'Reading the notices...' });
          break;
        case 'forge':
        case 'anvil':
          s.sendInteract(INTERACT.station, c.stableId, ACT.use, 0);
          break;
        case 'shaft':
          s.sendInteract(INTERACT.shaft, c.stableId, ACT.descend, 0);
          this.toast('You take hold of the winch rope...');
          break;
      }
      this.lastAction = `${c.kind} ${c.entityId ?? c.stableId}`;
      return;
    }
    // Offline: the same flow with local lines.
    this.lastAction = `offline ${c.kind}`;
    switch (c.kind) {
      case 'npc': {
        const lines = OFFLINE_LINES[c.role] ?? OFFLINE_LINES[0];
        const p = this.npcPanel(c, `${lines[hashStr(c.name) % lines.length]}`, true);
        if (c.role === 1) p.station = `(offline) ${c.name} sells ${MERCHANT_LABEL[c.merchant] ?? 'goods'}. Connect to a zone to see the wares.`;
        if (c.role === 4) p.station = '(offline) Connect to a zone to see today\'s bounties.';
        if (c.role === 3) p.station = '(offline) Connect to a zone to rest at the inn.';
        this.open(p);
        break;
      }
      case 'board':
        this.open({ ...this.blank('Bounty board', 'Notices pinned in the square'), line: '(offline) The board is covered in notices: bandits, deliveries, a demon by the mill. Connect to a zone to see and accept today\'s bounties.', offline: true });
        break;
      case 'forge':
      case 'anvil':
        openStationOffline(c.kind); // WP14: the smithing panel, crafting disabled offline
        break;
      case 'shaft':
        this.open({ ...this.blank('Old mineshaft', 'A rope winch over the shaft'), line: c.index >= 0 ? '(offline) The rope drops into darkness. Connect to a zone to descend into the cave below.' : '(offline) The shaft is choked with rubble.', offline: true });
        break;
    }
  }

  private blank(title: string, sub: string): PanelState {
    return { title, sub, line: '', npcEntityId: null, role: -1, shop: null, bounties: null, station: null, canRest: false, offline: false };
  }

  private npcPanel(c: Candidate, line: string, offline: boolean): PanelState {
    const role = NPC_ROLE_LABEL[c.role] ?? 'villager';
    const sub = c.role === 1 ? `${role}, ${MERCHANT_LABEL[c.merchant] ?? 'goods'}` : role;
    return { ...this.blank(c.name || 'Villager', sub), line: offline ? `(offline) "${line}"` : line, npcEntityId: c.entityId, role: c.role, offline };
  }

  private open(p: PanelState): void {
    this.panel = p;
    syncPanel('town', true, () => this.close()); // Esc closes it when it is the top panel (input/panelStack.ts)
    if (document.pointerLockElement) document.exitPointerLock();
    this.render();
  }

  close(): void {
    this.panel = null;
    hidePanel('town');
    this.pending = null;
    this.panelEl.style.display = 'none';
  }

  private render(): void {
    const p = this.panel;
    if (!p) return;
    const btn = (act: string, arg: number | string, label: string, disabled = false) => `<button data-act="${act}" data-arg="${arg}" ${disabled ? 'disabled' : ''} style="font:600 12px system-ui;padding:3px 10px;border-radius:4px;border:1px solid #c9a650;background:${disabled ? '#3a342a' : '#5a4626'};color:#f6e7c0;cursor:${disabled ? 'default' : 'pointer'}">${label}</button>`;
    let h = `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><div><div style="font:600 17px system-ui;color:#f3d48a">${escapeHtml(p.title)}</div><div style="opacity:.7;font-size:12px">${escapeHtml(p.sub)}</div></div>${btn('close', 0, 'Close (Esc)')}</div>`;
    if (p.line) h += `<p style="margin:10px 0 6px;font-style:italic">${escapeHtml(p.line)}</p>`;
    if (p.shop) {
      h += `<div style="margin-top:8px;font-weight:600;color:#f3d48a">Wares</div>`;
      if (!p.shop.length) h += '<div style="opacity:.7">Nothing for sale today.</div>';
      for (const it of p.shop) h += `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #ffffff14"><span>${escapeHtml(itemName(it.item))} <span style="opacity:.6">${it.stock} in stock</span>${it.item.startsWith('blueprint:') ? '<div style="opacity:.6;font-size:11px">Teaches the forge recipe; not the item itself</div>' : ''}</span><span>${it.price} g ${btn('buy', it.index, 'Buy', it.stock === 0)}</span></div>`;
    }
    if (p.bounties) {
      h += `<div style="margin-top:8px;font-weight:600;color:#f3d48a">Bounties</div>`;
      if (!p.bounties.list.length) h += '<div style="opacity:.7">No bounties today.</div>';
      for (const b of p.bounties.list) {
        // Playtest 1: where the job takes you, before you accept (and a map preview).
        const where = bountyPlace(b, this.pending);
        const state = b.done ? '<span style="color:#9fd38a">Completed</span>' : b.accepted ? '<span style="color:#9fd38a">Accepted</span>' : btn('accept', b.id, 'Accept');
        h += `<div data-bounty="${b.id}" style="padding:5px 0;border-bottom:1px solid #ffffff14"><div><b>${BOUNTY_KIND_LABEL[b.kind] ?? 'Job'}</b>: ${escapeHtml(b.text)}</div>`;
        if (where) h += `<div data-testid="bounty-where" style="display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:12px;color:#d9c79c;margin:2px 0"><span>&#9673; ${escapeHtml(where.text)}</span>${btn('preview', b.id, 'Show on map')}</div>`;
        h += `<div style="display:flex;justify-content:space-between;align-items:center;opacity:.9"><span>Reward ${b.reward} g${b.qty > 1 ? ` · x${b.qty}` : ''}</span>${state}</div></div>`;
      }
    }
    if (p.canRest) h += `<div style="margin-top:10px">${btn('rest', 0, 'Rest at the inn')}</div>`;
    if (p.station) h += `<p style="margin:10px 0 0;opacity:.9">${escapeHtml(p.station)}</p>`;
    this.panelEl.innerHTML = h;
    this.panelEl.style.display = 'block';
  }

  /** Zone events 800-807 (contracts/events.md). */
  private onEvent(e: ZoneEvent): void {
    if (e.kind < 800 || e.kind > 899) return;
    try {
      switch (e.kind) {
        case EV.npcSay: {
          const line = utf8(e.data);
          const c = this.pending && this.pending.kind === 'npc' && this.pending.entityId === e.entityId ? this.pending : null;
          const base = this.panel && this.panel.npcEntityId === e.entityId ? this.panel : this.npcPanel(c ?? { kind: 'npc', x: 0, y: 0, z: 0, entityId: e.entityId, stableId: 0n, index: -1, name: 'Villager', role: e.targetId, merchant: 255, settlement: -1 }, line, false);
          base.line = e.value === 1 ? line : `${line} (closed for the night)`;
          base.role = e.targetId;
          base.canRest = e.targetId === 3 && e.value === 1;
          this.open(base);
          break;
        }
        case EV.shop: {
          const items = decodeShop(e.data);
          if (this.panel && this.panel.npcEntityId === e.entityId) {
            this.panel.shop = items;
            this.render();
          } else {
            this.open({ ...this.blank('Merchant', MERCHANT_LABEL[e.value] ?? 'goods'), npcEntityId: e.entityId, shop: items });
          }
          break;
        }
        case EV.bounties: {
          const list = decodeBounties(e.data);
          const fromBoard = e.entityId === 0;
          const board = fromBoard && this.pending?.kind === 'board' ? this.pending.stableId : null;
          const state = { list, board: fromBoard ? (board ?? this.pending?.stableId ?? null) : null, keeper: fromBoard ? null : e.entityId };
          if (this.panel && (fromBoard ? this.panel.title === 'Bounty board' : this.panel.npcEntityId === e.entityId)) {
            this.panel.bounties = state;
            if (fromBoard) this.panel.line = '';
            this.render();
          } else this.open({ ...this.blank('Bounty board', 'Notices'), bounties: state });
          break;
        }
        case EV.bountyAccepted: {
          this.toast(`Bounty accepted: ${utf8(e.data)} (reward ${e.value} g)`);
          const b = this.panel?.bounties?.list.find((x) => x.id === e.targetId);
          if (b) {
            b.accepted = true;
            this.render();
          }
          break;
        }
        case EV.rested:
          this.toast(`You rest at the inn (+${e.value} health)`);
          break;
        case EV.stationOpened:
          // WP14: the smithing panel (client/src/ui/inventory/CraftPanel.tsx) opens on 805 instead of this placeholder.
          break;
        case EV.refused:
          this.toast(REFUSAL[e.value] ?? `Refused (${e.value})`);
          break;
        case EV.purchase:
          this.toast(`Bought ${e.targetId > 1 ? `${e.targetId} x ` : ''}${itemName(utf8(e.data))} (${e.value} g)`);
          break;
      }
    } catch (err) {
      console.warn('[towns] bad event payload', e.kind, err);
    }
  }

  /** Debug: what the panel shows (headless scripts). */
  debugPanel(): { title: string; line: string; shop: number; bounties: number } | null {
    const p = this.panel;
    return p ? { title: p.title, line: p.line, shop: p.shop?.length ?? 0, bounties: p.bounties?.list.length ?? 0 } : null;
  }

  dispose(): void {
    hidePanel('town');
    window.removeEventListener('keydown', this.onKey);
    this.hooked?.eventListeners.delete(this.listener);
    this.prompt.remove();
    this.toastEl.remove();
    this.panelEl.remove();
  }
}
