// Chimney smoke (playtest 2 immersion pass: "chimneys never smoke; the
// towns look like nobody lives in them"). Every chimney stack the town kit
// draws (kit.ts drawChimney) reports its top; the nearest ones within
// SMOKE_RANGE_M of the camera get a soft plume: SMOKE_PER puffs each, rising,
// widening and drifting downwind, fading out. All on the GPU: one instanced
// quad draw, per-instance (chimney top, seed), the age of a puff is
// fract(time * rate + seed), so the CPU only refreshes the chimney list four
// times a second. Hearths are busiest at breakfast and supper, lazier at
// noon and in the small hours (the town still smokes a little at night).
// The plume is lit like the sky (dim and bluish by moonlight); it never
// flashes or strobes.

import * as THREE from 'three';
import { windState } from '../wind';

export const SMOKE_RANGE_M = 260;
export const SMOKE_MAX_CHIMNEYS = 40;
export const SMOKE_PER = 16;

/** How much the hearths burn at this hour (0..1): breakfast and supper peaks. Pure (tested). */
export function hearthActivity(hour: number): number {
  const g = (c: number, w: number) => Math.exp(-(((hour - c) / w) ** 2));
  return Math.min(1, 0.35 + 0.65 * g(7.5, 1.6) + 0.55 * g(19, 2.2) + 0.2 * g(12.5, 1.2) - 0.15 * g(3, 2));
}

const VERT = /* glsl */ `
attribute vec3 aBase;
attribute float aSeed;
uniform float uTime;
uniform vec2 uWind;
uniform float uWindSpeed;
uniform float uAmount;
varying float vA;
varying vec2 vUv;
varying float vAge;
void main() {
  float rate = 0.075 + aSeed * 0.035;
  float age = fract(uTime * rate + aSeed * 7.31);
  vAge = age;
  // rise (slowing), bend downwind (more as it climbs), a lazy curl
  float rise = 9.0 * (1.0 - (1.0 - age) * (1.0 - age));
  vec2 drift = uWind * (0.6 + uWindSpeed * 0.9) * pow(age, 1.4) * 9.0;
  vec3 c = aBase + vec3(drift.x, rise, drift.y);
  c.x += sin(uTime * 0.7 + aSeed * 23.0 + age * 5.0) * 0.45 * age;
  c.z += cos(uTime * 0.6 + aSeed * 17.0 + age * 4.0) * 0.45 * age;
  float size = (0.7 + 3.4 * age) * (0.8 + 0.4 * aSeed);
  // a camera-facing quad
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  float r = aSeed * 6.2831 + age * 0.8;
  vec2 q = position.xy;
  q = vec2(q.x * cos(r) - q.y * sin(r), q.x * sin(r) + q.y * cos(r));
  mv.xy += q * size;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  // fade in over the first tenth, out over the rest; thinner when the hearths are low
  vA = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.35, 1.0, age)) * uAmount;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
varying vec2 vUv;
varying float vAge;
void main() {
  float d = length(vUv);
  // a soft lumpy puff: radial falloff broken by a little angular noise
  float n = 0.9 + 0.1 * sin(atan(vUv.y, vUv.x + 1e-6) * 3.0 + vAge * 6.0);
  float a = (1.0 - smoothstep(0.1, 1.0, d / n));
  a *= a * 0.8 * vA;
  if (a < 0.004) discard;
  // fresh smoke is a little darker and warmer near the stack
  vec3 col = uColor * mix(0.8, 1.05, smoothstep(0.0, 0.4, vAge));
  gl_FragColor = vec4(col, a);
}
`;

let mat: THREE.ShaderMaterial | null = null;
export function smokeMaterial(): THREE.ShaderMaterial {
  mat ??= new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0) }, uWindSpeed: { value: 0 }, uAmount: { value: 1 }, uColor: { value: new THREE.Color(0.8, 0.79, 0.77) } },
    transparent: true,
    depthWrite: false,
  });
  return mat;
}

function quad(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** One tiny object for the shader warm-up (warmExtras.ts). */
export function smokeWarmObject(): THREE.Object3D {
  const g = quad();
  g.setAttribute('aBase', new THREE.InstancedBufferAttribute(new Float32Array(3), 3));
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(1), 1));
  g.instanceCount = 1;
  const m = new THREE.Mesh(g, smokeMaterial());
  m.frustumCulled = false;
  return m;
}

export class ChimneySmoke {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly base: Float32Array;
  private readonly seed: Float32Array;
  private acc = 1;
  private t = 0;
  readonly stats = { chimneys: 0 };
  private readonly pick: { d: number; a: Float32Array; o: number }[] = [];

  constructor() {
    this.geo = quad();
    const n = SMOKE_MAX_CHIMNEYS * SMOKE_PER;
    this.base = new Float32Array(n * 3);
    this.seed = new Float32Array(n);
    for (let i = 0; i < n; i++) this.seed[i] = ((i % SMOKE_PER) + Math.random() * 0.6) / SMOKE_PER;
    this.geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(this.base, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.seed, 1));
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, smokeMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'chimney-smoke';
  }

  /**
   * `sources`: every loaded settlement's chimney tops (3 floats each), asked only when the list refreshes;
   * `light`: the sky's light on the smoke (0 night .. 1 day); `under`: underground.
   */
  update(camera: THREE.Camera, dt: number, hour: number, light: number, rain: number, under: number, sources: () => Iterable<Float32Array>): void {
    this.t += dt;
    const m = smokeMaterial();
    m.uniforms.uTime.value = this.t;
    (m.uniforms.uWind.value as THREE.Vector2).set(windState.dirX, windState.dirZ);
    m.uniforms.uWindSpeed.value = Math.min(2, windState.speed / 4);
    // fainter by night (only the moon on it), thinner in rain
    m.uniforms.uAmount.value = hearthActivity(hour) * (1 - 0.35 * rain) * (0.3 + 0.7 * light);
    // day: a soft grey a little darker than the sky, so it reads against it; night: a dim blue grey
    const k = 0.06 + 0.94 * light;
    (m.uniforms.uColor.value as THREE.Color).setRGB(0.55 * k + 0.03 * (1 - light), 0.55 * k + 0.045 * (1 - light), 0.58 * k + 0.07 * (1 - light));
    this.mesh.visible = under < 0.5 && this.geo.instanceCount > 0;
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    // the nearest chimneys in range
    const cam = camera.position;
    const pick = this.pick;
    pick.length = 0;
    for (const a of sources()) {
      for (let o = 0; o + 2 < a.length; o += 3) {
        const d = Math.hypot(a[o] - cam.x, a[o + 2] - cam.z);
        if (d < SMOKE_RANGE_M) pick.push({ d, a, o });
      }
    }
    if (pick.length > SMOKE_MAX_CHIMNEYS) pick.sort((x, y) => x.d - y.d);
    const n = Math.min(SMOKE_MAX_CHIMNEYS, pick.length);
    for (let c = 0; c < n; c++) {
      const { a, o } = pick[c];
      for (let p = 0; p < SMOKE_PER; p++) {
        const j = (c * SMOKE_PER + p) * 3;
        this.base[j] = a[o];
        this.base[j + 1] = a[o + 1];
        this.base[j + 2] = a[o + 2];
      }
    }
    this.stats.chimneys = n;
    this.geo.instanceCount = n * SMOKE_PER;
    (this.geo.getAttribute('aBase') as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.mesh.visible = under < 0.5 && n > 0;
  }

  dispose(): void {
    this.geo.dispose();
  }
}
