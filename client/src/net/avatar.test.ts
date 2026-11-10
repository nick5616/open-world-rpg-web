import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { COMBAT, type Event as ZoneEvent } from '@lodestone/contracts';
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
    expect(m.geometry.name).toBe('weapon:sword|sunsteel|5:2'); // playtest 2: the first-person detail level
    a.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(m);
    // in the right hand (+X of a yaw-0 avatar at x = 10), around hand height, reaching forward (-Z)
    const c = box.getCenter(new THREE.Vector3());
    expect(c.x).toBeGreaterThan(10.2);
    expect(c.y).toBeGreaterThan(0.5);
    expect(c.y).toBeLessThan(1.4);
    expect(box.min.z).toBeLessThan(19.7);

    a.update(view(packLook({ weapon: 'bow', material: '', gem: -1 })), cam, 0.016);
    expect(a.weaponMesh!.geometry.name).toBe('weapon:bow||-1:2');
    a.root.updateMatrixWorld(true);
    expect(new THREE.Box3().setFromObject(a.weaponMesh!).getCenter(new THREE.Vector3()).x).toBeLessThan(10); // the bow is in the left hand
  });
});

describe('remote archers (CR 033)', () => {
  it("each archer's own bow string comes back with the draw, an arrow on it, and snaps on release", async () => {
    const { Avatar } = await import('./avatar');
    const { classifyAction, CAST_FX_GUARD } = await import('./avatarAnim');
    const { BOW_MAX_DRAW } = await import('../combat/weapons/models');
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(10, 1.6, 24);
    const bow = packLook({ weapon: 'bow', material: '', gem: -1 });
    const a = new Avatar(7);
    const b = new Avatar(8);
    a.update(view(bow), cam, 0.016);
    b.update(view(bow), cam, 0.016);
    const ga = a.weaponMesh!.geometry;
    expect(ga).not.toBe(b.weaponMesh!.geometry); // their own copies: one archer's draw is not everyone's
    const info = ga.userData.weapon as { nock: number[]; arrow: number[]; base: Float32Array };
    const nockZ = (g: THREE.BufferGeometry) => g.getAttribute('position').getZ(info.nock[0]);
    const arrowLen = (g: THREE.BufferGeometry) => {
      const p = g.getAttribute('position');
      const zs = info.arrow.map((i) => p.getZ(i));
      return Math.max(...zs) - Math.min(...zs);
    };
    const rest = info.base[info.nock[0] * 3 + 2];
    expect(nockZ(ga)).toBeCloseTo(rest, 5);
    expect(arrowLen(ga)).toBe(0); // no arrow on the string at rest
    a.anim.trigger(classifyAction(CAST_FX_GUARD, 'bow'));
    for (let i = 0; i < 70; i++) a.update(view(bow), cam, 1 / 60);
    expect(nockZ(ga) - rest).toBeGreaterThan(0.9 * BOW_MAX_DRAW); // drawn all the way back
    expect(arrowLen(ga)).toBeGreaterThan(0.3); // nocked
    expect(nockZ(b.weaponMesh!.geometry)).toBeCloseTo(rest, 5); // the other archer is not drawing
    a.anim.trigger(classifyAction(COMBAT.moves.find((m) => m.key === 'bow_charged')!.id, 'bow'));
    for (let i = 0; i < 6; i++) a.update(view(bow), cam, 1 / 60);
    expect(nockZ(ga) - rest).toBeLessThan(0.02); // loosed
    expect(arrowLen(ga)).toBe(0);
  });
});

describe('remote avatar animation (playtest 2)', () => {
  it('Event 214 swings the sword arm (through their caster record, CR 022); the weapon in the hand moves with it', async () => {
    const { Avatar } = await import('./avatar');
    const { animateFromEvent } = await import('./RemotePlayers');
    const { castState, remoteEvent } = await import('../combat/castState');
    const { followCaster } = await import('./avatarAnim');
    const fx = { remoteCast: () => {}, remoteStream: () => {}, remoteChannelEnd: () => {}, chargeStart: () => {}, shieldBroken: () => {} };
    const a = new Avatar(7);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(10, 1.6, 24);
    const v = view(packLook({ weapon: 'sword', material: '', gem: -1 }));
    for (let i = 0; i < 5; i++) a.update(v, cam, 1 / 60);
    a.root.updateMatrixWorld(true);
    const rest = new THREE.Box3().setFromObject(a.weaponMesh!).getCenter(new THREE.Vector3());
    const slash = COMBAT.moves.find((m) => m.key === 'sword_slash_1')!.id;
    followCaster(a.anim, castState.get(7), a.weaponKind); // first sight
    const routed = remoteEvent({ kind: 214, entityId: 7, targetId: slash, value: 0, x: 0, y: 0, z: 0, data: new Uint8Array(4) } as unknown as ZoneEvent, 1, performance.now(), fx);
    expect(routed).toBe(true);
    followCaster(a.anim, castState.get(7), a.weaponKind);
    expect(a.anim.current).toBe('slash');
    let top = -Infinity;
    for (let i = 0; i < 8; i++) {
      a.update(v, cam, 1 / 60);
      a.root.updateMatrixWorld(true);
      top = Math.max(top, new THREE.Box3().setFromObject(a.weaponMesh!).getCenter(new THREE.Vector3()).y);
    }
    expect(top).toBeGreaterThan(rest.y + 0.4); // raised over the shoulder
    // spell actions are their caster record's; this router only takes hurts, downs and teleports
    expect(animateFromEvent({ kind: 214, entityId: 7, targetId: slash } as unknown as ZoneEvent, new Map([[7, a]]))).toBe(false);
    expect(animateFromEvent({ kind: 222, entityId: 8, targetId: 1 } as unknown as ZoneEvent, new Map([[7, a]]))).toBe(false);
    castState.clear();
  });

  it('LOD: full rig near, simplified to 80 m, no animation beyond', async () => {
    const { Avatar, LOD_LOW_M, LOD_MID_M } = await import('./avatar');
    const a = new Avatar(9);
    const cam = new THREE.PerspectiveCamera();
    const v = view(0);
    cam.position.set(10, 1.6, 20 + LOD_MID_M / 2);
    a.update(v, cam, 1 / 60);
    expect(a.animLevel).toBe(0);
    cam.position.set(10, 1.6, 20 + (LOD_MID_M + LOD_LOW_M) / 2);
    a.update(v, cam, 1 / 60);
    expect(a.animLevel).toBe(1);
    cam.position.set(10, 1.6, 20 + LOD_LOW_M + 10);
    const t = a.anim.time;
    a.update(v, cam, 1 / 60);
    expect(a.animLevel).toBe(2);
    expect(a.anim.time).toBe(t); // the animator isn't even stepped
    // only the figure in use is in the scene graph (the matrix pass skips the others)
    expect(a.root.children.filter((c) => c.type === 'Group' || c.type === 'Mesh').length).toBeLessThanOrEqual(2);
  });

  it('a dense crowd shrinks the full-rig radius to its budget, and it recovers', async () => {
    const { FullRigBudget, LOD_MID_M } = await import('./avatar');
    const b = new FullRigBudget(32);
    for (let i = 0; i < 60; i++) b.step(120);
    expect(b.radius).toBe(8);
    for (let i = 0; i < 200; i++) b.step(5);
    expect(b.radius).toBe(LOD_MID_M);
  });
});
