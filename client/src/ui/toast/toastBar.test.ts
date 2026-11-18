// Playtest 5 (CR 055): the shared toast bar.

import { describe, expect, it } from 'vitest';
import { barLeft, ensureToastBarCss, TOAST_BAR_CSS } from './ToastBar';

describe('toast bar', () => {
  it('drains linearly from full to empty over the toast time', () => {
    expect(barLeft(1000, 1000, 4000)).toBe(1);
    expect(barLeft(1000, 3000, 4000)).toBeCloseTo(0.5);
    expect(barLeft(1000, 4000, 4000)).toBeCloseTo(0.25);
    expect(barLeft(1000, 5000, 4000)).toBe(0);
    expect(barLeft(1000, 9000, 4000)).toBe(0);
    expect(barLeft(1000, 500, 4000)).toBe(1); // a clock that ran backwards never overfills
    expect(barLeft(0, 10, 0)).toBe(0);
  });

  it('the stylesheet drains linearly, pauses on hover and steps under prefers-reduced-motion', () => {
    expect(TOAST_BAR_CSS).toMatch(/animation-timing-function: linear/);
    expect(TOAST_BAR_CSS).toMatch(/\.ls-timed:hover \.ls-toast-bar \{ animation-play-state: paused/);
    expect(TOAST_BAR_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.ls-toast-bar \{ animation-timing-function: steps\(\d+, end\)/);
    expect(TOAST_BAR_CSS).toMatch(/height: 3px/);
    expect(TOAST_BAR_CSS).toMatch(/bottom: 0/);
  });

  it('adds the stylesheet once', () => {
    const els: { id: string; textContent: string }[] = [];
    const doc = {
      getElementById: (id: string) => els.find((e) => e.id === id) ?? null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (e: { id: string; textContent: string }) => els.push(e) },
    } as unknown as Document;
    ensureToastBarCss(doc);
    ensureToastBarCss(doc);
    expect(els).toHaveLength(1);
    expect(els[0].textContent).toBe(TOAST_BAR_CSS);
  });
});
