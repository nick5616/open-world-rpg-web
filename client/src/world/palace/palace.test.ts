// CR 044: the palace boxes and wind shafts are the zone's, to the bit
// (server/pkg/palace testdata/golden.json), and the layout is walkable.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PALACE } from '@lodestone/contracts';
import { TownCollision, type Towns } from '@lodestone/worldgen';
import { appendPalaceBoxes, newPalaceSite, palaceColumns, palaceWorld } from './palaceSites';

const golden = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../server/pkg/palace/testdata/golden.json'), 'utf8')) as { sites: number[][]; boxes: string[][]; cols: string[][] };

const bits = (v: number): string => {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v);
  return b.getBigUint64(0).toString(16).padStart(16, '0');
};

function emptyTowns(): Towns {
  return { boxes: { count: 0, f: new Float64Array(0), kind: new Uint8Array(0), flags: new Uint8Array(0), owner: new Uint16Array(0) } } as unknown as Towns;
}

describe('sky palace twin of server/pkg/palace', () => {
  it('appends the same boxes, bit for bit', () => {
    golden.sites.forEach((s, k) => {
      const t = emptyTowns();
      const site = newPalaceSite(1, s[0], s[1], s[2], s[3]);
      appendPalaceBoxes(t, [site]);
      const row: string[] = [];
      for (const f of t.boxes.f) row.push(bits(f));
      for (let i = 0; i < t.boxes.count; i++) row.push(bits(t.boxes.kind[i]), bits(t.boxes.flags[i]));
      expect(row.length).toBe(golden.boxes[k].length);
      expect(row).toEqual(golden.boxes[k]);
    });
  });

  it('has the same atrium shaft', () => {
    golden.sites.forEach((s, k) => {
      const c = palaceColumns([newPalaceSite(1, s[0], s[1], s[2], s[3])])[0];
      expect([c.x, c.z, c.r, c.top, c.lift].map(bits)).toEqual(golden.cols[k]);
    });
  });

  it('lets you walk from the steps through the gate to the colonnade and the sun gallery', () => {
    const t = emptyTowns();
    const site = newPalaceSite(1, 1000, 700, 800, 27404);
    appendPalaceBoxes(t, [site]);
    const col = new TownCollision(t.boxes);
    const out = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };
    const path: [number, number][] = [
      [0, 52],
      [0, 33],
      [0, 16],
      [-10, 16],
      [-21, 16],
    ];
    for (let i = 0; i + 1 < path.length; i++) {
      const [ax, az] = path[i];
      const [bx, bz] = path[i + 1];
      const n = Math.hypot(bx - ax, bz - az) * 4;
      for (let k = 0; k <= n; k++) {
        const [x, z] = palaceWorld(site, ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
        const r = col.collide(x, site.floor, z, out);
        expect(r.pushX === 0 && r.pushZ === 0).toBe(true);
      }
    }
    const [wx, wz] = palaceWorld(site, -27, 10);
    const r = col.collide(wx, site.floor, wz, out);
    expect(r.pushX !== 0 || r.pushZ !== 0).toBe(true);
    const [fx, fz] = palaceWorld(site, 0, 16);
    expect(col.floorAt(fx, site.floor + 0.2, fz)).toBe(site.floor);
    expect(PALACE.boxes.length).toBeGreaterThan(60);
  });
});
