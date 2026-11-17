// CR 044: the Depths shrine's notices and the new creature styles.
import { describe, expect, it, vi } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { shrineNotice, SHRINE_STATE } from './events';
import { modelSpec } from '../../combat/enemies/spec';

const ev = (value: number, wave: number, waves: number) => ({ kind: 1890, value, data: new Uint8Array([wave, waves]) }) as unknown as ZoneEvent;

describe('demon shrine', () => {
  it('tells each stage of the cleansing', () => {
    const notice = vi.fn();
    const hud = { notice } as unknown as Parameters<typeof shrineNotice>[1];
    shrineNotice(ev(SHRINE_STATE.started, 1, 3), hud);
    shrineNotice(ev(SHRINE_STATE.waveDone, 2, 3), hud);
    shrineNotice(ev(SHRINE_STATE.cleansed, 3, 3), hud);
    shrineNotice(ev(SHRINE_STATE.busy, 0, 3), hud);
    expect(notice).toHaveBeenCalledTimes(4);
    expect(notice.mock.calls[0][0]).toContain('Wave 1 of 3');
    expect(notice.mock.calls[1][0]).toContain('Wave 2 of 3');
  });
});

describe('sky and Depths creatures', () => {
  it('have models of their own, not a reused family', () => {
    for (const [key, family, behavior] of [
      ['sky_wyvern', 'elemental', 'flyer'],
      ['ember_demon', 'demon', 'melee'],
      ['magma_hound', 'cave', 'melee'],
      ['obsidian_golem', 'cave', 'melee'],
    ] as const) {
      const s = modelSpec({ key, family, behavior, element: 0, affix: 0, size: 1, color: '#444444' });
      expect(s.style).toBe(key);
    }
  });
});
