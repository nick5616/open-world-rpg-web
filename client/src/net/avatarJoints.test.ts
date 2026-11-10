// Playtest 2 ("make the model's arms connect to their body"): the avatar's
// shoulders sit at the top corners of its torso, every upper arm's ball is
// inside the torso's deltoid cap whatever the arm does, and the elbows and
// knees stay closed when they bend, in every pose the animator makes, with
// the same draw calls as before.

import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Activity, CONTENT } from '@lodestone/contracts';
import { packLook } from '../combat/weapons/look';
import type { RemoteView } from './interpolation';
import type { ActionKind } from './avatarAnim';

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
});

const ACTIONS: ActionKind[] = ['slash', 'thrust', 'spin', 'plunge', 'bow', 'bolt', 'bonk', 'cast', 'castStaff', 'castBig', 'castBeam', 'shield', 'form', 'dash', 'dodge', 'parry', 'charge', 'draw', 'mine', 'jet', 'skate', 'soar', 'rush'];

interface Limb {
  shoulder: THREE.Group;
  elbow: THREE.Group;
  hand: THREE.Group;
}
interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
}
type Rig = { armL: Limb; armR: Limb; legL: Leg; legR: Leg; torso: THREE.Group; high: THREE.Group };

function view(typeId: number, activity = 0, speed = 0): RemoteView {
  return { id: 7, kind: 1, name: 'Poser', level: 3, healthPct: 100, activity, partyId: 0, typeId, ring: 0, delayMs: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed, mode: 'interp' } as unknown as RemoteView;
}

describe('avatar shoulders and joints (playtest 2)', () => {
  it('the upper arm ball sits inside the deltoid cap, and the cap is in the torso at its top corner', async () => {
    const { AVATAR_RIG, ARM_R, DELTOID, TORSO_PROFILE } = await import('./avatar');
    const S = AVATAR_RIG.SHOULDER;
    // inside the cap at any arm angle (the arm turns about the joint, the ball's centre)
    expect(Math.hypot(S.x - DELTOID.x, S.y - DELTOID.y) + ARM_R).toBeLessThanOrEqual(DELTOID.r);
    // the torso's half width at the cap's height reaches well into the cap
    let w = 0;
    for (let i = 0; i < TORSO_PROFILE.length - 1; i++) {
      const [y0, x0] = TORSO_PROFILE[i];
      const [y1, x1] = TORSO_PROFILE[i + 1];
      if (DELTOID.y >= y0 && DELTOID.y <= y1) w = x0 + ((x1 - x0) * (DELTOID.y - y0)) / (y1 - y0);
    }
    expect(w).toBeGreaterThan(DELTOID.x - DELTOID.r * 0.7);
    // ... and the shoulder line is the torso's widest: its top corners
    expect(Math.max(...TORSO_PROFILE.map((p) => p[1]))).toBeLessThan(S.x);
    expect(Math.max(...TORSO_PROFILE.map((p) => p[1]))).toBeGreaterThan(S.x - ARM_R - 0.01);
    // the hips (the thighs' balls) are inside the torso too
    const hip = TORSO_PROFILE.find((p) => p[0] >= -AVATAR_RIG.TORSO_Y)!;
    expect(hip[1]).toBeGreaterThan(AVATAR_RIG.HIP_X + 0.05);
  });

  it('in every pose: shoulders inside the chest, elbows and knees closed, the same draw calls', async () => {
    const { Avatar, AVATAR_RIG } = await import('./avatar');
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 1.6, 3);
    const a = new Avatar(7, { nameplate: false });
    const rig = a as unknown as Rig;
    a.update(view(0), cam, 1 / 60); // the full rig joins the graph
    const chest = (() => {
      let c: THREE.Mesh | null = null;
      a.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.name === 'avatar-torso') c = o as THREE.Mesh;
      });
      return c!;
    })();
    expect(chest).not.toBeNull();
    const P = new THREE.Vector3();
    const Q = new THREE.Vector3();
    let poses = 0;
    const check = (label: string) => {
      a.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(chest);
      for (const arm of [rig.armL, rig.armR]) {
        arm.shoulder.getWorldPosition(P);
        expect(box.containsPoint(P), `${label}: shoulder inside the chest`).toBe(true);
        // the upper arm's lower ball is centred on the elbow joint (the forearm's top ball)
        arm.shoulder.localToWorld(Q.set(0, -AVATAR_RIG.UPPER_ARM, 0));
        expect(Q.distanceTo(arm.elbow.getWorldPosition(P)), `${label}: elbow`).toBeLessThan(1e-6);
      }
      for (const leg of [rig.legL, rig.legR]) {
        leg.hip.getWorldPosition(P);
        expect(box.containsPoint(P), `${label}: hip inside the torso`).toBe(true);
        leg.hip.localToWorld(Q.set(0, -AVATAR_RIG.THIGH, 0));
        expect(Q.distanceTo(leg.knee.getWorldPosition(P)), `${label}: knee`).toBeLessThan(1e-6);
      }
      // draw calls of the rider's figure: 13 body parts (as before playtest 2's reshaping) plus the weapon or a held prop (instruments and the steed are their own)
      let meshes = 0;
      const props = new Set(['lute', 'flute', 'drum', 'bell']);
      const inProp = (o: THREE.Object3D | null): boolean => !!o && (props.has(o.name) || inProp(o.parent));
      rig.high.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh && !inProp(o) && !(o as THREE.Sprite).isSprite) meshes++;
      });
      expect(meshes, `${label}: draw calls`).toBeLessThanOrEqual(15);
      poses++;
    };
    const run = (v: RemoteView, steps: number) => {
      for (let i = 0; i < steps; i++) a.update(v, cam, 1 / 60);
    };
    for (const weapon of ['sword', 'spear', 'bow', 'staff', 'wand'] as const) {
      const v = view(packLook({ weapon, material: '', gem: 0 }));
      run(v, 30);
      check(`${weapon} idle`);
      for (const kind of ACTIONS) {
        a.anim.trigger({ kind, durMs: 600, color: '#ff8a3c', dir: 1, hold: false });
        for (const t of [0.2, 0.5, 0.8]) {
          run(v, 12);
          check(`${weapon} ${kind} ${t}`);
        }
      }
    }
    const bare = view(0);
    for (const e of CONTENT.emotes.list) {
      a.anim.emote(e.id);
      run(bare, 40);
      check(`emote ${e.id}`);
    }
    for (const inst of CONTENT.instruments.list) {
      const { EMOTE_PLAYING } = await import('./avatarAnim');
      a.anim.emote(EMOTE_PLAYING, inst.id);
      run(bare, 40);
      check(`instrument ${inst.pose}`);
    }
    for (const act of [Activity.climbing, Activity.gliding, Activity.swimming, Activity.airborne]) {
      run(view(0, act, 4), 60);
      check(`activity ${act}`);
    }
    run(view(packLook({ weapon: 'sword', material: '', gem: 0 }), 0, 7.8), 60);
    check('sprint');
    const { TYPE_RIDING } = await import('../ui/mounts/events');
    run(view(packLook({ weapon: 'sword', material: '', gem: 0 }) | TYPE_RIDING, 0, 6), 60);
    check('riding');
    expect(poses).toBeGreaterThan(300);
  });
});
