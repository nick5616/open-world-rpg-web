// Materials and geometry of the gem cavern (title + character stage): procedural
// only (shaders and generated buffers, no textures, no downloads).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GEMS, caveSurface } from './caveGen';

export const caveUniforms = {
  uTime: { value: 0 },
  /** Gem shimmer amplitude (0 when reduce flashing / reduced motion). */
  uShim: { value: 1 },
};

const NOISE = /* glsl */ `
float csHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float csNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(csHash(i), csHash(i + vec3(1,0,0)), f.x), mix(csHash(i + vec3(0,1,0)), csHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(csHash(i + vec3(0,0,1)), csHash(i + vec3(1,0,1)), f.x), mix(csHash(i + vec3(0,1,1)), csHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

/** The cavern geometry: a squashed, noise-displaced sphere seen from inside, flat-ish floor. */
export function caveGeometry(widthSeg: number, heightSeg: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, widthSeg, heightSeg);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const tmp: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    const { p } = caveSurface(pos.getX(i), pos.getY(i), pos.getZ(i), tmp);
    pos.setXYZ(i, p[0], p[1], p[2]);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

/** Wet, dark, veined rock: noise colour, glowing gold/copper ore veins and flecks, wet low-roughness floor patches. */
export function caveRockMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0.02, side: THREE.BackSide });
  m.defines = { LS_NO_RIM: '' };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = caveUniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCsWorld;\nvarying vec3 vCsN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCsWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvCsN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying vec3 vCsWorld;\nvarying vec3 vCsN;\n${NOISE}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec3 csP = vCsWorld;
float csN1 = csNoise(csP * 0.8) * 0.5 + csNoise(csP * 3.1) * 0.3 + csNoise(csP * 9.0) * 0.2;
float csStrata = csNoise(vec3(csP.x * 0.12, csP.y * 1.7, csP.z * 0.12));
vec3 csRock = mix(vec3(0.045, 0.05, 0.09), vec3(0.19, 0.18, 0.26), csN1);
csRock = mix(csRock, vec3(0.11, 0.07, 0.13), smoothstep(0.55, 0.82, csStrata) * 0.65);
float csVm = csNoise(csP * 0.16 + 4.0);
float csVr = abs(csNoise(csP * 0.95 + vec3(11.0, 3.0, 5.0)) - 0.5);
float csVein = (1.0 - smoothstep(0.0, 0.016, csVr)) * smoothstep(0.52, 0.7, csVm);
float csFleck = step(0.93, csNoise(csP * 11.0)) * smoothstep(0.4, 0.65, csVm);
float csOre = clamp(csVein + csFleck * 0.7, 0.0, 1.0);
float csFloorUp = smoothstep(0.55, 0.85, -vCsN.y);
float csWet = smoothstep(0.56, 0.7, csNoise(csP * 0.22 + 3.0)) * csFloorUp;
diffuseColor.rgb = mix(csRock, vec3(0.62, 0.42, 0.16), csOre * 0.55) * (1.0 - csWet * 0.35);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.14, csWet);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += mix(vec3(1.0, 0.66, 0.24), vec3(0.85, 0.4, 0.22), csNoise(csP * 0.3)) * csOre * (0.3 + 0.12 * sin(uTime * 0.35 + csP.x * 0.4));`,
      );
  };
  return m;
}

/** One unit crystal: a hexagonal prism (y 0..1) with a pyramid tip (to 1.55), tapered. */
export function crystalGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.42, 0.5, 1, 6, 1, true);
  body.translate(0, 0.5, 0);
  const tip = new THREE.ConeGeometry(0.42, 0.55, 6, 1);
  tip.translate(0, 1.275, 0);
  const parts = [body, tip].map((g) => {
    const n = g.toNonIndexed();
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    return n;
  });
  const out = mergeGeometries(parts, false)!;
  body.dispose();
  tip.dispose();
  for (const p of parts) p.dispose();
  return out;
}

/** A gem: faceted, glossy, glowing from within (stronger toward the tip), slow travelling sparkle bands. */
export function gemMaterial(gem: number): THREE.MeshStandardMaterial {
  const g = GEMS[gem];
  const m = new THREE.MeshStandardMaterial({ color: g.body, roughness: 0.22, metalness: 0.1, flatShading: true, emissive: g.body, emissiveIntensity: 1.0 });
  m.defines = { LS_NO_RIM: '' };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = caveUniforms.uTime;
    sh.uniforms.uShim = caveUniforms.uShim;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCsH;\nvarying vec3 vCsWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCsH = position.y;\nvCsWp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform float uShim;\nvarying float vCsH;\nvarying vec3 vCsWp;\n${NOISE}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
float csG = 0.42 + 0.78 * smoothstep(0.0, 1.3, vCsH);
float csFr = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.0);
float csSp = 0.14 * sin(vCsH * 6.5 + uTime * 0.55 + csHash(floor(vCsWp * 0.5)) * 6.283) * uShim;
totalEmissiveRadiance *= (csG + csFr * 0.9) * (1.0 + csSp);`,
      );
  };
  return m;
}

/** Soft additive glow points (per-point size and colour): cluster halos and drifting motes. */
export function glowPointsMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 400 }, uTime: caveUniforms.uTime, uTwinkle: { value: 0.25 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aPhase;
      uniform float uScale; uniform float uTime; uniform float uTwinkle;
      varying vec3 vC; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 1.0 - uTwinkle * (0.5 + 0.5 * sin(uTime * 0.7 + aPhase * 6.283));
        gl_PointSize = aSize * uScale / max(0.1, -mv.z);
        vC = aColor; vA = tw;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = pow(clamp(1.0 - d, 0.0, 1.0), 2.2);
        gl_FragColor = vec4(vC * a * vA, a * vA);
      }`,
  });
}

/** Additive radial light pool laid on the floor (instanced; per-instance colour). */
export function poolMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: caveUniforms.uTime },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vC;
      void main() {
        vUv = uv - 0.5;
        #ifdef USE_INSTANCING_COLOR
          vC = instanceColor;
        #else
          vC = vec3(1.0);
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv; varying vec3 vC;
      void main() {
        float d = length(vUv) * 2.0;
        float ang = atan(vUv.y, vUv.x);
        float ripple = 0.9 + 0.1 * sin(ang * 3.0 + uTime * 0.3) * sin(ang * 5.0 - uTime * 0.2);
        float a = pow(clamp(1.0 - d * (1.0 / ripple), 0.0, 1.0), 1.8);
        gl_FragColor = vec4(vC * a, a);
      }`,
  });
}

/** A soft vertical light shaft: additive, fades along its length and toward its edges. */
export function shaftMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: caveUniforms.uTime, uAmp: { value: 0.1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime; uniform float uAmp;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        float along = pow(clamp(vUv.y, 0.0, 1.0), 1.4);
        float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float slow = 0.85 + 0.15 * sin(uTime * 0.2 + vUv.x * 9.0);
        float a = along * edge * slow * uAmp;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
}

/** Flame: layered additive cone with a gentle vertical gradient. */
export function flameMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: caveUniforms.uTime },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        float fade = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 0.8);
        float rim = pow(abs(dot(normalize(vN), normalize(vV))), 1.2);
        float a = fade * rim;
        gl_FragColor = vec4(uColor * a * 1.6, a);
      }`,
  });
}

