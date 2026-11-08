// Town collision on hand-built boxes (no wasm): floors within a step, walls
// push the body out, ceilings stop a jump, ramps interpolate, and the
// ground wrapper composes with its base. The golden table pins the same
// code bit for bit against Go on real towns (townGolden.ts).
import { describe, expect, it } from 'vitest';
import { BOX_FLAG, TownCollision, TownGroundCore, type TownBoxes } from '../src/town';

function boxes(list: { cx: number; cz: number; yaw?: number; hx: number; hz: number; y0: number; y1: number; y2?: number; flags: number }[]): TownBoxes {
  const n = list.length;
  const b: TownBoxes = { count: n, f: new Float64Array(n * 9), kind: new Uint8Array(n), flags: new Uint8Array(n), owner: new Uint16Array(n) };
  list.forEach((x, i) => {
    const yaw = x.yaw ?? 0;
    b.f.set([x.cx, x.cz, Math.fround(Math.cos(yaw)), Math.fround(Math.sin(yaw)), x.hx, x.hz, x.y0, x.y1, x.y2 ?? x.y1], i * 9);
    b.flags[i] = x.flags;
  });
  return b;
}

const W = BOX_FLAG.walk;
const S = BOX_FLAG.solid;
const C = BOX_FLAG.ceil;

describe('town collision', () => {
  // A 6 x 6 m room at (100, 100): floor top 10.25, a back wall (+z), a ceiling at 13.
  const col = new TownCollision(
    boxes([
      { cx: 100, cz: 100, hx: 3, hz: 3, y0: 9, y1: 10.25, flags: W | S },
      { cx: 100, cz: 102.85, hx: 3, hz: 0.15, y0: 10.2, y1: 13, flags: S },
      { cx: 100, cz: 100, hx: 2.7, hz: 2.7, y0: 13, y1: 16, flags: W | C },
      // A ramp along +x from 10 to 11 over 4 m, walkable only.
      { cx: 110, cz: 100, hx: 2, hz: 1, y0: 9, y1: 10, y2: 11, flags: W },
    ]),
  );

  it('floors count within a step of the feet', () => {
    expect(col.floorAt(100, 10, 100)).toBe(10.25);
    expect(col.floorAt(100, 9.5, 100)).toBe(-Infinity); // 0.75 above the feet: not a step
    expect(col.floorAt(100, 12.9, 100)).toBe(10.25); // the ceiling block's top (16) is out of reach
    expect(col.floorAt(120, 10, 100)).toBe(-Infinity);
  });

  it('ramps interpolate along local u', () => {
    expect(col.floorAt(110, 10.4, 100)).toBeCloseTo(10.5, 12);
    expect(col.floorAt(108, 10, 100)).toBe(10);
    expect(col.floorAt(112, 10.5, 100)).toBe(11);
  });

  it('walls push the body out by its radius', () => {
    const r = col.collideNew(100, 10.25, 102.5); // body centre 0.2 m from the wall's inner face
    expect(r.z).toBeCloseTo(102.7 - 0.4, 12);
    expect(r.pushZ).toBeLessThan(0);
    expect(r.ceiling).toBe(false);
    // Feet above the wall top: no push.
    expect(col.collideNew(100, 12.5, 102.5).pushZ).toBe(0);
  });

  it('ceilings lower a jump', () => {
    const r = col.collideNew(100, 11.5, 100); // head at 13.4 > ceiling 13
    expect(r.ceiling).toBe(true);
    expect(r.y).toBeCloseTo(13 - 1.9, 12);
  });

  it('the ground wrapper takes the higher of base and town floor at the level', () => {
    const g = new TownGroundCore({ heightAt: () => 10, waterAt: () => -Infinity }, col);
    expect(g.heightAt(100, 100)).toBe(10); // non-step callers see the base
    const v = g.atLevel(10);
    expect(v.heightAt(100, 100)).toBe(10.25);
    expect(v.heightAt(130, 100)).toBe(10);
    const out = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };
    v.collide(100, 10.25, 102.5, out);
    expect(out.pushZ).toBeLessThan(0);
  });
});
