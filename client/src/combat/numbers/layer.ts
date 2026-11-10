// Damage numbers, drawn (playtest 2): a glyph atlas (one canvas, made once)
// and ONE instanced draw of glyph quads placed in screen space around each
// number's world anchor, at a constant pixel size (readable in first and
// third person alike, never the old metre-wide blocks). Stacked so they do
// not overlap (layout.ts), rise and fade; crits pop. No per-frame
// allocation: a fixed pool of numbers and glyph instances.

import * as THREE from 'three';
import type { DamageNumber } from '../store';
import { NUMBER_MS, NUMBER_PX, numberColor, numberMotion, numberText, stackNumbers, type NumberKind } from './layout';

const CHARS = '0123456789+-!MISDOGEPARY';
const CELL_W = 64;
const CELL_H = 64;
/** Glyph advance as a share of the glyph height. */
const ADVANCE = 0.5;
const MAX_NUMBERS = 64;
const MAX_GLYPHS = MAX_NUMBERS * 8;

interface Num {
  live: boolean;
  at: number;
  kind: NumberKind;
  x: number;
  y: number;
  z: number;
  text: string;
  color: THREE.Color;
  jitter: number;
  /** Sticky stacking offset (px): only ever grows, so a number never drops back down. */
  stack: number;
}

let atlas: THREE.Texture | null = null;

/** The glyph atlas: fill in red, outline in green (the shader colours them). */
function glyphAtlas(): THREE.Texture {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = CELL_W * CHARS.length;
  c.height = CELL_H;
  const g = c.getContext('2d')!;
  g.font = `800 ${Math.round(CELL_H * 0.72)}px system-ui, "Segoe UI", Roboto, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  for (let i = 0; i < CHARS.length; i++) {
    const cx = i * CELL_W + CELL_W / 2;
    g.lineWidth = 9;
    g.strokeStyle = 'rgb(0,255,0)';
    g.strokeText(CHARS[i], cx, CELL_H / 2 + 2, CELL_W - 14);
    g.fillStyle = 'rgb(255,0,0)';
    g.fillText(CHARS[i], cx, CELL_H / 2 + 2, CELL_W - 14);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  atlas = t;
  return t;
}

const VERT = /* glsl */ `
attribute vec3 iAnchor;
attribute vec4 iRect;   // px offset x, y (up), px width, height
attribute vec4 iUv;     // u0 v0 u1 v1
attribute vec4 iColor;  // rgb, alpha
uniform vec2 uRes;      // drawing-buffer px
uniform float uDpr;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(iAnchor, 1.0);
  vec2 px = (iRect.xy + position.xy * iRect.zw) * uDpr;
  clip.xy += px * 2.0 / uRes * clip.w;
  gl_Position = clip;
  vUv = mix(iUv.xy, iUv.zw, position.xy + 0.5);
  vColor = iColor;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 g = texture2D(uAtlas, vUv);
  float a = max(g.r, g.g) * vColor.a;
  if (a < 0.02) discard;
  vec3 col = mix(vec3(0.04, 0.03, 0.03), vColor.rgb, clamp(g.r * 1.15, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
}`;

let material: THREE.ShaderMaterial | null = null;
export function numberMaterial(): THREE.ShaderMaterial {
  material ??= new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: null }, uRes: { value: new THREE.Vector2(1280, 720) }, uDpr: { value: 1 } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  material.name = 'lodestone-damage-numbers';
  return material;
}

const _v = new THREE.Vector3();
const _size = new THREE.Vector2();

export class DamageNumberLayer {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private nums: Num[] = [];
  private next = 0;
  private aAnchor: THREE.InstancedBufferAttribute;
  private aRect: THREE.InstancedBufferAttribute;
  private aUv: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  // layout scratch
  private order = new Int32Array(MAX_NUMBERS);
  private sx = new Float32Array(MAX_NUMBERS);
  private sy = new Float32Array(MAX_NUMBERS);
  private sw = new Float32Array(MAX_NUMBERS);
  private sh = new Float32Array(MAX_NUMBERS);
  private dy = new Float32Array(MAX_NUMBERS);
  private idx = new Int32Array(MAX_NUMBERS);
  private motion = { rise: 0, scale: 1, alpha: 1 };
  /** Live numbers last frame (tests, the gallery). */
  count = 0;

  constructor() {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    this.aAnchor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 3), 3);
    this.aRect = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 4), 4);
    this.aUv = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 4), 4);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 4), 4);
    for (const a of [this.aAnchor, this.aRect, this.aUv, this.aColor]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iAnchor', this.aAnchor);
    geo.setAttribute('iRect', this.aRect);
    geo.setAttribute('iUv', this.aUv);
    geo.setAttribute('iColor', this.aColor);
    const mat = numberMaterial();
    if (typeof document !== 'undefined') mat.uniforms.uAtlas.value = glyphAtlas();
    geo.instanceCount = 0;
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    for (let i = 0; i < MAX_NUMBERS; i++) this.nums.push({ live: false, at: 0, kind: 'dealt', x: 0, y: 0, z: 0, text: '', color: new THREE.Color(), jitter: 0, stack: 0 });
  }

  add(n: DamageNumber & { element?: number }): void {
    // reuse the oldest slot when full
    let slot = -1;
    for (let k = 0; k < MAX_NUMBERS; k++) {
      const i = (this.next + k) % MAX_NUMBERS;
      if (!this.nums[i].live) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      let oldest = 0;
      for (let i = 1; i < MAX_NUMBERS; i++) if (this.nums[i].at < this.nums[oldest].at) oldest = i;
      slot = oldest;
    }
    this.next = (slot + 1) % MAX_NUMBERS;
    const u = this.nums[slot];
    u.live = true;
    u.at = n.at;
    u.kind = n.kind;
    u.x = n.x;
    u.y = n.y;
    u.z = n.z;
    u.text = numberText(n.kind, n.value);
    u.color.set(numberColor(n.kind, n.element ?? 8));
    u.jitter = ((n.id * 37) % 7) * 4 - 12; // -12..12 px: side by side hits spread a little
    u.stack = 0;
  }

  /** Lay out and write the glyph instances for this frame. */
  update(camera: THREE.Camera, renderer: { getDrawingBufferSize(v: THREE.Vector2): THREE.Vector2; getPixelRatio(): number }, nowMs: number): void {
    const mat = this.mesh.material as THREE.ShaderMaterial;
    renderer.getDrawingBufferSize(_size);
    const dpr = renderer.getPixelRatio();
    mat.uniforms.uRes.value.copy(_size);
    mat.uniforms.uDpr.value = dpr;
    const W = _size.x / dpr;
    const H = _size.y / dpr;
    // project the live ones, oldest first
    let n = 0;
    for (let i = 0; i < MAX_NUMBERS; i++) {
      const u = this.nums[i];
      if (!u.live) continue;
      const age = nowMs - u.at;
      if (age >= NUMBER_MS || age < -50) {
        u.live = false;
        continue;
      }
      _v.set(u.x, u.y, u.z).project(camera);
      if (_v.z > 1 || _v.z < -1) continue; // behind the camera
      const m = numberMotion(u.kind, age, this.motion);
      const hpx = NUMBER_PX[u.kind];
      this.idx[n] = i;
      this.sx[n] = ((_v.x + 1) / 2) * W + u.jitter;
      this.sy[n] = ((1 - _v.y) / 2) * H - m.rise;
      this.sw[n] = u.text.length * hpx * ADVANCE;
      this.sh[n] = hpx;
      this.dy[n] = 0;
      n++;
    }
    // oldest first
    for (let i = 0; i < n; i++) this.order[i] = i;
    const at = (k: number) => this.nums[this.idx[k]].at;
    for (let i = 1; i < n; i++) {
      const v = this.order[i];
      let j = i - 1;
      while (j >= 0 && at(this.order[j]) > at(v)) {
        this.order[j + 1] = this.order[j];
        j--;
      }
      this.order[j + 1] = v;
    }
    // stack (sticky: an offset only grows)
    for (let k = 0; k < n; k++) this.sy[k] -= this.nums[this.idx[k]].stack;
    stackNumbers(n, this.order, this.sx, this.sy, this.sw, this.sh, this.dy);
    let g = 0;
    const anc = this.aAnchor.array as Float32Array;
    const rect = this.aRect.array as Float32Array;
    const uv = this.aUv.array as Float32Array;
    const col = this.aColor.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const u = this.nums[this.idx[k]];
      u.stack += this.dy[k];
      const m = numberMotion(u.kind, nowMs - u.at, this.motion);
      const hpx = NUMBER_PX[u.kind] * m.scale;
      const adv = hpx * ADVANCE;
      const total = u.text.length * adv;
      const rise = m.rise + u.stack;
      for (let c = 0; c < u.text.length && g < MAX_GLYPHS; c++) {
        const ci = CHARS.indexOf(u.text[c]);
        if (ci < 0) continue;
        anc[g * 3] = u.x;
        anc[g * 3 + 1] = u.y;
        anc[g * 3 + 2] = u.z;
        rect[g * 4] = u.jitter - total / 2 + adv * (c + 0.5);
        rect[g * 4 + 1] = rise;
        rect[g * 4 + 2] = hpx * (CELL_W / CELL_H) * 0.92;
        rect[g * 4 + 3] = hpx;
        // (a little inset: no bleed from the neighbouring glyph under filtering)
        uv[g * 4] = (ci + 0.04) / CHARS.length;
        uv[g * 4 + 1] = 0;
        uv[g * 4 + 2] = (ci + 0.96) / CHARS.length;
        uv[g * 4 + 3] = 1;
        col[g * 4] = u.color.r;
        col[g * 4 + 1] = u.color.g;
        col[g * 4 + 2] = u.color.b;
        col[g * 4 + 3] = m.alpha;
        g++;
      }
    }
    this.count = n;
    this.geo.instanceCount = g;
    this.mesh.visible = g > 0;
    if (g > 0) for (const a of [this.aAnchor, this.aRect, this.aUv, this.aColor]) a.needsUpdate = true;
  }

  clear(): void {
    for (const u of this.nums) u.live = false;
    this.geo.instanceCount = 0;
    this.mesh.visible = false;
  }
}
