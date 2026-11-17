import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDwarfDecos } from './dwarfDecos';
import { CHEST_COOLDOWN_MS, DW, DECO_INTERACT, isDwarfChamber, isWarmKind } from './dwarfKinds';

describe('dwarven decorations (CR 043)', () => {
  it('knows the dwarves chambers and warm kinds', () => {
    expect(isDwarfChamber(5)).toBe(false);
    expect(isDwarfChamber(6) && isDwarfChamber(8)).toBe(true);
    expect(isWarmKind(DW.brazier)).toBe(true);
    expect(isWarmKind(DW.bones)).toBe(false);
    expect(CHEST_COOLDOWN_MS).toBeGreaterThan(0);
  });

  it('builds every kind and swings a chest lid open', () => {
    const mk = (kind: number, flags = 0) => ({ x: 10, y: -50, z: 20, size: 3, kind, tint: 6, layer: 2, flags, yaw: 1000, aux: 0 });
    const decos = Object.values(DW).map((k) => mk(k, k === DW.chest || k === DW.tablet ? DECO_INTERACT : 0));
    const added: THREE.Object3D[] = [];
    const mat = new THREE.MeshStandardMaterial();
    const set = buildDwarfDecos(
      decos,
      (d) => d.layer,
      {
        glowMaterial: () => mat,
        instanced: (geo, m, list, place) => {
          const im = new THREE.InstancedMesh(geo, m, list.length);
          const mm = new THREE.Matrix4();
          list.forEach((d, i) => {
            place(d, mm);
            im.setMatrixAt(i, mm);
          });
          return im;
        },
        compose: (m, x, y, z, yaw, sx, sy = sx, sz = sx) => m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(sx, sy, sz)),
        add: (_l, o) => {
          if (o) added.push(o);
        },
      },
      [{ x: 0, z: 0, r: 3, y0: -60, y1: -10, layer: 2 }],
    );
    // 18 kinds, the chest has base and lid, plus the colonnade.
    expect(added.length).toBe(Object.keys(DW).length + 1 + 1);
    const idx = decos.findIndex((d) => d.kind === DW.chest);
    const lid = added[added.length - 1] as THREE.InstancedMesh;
    expect(lid).toBeTruthy();
    const before = new THREE.Matrix4();
    lid.getMatrixAt(0, before);
    set.openChest(idx);
    const after = new THREE.Matrix4();
    lid.getMatrixAt(0, after);
    expect(after.equals(before)).toBe(false);
  });
});
