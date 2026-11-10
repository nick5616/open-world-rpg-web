// Analytic atmospheric scattering driven by the world clock (spec 12 "Sky:
// analytic atmospheric scattering driven by world time").
//
// Model: single scattering through a homogeneous-equivalent atmosphere with
// Rayleigh + Mie optical depths and a Kasten-Young airmass, which has a
// closed form, so the sky is one cheap evaluation per pixel and the CPU can
// evaluate the same thing for the sun's light colour, the ambient and the
// fog. Sunsets come out of the physics: the sun's path through ~38 airmasses
// at the horizon strips the blue, so the light and the haze turn orange
// together and the sky stays consistent with everything it lights.
//
//   L(v) = E * T(s) * (tauR*PR(mu) + tauM*PM(mu)) / tau * (1 - exp(-tau * m(v)))
//
// T(s) = exp(-tau * m(s)) is the sun's transmittance, m() the airmass, tau the
// zenith optical depths (Rayleigh: beta_R * 8 km; Mie: 21e-6 * 1.2 km), PR and
// PM the phase functions. Below the horizon the sun fades through a short
// twilight instead of switching off.

import * as THREE from 'three';
import { DAY_LENGTH_S } from '@lodestone/contracts';
import { sunDirection } from '../../scene/SkyAndSun';

export const TAU_R = new THREE.Vector3(5.8e-6 * 8000, 13.5e-6 * 8000, 33.1e-6 * 8000);
export const TAU_M = 21e-6 * 1200;
export const MIE_G = 0.76;
/** Sun irradiance scale; sky radiance and the directional light share it. */
export const SUN_E = 22;

/** Kasten-Young relative airmass for a direction with elevation sin = y; ~38 at the horizon. */
export function airmass(y: number): number {
  const el = Math.max(Math.asin(Math.max(-1, Math.min(1, y))) * (180 / Math.PI), -1.5);
  return 1 / (Math.sin((el * Math.PI) / 180) + 0.50572 * Math.pow(el + 6.07995, -1.6364));
}

/** Fraction of the sun above the horizon, smoothed through twilight. */
export function sunVisibility(sunY: number): number {
  return THREE.MathUtils.smoothstep(sunY, -0.08, 0.02);
}

/**
 * Sunlight reaching the air that scatters it toward the viewer. That air is
 * mostly high up, so the light has crossed only part of the airmass that
 * reaches the ground: with the full ground transmittance the zenith turned
 * orange at sunset, while the real one stays blue above an orange horizon.
 * Looking at the horizon, the scattering air is low and the full reddening
 * applies; looking up, only SKY_TRANS_FRACTION of it.
 */
export const SKY_TRANS_FRACTION = 0.3;
export function sunTransmittanceSky(sunY: number, viewY: number, out = new THREE.Color()): THREE.Color {
  const f = 1 + (SKY_TRANS_FRACTION - 1) * Math.sqrt(Math.min(1, Math.max(0, viewY)));
  const m = airmass(Math.max(sunY, 0.0)) * f;
  const vis = sunVisibility(sunY);
  out.setRGB(Math.exp(-(TAU_R.x + TAU_M * 1.1) * m) * vis, Math.exp(-(TAU_R.y + TAU_M * 1.1) * m) * vis, Math.exp(-(TAU_R.z + TAU_M * 1.1) * m) * vis);
  return out;
}

/** Linear RGB of direct sunlight at the ground (before SUN_E), writes into out. */
export function sunTransmittance(sunY: number, out = new THREE.Color()): THREE.Color {
  const m = airmass(Math.max(sunY, 0.0));
  const vis = sunVisibility(sunY);
  out.setRGB(Math.exp(-(TAU_R.x + TAU_M * 1.1) * m) * vis, Math.exp(-(TAU_R.y + TAU_M * 1.1) * m) * vis, Math.exp(-(TAU_R.z + TAU_M * 1.1) * m) * vis);
  return out;
}

const phaseR = (mu: number) => (3 / (16 * Math.PI)) * (1 + mu * mu);
const phaseM = (mu: number, g = MIE_G) => ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));

/** CPU sky radiance in direction v (unit), sun s (unit). Matches SKY_GLSL skyRadiance() minus stars/clouds. */
export function skyRadiance(v: THREE.Vector3, s: THREE.Vector3, out = new THREE.Color()): THREE.Color {
  const vy = Math.max(v.y, 0.0);
  const mv = airmass(vy);
  const mu = v.dot(s);
  const ts = sunTransmittanceSky(s.y, v.y);
  const pR = phaseR(mu);
  const pM = phaseM(mu);
  const ch = (tr: number, t: number) => {
    const tau = tr + TAU_M;
    return (SUN_E * t * (tr * pR + TAU_M * pM) * (1 - Math.exp(-tau * mv))) / tau;
  };
  out.setRGB(ch(TAU_R.x, ts.r), ch(TAU_R.y, ts.g), ch(TAU_R.z, ts.b));
  // Multiple-scattering floor so twilight and deep shade are never pure black.
  const amb = 0.02 + 0.25 * sunVisibility(s.y + 0.1) * Math.max(0, s.y + 0.1);
  out.r += amb * 0.32;
  out.g += amb * 0.45;
  out.b += amb * 0.75;
  // Night sky floor (moonlit blue).
  out.r += 0.004;
  out.g += 0.006;
  out.b += 0.012;
  return out;
}

export interface SkyLighting {
  sunDir: THREE.Vector3;
  /** Direction of the light that casts shadows: the sun by day, the moon by night. */
  lightDir: THREE.Vector3;
  lightColor: THREE.Color;
  lightIntensity: number;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  hemiIntensity: number;
  /** 0 night .. 1 day. */
  day: number;
  /** 0..1, peaks when the sun is near the horizon. */
  golden: number;
}

const _v = new THREE.Vector3();
const _c = new THREE.Color();

/** Everything the lights and post need for a time of day. */
export function skyLighting(timeOfDayS: number, out: SkyLighting): SkyLighting {
  sunDirection(timeOfDayS % DAY_LENGTH_S, out.sunDir);
  const s = out.sunDir;
  out.day = THREE.MathUtils.smoothstep(s.y, -0.1, 0.25);
  out.golden = Math.max(0, 1 - Math.abs(s.y - 0.04) / 0.22) * sunVisibility(s.y);
  const sunUp = s.y > -0.05;
  if (sunUp) {
    out.lightDir.copy(s);
    sunTransmittance(s.y, out.lightColor);
    const m = Math.max(out.lightColor.r, out.lightColor.g, out.lightColor.b, 1e-4);
    out.lightIntensity = 3.2 * m;
    out.lightColor.multiplyScalar(1 / m);
  } else {
    // Moon opposite the sun, cool and dim, so nights still have shadows to hide in.
    out.lightDir.set(-s.x, Math.max(0.25, -s.y), -s.z).normalize();
    out.lightColor.setRGB(0.55, 0.65, 1.0);
    out.lightIntensity = 0.18 * THREE.MathUtils.smoothstep(-s.y, 0.05, 0.25);
  }
  // Ambient: the sky's zenith and horizon radiance, scaled to light units.
  skyRadiance(_v.set(0, 1, 0), s, out.skyColor);
  skyRadiance(_v.set(s.x, 0.05, s.z).normalize(), s, _c);
  out.skyColor.lerp(_c, 0.35);
  const lum = Math.max(out.skyColor.r, out.skyColor.g, out.skyColor.b, 1e-4);
  out.hemiIntensity = Math.min(1.6, 0.25 + lum * 2.2);
  out.skyColor.multiplyScalar(1 / lum);
  // Light bounced off grassy ground, warmed by the sun's colour.
  out.groundColor.setRGB(0.32, 0.3, 0.2).multiply(_c.copy(out.lightColor).lerp(new THREE.Color(1, 1, 1), 0.5));
  return out;
}

export function makeSkyLighting(): SkyLighting {
  return { sunDir: new THREE.Vector3(), lightDir: new THREE.Vector3(), lightColor: new THREE.Color(), lightIntensity: 1, skyColor: new THREE.Color(), groundColor: new THREE.Color(), hemiIntensity: 1, day: 1, golden: 0 };
}

/**
 * GLSL twin of skyRadiance(), shared by the sky dome and the fog pass so
 * distant terrain dissolves into exactly the sky behind it. Needs uniform
 * `uSunDir`.
 */
export const SKY_GLSL = /* glsl */ `
const vec3 TAU_R = vec3(${TAU_R.x.toFixed(5)}, ${TAU_R.y.toFixed(5)}, ${TAU_R.z.toFixed(5)});
const float TAU_M = ${TAU_M.toFixed(5)};
const float MIE_G = ${MIE_G.toFixed(3)};
const float SUN_E = ${SUN_E.toFixed(2)};
const float PI_ = 3.14159265;
float airmassY(float y) {
  float el = max(degrees(asin(clamp(y, -1.0, 1.0))), -1.5);
  return 1.0 / (sin(radians(el)) + 0.50572 * pow(el + 6.07995, -1.6364));
}
float sunVis(float y) { return smoothstep(-0.08, 0.02, y); }
vec3 sunTrans(float y) {
  return exp(-(TAU_R + TAU_M * 1.1) * airmassY(max(y, 0.0))) * sunVis(y);
}
vec3 sunTransSky(float y, float vy) {
  float f = mix(1.0, ${SKY_TRANS_FRACTION.toFixed(3)}, sqrt(clamp(vy, 0.0, 1.0)));
  return exp(-(TAU_R + TAU_M * 1.1) * airmassY(max(y, 0.0)) * f) * sunVis(y);
}
float phaseR(float mu) { return 3.0 / (16.0 * PI_) * (1.0 + mu * mu); }
float phaseM(float mu) {
  float g2 = MIE_G * MIE_G;
  return 3.0 / (8.0 * PI_) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * MIE_G * mu, 1.5));
}
vec3 skyRadiance(vec3 v, vec3 s) {
  float mv = airmassY(max(v.y, 0.0));
  float mu = dot(v, s);
  vec3 tau = TAU_R + TAU_M;
  vec3 L = SUN_E * sunTransSky(s.y, v.y) * (TAU_R * phaseR(mu) + TAU_M * phaseM(mu)) * (1.0 - exp(-tau * mv)) / tau;
  float amb = 0.02 + 0.25 * sunVis(s.y + 0.1) * max(0.0, s.y + 0.1);
  L += amb * vec3(0.32, 0.45, 0.75) + vec3(0.004, 0.006, 0.012);
  return L;
}
/** skyRadiance without the Mie aureole (fog colour). */
vec3 skyAmbient(vec3 v, vec3 s) {
  float mv = airmassY(max(v.y, 0.0));
  float mu = dot(v, s);
  vec3 tau = TAU_R + TAU_M;
  vec3 L = SUN_E * sunTransSky(s.y, v.y) * (TAU_R * phaseR(mu) + TAU_M * 0.08) * (1.0 - exp(-tau * mv)) / tau;
  float amb = 0.02 + 0.25 * sunVis(s.y + 0.1) * max(0.0, s.y + 0.1);
  L += amb * vec3(0.32, 0.45, 0.75) + vec3(0.004, 0.006, 0.012);
  return L;
}
`;

/**
 * Playtest 2 visual styles (world/style/styles.ts): the sky's look on top of
 * the physics, shared by the sky dome and the fog colour so the horizon still
 * matches. Needs uniform `uSkyStyle` = (saturation, brightness, painterly
 * bands, zenith-to-horizon gradient); (1, 1, 0, 0) is the plain sky.
 */
export const SKY_STYLE_GLSL = /* glsl */ `
uniform vec4 uSkyStyle;
vec3 lsSkyStyle(vec3 col, float vy) {
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, uSkyStyle.x), 0.0) * uSkyStyle.y;
  col *= mix(vec3(1.0), mix(vec3(1.07, 1.02, 0.94), vec3(0.88, 0.96, 1.1), smoothstep(0.02, 0.55, vy)), uSkyStyle.w);
  if (uSkyStyle.z > 0.0) {
    float l2 = max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
    float x = sqrt(l2) * 9.0;
    float q = (floor(x) + smoothstep(0.3, 0.7, fract(x))) / 9.0;
    col *= mix(1.0, q * q / l2, uSkyStyle.z);
  }
  return col;
}
`;
