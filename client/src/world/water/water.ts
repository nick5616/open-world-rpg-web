// Water (spec 12: planar with depth fade and gentle normal motion, no
// screen-space reflections).
//
// Two meshes share one shader:
//  - per-tile water (lakes, rivers and sea inside streamed tiles), whose
//    vertices carry the exact depth (surface minus ground) from the chunk, so
//    shorelines fade at 1 m resolution without a depth pre-pass;
//  - a sea plane following the camera out to the horizon, drawn only where no
//    tile is loaded (coverage texture), with depth from the atlas heightmap.
//
// Reflection is the analytic sky in the reflected direction (the same
// function the sky dome draws), so water always agrees with the sky above it.

import * as THREE from 'three';
import { SKY_GLSL } from '../sky/atmosphere';
import { STYLE_UNIFORMS } from '../style/styleShader';
import { DOMAIN_CHUNKS, DOMAIN_MIN } from '../terrain/quadtree';

export interface WaterUniforms {
  uSunDir: { value: THREE.Vector3 };
  uLightColor: { value: THREE.Color };
  uAmbient: { value: THREE.Color };
  uTime: { value: number };
  uDetail: { value: number };
  uCoverage: { value: THREE.Texture | null };
  uAtlasHeight: { value: THREE.Texture | null };
  uSeaY: { value: number };
  /** Playtest 2 styles: x = shallow turquoise, y = shore foam, z = fresnel boost. */
  uWaterStyle: { value: THREE.Vector4 };
  lsStyle: { value: Float32Array };
  lsRetro: { value: Float32Array };
}

export function makeWaterUniforms(): WaterUniforms {
  return {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uLightColor: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: new THREE.Color(0.5, 0.6, 0.7) },
    uTime: { value: 0 },
    uDetail: { value: 1 },
    uCoverage: { value: null },
    uAtlasHeight: { value: null },
    uSeaY: { value: 0 },
    uWaterStyle: { value: new THREE.Vector4(0, 1, 0, 0) },
    // Retro vertex snap (style/styleShader.ts; the vertex shader includes logdepthbuf_vertex).
    lsStyle: STYLE_UNIFORMS.lsStyle,
    lsRetro: STYLE_UNIFORMS.lsRetro,
  };
}

const VERT = /* glsl */ `
attribute float aDepth;
varying vec3 vWPos;
varying float vDepth;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vDepth = aDepth;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uLightColor;
uniform vec3 uAmbient;
uniform float uTime;
uniform float uDetail;
uniform sampler2D uCoverage;
uniform sampler2D uAtlasHeight;
uniform float uSeaY;
uniform vec4 uWaterStyle;
varying vec3 vWPos;
varying float vDepth;
${SKY_GLSL}
#include <common>
#include <logdepthbuf_pars_fragment>

vec2 wave(vec2 p, vec2 d, float freq, float speed) {
  float ph = dot(p, d) * freq + uTime * speed;
  return d * cos(ph) * freq;
}
void main() {
  #include <logdepthbuf_fragment>
  float depth = vDepth;
  #ifdef SEA_PLANE
    vec2 cc = vWPos.xz / 64.0 - float(${DOMAIN_MIN});
    if (cc.x >= 0.0 && cc.y >= 0.0 && cc.x < float(${DOMAIN_CHUNKS}) && cc.y < float(${DOMAIN_CHUNKS})) {
      if (texture2D(uCoverage, cc / float(${DOMAIN_CHUNKS})).r > 0.5) discard; // a tile's own water is here
    }
    vec2 auv = vWPos.xz / 4096.0;
    float ground = (auv.x >= 0.0 && auv.y >= 0.0 && auv.x <= 1.0 && auv.y <= 1.0) ? texture2D(uAtlasHeight, auv).r : uSeaY - 40.0;
    depth = uSeaY - ground;
  #endif
  if (depth < -0.05) discard;
  vec3 V = normalize(cameraPosition - vWPos);
  float dist = length(cameraPosition - vWPos);
  // Gentle moving normals: a few directional waves, faded with distance (they only alias far away).
  vec2 g = vec2(0.0);
  float amp = uDetail * (1.0 - smoothstep(60.0, 400.0, dist));
  if (amp > 0.0) {
    vec2 p = vWPos.xz;
    g += wave(p, normalize(vec2(1.0, 0.3)), 0.35, 1.1) * 0.05;
    g += wave(p, normalize(vec2(-0.4, 1.0)), 0.6, 1.7) * 0.03;
    g += wave(p, normalize(vec2(0.7, -0.8)), 1.3, 2.3) * 0.015;
    g += wave(p, normalize(vec2(-0.9, -0.2)), 2.7, 3.1) * 0.008;
    g *= amp;
  }
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  float ndv = max(dot(n, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  fres = min(1.0, fres * (1.0 + uWaterStyle.z));
  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  vec3 sky = skyRadiance(normalize(R), uSunDir);
  // Body colour: turquoise shallows to deep green-blue, lit by sky ambient and sun.
  // Styles push the shallows toward a clear, sunlit turquoise (bright lakes read from far off).
  vec3 shallow = mix(vec3(0.06, 0.20, 0.18), vec3(0.05, 0.34, 0.33), uWaterStyle.x);
  vec3 deep = vec3(0.010, 0.045, 0.060);
  float sunDot = max(uSunDir.y, 0.0);
  vec3 lightIn = uAmbient * 0.6 + uLightColor * sunDot * 0.5;
  vec3 body = mix(shallow, deep, smoothstep(0.5, 9.0, depth)) * lightIn;
  vec3 col = mix(body, sky, fres);
  // Sun glint.
  float spec = pow(max(dot(R, uSunDir), 0.0), 600.0) * 6.0 + pow(max(dot(R, uSunDir), 0.0), 60.0) * 0.12;
  col += uLightColor * spec * uDetail;
  // Depth fade at the shore and a soft foam line.
  float alpha = clamp(1.0 - exp(-max(depth, 0.0) * 0.55), 0.0, 1.0);
  alpha = max(alpha, fres * smoothstep(0.0, 0.3, depth));
  float foam = (1.0 - smoothstep(0.0, 0.35, depth)) * (0.6 + 0.4 * sin(uTime * 1.5 + vWPos.x * 0.8 + vWPos.z * 0.6)) * uDetail;
  // Styles: a broken second foam band a little further out, lapping in with the waves.
  float lap = sin(depth * 9.0 - uTime * 1.8 + sin(vWPos.x * 0.37 + vWPos.z * 0.29) * 2.0);
  float speck = fract(sin(dot(floor(vWPos.xz * 3.0), vec2(12.9898, 78.233))) * 43758.5453);
  float band = smoothstep(0.55, 0.95, lap) * (1.0 - smoothstep(0.2, 1.1, depth)) * step(0.35, speck);
  foam = clamp((foam + band * 0.7) * uWaterStyle.y, 0.0, 1.0) * uDetail;
  col = mix(col, lightIn * 1.4, foam * 0.5);
  alpha = max(alpha, foam * 0.6);
  gl_FragColor = vec4(col, alpha);
}
`;

export function createWaterMaterial(u: WaterUniforms, sea: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: sea ? VERT.replace('attribute float aDepth;', 'float aDepth = 0.0;') : VERT,
    fragmentShader: FRAG,
    uniforms: u as unknown as Record<string, THREE.IUniform>,
    defines: sea ? { SEA_PLANE: '' } : {},
    transparent: true,
    depthWrite: true,
    // Fog is applied in post from the depth buffer (post/fog.ts), so water writes depth.
  });
}

/** Atlas macro heights as a half-float texture (sea depth beyond the streamed tiles). */
export function atlasHeightTexture(height: Float32Array, n: number): THREE.DataTexture {
  const half = new Uint16Array(height.length);
  for (let i = 0; i < height.length; i++) half[i] = THREE.DataUtils.toHalfFloat(height[i]);
  const t = new THREE.DataTexture(half, n, n, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** A disc of rings around the camera, denser near the middle; recentred on a grid so it never swims. */
export function createSeaPlane(material: THREE.Material, seaY: number): THREE.Mesh {
  const g = new THREE.RingGeometry(0.001, 9000, 64, 24);
  // Push ring vertices toward the centre: fine near the camera, coarse at the horizon.
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const k = r > 0 ? (Math.pow(r / 9000, 2.2) * 9000) / r : 0;
    pos.setXY(i, x * k, y * k);
  }
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, material);
  m.position.y = seaY;
  m.frustumCulled = false;
  m.renderOrder = 1;
  m.name = 'sea';
  return m;
}
