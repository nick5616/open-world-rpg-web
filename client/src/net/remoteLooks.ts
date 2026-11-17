// Other players' creation looks (CR 047). The first time an avatar appears the
// client asks the zone once (Interact 91, targetId = the entity id); the zone
// answers that client alone with Event 1900 (value = the packed look). A player
// with no stored look never answers, so asks are retried a few times a few
// seconds apart and then given up on (the default figure stays). Nothing per
// frame beyond a map lookup.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { unpackLook, type Look } from './look';

export const INTERACT_LOOK = 91;
export const LOOK_ACT_ASK = 1;
export const EV_LOOK = 1900;

const RETRY_MS = 4000;
const MAX_ASKS = 3;

export class LookBook {
  private looks = new Map<number, Look>();
  private asks = new Map<number, { n: number; at: number }>();

  /** Event listener: stores Event 1900. */
  onEvent = (e: ZoneEvent): void => {
    if (e.kind !== EV_LOOK) return;
    const l = unpackLook(e.value);
    if (l) this.looks.set(e.entityId, l);
  };

  get(id: number): Look | undefined {
    return this.looks.get(id);
  }

  /** True when the caller should send an ask for `id` now (and records it). */
  due(id: number, now: number): boolean {
    if (this.looks.has(id)) return false;
    const a = this.asks.get(id);
    if (!a) {
      this.asks.set(id, { n: 1, at: now });
      return true;
    }
    if (a.n >= MAX_ASKS || now - a.at < RETRY_MS) return false;
    a.n++;
    a.at = now;
    return true;
  }

  /** The avatar left: forget it (a later return asks again; ids are not reused). */
  forget(id: number): void {
    this.looks.delete(id);
    this.asks.delete(id);
  }

  clear(): void {
    this.looks.clear();
    this.asks.clear();
  }
}
