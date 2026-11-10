import { describe, expect, it } from 'vitest';
import { ELEMENT_COLOR } from '../skills/tree';
import { contrastRatio, GREEN, parseColor, PANEL_BG, SURFACES, TEXT_TOKENS } from './theme';

// WCAG AA: 4.5:1 for normal text (the panel has no text under 11px that
// would only qualify as large). The panel surface is translucent, so it is
// checked over both a black and a white world behind it (snow at noon).
const AA = 4.5;
const BACKDROPS = ['#000000', '#ffffff'];

describe('contrast maths', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#000000')).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
    expect(parseColor('rgba(12,14,20,0.97)')).toEqual([12, 14, 20, 0.97]);
    expect(parseColor('#fc0')).toEqual([255, 204, 0, 1]);
  });

  it('the old panel text failed where the new tokens pass', () => {
    // Before: secondary text was #f1f3f5 at opacity 0.55 on a 0.94 panel; over a bright world that is under AA.
    const old = 'rgba(241,243,245,0.55)';
    expect(contrastRatio(old, 'rgba(12,14,20,0.94)', '#ffffff')).toBeLessThan(contrastRatio(TEXT_TOKENS.TEXT_3, PANEL_BG, '#ffffff'));
  });
});

describe('character panel colour tokens meet WCAG AA', () => {
  for (const [tn, fg] of Object.entries(TEXT_TOKENS)) {
    for (const [sn, bg] of Object.entries(SURFACES)) {
      for (const backdrop of BACKDROPS) {
        it(`${tn} on ${sn} (world ${backdrop})`, () => {
          expect(contrastRatio(fg, bg, backdrop)).toBeGreaterThanOrEqual(AA);
        });
      }
    }
  }

  // School colours are text on cards (the school line, the tooltip's name and accents).
  for (const [school, fg] of Object.entries(ELEMENT_COLOR)) {
    for (const [sn, bg] of Object.entries(SURFACES)) {
      it(`${school} school colour on ${sn}`, () => {
        for (const backdrop of BACKDROPS) expect(contrastRatio(fg, bg, backdrop)).toBeGreaterThanOrEqual(AA);
      });
    }
  }

  it('the slot badge (dark on green) is readable', () => {
    expect(contrastRatio('#0c0e14', GREEN)).toBeGreaterThanOrEqual(AA);
  });
});
