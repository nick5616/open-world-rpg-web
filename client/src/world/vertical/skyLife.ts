// CR 044: life in the sky. Flocks of birds riding the air round every
// archipelago (instanced, matrices written from a closed-form orbit each
// frame: no per-bird state), and wind chimes hanging on the sky towns' and
// palaces' islands that sway and glint. Purely visual; both are skipped on
// the low tier.
import * as THREE from 'three';
import type { VerticalWorld } from '@lodestone/worldgen';

const BIRDS_PER_FLOCK = 9;

function birdGeometry(): THREE.BufferGeometry {
  // A small V of two wings and a body, one draw call for every bird.
  const g = new THREE.BufferGeometry();
  const p = new Float32Array([
    0, 0, 0.5, -1.1, 0.12, -0.2, 0, 0, -0.35, // left wing
    0, 0, 0.5, 0, 0, -0.35, 1.1, 0.12, -0.2, // right wing
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

export class SkyLife {
  readonly group = new THREE.Group();
  private readonly birds: THREE.InstancedMesh;
  private readonly chimes: THREE.InstancedMesh;
  private readonly flocks: { x: number; y: number; z: number; r: number; speed: number; phase: number }[] = [];
  private readonly chimeAt: { x: number; y: number; z: number }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();

  constructor(v: VerticalWorld, low: boolean) {
    for (const a of v.archs) {
      this.flocks.push({ x: a.x, y: a.cloudY + 110, z: a.z, r: a.r * 0.8 + 40, speed: 0.045, phase: (a.x * 0.013) % 6 });
    }
    for (const i of v.islands) {
      if (i.kind === 3 || i.kind === 4) {
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 + i.x;
          this.chimeAt.push({ x: i.x + Math.cos(a) * i.r * 0.82, y: i.top + 7, z: i.z + Math.sin(a) * i.r * 0.82 });
        }
      }
    }
    const bm = new THREE.MeshBasicMaterial({ color: 0x252a34, side: THREE.DoubleSide, fog: true });
    this.birds = new THREE.InstancedMesh(birdGeometry(), bm, Math.max(1, low ? 0 : this.flocks.length * BIRDS_PER_FLOCK));
    this.birds.frustumCulled = false;
    this.birds.count = low ? 0 : this.flocks.length * BIRDS_PER_FLOCK;
    const cg = new THREE.CylinderGeometry(0.05, 0.05, 1, 5);
    cg.translate(0, -0.5, 0);
    const cm = new THREE.MeshStandardMaterial({ color: 0xe8d8a0, emissive: 0x6a5420, metalness: 0.7, roughness: 0.3 });
    this.chimes = new THREE.InstancedMesh(cg, cm, Math.max(1, this.chimeAt.length * 4));
    this.chimes.frustumCulled = false;
    this.chimes.count = low ? 0 : this.chimeAt.length * 4;
    this.group.add(this.birds, this.chimes);
  }

  update(t: number, camera: THREE.Vector3): void {
    if (this.birds.count > 0) {
      let n = 0;
      for (const f of this.flocks) {
        const near = (f.x - camera.x) ** 2 + (f.z - camera.z) ** 2 < 2200 * 2200;
        for (let b = 0; b < BIRDS_PER_FLOCK; b++, n++) {
          if (!near) {
            this.m.makeScale(0, 0, 0);
            this.birds.setMatrixAt(n, this.m);
            continue;
          }
          const a = f.phase + t * f.speed * (1 + (b % 3) * 0.06) + (b / BIRDS_PER_FLOCK) * 0.7;
          const rr = f.r * (0.8 + (b % 4) * 0.1);
          this.p.set(f.x + Math.cos(a) * rr, f.y + Math.sin(t * 0.3 + b * 1.7) * 8 + (b % 5) * 5, f.z + Math.sin(a) * rr);
          // Heading along the orbit; wings flap by scaling the wingspan.
          this.q.setFromEuler(this.e.set(0.12, -a, Math.sin(t * 2.2 + b) * 0.1));
          const flap = 0.9 + Math.sin(t * 6 + b * 2) * 0.25;
          this.s.set(3.2 * flap, 1, 3.2);
          this.m.compose(this.p, this.q, this.s);
          this.birds.setMatrixAt(n, this.m);
        }
      }
      this.birds.instanceMatrix.needsUpdate = true;
    }
    if (this.chimes.count > 0) {
      let n = 0;
      for (const c of this.chimeAt) {
        for (let k = 0; k < 4; k++, n++) {
          const sway = Math.sin(t * (1.1 + k * 0.23) + c.x) * 0.12;
          this.q.setFromEuler(this.e.set(sway, 0, Math.cos(t * (0.9 + k * 0.3) + c.z) * 0.12));
          this.p.set(c.x + (k - 1.5) * 0.35, c.y, c.z);
          this.s.set(1, 1.2 + k * 0.45, 1);
          this.m.compose(this.p, this.q, this.s);
          this.chimes.setMatrixAt(n, this.m);
        }
      }
      this.chimes.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.birds.geometry.dispose();
    this.chimes.geometry.dispose();
  }
}
