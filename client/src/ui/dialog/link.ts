// The conversation controller (CR 049): E on a person opens it (Interact 180
// action 1), choices go out as action 2, closing as action 3; the zone's
// Events 1910-1913 fill the store. It also keeps the world in step with the
// store: the camera frames the face, the mouse is free and you stand still
// while it is open, the person turns to you and talks (npcFocus), and a
// service you pick (shop, board) opens in its usual panel while the
// conversation waits.
//
// Offline (solo, no zone) there is a small local conversation so the flow
// can still be seen.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { npcFocus } from '../../world/buildings/npcFocus';
import type { Candidate } from '../../world/buildings/interact';
import { localPlayer } from '../../state/live';
import { lookRouter } from '../../input/lookRouter';

import { dialogCamBegin, dialogCamEnd } from './camera';
import { DLG_ACT, DLG_EV, DLG_INTERACT, type DialogNode } from './events';
import { offlineNode, offlineReply } from './offline';
import { applyDialogEvent, bubbleText, recordAnswer, resetDialog, staleDialogAction, useDialog } from './store';
import { dialogChime } from './voice';

const FACE_RAISE_M = 0.45;

let hooked: ZoneSession | null = null;
let worldOn = false;
let panelOpenFn: () => boolean = () => false;

const listener = (e: ZoneEvent) => {
  if (e.kind < 1910 || e.kind > 1929) return;
  const before = useDialog.getState();
  applyDialogEvent(e);
  const s = useDialog.getState();
  if (e.kind === DLG_EV.node && s.node && s.open) {
    if (!before.node) dialogChime('open');
    if (s.key !== null) npcFocus.say(s.key, bubbleText(s.node.line), 0, true);
  }
  if (!s.open) {
    if (before.open && before.node) dialogChime('close');
    finish();
  }
};

function session(): ZoneSession | null {
  const s = netRuntime.session;
  return s && s.phase === 'playing' ? s : null;
}

/** Hook the live session if it changed (townHud calls this every frame; cheap). */
export function ensureDialogHook(): void {
  watchdog();
  const s = netRuntime.session;
  if (s === hooked) return;
  hooked?.eventListeners.delete(listener);
  hooked = s;
  s?.eventListeners.add(listener);
  if (!worldOn) {
    worldOn = true;
    useDialog.subscribe(syncWorld);
  }
}

/** Playtest 5: a conversation that went quiet lets go on its own (see staleDialogAction). */
function watchdog(now = performance.now()): void {
  const s = useDialog.getState();
  if (!s.open) return;
  const act = staleDialogAction(s, now, panelOpenFn());
  if (act === 'close') {
    dialogController.close();
    useDialog.setState({ toast: { text: s.node ? 'The conversation drifted off.' : 'No answer.', at: now } });
  } else if (act === 'unpark') useDialog.setState({ parked: false, awaitingWork: false, at: now });
}

/** The world follows the store: framing, mouse, standing still, who is talking. */
function syncWorld(): void {
  const s = useDialog.getState();
  const live = s.open && !s.parked;
  if (live && s.focus) {
    dialogCamBegin(s.focus, localPlayer.yaw, localPlayer.pitch);
    lookRouter.blockMove = true;
    if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
  } else {
    dialogCamEnd();
    lookRouter.blockMove = false;
  }
  if (s.open && s.key !== null) npcFocus.setTalkingTo(s.key);
  else if (npcFocus.talkingTo !== null) npcFocus.setTalkingTo(null);
}

function finish(): void {
  dialogCamEnd();
  lookRouter.blockMove = false;
  npcFocus.setTalkingTo(null);
}

export const dialogController = {
  /** townHud tells us whether its services panel is up. */
  setPanelProbe(fn: () => boolean): void {
    panelOpenFn = fn;
  },

  /** E on a person. */
  open(c: Candidate): void {
    ensureDialogHook();
    const s = session();
    const key = c.entityId ?? -1 - c.index;
    const focus = { x: c.x, y: c.y + FACE_RAISE_M, z: c.z };
    resetDialog();
    if (s && c.entityId !== null) {
      s.sendInteract(DLG_INTERACT, BigInt(c.entityId), DLG_ACT.open, 0);
      useDialog.setState({ open: true, key, focus, offline: false, at: performance.now() });
      return;
    }
    const node = offlineNode(c);
    useDialog.setState({ open: true, key, focus, node, lineAt: performance.now(), offline: true, lines: 1, at: performance.now() });
    npcFocus.say(key, bubbleText(node.line), 0, true);
    dialogChime('open');
  },

  /** Pick choice id (a number key or a click). */
  choose(id: number): void {
    const st = useDialog.getState();
    const node = st.node;
    if (!st.open || !node) return;
    const ch = node.choices.find((c) => c.id === id);
    if (!ch || node.bye) return;
    if (st.offline) {
      recordAnswer(ch);
      const next = offlineReply(node, ch);
      const cur = useDialog.getState();
      useDialog.setState({ node: next, lineAt: performance.now(), lines: st.lines + 1, at: performance.now(), history: [...cur.history, { who: 'npc', text: node.line, check: node.check }] });
      if (st.key !== null) npcFocus.say(st.key, bubbleText(next.line), 0, true);
      if (next.bye) setTimeout(() => dialogController.close(), 2600);
      return;
    }
    const s = session();
    if (!s) return;
    recordAnswer(ch);
    s.sendInteract(DLG_INTERACT, BigInt(node.npc.id), DLG_ACT.choose, id);
    if (ch.kind === 'leave') {
      // The zone answers with their farewell and closes the box after it (Event 1910 bye, then 1911).
      return;
    }
    if (ch.kind === 'work') {
      useDialog.setState({ awaitingWork: true, at: performance.now() });
      setTimeout(() => {
        const cur = useDialog.getState();
        if (cur.open && cur.parked && !panelOpenFn()) useDialog.setState({ parked: false, at: performance.now() });
      }, 900);
    }
  },

  /** Esc, the close button, or walking off. */
  close(): void {
    const st = useDialog.getState();
    if (!st.open) return;
    const s = session();
    if (s && !st.offline && st.node) s.sendInteract(DLG_INTERACT, BigInt(st.node.npc.id), DLG_ACT.close, 0);
    if (st.node) dialogChime('close');
    resetDialog();
    finish();
  },

  /** The services panel closed: back to the conversation. */
  panelClosed(): void {
    const st = useDialog.getState();
    // (playtest 6 polish: two kinds of panel can park it now, the town's and a station's: only when both are shut)
    if (st.open && st.parked && !panelOpenFn()) useDialog.setState({ parked: false, at: performance.now() });
  },

  get node(): DialogNode | null {
    return useDialog.getState().node;
  },
};
