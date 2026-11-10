import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ITEMS } from '@lodestone/contracts';
import { buildWeapon, fistGeometry, forearmGeometry, setBowDraw, weaponGeometry, weaponTriangles, BOW_MAX_DRAW, type Detail } from './models';
import { WEAPON_KINDS, lookKey, materialCode, materialKey, packLook, unpackLook, type WeaponLook } from './look';
import { decodeSync } from '../events';

const BUDGET: Record<Detail, number> = { 2: 3000, 1: 600, 0: 200 };

// Expected overall size (m): [min, max] of the longest bounding-box side.
const LENGTH: Record<string, [number, number]> = { sword: [0.9, 1.1], spear: [2.2, 2.5], bow: [1.3, 1.5], staff: [1.6, 1.9], wand: [0.35, 0.45] };

function finite(g: THREE.BufferGeometry): boolean {
  const a = g.getAttribute('position').array;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  const n = g.getAttribute('normal').array;
  for (let i = 0; i < n.length; i++) if (!Number.isFinite(n[i])) return false;
  return true;
}

describe('weapon models', () => {
  for (const weapon of WEAPON_KINDS)
    for (const d of [2, 1, 0] as Detail[])
      it(`${weapon} detail ${d}: within the triangle budget, sane bounds, finite`, () => {
        for (const look of [
          { weapon, material: '', gem: -1 },
          { weapon, material: 'sunsteel', gem: 5 },
        ] as WeaponLook[]) {
          const g = buildWeapon(look, d);
          const tris = weaponTriangles(g);
          expect(tris).toBeGreaterThan(d === 0 ? 20 : 100);
          expect(tris).toBeLessThanOrEqual(BUDGET[d]);
          expect(g.index!.count / 3).toBe(tris);
          expect(finite(g)).toBe(true);
          const size = g.boundingBox!.getSize(new THREE.Vector3());
          const longest = Math.max(size.x, size.y, size.z);
          expect(longest).toBeGreaterThanOrEqual(LENGTH[weapon][0]);
          expect(longest).toBeLessThanOrEqual(LENGTH[weapon][1]);
          // the grip (origin) is inside the weapon's extent along its axis
          expect(g.boundingBox!.min.y).toBeLessThan(0);
          expect(g.boundingBox!.max.y).toBeGreaterThan(0);
          // one geometry with the attributes the shared material reads
          for (const a of ['position', 'normal', 'color', 'surf']) expect(g.getAttribute(a)).toBeTruthy();
        }
      });

  it('is deterministic', () => {
    for (const weapon of WEAPON_KINDS) {
      const a = buildWeapon({ weapon, material: 'iron', gem: 3 }, 2).getAttribute('position').array;
      const b = buildWeapon({ weapon, material: 'iron', gem: 3 }, 2).getAttribute('position').array;
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });

  it('caches geometries by look and detail', () => {
    const l: WeaponLook = { weapon: 'sword', material: 'sunsteel', gem: 1 };
    expect(weaponGeometry(l, 2)).toBe(weaponGeometry({ ...l }, 2));
    expect(weaponGeometry(l, 1)).not.toBe(weaponGeometry(l, 2));
    expect(weaponGeometry(l, 2)).not.toBe(weaponGeometry({ ...l, gem: 2 }, 2));
  });

  it('colours the socketed gem by element and makes sunsteel glow', () => {
    const glowOf = (g: THREE.BufferGeometry) => {
      const s = g.getAttribute('surf').array;
      let max = 0;
      for (let i = 2; i < s.length; i += 3) max = Math.max(max, s[i]);
      return max;
    };
    const plain = buildWeapon({ weapon: 'sword', material: '', gem: -1 }, 2);
    const sun = buildWeapon({ weapon: 'sword', material: 'sunsteel', gem: -1 }, 2);
    const gem = buildWeapon({ weapon: 'sword', material: '', gem: 0 }, 2);
    expect(glowOf(plain)).toBe(0);
    expect(glowOf(sun)).toBeGreaterThan(0.5);
    expect(glowOf(gem)).toBeGreaterThanOrEqual(1);
    // a fire gem adds reddish glowing vertices
    const c = gem.getAttribute('color').array;
    const s = gem.getAttribute('surf').array;
    let red = 0;
    for (let i = 0; i < s.length / 3; i++) if (s[i * 3 + 2] >= 1 && c[i * 3] > c[i * 3 + 2] * 1.5) red++;
    expect(red).toBeGreaterThan(10);
  });

  it('first-person bow: the string and arrow follow the draw', () => {
    const g = buildWeapon({ weapon: 'bow', material: '', gem: -1 }, 2);
    const info = g.userData.weapon as { nock: number[]; arrow: number[] };
    expect(info.nock.length).toBe(8);
    expect(info.arrow.length).toBeGreaterThan(20);
    const pos = g.getAttribute('position');
    const z0 = pos.getZ(info.nock[0]);
    setBowDraw(g, BOW_MAX_DRAW, true);
    expect(pos.getZ(info.nock[0])).toBeCloseTo(z0 + BOW_MAX_DRAW, 5);
    // arrow hidden at rest: collapsed to a point
    setBowDraw(g, 0, false);
    const a0 = new THREE.Vector3().fromBufferAttribute(pos, info.arrow[0]);
    const a1 = new THREE.Vector3().fromBufferAttribute(pos, info.arrow[info.arrow.length - 1]);
    expect(a0.distanceTo(a1)).toBe(0);
  });

  it('hands are small and cached', () => {
    expect(fistGeometry()).toBe(fistGeometry());
    expect(forearmGeometry().index!.count / 3).toBeLessThan(320); // playtest 2: a sleeve cuff
    expect(fistGeometry().index!.count / 3).toBeLessThan(2000); // playtest 2: an anatomical fist (hands.test.ts)
  });
});

describe('weapon look (player typeId)', () => {
  it('packs and unpacks', () => {
    for (const weapon of WEAPON_KINDS)
      for (const material of ['', ...ITEMS.materials.map((m) => m.key)])
        for (let gem = -1; gem < 8; gem++) {
          const l: WeaponLook = { weapon, material, gem };
          const t = packLook(l);
          expect(t).toBeLessThan(1 << 12);
          expect(lookKey(unpackLook(t))).toBe(lookKey(l));
        }
    expect(unpackLook(0)).toEqual({ weapon: null, material: '', gem: -1 });
    expect(unpackLook(undefined).weapon).toBeNull();
  });

  it('reads the per-loadout material codes at the end of combat_sync (and tolerates their absence)', () => {
    const b: number[] = [1, 0];
    for (let l = 0; l < 2; l++) {
      b.push(1);
      for (let k = 0; k < 8; k++) b.push(0);
      b.push(l === 0 ? 5 : 0xff);
    }
    b.push(0, 0, 0, 1000 & 0xff, 1000 >> 8, 3, 2, 0, 4);
    const old = decodeSync(new Uint8Array(b))!;
    expect(old.level).toBe(4);
    expect(old.loadouts[0].material).toBeUndefined();
    const s = decodeSync(new Uint8Array([...b, materialCode('sunsteel'), 0]))!;
    expect(s.loadouts[0]).toMatchObject({ weapon: 'sword', gem: 5, material: 6 });
    expect(s.loadouts[1].material).toBe(0);
  });

  it('matches the documented layout (contracts/events.md, Go weaponlook.go)', () => {
    // sword (id 1), sunsteel (items.yaml index 5 -> code 6), light gem (element 5 -> 6)
    expect(materialCode('sunsteel')).toBe(6);
    expect(packLook({ weapon: 'sword', material: 'sunsteel', gem: 5 })).toBe(1 | (6 << 4) | (6 << 8));
    expect(packLook({ weapon: 'bow', material: '', gem: -1 })).toBe(3);
    expect(materialKey(0)).toBe('');
    expect(materialKey(15)).toBe('');
  });
});
