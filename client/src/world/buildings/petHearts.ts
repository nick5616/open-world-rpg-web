// Little hearts that rise from a petted animal (playtest 5, CR 054): one
// Points object (one draw call) with a heart drawn in the fragment shader,
// a fixed pool recycled in order, soft and warm, fading as they climb.

import * as THREE from 'three';

const MAX = 14;
const LIFE_S = 1.5;

const VERT = /* glsl */ `
attribute float aAge;
attribute float aSize;
varying float vAge;
void main() {
  vAge = aAge;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float grow = smoothstep(0.0, 0.18, aAge);
  gl_PointSize = aAge < 0.0 ? 0.0 : clamp(aSize * grow * 340.0 / max(-mv.z, 0.2), 0.0, 64.0);
}
`;

const FRAG = /* glsl */ `
varying float vAge;
void main() {
  vec2 p = (gl_PointCoord - vec2(0.5, 0.56)) * 2.5;
  p.y = -p.y;
  float a = p.x * p.x + p.y * p.y - 1.0;
  float h = a * a * a - p.x * p.x * p.y * p.y * p.y;
  if (h > 0.0) discard;
  float fade = 1.0 - smoothstep(0.55, 1.0, vAge);
  vec3 col = mix(vec3(1.0, 0.34, 0.42), vec3(1.0, 0.62, 0.66), clamp(-h * 3.0, 0.0, 1.0));
  gl_FragColor = vec4(col, 0.92 * fade);
}
`;

export class PetHearts {
  readonly object: THREE.Points;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly age = new Float32Array(MAX).fill(-1);
  private readonly size = new Float32Array(MAX);
  private readonly vel = new Float32Array(MAX * 3);
  private next = 0;
  /** Hearts alive (debug). */
  alive = 0;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true });
    this.object = new THREE.Points(g, m);
    this.object.name = 'pet-hearts';
    this.object.frustumCulled = false;
    this.object.renderOrder = 6;
    this.object.visible = false;
  }

  /** One heart from (x, y, z), drifting up and a little sideways (`dir` -1..1). */
  spawn(x: number, y: number, z: number, dir: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = dir * 0.16;
    this.vel[i * 3 + 1] = 0.42 + Math.abs(dir) * 0.06;
    this.vel[i * 3 + 2] = -dir * 0.1;
    this.age[i] = 0;
    this.size[i] = 0.11 + Math.abs(dir) * 0.04;
  }

  update(dt: number): void {
    let alive = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.age[i] < 0) continue;
      this.age[i] += dt / LIFE_S;
      if (this.age[i] >= 1) {
        this.age[i] = -1;
        continue;
      }
      alive++;
      this.pos[i * 3] += this.vel[i * 3] * dt + Math.sin(this.age[i] * 9 + i) * 0.1 * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.alive = alive;
    this.object.visible = alive > 0;
    if (alive > 0 || this.object.visible) {
      (this.object.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.object.geometry.getAttribute('aAge') as THREE.BufferAttribute).needsUpdate = true;
      (this.object.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}
