// Playtest 2 polish: combat's mouse and keys against the mouse capture, the
// Esc menu and panels, and chat shortcuts (combat/runtime.ts attachInput).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CombatRuntime } from './runtime';
import { pointerLockState } from '../input/useMouseLook';

/** A stand-in for window: the events land on it, and it is the canvas (tagName). */
function rig() {
  const target = Object.assign(new EventTarget(), { tagName: 'CANVAS' });
  const r = new CombatRuntime({ sendHitClaim: () => {}, sendInteract: () => {}, latestTick: () => 0, selfId: () => 1 });
  r.attachInput(target as unknown as Window);
  const fire = (type: string, props: Record<string, unknown>) => target.dispatchEvent(Object.assign(new Event(type), props));
  return { r, target, fire };
}

const doc = { pointerLockElement: null as unknown, exitPointerLock() {}, hidden: false, querySelectorAll: () => [] };

beforeEach(() => {
  doc.pointerLockElement = null;
  pointerLockState.refusals = 0;
  vi.stubGlobal('document', doc);
});
afterEach(() => vi.unstubAllGlobals());

describe('the click that captures the mouse', () => {
  it('neither swings nor casts; the next click does', () => {
    const { r, fire } = rig();
    fire('mousedown', { button: 0 });
    fire('mouseup', { button: 0 });
    expect(r.buttons.attackPress).toBe(0);
    fire('mousedown', { button: 2 });
    expect(r.buttons.altPress).toBe(0);
    doc.pointerLockElement = {}; // the lock arrived
    fire('mousedown', { button: 0 });
    expect(r.buttons.attackPress).toBe(1);
    expect(r.buttons.attackDown).toBe(true);
  });

  it('fights unlocked where the browser keeps refusing the lock', () => {
    const { r, fire } = rig();
    pointerLockState.refusals = 2;
    fire('mousedown', { button: 0 });
    expect(r.buttons.attackPress).toBe(1);
  });
});
