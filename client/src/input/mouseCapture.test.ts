import { describe, expect, it } from 'vitest';
import { gameWantsMouse, isPlayKey, noteLockRefused, pointerLockState, shouldCapture, type MouseNeeds } from './mouseCapture';

const idle: MouseNeeds = { screenPlay: true, menuOpen: false, chatOpen: false, debugPanel: false, typing: false, panelUp: false, focused: true };
const k = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('mouse capture (playtest 6)', () => {
  it('the game wants the mouse only in the world with nothing open that uses it', () => {
    expect(gameWantsMouse(idle)).toBe(true);
    for (const f of ['menuOpen', 'chatOpen', 'debugPanel', 'typing', 'panelUp'] as const) expect(gameWantsMouse({ ...idle, [f]: true })).toBe(false);
    expect(gameWantsMouse({ ...idle, screenPlay: false })).toBe(false);
    expect(gameWantsMouse({ ...idle, focused: false })).toBe(false);
  });

  it('play keys take the mouse; Esc, F-keys, modifiers, shortcuts and typing do not', () => {
    for (const c of ['KeyW', 'Space', 'ArrowUp', 'Digit1', 'Tab', 'Enter', 'Period']) expect(isPlayKey(k(c), false)).toBe(true);
    for (const c of ['Escape', 'F5', 'F11', 'F12', 'ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft', 'CapsLock']) expect(isPlayKey(k(c), false)).toBe(false);
    expect(isPlayKey(k('KeyW', { ctrlKey: true }), false)).toBe(false); // Ctrl+W closes the tab
    expect(isPlayKey(k('KeyR', { metaKey: true }), false)).toBe(false);
    expect(isPlayKey(k('Tab', { altKey: true }), false)).toBe(false);
    expect(isPlayKey(k('KeyW'), true)).toBe(false); // chat
  });

  it('takes the mouse back after the game freed it, or within a gesture, never while locked or busy', () => {
    const now = 10_000;
    expect(shouldCapture({ released: true, gestureUntil: 0 }, false, true, now)).toBe(true); // a panel closed
    expect(shouldCapture({ released: false, gestureUntil: now + 100 }, false, true, now)).toBe(true); // a key just now
    expect(shouldCapture({ released: false, gestureUntil: now - 1 }, false, true, now)).toBe(false); // the player freed it (Esc), no key since
    expect(shouldCapture({ released: true, gestureUntil: now + 100 }, false, false, now)).toBe(false); // a panel is still up
    expect(shouldCapture({ released: true, gestureUntil: now + 100 }, true, true, now)).toBe(false); // already captured
  });

  it('a refused soft request does not count toward clicks fighting unlocked', () => {
    pointerLockState.refusals = 0;
    pointerLockState.softUntil = 500;
    noteLockRefused(400);
    expect(pointerLockState.refusals).toBe(0);
    noteLockRefused(600);
    expect(pointerLockState.refusals).toBe(1);
    pointerLockState.refusals = 0;
    pointerLockState.softUntil = -1e9;
  });
});
