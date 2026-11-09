import { describe, expect, it } from 'vitest';
import { PIECE_KINDS, PROP_KINDS, type TownPiece, type TownProp } from '@lodestone/worldgen';
import { nextStrike, PointGrid, townEmitters } from './emitters';
import { SPACE_OUTDOORS } from './spatial';
import { classifySurface } from './surface';

const prop = (id: number, kind: (typeof PROP_KINDS)[number], x: number, z: number, y = 10): TownProp => ({ index: id, id: BigInt(id), x, y, z, yaw: 0, kind: PROP_KINDS.indexOf(kind), variant: 0, building: -1, settlement: 0, flags: 0, scale: 64, structure: -1 });
const piece = (id: number, kind: (typeof PIECE_KINDS)[number], x: number, z: number): TownPiece => ({ id: BigInt(id), x, y: 5, z, c: 1, s: 0, sx: 1, sy: 1, kind: PIECE_KINDS.indexOf(kind), variant: 0, structure: 0 });

describe('world sound sources from the towns buffer', () => {
  it('every fire prop is a loop of its kind; forges are also smiths; other props are silent', () => {
    const props = [prop(1, 'hearth', 0, 0), prop(2, 'forge', 10, 0), prop(3, 'torch', 20, 0), prop(4, 'brazier', 30, 0), prop(5, 'campfire', 40, 0), prop(6, 'lantern', 50, 0), prop(7, 'table', 60, 0)];
    const { fires, hammers } = townEmitters({ props, pieces: [] }, (x) => (x === 0 ? 7 : SPACE_OUTDOORS));
    expect(fires.map((f) => f.kind)).toEqual(['hearth', 'forge', 'torch', 'brazier', 'campfire']);
    expect(fires[0].space).toBe(7);
    expect(fires[2].y).toBe(10); // a torch's y is its flame
    expect(fires[1].y).toBeGreaterThan(10);
    expect(hammers.map((h) => h.id)).toEqual(['prop:2']);
  });

  it('a camp campfire piece and its prop are one fire', () => {
    const { fires } = townEmitters({ props: [prop(1, 'campfire', 0, 0)], pieces: [piece(9, 'campfire', 0.4, 0.3), piece(10, 'campfire', 50, 50), piece(11, 'tent', 60, 60)] }, () => SPACE_OUTDOORS);
    expect(fires.map((f) => f.id)).toEqual(['prop:1', 'piece:10']);
  });

  it('PointGrid finds what is near', () => {
    const g = new PointGrid([{ x: 5, z: 5 }, { x: 58, z: -40 }, { x: 500, z: 500 }]);
    const near = [...g.near(0, 0, 60)];
    expect(near).toContainEqual({ x: 5, z: 5 });
    expect(near).toContainEqual({ x: 58, z: -40 });
    expect(near).not.toContainEqual({ x: 500, z: 500 });
    expect(g.size).toBe(3);
  });

  it("a smith's rhythm: bursts of quick strikes, then a pause", () => {
    let left = 0;
    const gaps: number[] = [];
    for (let i = 0; i < 200; i++) {
      const n = nextStrike(left);
      gaps.push(n.delayS);
      left = n.left;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(3);
    }
    expect(gaps.every((g) => (g >= 0.38 && g <= 0.52) || (g >= 2.5 && g <= 6))).toBe(true);
    expect(gaps.some((g) => g < 1)).toBe(true);
    expect(gaps.some((g) => g > 2)).toBe(true);
  });
});

describe('footstep surface', () => {
  const base = { underground: 0, box: null, waterDepth: -1, biome: 'meadow', inTown: false };
  it('grass, stone, wood, water, snow', () => {
    expect(classifySurface(base)).toBe('soft');
    expect(classifySurface({ ...base, inTown: true })).toBe('hard');
    expect(classifySurface({ ...base, underground: 0.9 })).toBe('hard');
    expect(classifySurface({ ...base, box: 'floor', inTown: true })).toBe('wood');
    expect(classifySurface({ ...base, box: 'deck' })).toBe('wood');
    expect(classifySurface({ ...base, box: 'townWall' })).toBe('hard');
    expect(classifySurface({ ...base, waterDepth: 0.3 })).toBe('water');
    expect(classifySurface({ ...base, waterDepth: 2 })).toBe('soft');
    expect(classifySurface({ ...base, biome: 'snowpeak' })).toBe('snow');
    expect(classifySurface({ ...base, biome: 'snowpeak', box: 'deck' })).toBe('wood');
  });
});
