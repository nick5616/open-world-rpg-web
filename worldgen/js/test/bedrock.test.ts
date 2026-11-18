// Playtest 5 ("the underground has an invisible floor"): the world has a real bottom, under the
// deepest content. A fall that no layer and no cave catches ends on bedrock; it does not go on
// for ever (and the ground never gets lifted to the surface either). Go twin:
// server/pkg/vertical/bedrock_test.go.
import { describe, expect, it } from 'vitest';
import { VC, VerticalGroundCore, type VerticalWorld } from '../src/vertical';

const NONE: VerticalWorld = {
  genVersion: 3,
  baseSites: 0,
  archs: [],
  islands: [],
  updrafts: [],
  chambers: [],
  corridors: [],
  openings: [],
  surfaceOpenings: [],
  gateOpenings: [],
  shafts: [],
  columns: [],
  decos: [],
  veins: [],
  domain: [new Uint8Array(512), new Uint8Array(512), new Uint8Array(512)],
};

/** Open air under a hillside: the cave ground keeps you falling (floor = 35 m under the feet). */
const falling = {
  heightAt: () => 120,
  atLevel: (y: number) => ({ heightAt: () => y - 35 }),
};

describe('the bottom of the world', () => {
  const g = new VerticalGroundCore(falling, NONE, { height: () => 0 });

  it('is deeper than the Depths and their snap band', () => {
    expect(VC.bedrock).toBeLessThan(-454.6 - VC.ext);
  });

  it('a fall that nothing catches ends on bedrock', () => {
    expect(g.floorAt(10, -460, 10)).toBe(-495); // still falling (y - 35)
    expect(g.floorAt(10, -480, 10)).toBe(VC.bedrock);
    expect(g.floorAt(10, -900, 10)).toBe(VC.bedrock);
    expect(g.atLevel(-2000).heightAt(10, 10)).toBe(VC.bedrock);
  });

  it('is only a floor: nothing above it changes', () => {
    expect(g.floorAt(10, -100, 10)).toBe(-135);
    expect(g.floorAt(10, 200, 10)).toBe(165);
  });
});
