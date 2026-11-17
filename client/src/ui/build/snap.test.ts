// CR 041: the build ghost's snapping over the real rules.

import { describe, expect, it } from 'vitest';
import { CAMPS } from '@lodestone/contracts';
import type { BP } from './geometry';
import { REFUSE, type BuildEnv } from './rules';
import { aimPiece, aimPoint, isEdgePiece, snap, turnStep } from './snap';

const id = (key: string) => CAMPS.pieces.find((p) => p.key === key)!.id;
const env: BuildEnv = { heightAt: () => 10, waterAt: () => -100, noBuild: () => 0, structure: () => false };
const bp = (key: string, x: number, y: number, z: number, rot = 0, i = 1): BP => ({ id: i, kind: id(key), rot, x: x * 100, y: y * 100, z: z * 100, state: 0, owner: '@me', party: 1, lock: 0 });
const feet = { x: 1001, y: 10, z: 1006 };
const input = (key: string, px: number, pz: number, all: BP[], rot = 0, py = 10) => ({ kind: id(key), rot, px, py, pz, feet, owner: '@me', party: 1, all, env });

describe('build snapping', () => {
  it('a foundation snaps to the cell centre and the ground', () => {
    const r = snap(input('foundation_wood', 1000.3, 1003.2, []));
    expect(r).toMatchObject({ reason: 0, x: 100100, z: 100300, y: 1000 });
  });

  it('a wall takes the nearer grid line, whichever way you turn it', () => {
    const f = bp('foundation_stone', 1001, 10, 1001);
    const north = snap(input('wall_stone', 1001.2, 1000.2, [f]));
    expect(north).toMatchObject({ reason: 0, x: 100100, z: 100000, y: 1000, rot: 0 });
    const west = snap(input('wall_stone', 1000.2, 1001.1, [f]));
    expect(west).toMatchObject({ reason: 0, x: 100000, z: 100100, rot: 2, y: 1000 });
    // R flips the facing (4), keeping the line.
    expect(snap(input('wall_stone', 1001.2, 1000.2, [f], 4)).rot).toBe(4);
    expect(isEdgePiece(id('wall_stone'))).toBe(true);
    expect(turnStep(id('wall_stone'))).toBe(4);
    expect(turnStep(id('stairs_wood'))).toBe(2);
  });

  it('a wall with nothing under it is red with the reason', () => {
    const r = snap(input('wall_wood', 1003.2, 1004.2, []));
    expect(r.reason).toBe(REFUSE.support);
  });

  it('a floor finds the wall tops as its height', () => {
    const all = [bp('foundation_wood', 1001, 10, 1001, 0, 1), bp('wall_wood', 1001, 10, 1000, 0, 2), bp('wall_wood', 1001, 10, 1002, 4, 3)];
    const r = snap(input('floor_wood', 1001, 1001, all, 0, 12.5));
    expect(r).toMatchObject({ reason: 0, y: 1250, x: 100100, z: 100100 });
  });

  it('furnishings snap to half metres and stand on the foundation', () => {
    const f = bp('foundation_wood', 1001, 10, 1001);
    const r = snap(input('table', 1001.3, 1001.2, [f]));
    expect(r).toMatchObject({ reason: 0, x: 100150, z: 100100, y: 1000 });
  });

  it('stairs meet a floor edge or the ground', () => {
    const r = snap(input('stairs_wood', 1006.2, 1001.1, []));
    expect(r.reason).toBe(0);
    expect(r.y).toBe(1000);
  });

  it('aims: the ray lands on the ground, and the piece under the crosshair is found', () => {
    const p = aimPoint({ x: 0, y: 11.6, z: 0 }, { x: 0, y: -0.5, z: -Math.sqrt(0.75) }, () => 10, () => null);
    expect(p.hit).toBe(true);
    expect(p.y).toBe(10);
    const wall = bp('wall_stone', 1001, 10, 1000);
    const hit = aimPiece({ x: 1001, y: 11.6, z: 1004 }, { x: 0, y: -0.15, z: -0.9887 }, [wall]);
    expect(hit?.id).toBe(1);
    expect(aimPiece({ x: 1001, y: 11.6, z: 1004 }, { x: 1, y: 0, z: 0 }, [wall])).toBeNull();
  });
});
