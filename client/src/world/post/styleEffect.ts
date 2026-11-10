// The visual style's screen pass (playtest 2 graphics styles, style/styles.ts):
// one Effect merged into the post chain's single EffectPass, after the grade.
// Every knob is a uniform, so switching style never recompiles it.
//
//   ink outlines   depth Laplacian over 4 taps, relative to depth, faded out
//                  with distance (Painterly)
//   posterize      luminance bands with soft edges, hue kept (Painterly's
//                  flatter colour)
//   vignette
//   quantize       per-channel colour levels in sRGB with a 4x4 ordered
//                  (Bayer) dither in internal pixels (Retro's 15-bit look)

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const FRAG = /* glsl */ `
uniform vec4 uOutline;   // strength, thickness (px), threshold, fade distance (m)
uniform vec4 uLook;      // posterize levels, vignette, quantize levels, dither strength
float lsLinZ(const in vec2 p) { return -getViewZ(readDepth(p)); }
float lsBayer(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[idx] + 0.5) / 16.0 - 0.5;
}
vec3 lsToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 lsToLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  if (uOutline.x > 0.0 && depth < 0.999999) {
    float z0 = lsLinZ(uv);
    vec2 t = texelSize * uOutline.y;
    float lap = abs(lsLinZ(uv + vec2(t.x, 0.0)) + lsLinZ(uv - vec2(t.x, 0.0)) + lsLinZ(uv + vec2(0.0, t.y)) + lsLinZ(uv - vec2(0.0, t.y)) - 4.0 * z0) / max(z0, 0.5);
    float edge = smoothstep(uOutline.z, uOutline.z * 3.0, lap) * (1.0 - smoothstep(uOutline.w * 0.4, uOutline.w, z0));
    c = mix(c, c * vec3(0.16, 0.14, 0.2), edge * uOutline.x);
  }
  if (uLook.x > 0.0) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float x = sqrt(max(l, 0.0)) * uLook.x;
    float q = (floor(x) + smoothstep(0.3, 0.7, fract(x))) / uLook.x;
    c *= mix(1.0, (q * q) / max(l, 1e-4), 0.75);
  }
  if (uLook.y > 0.0) {
    float v = smoothstep(0.95, 0.3, length((uv - 0.5) * vec2(1.0, 0.82)) * 1.35);
    c *= mix(1.0, v, uLook.y);
  }
  if (uLook.z > 0.0) {
    vec3 s = lsToSrgb(clamp(c, 0.0, 1.0));
    s = floor(s * uLook.z + 0.5 + lsBayer(gl_FragCoord.xy) * uLook.w) / uLook.z;
    c = lsToLin(clamp(s, 0.0, 1.0));
  }
  outputColor = vec4(c, inputColor.a);
}
`;

export class StyleEffect extends Effect {
  constructor() {
    super('StyleEffect', FRAG, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uOutline', new THREE.Uniform(new THREE.Vector4(0, 1, 0.08, 220))],
        ['uLook', new THREE.Uniform(new THREE.Vector4(0, 0, 0, 0))],
      ]),
    });
  }
  get outline(): THREE.Vector4 {
    return this.uniforms.get('uOutline')!.value as THREE.Vector4;
  }
  get look(): THREE.Vector4 {
    return this.uniforms.get('uLook')!.value as THREE.Vector4;
  }
}
