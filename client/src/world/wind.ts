// The one wind field (spec 12: "one wind field drives grass, leaves,
// banners, smoke, fire spread and glide updrafts, so everything sways
// together and agrees with the chemistry"). Other packages read it from here:
//
//   import { windAt, windUniforms, WIND_GLSL } from '../world/wind';
//   windAt(x, z, out)            // CPU: horizontal wind vector (m/s) at a point, now
//   windUniforms                 // add to a ShaderMaterial's uniforms (shared objects, updated once per frame)
//   WIND_GLSL                    // `vec2 windAt(vec2 xz)` and `float windGust(vec2 xz)` for shaders
//
// The field is a pure function of (x, z, time) and the world's prevailing
// direction (WorldSpec windDirection: where the wind comes *from*, 0 = north
// = -z, 90 = +x). Gust fronts travel downwind, so a gust visibly rolls across
// a meadow. CPU and GLSL evaluate the same formula, so a smoke plume (CPU)
// and the grass under it (GPU) lean together.

import * as THREE from 'three';

export const windState = {
  /** Unit vector the wind blows toward (x, z). */
  dirX: 0,
  dirZ: 1,
  /** Mean speed, m/s. */
  speed: 4,
  /** Seconds; advanced by the world's frame loop. */
  time: 0,
};

/** Set the prevailing wind from the WorldSpec windDirection (degrees, direction it comes from). */
export function setPrevailingWind(fromDeg: number, speed = 4): void {
  const a = (fromDeg * Math.PI) / 180;
  windState.dirX = -Math.sin(a);
  windState.dirZ = Math.cos(a);
  windState.speed = speed;
}

/** Gust factor 0.35..1.6 at a point: slow swell times fronts rolling downwind. */
export function windGust(x: number, z: number, t = windState.time): number {
  const along = x * windState.dirX + z * windState.dirZ;
  const across = -x * windState.dirZ + z * windState.dirX;
  const front = Math.sin(along * 0.045 - t * 0.9 + Math.sin(across * 0.021) * 1.7);
  const swell = Math.sin(t * 0.23) * 0.5 + 0.5;
  return 0.35 + 0.55 * swell + 0.7 * Math.max(0, front) * (0.4 + 0.6 * swell);
}

/** Horizontal wind vector (m/s) at (x, z). */
export function windAt(x: number, z: number, out = { x: 0, z: 0 }, t = windState.time): { x: number; z: number } {
  const g = windGust(x, z, t) * windState.speed;
  out.x = windState.dirX * g;
  out.z = windState.dirZ * g;
  return out;
}

export const windUniforms = {
  uWindDir: { value: new THREE.Vector2(0, 1) },
  uWindSpeed: { value: 4 },
  uWindTime: { value: 0 },
  /** Visual style (world/style/styles.ts): x = sway multiplier, y = gust sheen on grass. */
  uWindSweep: { value: new THREE.Vector2(1, 0) },
};

export function advanceWind(dt: number): void {
  windState.time += dt;
  windUniforms.uWindDir.value.set(windState.dirX, windState.dirZ);
  windUniforms.uWindSpeed.value = windState.speed;
  windUniforms.uWindTime.value = windState.time;
}

/** Same formulas as windGust/windAt above. Needs the windUniforms. */
export const WIND_GLSL = /* glsl */ `
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform float uWindTime;
uniform vec2 uWindSweep;
float windGust(vec2 p) {
  float along = dot(p, uWindDir);
  float across = -p.x * uWindDir.y + p.y * uWindDir.x;
  float front = sin(along * 0.045 - uWindTime * 0.9 + sin(across * 0.021) * 1.7);
  float swell = sin(uWindTime * 0.23) * 0.5 + 0.5;
  return 0.35 + 0.55 * swell + 0.7 * max(0.0, front) * (0.4 + 0.6 * swell);
}
vec2 windAt(vec2 p) { return uWindDir * windGust(p) * uWindSpeed; }
`;
