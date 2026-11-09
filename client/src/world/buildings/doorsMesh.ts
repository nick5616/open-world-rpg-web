// Door leaves (playtest follow-up to WP20): every closable door near the
// camera as one InstancedMesh (one draw call, plus its shadow passes, for
// all of them). Each leaf hangs on a hinge at the inner face of the wall
// and swings from closed (across the doorway) to open (into the room,
// against the jamb) over ~0.45 s when its state changes at the local
// player's current movement step: the same moment the collision changes.
// Doorways wider than 1.6 m (inns) get two leaves.

import * as THREE from 'three';
import type { TownDoors } from '@lodestone/worldgen';
import { at, dirOf, frameOf, MeshBuilder, type V3 } from './meshBuilder';
import { P } from './props';
import { geometryOf } from './townMaterial';

export const DOOR_VIEW_M = 110;
const MAX_LEAVES = 320;
const LEAF_H = 2.28;
const LEAF_T = 0.03;
const OPEN_ANGLE = Math.PI / 2 - 0.15;
const SWING_S = 0.45;

/** Unit leaf: u 0..1 (width), y 0..1 (height), 6 cm thick; planked faces, wood edges. */
function leafGeometry(): THREE.BufferGeometry {
  const mb = new MeshBuilder(64);
  const f = frameOf(0, 0, 0);
  const uv: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  P(mb, 'door');
  const face = (v: number) => {
    const pts: V3[] = [at(f, 0, 0, v), at(f, 1, 0, v), at(f, 1, 1, v), at(f, 0, 1, v)];
    mb.poly(pts, dirOf(f, 0, 0, Math.sign(v)), uv);
  };
  face(-LEAF_T);
  face(LEAF_T);
  P(mb, 'wood', [0.7, 0.7, 0.7]);
  mb.slopedBox(f, 0, 1, -LEAF_T, LEAF_T, 0, 1, 1, { skip: ['-v', '+v'], bottom: true });
  return geometryOf(mb.data());
}

export class DoorRenderer {
  readonly mesh: THREE.InstancedMesh;
  /** Visual openness per door, 0 closed .. 1 open (doors start open). */
  readonly open: Float32Array;
  /** Doors within reach of the camera this frame (interaction candidates). */
  readonly near: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    readonly doors: TownDoors,
    material: THREE.Material,
  ) {
    this.mesh = new THREE.InstancedMesh(leafGeometry(), material, MAX_LEAVES);
    this.mesh.name = 'door-leaves';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // one draw for every leaf near the camera
    this.mesh.count = 0;
    this.open = new Float32Array(doors.count).fill(1);
  }

  /** Per frame: animate toward each door's state and write the leaves near the camera. */
  update(cam: THREE.Vector3, dt: number, isOpen: (d: number) => boolean, reach: number): void {
    const ds = this.doors;
    let n = 0;
    this.near.length = 0;
    const k = Math.min(1, dt / SWING_S);
    for (const door of ds.doors) {
      const dx = door.x - cam.x;
      const dz = door.z - cam.z;
      if (Math.abs(dx) > DOOR_VIEW_M || Math.abs(dz) > DOOR_VIEW_M) continue;
      const d = door.index;
      const target = isOpen(d) ? 1 : 0;
      const a = this.open[d];
      this.open[d] = a < target ? Math.min(target, a + k) : Math.max(target, a - k);
      if (Math.abs(dx) < reach && Math.abs(dz) < reach) this.near.push(d);
      const leaves = door.width > 1.6 ? 2 : 1;
      const lw = door.width / leaves - 0.03;
      // Ease in-out so the swing starts and stops softly.
      const e = this.open[d];
      const th = (e * e * (3 - 2 * e)) * OPEN_ANGLE;
      const f = frameOf(door.x, door.z, door.yaw);
      for (let l = 0; l < leaves && n < MAX_LEAVES; l++) {
        const side = leaves === 1 ? -1 : l === 0 ? -1 : 1;
        // Hinge at the jamb, on the inner face of the wall.
        const h = at(f, side * (door.width * 0.5 - 0.02), door.y + 0.02, door.thick * 0.5 - LEAF_T - 0.01);
        // Closed: the leaf runs from the hinge across the doorway (-side u); open: into the room (+v).
        const dir = dirOf(f, -side * Math.cos(th), 0, Math.sin(th));
        this.q.setFromAxisAngle(this.up, Math.atan2(-dir[2], dir[0]));
        this.p.set(h[0], h[1], h[2]);
        this.s.set(lw, LEAF_H, 1);
        this.m.compose(this.p, this.q, this.s);
        this.mesh.setMatrixAt(n++, this.m);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
