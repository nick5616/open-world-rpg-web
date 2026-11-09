// Style hooks in every lit material, without a recompile per style
// (playtest 2 graphics styles, styles.ts).
//
// three.js builds the built-in materials (MeshStandardMaterial, Lambert,
// Phong, Basic...) from ShaderChunk strings and a per-program clone of the
// ShaderLib uniforms. Patching a few chunks once, before the first program
// compiles, puts the hooks into every material in the game (terrain, scatter,
// towns, caves, avatars, weapons, spell meshes) whatever package made it:
//
//   lights_*_pars_fragment  RE_Direct: the N.L term goes through lsToon()
//                           (banded light with soft edges) and upright
//                           surfaces get a rim light (characters, trunks,
//                           walls; never the ground, so grazing terrain is
//                           not washed out).
//   logdepthbuf_vertex      (right after project_vertex in every vertex
//                           shader, including the scatter and water shaders
//                           that replace project_vertex): retro vertex snap.
//   common                  declares the two uniforms.
//
// The uniforms are registered on the ShaderLib entries with a Float32Array
// value. UniformsUtils.clone copies Vectors and Colors but passes typed arrays
// through by reference, so every program's copy points at the same array and
// a style switch is a write into it: no program changes, no warm-up.
//
//   lsStyle  = (toon amount, rim, toon bands, band softness)
//   lsRetro  = (snap grid x, snap grid y, affine amount, texel snap)
//
// Materials opt out with defines: LS_NO_RIM (terrain, horizon), LS_NO_SNAP.
// ShaderMaterials that want the hooks add STYLE_UNIFORMS to their uniforms.

import * as THREE from 'three';

export const lsStyle = new Float32Array([0, 0, 2, 0.2]);
export const lsRetro = new Float32Array([0, 0, 0, 0]);

/** Shared uniform objects (add to a ShaderMaterial's uniforms to opt in). */
export const STYLE_UNIFORMS = { lsStyle: { value: lsStyle }, lsRetro: { value: lsRetro } };

const DECL = /* glsl */ `
uniform vec4 lsStyle;
uniform vec4 lsRetro;
`;

/** Banded light: sqrt-shaped so the terminator sits low (a broad lit side, a narrow shade band). */
const TOON = /* glsl */ `
float lsToon(float d) {
  if (lsStyle.x <= 0.0) return d;
  float n = max(lsStyle.z - 1.0, 1.0);
  float x = sqrt(max(d, 0.0)) * n;
  float q = (floor(x) + smoothstep(0.5 - lsStyle.w, 0.5 + lsStyle.w, fract(x))) / n;
  return mix(d, min(q, 1.0), lsStyle.x);
}
`;

const DOT_NL = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
const TOON_CALL = `${DOT_NL}\n\tdotNL = lsToon( dotNL );`;

/** Added to RE_Direct after the diffuse term (`diffuse` is the material's diffuse colour expression). */
const rim = (diffuse: string) => /* glsl */ `
	#ifndef LS_NO_RIM
	if ( lsStyle.y > 0.0 ) {
		vec3 lsUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
		float lsUpright = 1.0 - smoothstep( 0.45, 0.85, abs( dot( geometryNormal, lsUp ) ) );
		float lsFr = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 3.0 );
		float lsWrap = saturate( dot( geometryNormal, directLight.direction ) * 0.5 + 0.6 );
		reflectedLight.directDiffuse += lsStyle.y * lsFr * lsUpright * lsWrap * directLight.color * ( 0.3 + 0.7 * ${diffuse} );
	}
	#endif
`;

// Not in the shadow passes (depth/distance materials): snapping in light
// space would only shift shadows off their (snapped) receivers.
const SNAP = /* glsl */ `
#if !defined( LS_NO_SNAP ) && !defined( DEPTH_PACKING ) && !defined( DISTANCE )
if ( lsRetro.x > 0.0 && gl_Position.w > 0.0 ) {
	gl_Position.xy = floor( gl_Position.xy / gl_Position.w * lsRetro.xy + 0.5 ) / lsRetro.xy * gl_Position.w;
}
#endif
`;

function patchLights(chunk: 'lights_physical_pars_fragment' | 'lights_lambert_pars_fragment' | 'lights_phong_pars_fragment', diffuseAdd: RegExp, diffuse: string): void {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  let src = chunks[chunk];
  if (!src.includes(DOT_NL) || !diffuseAdd.test(src)) throw new Error(`three ${chunk} layout changed: update styleShader.ts`);
  src = src.replace(DOT_NL, TOON_CALL);
  src = src.replace(diffuseAdd, (m) => `${m}\n${rim(diffuse)}`);
  chunks[chunk] = `${TOON}\n${src}`;
}

let installed = false;

/** Patch the chunks and register the uniforms. Idempotent; must run before the first program compiles. */
export function installStyleChunks(): void {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.common = `${chunks.common}\n${DECL}`;
  chunks.logdepthbuf_vertex = `${SNAP}\n${chunks.logdepthbuf_vertex}`;
  patchLights('lights_physical_pars_fragment', /reflectedLight\.directDiffuse \+= irradiance \* BRDF_Lambert\( material\.diffuseColor \);/, 'material.diffuseColor');
  patchLights('lights_lambert_pars_fragment', /reflectedLight\.directDiffuse \+= irradiance \* BRDF_Lambert\( material\.diffuseColor \);/, 'material.diffuseColor');
  patchLights('lights_phong_pars_fragment', /reflectedLight\.directDiffuse \+= irradiance \* BRDF_Lambert\( material\.diffuseColor \);/, 'material.diffuseColor');
  // Every ShaderLib entry (depth and distance materials too: the shadow
  // passes include logdepthbuf_vertex; an active uniform without a value
  // makes three.js throw in WebGLUniforms.upload).
  const lib = THREE.ShaderLib as unknown as Record<string, { uniforms?: Record<string, THREE.IUniform> }>;
  for (const id of Object.keys(lib)) {
    const u = lib[id]?.uniforms;
    if (!u) continue;
    u.lsStyle = { value: lsStyle };
    u.lsRetro = { value: lsRetro };
  }
  // ShaderMaterials (any package's) that include <common> and
  // <logdepthbuf_vertex> get the uniforms too, so the snap code can never
  // reference a uniform the material lacks. The default onBeforeCompile is a
  // no-op shared by every material that does not set its own.
  THREE.Material.prototype.onBeforeCompile = function lsStyleUniforms(shader: { uniforms?: Record<string, THREE.IUniform> }) {
    const u = shader.uniforms;
    if (u && !u.lsRetro) {
      u.lsStyle = STYLE_UNIFORMS.lsStyle;
      u.lsRetro = STYLE_UNIFORMS.lsRetro;
    }
  } as THREE.Material['onBeforeCompile'];
}

installStyleChunks();
