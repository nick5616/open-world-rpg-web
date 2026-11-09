import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { packLook } from '../combat/weapons/look';
import type { RemoteView } from './interpolation';

// Avatar draws its nameplate on a canvas: a stub is enough in node.
beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
});

function view(typeId: number): RemoteView {
  return { id: 7, kind: 1, name: 'Wielder', level: 3, healthPct: 100, activity: 0, partyId: 0, typeId, ring: 0, delayMs: 0, x: 10, y: 0, z: 20, yaw: 0, pitch: 0, speed: 0, mode: 'interp' } as unknown as RemoteView;
}

describe('remote avatar weapon (pt/ux)', () => {
  it('holds the weapon its typeId names, in the right hand, and swaps it on change', async () => {
    const { Avatar } = await import('./avatar');
    const a = new Avatar(7);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(10, 1.6, 24);
    a.update(view(0), cam, 0.016);
    expect(a.weaponMesh).toBeNull();

    a.update(view(packLook({ weapon: 'sword', material: 'sunsteel', gem: 5 })), cam, 0.016);
    const m = a.weaponMesh!;
    expect(m).not.toBeNull();
    expect(m.geometry.name).toBe('weapon:sword|sunsteel|5:1');
    a.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(m);
    // in the right hand (+X of a yaw-0 avatar at x = 10), around hand height, reaching forward (-Z)
    const c = box.getCenter(new THREE.Vector3());
    expect(c.x).toBeGreaterThan(10.2);
    expect(c.y).toBeGreaterThan(0.5);
    expect(c.y).toBeLessThan(1.4);
    expect(box.min.z).toBeLessThan(19.7);

    a.update(view(packLook({ weapon: 'bow', material: '', gem: -1 })), cam, 0.016);
    expect(a.weaponMesh!.geometry.name).toBe('weapon:bow||-1:1');
    a.root.updateMatrixWorld(true);
    expect(new THREE.Box3().setFromObject(a.weaponMesh!).getCenter(new THREE.Vector3()).x).toBeLessThan(10); // the bow is in the left hand
  });
});
