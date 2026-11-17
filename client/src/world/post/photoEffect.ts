// Playtest 2 photo mode's screen pass (ui/photo): depth of field, vignette
// and film grain. Its own EffectPass at the end of the chain (PostFX.photo),
// enabled only while photo mode is up with a non-zero knob, so ordinary play
// never pays for it; it reads the scene depth like the fog does.
//
//   depth of field  a 24-tap golden-angle disc gather whose radius follows
//                   the circle of confusion: |z - focus| / z, scaled by the
//                   strength (max ~14 px at full strength)
//   vignette        the style pass's falloff, stronger
//   grain           luminance-weighted hash noise, re-seeded every frame

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const FRAG = /* glsl */ `
uniform vec4 uPhoto; // dof strength 0..1, focus distance m, vignette 0..1, grain 0..1
uniform float uSeed;
float phZ(const in vec2 p) {
  float d = readDepth(p);
  return d >= 0.999999 ? 1e4 : -getViewZ(d);
}
float phHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  if (uPhoto.x > 0.0) {
    float z = phZ(uv);
    float coc = clamp(abs(z - uPhoto.y) / max(z, 0.5) * 2.2, 0.0, 1.0) * uPhoto.x;
    float r = coc * 14.0;
    if (r > 0.5) {
      vec3 acc = c;
      float wsum = 1.0;
      for (int i = 1; i < 24; i++) {
        float fi = float(i);
        float a = fi * 2.39996323;
        vec2 o = vec2(cos(a), sin(a)) * sqrt(fi / 24.0) * r * texelSize;
        // a sharp foreground sample doesn't bleed into the blur behind it
        float zs = phZ(uv + o);
        float cs = clamp(abs(zs - uPhoto.y) / max(zs, 0.5) * 2.2, 0.0, 1.0) * uPhoto.x;
        float w = zs < z - 0.5 ? cs : 1.0;
        acc += texture2D(inputBuffer, uv + o).rgb * w;
        wsum += w;
      }
      c = acc / wsum;
    }
  }
  if (uPhoto.z > 0.0) {
    float v = (1.0 - smoothstep(0.25, 0.95, length((uv - 0.5) * vec2(1.0, 0.82)) * 1.4));
    c *= mix(1.0, v, uPhoto.z);
  }
  if (uPhoto.w > 0.0) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float n = phHash(floor(uv / texelSize)) - 0.5;
    c += n * uPhoto.w * 0.16 * (0.35 + 0.65 * (1.0 - l));
  }
  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`;

export class PhotoEffect extends Effect {
  constructor() {
    super('PhotoEffect', FRAG, {
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uPhoto', new THREE.Uniform(new THREE.Vector4(0, 10, 0, 0))],
        ['uSeed', new THREE.Uniform(0)],
      ]),
    });
  }
  get photo(): THREE.Vector4 {
    return this.uniforms.get('uPhoto')!.value as THREE.Vector4;
  }
  override update(): void {
    const u = this.uniforms.get('uSeed')!;
    u.value = ((u.value as number) + 1.618) % 97;
  }
}
