// A NaN / Inf guard for the HDR scene colour (Playtest 4, Linux GPU dark-blue screen).
//
// One NaN pixel is not one bad pixel: the bloom's luminance pass feeds a mip
// pyramid whose blurs average it into every level, so a single NaN in the scene
// buffer turned the whole frame black on Mesa / NVIDIA OpenGL (ANGLE/D3D11
// happens to hide the same shader bugs). The test is a bit test on the float's
// exponent field, because `x != x` and `isnan()` may be folded away by the
// compiler's fast-math assumptions; select with `?:` rather than mix() because
// NaN * 0 is NaN. Negative radiance (a lighting artefact) and values beyond the
// half-float range are clamped as well.

export const FINITE_GLSL = /* glsl */ `
float lsFiniteF(float x) {
  return (floatBitsToUint(x) & 0x7F800000u) == 0x7F800000u ? 0.0 : clamp(x, 0.0, 60000.0);
}
vec3 lsFinite(vec3 c) {
  return vec3(lsFiniteF(c.r), lsFiniteF(c.g), lsFiniteF(c.b));
}
`;

/**
 * Patch postprocessing's luminance pass (its `main` starts with
 * `vec4 texel=texture2D(inputBuffer,vUv);`) so the texel it reads is sanitised.
 * Returns the source unchanged if the library's shader no longer has that shape.
 */
export function guardLuminanceFragment(src: string): string {
  const needle = 'vec4 texel=texture2D(inputBuffer,vUv);';
  if (!src.includes(needle)) return src;
  return src.replace('varying vec2 vUv;', `${FINITE_GLSL}\nvarying vec2 vUv;`).replace(needle, `${needle}texel.rgb=lsFinite(texel.rgb);`);
}
