// Playtest 2 immersion pass: the story's cinematic hides the HUD while it
// holds the screen (nested holders counted) and keeps its own layer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CINEMATIC_RULE, cinematicActive, holdCinematic } from './cinematicMode';

function fakeDocument() {
  const styles: { id: string; textContent: string }[] = [];
  return {
    styles,
    body: { dataset: {} as Record<string, string> },
    head: { appendChild: (s: { id: string; textContent: string }) => styles.push(s) },
    getElementById: (id: string) => styles.find((s) => s.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
  };
}

describe('cinematic mode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hides the HUD while held, once per stack of holders, and installs its rule once', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    expect(cinematicActive()).toBe(false);
    const a = holdCinematic();
    const b = holdCinematic();
    expect(doc.body.dataset.cinematic).toBe('1');
    expect(doc.styles).toHaveLength(1);
    expect(cinematicActive()).toBe(true);
    a();
    a(); // idempotent
    expect(doc.body.dataset.cinematic).toBe('1');
    b();
    expect(doc.body.dataset.cinematic).toBeUndefined();
    expect(cinematicActive()).toBe(false);
  });

  it('keeps the canvas, its holders and the cinematic layer visible', () => {
    expect(CINEMATIC_RULE).toContain(':not(canvas):not(:has(canvas))');
    expect(CINEMATIC_RULE).toContain(':not([data-cinematic-keep]):not([data-cinematic-keep] *)');
    expect(CINEMATIC_RULE).toContain('[data-cinematic-keep] * { visibility: visible');
  });
});
