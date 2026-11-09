// Playtest 1: overhead health bars face the camera from any angle (they
// used to turn with the enemy's body and vanish from behind).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { faceCamera } from './CombatLayer';

describe('faceCamera', () => {
  it('gives the plate the camera rotation whatever the parent yaw', () => {
    const cam = new THREE.PerspectiveCamera();
    const scene = new THREE.Scene();
    scene.add(cam);
    for (const yaw of [0, 0.7, Math.PI / 2, Math.PI, -2.5]) {
      for (const camYaw of [0, Math.PI, 1.3]) {
        const root = new THREE.Group();
        root.position.set(10, 0, -4);
        root.rotation.y = yaw;
        const plate = new THREE.Group();
        plate.position.y = 2;
        root.add(plate);
        scene.add(root);
        cam.position.set(10 + 5 * Math.sin(camYaw), 2, -4 + 5 * Math.cos(camYaw));
        cam.rotation.set(-0.2, camYaw, 0, 'YXZ');
        cam.updateMatrixWorld(true);
        faceCamera(plate, cam);
        plate.updateWorldMatrix(true, false);
        const q = plate.getWorldQuaternion(new THREE.Quaternion());
        expect(q.angleTo(cam.quaternion)).toBeLessThan(1e-6);
        // The plate's front (+z) points at the camera side: visible.
        const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
        const toCam = cam.position.clone().sub(plate.getWorldPosition(new THREE.Vector3())).normalize();
        expect(n.dot(toCam)).toBeGreaterThan(0.5);
        scene.remove(root);
      }
    }
  });
});
