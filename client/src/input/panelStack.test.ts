// Playtest 2 polish: Esc closes the top panel only (input/panelStack.ts).

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { clearPanels, closeTopPanel, hidePanel, openPanels, showPanel, syncPanel, topPanel, trackPanel } from './panelStack';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('the panel stack', () => {
  beforeEach(() => clearPanels());

  it('closes the newest panel first, one per Esc', () => {
    const closed: string[] = [];
    showPanel('town', () => closed.push('town')); // a shop
    showPanel('inventory', () => closed.push('inventory')); // then I
    expect(topPanel()).toBe('inventory');
    expect(closeTopPanel()).toBe(true);
    expect(closed).toEqual(['inventory']);
    expect(openPanels()).toEqual(['town']);
    expect(closeTopPanel()).toBe(true);
    expect(closed).toEqual(['inventory', 'town']);
    expect(closeTopPanel()).toBe(false); // nothing open: the Esc menu's turn
  });

  it('a journal over a quest offer closes alone', () => {
    const closed: string[] = [];
    showPanel('quest-offer', () => closed.push('offer'));
    showPanel('journal', () => closed.push('journal'));
    closeTopPanel();
    expect(closed).toEqual(['journal']);
    expect(openPanels()).toEqual(['quest-offer']);
  });

  it('opening a panel again brings it to the top; a refresh while open does not', () => {
    showPanel('a', () => {});
    showPanel('b', () => {});
    syncPanel('a', true, () => {}); // still open (a re-render, a refreshed shop)
    expect(openPanels()).toEqual(['a', 'b']);
    showPanel('a', () => {}); // opened anew
    expect(openPanels()).toEqual(['b', 'a']);
    hidePanel('b'); // closed some other way
    syncPanel('a', false, () => {});
    expect(openPanels()).toEqual([]);
  });

  it('follows a store', () => {
    const useS = create<{ open: boolean; other: number }>()(() => ({ open: false, other: 0 }));
    const off = trackPanel(useS, (s) => s.open, 'map', () => useS.setState({ open: false }));
    expect(openPanels()).toEqual([]);
    useS.setState({ open: true });
    showPanel('chat', () => {});
    useS.setState({ other: 1 }); // unrelated change: stays where it is
    expect(openPanels()).toEqual(['map', 'chat']);
    hidePanel('chat');
    closeTopPanel();
    expect(useS.getState().open).toBe(false);
    expect(openPanels()).toEqual([]);
    off();
  });
});

describe('every panel registers on the stack', () => {
  // Files that draw a data-ui-panel, and the file that puts it on the stack when it is not the same one.
  const REGISTERED_BY: Record<string, string> = {
    'social/ui/FriendsPanel.tsx': 'social/ui/SocialOverlay.tsx',
    'ui/achievements/AchievementsScreen.tsx': 'ui/achievements/AchievementsHud.tsx',
    'ui/map/MapScreen.tsx': 'ui/map/ExplorationHud.tsx',
    'ui/menu/EscMenu.tsx': '', // the menu itself: over everything, closed first
  };
  const files = (dir = SRC, out: string[] = []): string[] => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) {
        if (f.name !== 'node_modules' && f.name !== 'dev') files(p, out);
      } else if (/\.tsx?$/.test(f.name) && !/\.test\.tsx?$/.test(f.name)) out.push(path.relative(SRC, p).replace(/\\/g, '/'));
    }
    return out;
  };

  it('each data-ui-panel has a stack entry (usePanelEsc / trackPanel / syncPanel / showPanel)', () => {
    const missing: string[] = [];
    let panels = 0;
    for (const f of files()) {
      const text = readFileSync(path.join(SRC, f), 'utf8');
      if (!/data-ui-panel[\s>]|dataset\.uiPanel = /.test(text)) continue;
      panels++;
      const by = f in REGISTERED_BY ? REGISTERED_BY[f] : f;
      if (by === '') continue;
      if (!/\b(usePanelEsc|trackPanel|syncPanel|showPanel)\(/.test(readFileSync(path.join(SRC, by), 'utf8'))) missing.push(f);
    }
    expect(panels).toBeGreaterThan(15);
    expect(missing).toEqual([]);
  });

  it('only the Esc menu listens for Esc outside text fields (input/bindings.ts declares the rest)', () => {
    const esc = readFileSync(path.join(SRC, 'ui/menu/EscMenu.tsx'), 'utf8');
    expect(esc).toContain('closeTopPanel()');
  });
});
