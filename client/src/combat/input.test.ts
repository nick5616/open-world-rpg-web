// Playtest 2 polish: combat's mouse and keys against the mouse capture, the
// Esc menu and panels, and chat shortcuts (combat/runtime.ts attachInput).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CombatRuntime } from './runtime';
import { pointerLockState } from '../input/useMouseLook';
import { releaseHeld } from '../input/held';
import { useMenu } from '../ui/menu/store';
import { fishingInput } from '../ui/fishing/FishingHud';
import { fishLive, useFishing } from '../ui/fishing/store';

type Held = { attackPress: number; attackDown: boolean; altPress: number; altDown: boolean; castHeld: boolean[] };
/** The runtime's input latches (private: what the listeners fill). */
const b = (r: CombatRuntime) => (r as unknown as { buttons: Held }).buttons;

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
    expect(b(r).attackPress).toBe(0);
    fire('mousedown', { button: 2 });
    expect(b(r).altPress).toBe(0);
    doc.pointerLockElement = {}; // the lock arrived
    fire('mousedown', { button: 0 });
    expect(b(r).attackPress).toBe(1);
    expect(b(r).attackDown).toBe(true);
  });

  it('fights unlocked where the browser keeps refusing the lock', () => {
    const { r, fire } = rig();
    pointerLockState.refusals = 2;
    fire('mousedown', { button: 0 });
    expect(b(r).attackPress).toBe(1);
  });
});

describe('typing "/" for chat', () => {
  it('casts nothing and takes no form, on any layout', () => {
    const { r, fire } = rig();
    doc.pointerLockElement = {};
    fire('keydown', { code: 'Digit1', key: '/' }); // a layout with "/" on a number row key
    fire('keydown', { code: 'KeyQ', key: '/' }); // Hebrew
    expect(b(r).castHeld[0]).toBe(false);
    expect((r as unknown as { buttons: { formPress: number } }).buttons.formPress).toBe(0);
    fire('keydown', { code: 'Digit1', key: '1' });
    expect(b(r).castHeld[0]).toBe(true);
  });
});

describe('held actions and the Esc menu (input/held.ts)', () => {
  afterEach(() => useMenu.setState({ open: false }));

  it('a stream, a draw and Z let go when the menu opens, and 1-4 / Z / clicks do nothing under it', () => {
    const { r, fire } = rig();
    doc.pointerLockElement = {};
    fire('keydown', { code: 'Digit1' });
    fire('keydown', { code: 'KeyZ' });
    fire('mousedown', { button: 0 });
    expect(b(r).castHeld[0]).toBe(true);
    expect(b(r).altDown).toBe(true);
    expect(b(r).attackDown).toBe(true);
    useMenu.setState({ open: true });
    expect(b(r).castHeld).toEqual([false, false, false, false]);
    expect(b(r).altDown).toBe(false);
    expect(b(r).attackDown).toBe(false);
    const presses = b(r).attackPress;
    fire('keydown', { code: 'Digit2' });
    fire('keydown', { code: 'KeyZ' });
    fire('mousedown', { button: 0 });
    expect(b(r).castHeld[1]).toBe(false);
    expect(b(r).altDown).toBe(false);
    expect(b(r).attackPress).toBe(presses);
  });

  it('losing the mouse capture or the window lets go too', () => {
    const { r, fire } = rig();
    doc.pointerLockElement = {};
    fire('keydown', { code: 'Digit3' });
    expect(b(r).castHeld[2]).toBe(true);
    releaseHeld(); // what pointerlockchange (lost), blur and a hidden page call
    expect(b(r).castHeld[2]).toBe(false);
  });

  it('fishing does not reel under the menu, and stops reeling when it opens', () => {
    doc.pointerLockElement = {};
    useFishing.setState({ phase: 'fight' });
    const key = (type: string, code: string) => {
      const e = Object.assign(new Event(type, { cancelable: true }), { code, repeat: false });
      fishingInput.onKey(e as unknown as KeyboardEvent);
      return e;
    };
    key('keydown', 'Space');
    expect(fishLive.reel).toBe(true);
    useMenu.setState({ open: true });
    expect(fishLive.reel).toBe(false);
    const e = key('keydown', 'KeyE');
    expect(fishLive.reel).toBe(false);
    expect(e.defaultPrevented).toBe(true); // swallowed: no jump or other E while the line is out
    useMenu.setState({ open: false });
    key('keydown', 'KeyE');
    expect(fishLive.reel).toBe(true);
    key('keyup', 'KeyE');
    expect(fishLive.reel).toBe(false);
    useFishing.setState({ phase: 'idle' });
  });
});
