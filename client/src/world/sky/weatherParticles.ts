// Weather particles around the camera (playtest 2, CR 030): falling snow and
// blowing sand. One draw call each (GL points in a box that follows the
// camera, positions on the CPU like the rain streaks), hidden when calm; the
// count in use scales with the intensity, the capacity with the quality tier.
// Snow writes depth (so the fog pass treats a flake as near, not as the
// mountain behind it); sand is a translucent stream that the fog tints.

import * as THREE from 'three';
import { windState } from '../wind';

const VERT = /* glsl */ `
attribute float aSeed;
uniform float uSize;
uniform float uScale;
varying float vSeed;
void main() {
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * (0.7 + 0.6 * aSeed) * uScale / max(-mv.z, 0.1), 1.0, 48.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSquare;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float a = uSquare > 0.5 ? 1.0 : smoothstep(0.5, 0.25, r);
  if (a < 0.35 && uSquare < 0.5 && uOpacity > 0.9) discard;
  gl_FragColor = vec4(uColor * (0.85 + 0.3 * vSeed), a * uOpacity);
}
`;

export interface ParticleKind {
  /** Box edge around the camera, m. */
  box: number;
  /** Fall speed m/s (snow ~1.3; sand 0). */
  fall: number;
  /** Speed along the wind at full wind, m/s. */
  drift: number;
  /** Side-to-side flutter amplitude, m. */
  sway: number;
  color: THREE.ColorRepresentation;
  /** Point size (world-ish units). */
  size: number;
  opaque: boolean;
}

export const SNOW: ParticleKind = { box: 46, fall: 1.4, drift: 5, sway: 0.6, color: '#f4f8ff', size: 0.12, opaque: true };
export const SAND: ParticleKind = { box: 36, fall: 0, drift: 13, sway: 0.25, color: '#c8a070', size: 0.06, opaque: false };

export class WeatherParticles {
  readonly object: THREE.Points;
  private readonly pos: Float32Array;
  private readonly off: Float32Array;
  private readonly mat: THREE.ShaderMaterial;
  private t = 0;

  constructor(
    readonly kind: ParticleKind,
    readonly capacity: number,
    name: string,
  ) {
    this.pos = new Float32Array(capacity * 3);
    this.off = new Float32Array(capacity * 3);
    const seed = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.off[i * 3] = (Math.random() - 0.5) * kind.box;
      this.off[i * 3 + 1] = (Math.random() - 0.5) * kind.box;
      this.off[i * 3 + 2] = (Math.random() - 0.5) * kind.box;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uSize: { value: kind.size }, uScale: { value: 600 }, uColor: { value: new THREE.Color(kind.color) }, uOpacity: { value: 1 }, uSquare: { value: 0 } },
      transparent: true,
      depthWrite: kind.opaque,
    });
    this.object = new THREE.Points(geo, this.mat);
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.name = name;
  }

  /**
   * `amount` 0..1 (eased intensity), `wind` 0..1. Style: point size factor
   * and square points (Retro's chunky flakes).
   */
  update(camera: THREE.PerspectiveCamera, dt: number, amount: number, wind: number, viewportH: number, sizeMul = 1, square = false): void {
    const on = amount > 0.04;
    this.object.visible = on;
    if (!on) return;
    const k = this.kind;
    const n = Math.max(1, Math.floor(this.capacity * Math.min(1, amount)));
    this.object.geometry.setDrawRange(0, n);
    this.t += dt;
    this.mat.uniforms.uScale.value = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.mat.uniforms.uSize.value = k.size * sizeMul;
    this.mat.uniforms.uSquare.value = square ? 1 : 0;
    this.mat.uniforms.uOpacity.value = k.opaque ? 1 : Math.min(0.75, 0.25 + amount * 0.6);
    const half = k.box / 2;
    const wx = windState.dirX * k.drift * (0.25 + wind) * dt;
    const wz = windState.dirZ * k.drift * (0.25 + wind) * dt;
    const fall = k.fall * dt;
    const o = this.off;
    const p = this.pos;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const wrap = (v: number) => (v > half ? v - k.box : v < -half ? v + k.box : v);
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const ph = i * 1.37;
      o[j] = wrap(o[j] + wx + Math.sin(this.t * 1.3 + ph) * k.sway * dt);
      o[j + 1] = wrap(o[j + 1] - fall - (k.fall === 0 ? Math.sin(this.t * 2 + ph) * 0.3 * dt : 0));
      o[j + 2] = wrap(o[j + 2] + wz + Math.cos(this.t * 1.1 + ph) * k.sway * dt);
      p[j] = cx + o[j];
      p[j + 1] = cy + o[j + 1];
      p[j + 2] = cz + o[j + 2];
    }
    (this.object.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.mat.dispose();
  }
}
