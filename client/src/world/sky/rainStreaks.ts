// Rain streaks around the camera (moved here from WP15's NightLayer in
// playtest 2 so solo play shows rain too: the world scene now owns the
// whole look of a shower, streaks plus wet ground, overcast sky and thicker
// air). 1800 line segments in a 60 m box that follows the camera, leaning
// downwind; one draw call, hidden when dry.

import * as THREE from 'three';
import { windState } from '../wind';

const RAIN = 1800;

export class RainStreaks {
  readonly object: THREE.LineSegments;
  private readonly pos = new Float32Array(RAIN * 6);
  private readonly drops = new Float32Array(RAIN * 3);

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.object = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#9fb4c8', transparent: true, opacity: 0.45 }));
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.name = 'rain';
    // Random offsets around the camera, each with its own phase.
    for (let i = 0; i < RAIN; i++) {
      this.drops[i * 3] = (Math.random() - 0.5) * 60;
      this.drops[i * 3 + 1] = (Math.random() - 0.5) * 60;
      this.drops[i * 3 + 2] = Math.random() * 30;
    }
  }

  /** `amount` 0..1 (eased rain): drawn above 0.15, underground never. */
  update(camera: THREE.Camera, dt: number, amount: number): void {
    const on = amount > 0.15;
    this.object.visible = on;
    if (!on) return;
    (this.object.material as THREE.LineBasicMaterial).opacity = 0.45 * Math.min(1, (amount - 0.15) / 0.5);
    const p = this.pos;
    const d = this.drops;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    for (let i = 0; i < RAIN; i++) {
      d[i * 3 + 2] -= dt * 18;
      if (d[i * 3 + 2] < -6) d[i * 3 + 2] += 30;
      const x = cx + d[i * 3] + windState.dirX * 0.4 * d[i * 3 + 2];
      const z = cz + d[i * 3 + 1] + windState.dirZ * 0.4 * d[i * 3 + 2];
      const y = cy + d[i * 3 + 2] - 6;
      p[i * 6] = x;
      p[i * 6 + 1] = y;
      p[i * 6 + 2] = z;
      p[i * 6 + 3] = x - windState.dirX * 0.2;
      p[i * 6 + 4] = y - 0.7;
      p[i * 6 + 5] = z - windState.dirZ * 0.2;
    }
    (this.object.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}
