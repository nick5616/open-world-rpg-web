// Playtest 2 onboarding: the Esc menu's decisions and the key reference.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlGroups, keyLabel, movementKeys } from './controls';
import { escAction, registerMenuEntry, sortEntries, unlockOpensMenu, useMenu } from './store';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('controls reference', () => {
  it('labels key codes', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('ShiftLeft')).toBe('Shift');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('ArrowUp')).toBe('↑');
  });

  it('takes movement from the movement key map', () => {
    expect(movementKeys('forward')).toEqual(['W', '↑']);
    expect(movementKeys('sprint')).toEqual(['Shift']);
    expect(movementKeys('jump')).toEqual(['Space']);
    expect(movementKeys('glide')).toEqual(['G']);
    const walk = controlGroups(false)[0].rows[0];
    expect(walk.keys).toEqual(['W', 'A', 'S', 'D']);
  });

  it('every listed binding exists in the handler code it names', () => {
    let checked = 0;
    for (const g of controlGroups(true))
      for (const r of g.rows)
        for (const [file, literal] of r.src ?? []) {
          const text = readFileSync(path.join(SRC, file), 'utf8');
          expect(text.includes(literal), `${r.action}: ${literal} in ${file}`).toBe(true);
          checked++;
        }
    expect(checked).toBeGreaterThan(30);
  });

  it('covers the keys a new player needs, and dev keys only in dev builds', () => {
    const keys = (debug: boolean) => new Set(controlGroups(debug).flatMap((g) => g.rows.flatMap((r) => r.keys)));
    const k = keys(false);
    for (const want of ['W', 'Shift', 'Space', 'G', 'Left mouse', 'Right mouse', 'Mouse wheel', 'Z', '1', '4', 'F', 'Q', 'R', 'X', 'V', 'T', 'E', 'I', 'C', 'N', 'B', 'J', 'M', 'K', 'O', 'Enter', 'Esc']) expect(k.has(want), want).toBe(true);
    expect(k.has('F3')).toBe(false);
    expect(keys(true).has('F3')).toBe(true);
    // no action listed twice in a group
    for (const g of controlGroups(true)) expect(new Set(g.rows.map((r) => r.action)).size).toBe(g.rows.length);
  });
});

describe('Esc', () => {
  const base = { menuOpen: false, stacked: false, panelOpen: false, typing: false, sinceUnlockMs: 1e9 };
  it('opens the menu when nothing else is open', () => {
    expect(escAction(base)).toBe('open');
  });
  it('closes the top panel on the stack (playtest 2 polish: one at a time)', () => {
    expect(escAction({ ...base, stacked: true })).toBe('pop');
    expect(escAction({ ...base, stacked: true, panelOpen: true })).toBe('pop');
    expect(escAction({ ...base, stacked: true, menuOpen: true })).toBe('close'); // the menu is over everything
  });
  it('leaves a panel that is not on the stack to its own Esc', () => {
    expect(escAction({ ...base, panelOpen: true })).toBe('none');
  });
  it('never acts while typing (chat owns Esc)', () => {
    expect(escAction({ ...base, typing: true })).toBe('none');
    expect(escAction({ ...base, stacked: true, typing: true })).toBe('none');
    expect(escAction({ ...base, menuOpen: true, typing: true })).toBe('none');
  });
  it('closes the open menu, but not with the press that just freed the mouse', () => {
    expect(escAction({ ...base, menuOpen: true })).toBe('close');
    expect(escAction({ ...base, menuOpen: true, sinceUnlockMs: 50 })).toBe('none');
  });
});

describe('a lost pointer lock', () => {
  const base = { panelOpen: false, typing: false, focused: true, menuOpen: false, requestedMs: 1e9 };
  it('opens the menu after the browser Esc', () => {
    expect(unlockOpensMenu(base)).toBe(true);
  });
  it('does not when a panel, chat or our own code freed the mouse, or the window lost focus', () => {
    expect(unlockOpensMenu({ ...base, panelOpen: true })).toBe(false);
    expect(unlockOpensMenu({ ...base, typing: true })).toBe(false);
    expect(unlockOpensMenu({ ...base, requestedMs: 20 })).toBe(false);
    expect(unlockOpensMenu({ ...base, focused: false })).toBe(false);
    expect(unlockOpensMenu({ ...base, menuOpen: true })).toBe(false);
  });
});

describe('plug-in entries', () => {
  it('registers, replaces by id, sorts and removes', () => {
    const off1 = registerMenuEntry({ id: 'graphics', label: 'Graphics', order: 20, open: () => {} });
    registerMenuEntry({ id: 'a', label: 'Accessibility', open: () => {} });
    const g2 = { id: 'graphics', label: 'Graphics settings', order: 20, open: () => {} };
    const off2 = registerMenuEntry(g2);
    expect(useMenu.getState().entries.map((e) => e.label)).toEqual(['Graphics settings', 'Accessibility']);
    off1(); // the replaced entry's removal is a no-op
    expect(useMenu.getState().entries).toHaveLength(2);
    off2();
    expect(useMenu.getState().entries.map((e) => e.id)).toEqual(['a']);
    expect(sortEntries([{ id: 'x', label: 'B' }, { id: 'y', label: 'A' }, { id: 'z', label: 'Z', order: 1 }]).map((e) => e.id)).toEqual(['z', 'y', 'x']);
  });
  it('opening resets to the main page', () => {
    useMenu.getState().setOpen(true);
    useMenu.getState().setPage('controls');
    useMenu.getState().setOpen(false);
    useMenu.getState().setOpen(true);
    expect(useMenu.getState().page).toBe('main');
    useMenu.getState().setOpen(false);
  });
});
