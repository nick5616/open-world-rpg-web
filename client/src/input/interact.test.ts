// Playtest 5 ("can't pick anything up after a while, you can't press E on anything"): E_ORDER puts the town and
// cave prompts first, so a prompt nobody refreshes any more must not keep owning E.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ePromptUp, eTakenAbove, PROMPT_FRESH_MS, stampPrompt } from './interact';

interface FakeEl {
  textContent: string;
  style: { visibility?: string; display?: string };
  dataset: Record<string, string | undefined>;
}

function prompt(text: string): FakeEl {
  return { textContent: text, style: {}, dataset: {} };
}

function withPrompts(byTestId: Record<string, FakeEl>): void {
  vi.stubGlobal('document', {
    querySelector: (sel: string) => {
      const m = /data-testid="([^"]+)"/.exec(sel);
      return (m && byTestId[m[1]]) ?? null;
    },
    querySelectorAll: () => [],
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('E prompts', () => {
  it('a fresh [E] prompt owns E; a hint without [E] does not', () => {
    const town = prompt('[E] Talk to Mira (blacksmith)');
    withPrompts({ 'town-prompt': town });
    stampPrompt(town as unknown as HTMLElement, town.textContent, 1000);
    expect(ePromptUp('town', 1100)).toBe(true);
    town.textContent = 'Crokathloch, 2 km';
    expect(ePromptUp('town', 1100)).toBe(false);
  });

  it('a prompt whose writer stopped hands E back after a moment (it used to own E for good)', () => {
    const town = prompt('[E] Talk to Mira (blacksmith)');
    withPrompts({ 'town-prompt': town });
    stampPrompt(town as unknown as HTMLElement, town.textContent, 1000);
    expect(ePromptUp('town', 1000 + PROMPT_FRESH_MS - 1)).toBe(true);
    expect(ePromptUp('town', 1000 + PROMPT_FRESH_MS + 1)).toBe(false);
    // ... so the pickup below it in E_ORDER may take the key again
    const old = prompt('[E] Talk to Mira (blacksmith)');
    withPrompts({ 'town-prompt': old });
    stampPrompt(old as unknown as HTMLElement, old.textContent, performance.now() - 10_000);
    expect(eTakenAbove('loot', false)).toBe(false);
    stampPrompt(old as unknown as HTMLElement, old.textContent);
    expect(eTakenAbove('loot', false)).toBe(true);
  });

  it('an unstamped prompt (a React prompt that unmounts with its state) behaves as before', () => {
    withPrompts({ 'revive-prompt': prompt('[E] Hold to raise Tam') });
    expect(ePromptUp('revive', 1e9)).toBe(true);
  });

  it('clearing the text clears the stamp', () => {
    const cave = prompt('');
    withPrompts({ 'cave-hud': cave });
    stampPrompt(cave as unknown as HTMLElement, '[E] mine copper ore', 5);
    expect(cave.dataset.eAt).toBe('5');
    stampPrompt(cave as unknown as HTMLElement, '', 6);
    expect(cave.dataset.eAt).toBeUndefined();
  });
});
