// Playtest 2 dev console (CR 032): what the zone said (Events 1400-1402)
// and the console's own state. `dev` turns true only when a zone in dev
// mode answers; the console never shows otherwise.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { devCombat } from '../../combat/timeline';
import { devMove } from '../../sim/devStep';
import { DEV_ACT, DEV_EV, DEV_FLAG, DEV_RESULT, type DevPlaces, type DevSend, type DevStatus } from './events';

export type DevTab = 'items' | 'spells' | 'character' | 'world';

export interface DevLine {
  id: number;
  kind: 'cmd' | 'ok' | 'err' | 'info';
  text: string;
}

export interface DevState {
  /** A zone in dev mode answered (Event 1400). */
  dev: boolean;
  open: boolean;
  tab: DevTab;
  status: DevStatus;
  places: DevPlaces;
  log: DevLine[];
  history: string[];
  send: ((s: DevSend) => void) | null;
}

const MAX_LOG = 200;
let lineId = 1;

const initial = (): Omit<DevState, 'send'> => ({
  dev: false,
  open: false,
  tab: 'items',
  status: { flags: 0, speed: 1, skillBonus: 0, frozen: false, hour: 12, weather: -1, spawned: 0 },
  places: { towers: [], towns: [], vaults: [] },
  log: [],
  history: [],
});

export const useDev = create<DevState>(() => ({ ...initial(), send: null }));

export function devLog(kind: DevLine['kind'], text: string): void {
  useDev.setState((s) => ({ log: [...s.log, { id: lineId++, kind, text }].slice(-MAX_LOG) }));
}

const ACT_NAME = Object.fromEntries(Object.entries(DEV_ACT).map(([k, v]) => [v, k])) as Record<number, string>;

/** Apply the flags to the local prediction (fly, stamina, mana, cooldowns). */
export function applyDevFlags(st: DevStatus): void {
  devMove.fly = st.flags & DEV_FLAG.fly ? st.speed || 1 : 0;
  devMove.stamina = (st.flags & DEV_FLAG.stamina) !== 0;
  devCombat.infiniteMana = (st.flags & DEV_FLAG.mana) !== 0;
  devCombat.noCooldowns = (st.flags & DEV_FLAG.cooldowns) !== 0;
}

/** One zone Event (1400-1402). */
export function applyDevEvent(ev: ZoneEvent): void {
  const text = () => new TextDecoder().decode(ev.data);
  switch (ev.kind) {
    case DEV_EV.status: {
      let st: DevStatus;
      try {
        st = JSON.parse(text()) as DevStatus;
      } catch {
        return;
      }
      applyDevFlags(st);
      useDev.setState({ dev: true, status: st });
      return;
    }
    case DEV_EV.result: {
      const name = ACT_NAME[ev.targetId] ?? `#${ev.targetId}`;
      devLog(ev.value === DEV_RESULT.ok ? 'ok' : 'err', `${ev.value === DEV_RESULT.ok ? '' : `${name}: `}${text()}`);
      return;
    }
    case DEV_EV.places:
      try {
        useDev.setState({ places: JSON.parse(text()) as DevPlaces });
      } catch {
        /* a bad list: keep the old one */
      }
  }
}

export function sendDev(s: DevSend): boolean {
  const f = useDev.getState().send;
  if (!f) {
    devLog('err', 'not connected to a zone');
    return false;
  }
  f(s);
  return true;
}

export function setDevOpen(open: boolean): void {
  if (open && !useDev.getState().dev) return;
  useDev.setState({ open });
  if (open && typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

export function resetDev(): void {
  useDev.setState({ ...initial(), send: useDev.getState().send });
  applyDevFlags(initial().status);
}
