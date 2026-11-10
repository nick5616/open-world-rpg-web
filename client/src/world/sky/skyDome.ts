// Sky dome: the analytic atmosphere (atmosphere.ts SKY_GLSL) plus the sun
// disk (HDR, so bloom catches it), a moon, stars at night and a drifting
// cloud layer that follows the shared wind. Drawn on the far plane, so it
// never occludes anything and the fog pass leaves it alone (depth = 1).

import * as THREE from 'three';
import { SKY_GLSL, SKY_STYLE_GLSL } from './atmosphere';
import { WIND_GLSL, windUniforms } from '../wind';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform float uClouds;
uniform float uCloudCover;
// Playtest 2 weather (CR 030): x storm darkness, y rainbow, z lightning flash, w blowing sand.
uniform vec4 uWeatherSky;
varying vec3 vDir;
${SKY_GLSL}
${SKY_STYLE_GLSL}
${WIND_GLSL}
float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
float n2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * n2(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
void main() {
  vec3 v = normalize(vDir);
  vec3 s = normalize(uSunDir);
  vec3 vh = vec3(v.x, max(v.y, 0.0), v.z);
  vec3 col = skyRadiance(normalize(vh + vec3(0.0, 0.001, 0.0)), s);
  float night = 1.0 - smoothstep(-0.12, 0.05, s.y);
  // Stars: hashed cells on the dome, twinkle by time.
  if (night > 0.0 && v.y > 0.0) {
    vec3 sd = v * 220.0;
    vec3 cell = floor(sd);
    float hs = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float star = step(0.9965, hs) * smoothstep(0.5, 0.0, length(fract(sd) - 0.5));
    col += vec3(0.9, 0.95, 1.0) * star * night * (0.6 + 0.4 * sin(uWindTime * 3.0 + hs * 50.0)) * 1.6 * smoothstep(0.0, 0.15, v.y);
  }
  // Sun disk (HDR) and moon.
  float mu = dot(v, s);
  col += sunTrans(s.y) * SUN_E * 40.0 * smoothstep(0.99996, 0.99999, mu);
  vec3 m = -s;
  float mm = dot(v, normalize(vec3(m.x, max(m.y, 0.25), m.z)));
  col += vec3(0.85, 0.9, 1.0) * 1.2 * smoothstep(0.99975, 0.99985, mm) * night;
  // CR 030: a storm darkens the whole dome; a rainbow stands opposite a low sun after a shower.
  col *= 1.0 - 0.45 * uWeatherSky.x;
  if (uWeatherSky.y > 0.0 && v.y > 0.0) {
    float ang = degrees(acos(clamp(dot(v, -s), -1.0, 1.0)));
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float b1 = (ang - 40.6) / 2.0;
    float b2 = (53.4 - ang) / 3.0;
    vec3 bow = vec3(0.0);
    if (b1 > 0.0 && b1 < 1.0) bow += clamp(abs(mod((1.0 - b1) * 4.6 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0) * sin(b1 * 3.14159);
    if (b2 > 0.0 && b2 < 1.0) bow += 0.35 * clamp(abs(mod((1.0 - b2) * 4.6 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0) * sin(b2 * 3.14159);
    col += bow * (lum * 1.3 + 0.08) * uWeatherSky.y * smoothstep(0.0, 0.12, v.y);
  }
  // Clouds: a plane at ~2 km projected onto the dome, drifting downwind.
  if (uClouds > 0.0 && v.y > 0.01) {
    vec2 cp = v.xz / (v.y + 0.08) * 1.6 + uWindDir * uWindTime * 0.012;
    float c = fbm(cp);
    float cover = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.35, c);
    vec3 lit = skyRadiance(vec3(0.0, 1.0, 0.0), s) * 1.6 + sunTrans(s.y) * SUN_E * 0.035 * (0.6 + 0.4 * mu);
    vec3 shade = lit * mix(0.55, 1.0, smoothstep(0.3, 0.9, c));
    shade *= 1.0 - 0.7 * uWeatherSky.x;
    shade += vec3(0.75, 0.8, 1.0) * uWeatherSky.z * 2.5 * smoothstep(0.35, 0.8, c); // lightning inside the clouds
    col = mix(col, shade, cover * smoothstep(0.01, 0.15, v.y) * 0.9);
  }
  col += vec3(0.5, 0.55, 0.75) * uWeatherSky.z * 0.6;
  if (uWeatherSky.w > 0.0) col = mix(col, vec3(0.78, 0.62, 0.42) * (0.25 + dot(col, vec3(0.33))), 0.7 * uWeatherSky.w);
  // Below the horizon: a dim mirror of the horizon colour (seen past the world's edge).
  if (v.y < 0.0) col = mix(col, col * 0.4, smoothstep(0.0, -0.3, v.y));
  col = lsSkyStyle(col, v.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface SkyDome {
  mesh: THREE.Mesh;
  uniforms: { uSunDir: { value: THREE.Vector3 }; uClouds: { value: number }; uCloudCover: { value: number }; uSkyStyle: { value: THREE.Vector4 }; uWeatherSky: { value: THREE.Vector4 } };
}

export function createSkyDome(): SkyDome {
  const uniforms = { uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uClouds: { value: 1 }, uCloudCover: { value: 0.42 }, uSkyStyle: { value: new THREE.Vector4(1, 1, 0, 0) }, uWeatherSky: { value: new THREE.Vector4(0, 0, 0, 0) } };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { ...uniforms, ...windUniforms },
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = 'sky';
  return { mesh, uniforms };
}
