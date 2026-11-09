// Custom spell shaders (ported from wizard-wars client/src/components/spells/
// fx/materials.ts, plus Lodestone's lightning/wind/light zone and dome
// styles, the shield shell and the bolt ribbon). All unlit, so their
// programs don't depend on the scene's light count and compile once in the
// shader warm-up (warm.ts) however many instances exist. Each factory
// returns a fresh ShaderMaterial (its own uniforms) sharing the cached program.
//
// Conventions: additive blending, depthWrite off, linear THREE.Colors (HDR
// values > 1.25 bloom on medium and high), output through the renderer's
// tone mapping and colour space chunks (no-ops inside the post chain).

import * as THREE from 'three';

const OUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

const NOISE = /* glsl */ `
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return v; }
`;

type U<T extends string> = Record<T, { value: unknown }>;
export type FxShader<T extends string> = THREE.ShaderMaterial & { uniforms: U<T> };

function additive(params: THREE.ShaderMaterialParameters): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...params });
}

const UV_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// ── Beam ────────────────────────────────────────────────────────────────────
// Open cylinder (GEO.beam, y 0..1 along its length). Brightness follows how
// squarely each fragment faces the camera across the axis, so it reads as a
// volumetric shaft with a hot core from any angle (your own beam seen almost
// end-on in first person keeps its core). Scrolling noise = energy flowing.
export type BeamMat = FxShader<'uColor' | 'uCore' | 'uOpacity' | 'uTime' | 'uScroll' | 'uNoise' | 'uLength'>;
export function createBeamMaterial(): BeamMat {
  return additive({
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color() },
      uCore: { value: new THREE.Color() },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uScroll: { value: 6 },
      uNoise: { value: 0.35 },
      uLength: { value: 10 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vAxis; varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vAxis = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uCore; uniform float uOpacity; uniform float uTime;
      uniform float uScroll; uniform float uNoise; uniform float uLength;
      varying vec3 vN; varying vec3 vV; varying vec3 vAxis; varying vec2 vUv;
      ${NOISE}
      void main() {
        vec3 axis = normalize(vAxis);
        vec3 v = normalize(vV);
        vec3 vp = v - axis * dot(v, axis);
        float vpl = length(vp);
        float facing = vpl > 0.02 ? abs(dot(normalize(vN), vp / vpl)) : 1.0;
        float body = pow(facing, 1.6);
        float core = pow(facing, 9.0);
        float along = vUv.y * uLength;
        float n = fbm(vec2(vUv.x * 3.1416, along * 0.6 - uTime * uScroll));
        float energy = mix(1.0, 0.55 + n * 0.9, uNoise);
        float ends = smoothstep(0.0, 0.02, vUv.y) * (1.0 - smoothstep(0.96, 1.0, vUv.y));
        vec3 col = uColor * body * energy + uCore * core * 1.6;
        float a = clamp((body * 0.85 * energy + core) * uOpacity * ends, 0.0, 1.0);
        gl_FragColor = vec4(col, a);
        ${OUT}
      }
    `,
  }) as BeamMat;
}

// ── Magic circle ────────────────────────────────────────────────────────────
// Procedural ground sigil (uv 0..1 -> -1..1): outer and inner rings, a
// rotating ring of runic ticks, an n-pointed star (per family), a sweep
// fill for windup / arming progress.
export type CircleMat = FxShader<'uColor' | 'uColor2' | 'uOpacity' | 'uTime' | 'uProgress' | 'uSides' | 'uSpin' | 'uFill'>;
export function createCircleMaterial(): CircleMat {
  return additive({
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color() },
      uColor2: { value: new THREE.Color() },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uProgress: { value: 1 },
      uSides: { value: 5 },
      uSpin: { value: 0.4 },
      uFill: { value: 0.12 },
    },
    vertexShader: UV_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uColor2; uniform float uOpacity; uniform float uTime;
      uniform float uProgress; uniform float uSides; uniform float uSpin; uniform float uFill;
      varying vec2 vUv;
      #define PI 3.14159265
      float line(float d, float w) { float fw = fwidth(d) * 1.2; return 1.0 - smoothstep(w, w + fw, abs(d)); }
      float polyDist(vec2 p, float n, float rot) {
        float a = atan(p.y, p.x) + rot;
        float sector = 2.0 * PI / n;
        return cos(floor(0.5 + a / sector) * sector - a) * length(p);
      }
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.02) discard;
        float ang = atan(p.y, p.x);
        float rot = uTime * uSpin;
        float outer = line(r - 0.965, 0.022);
        float inner = line(r - 0.80, 0.010);
        float ticks = step(0.83, r) * step(r, 0.93);
        float tickPattern = step(0.55, fract((ang - rot * 0.7) * 24.0 / (2.0 * PI))) * step(0.3, fract((ang - rot * 0.7) * 3.0 / PI + 0.17));
        float tickLine = ticks * tickPattern * 0.55;
        float n = max(3.0, uSides);
        float starR = 0.70 * cos(PI / n);
        float star = line(polyDist(p, n, rot) - starR, 0.012) + line(polyDist(p, n, rot + PI / n) - starR, 0.012);
        float innerCircle = line(r - starR * 0.62, 0.009);
        float centerDot = exp(-r * r * 60.0) * 0.8;
        float sweepAng = fract((ang + PI * 0.5) / (2.0 * PI));
        float swept = step(sweepAng, uProgress);
        float glow = (outer * 1.3 + inner * 0.8 + tickLine + star * 0.85 + innerCircle * 0.6 + centerDot) * mix(0.55, 1.0, swept);
        float fill = (uFill + 0.08 * smoothstep(0.6, 1.0, r)) * mix(0.35, 1.0, swept);
        glow += line(r - 0.965, 0.06) * 0.25;
        vec3 col = mix(uColor, uColor2, clamp(glow * 0.5, 0.0, 1.0));
        float a = clamp((glow + fill) * uOpacity, 0.0, 1.0);
        if (a < 0.003) discard;
        gl_FragColor = vec4(col * (1.0 + glow * 0.6), a);
        ${OUT}
      }
    `,
  }) as CircleMat;
}

// ── Ground zone ─────────────────────────────────────────────────────────────
// Lingering areas, cone and line flashes, domain floors. Animated noise per
// style, soft edge, brighter rim. uSector (radians, 0 = full disc) and
// uYaw cut a cone; uLine > 0 makes it a strip (aspect = length / width).
// uStyle: 0 lava, 1 frost, 2 void swirl, 3 steel, 4 nature, 5 crystal,
// 6 storm (crackle), 7 wind (spiral streaks), 8 radiance (rays).
export type ZoneMat = FxShader<'uColor' | 'uColor2' | 'uOpacity' | 'uTime' | 'uStyle' | 'uScale' | 'uSector' | 'uYaw' | 'uLine'>;
export function createZoneMaterial(): ZoneMat {
  return additive({
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color() },
      uColor2: { value: new THREE.Color() },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uStyle: { value: 0 },
      uScale: { value: 3 },
      uSector: { value: 0 },
      uYaw: { value: 0 },
      uLine: { value: 0 },
    },
    vertexShader: UV_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uColor2; uniform float uOpacity; uniform float uTime;
      uniform float uStyle; uniform float uScale; uniform float uSector; uniform float uYaw; uniform float uLine;
      varying vec2 vUv;
      ${NOISE}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float edge; float rim;
        if (uLine > 0.0) {
          // strip along +local z (uv.y): soft sides, bright border
          float ax = abs(p.x);
          edge = 1.0 - smoothstep(0.75, 1.0, ax);
          rim = smoothstep(0.82, 0.96, ax) * (1.0 - smoothstep(0.96, 1.0, ax)) + (1.0 - smoothstep(0.0, 0.04, 1.0 - abs(p.y))) * 0.6;
          r = abs(p.x) * 0.5 + 0.25;
        } else {
          if (r > 1.0) discard;
          edge = 1.0 - smoothstep(0.82, 1.0, r);
          rim = smoothstep(0.78, 0.96, r) * (1.0 - smoothstep(0.96, 1.0, r));
          if (uSector > 0.0) {
            // world yaw convention: forward (-z) at yaw 0; plane uv.y up = -z
            float a = atan(-p.x, p.y) - uYaw;
            a = mod(a + 3.14159265, 6.2831853) - 3.14159265;
            float half_ = uSector * 0.5;
            if (abs(a) > half_) discard;
            rim += (1.0 - smoothstep(0.0, 0.05, half_ - abs(a))) * 0.8 * step(0.15, r);
          }
        }
        vec2 q = p * uScale;
        float v;
        if (uStyle < 0.5) {
          float n = fbm(q + vec2(0.0, -uTime * 0.25));
          v = pow(1.0 - abs(n - 0.5) * 2.0, 6.0) * 1.4 + n * 0.35;
        } else if (uStyle < 1.5) {
          float n = fbm(q * 1.6 + uTime * 0.05);
          v = smoothstep(0.55, 0.75, n) * 0.9 + 0.22;
        } else if (uStyle < 2.5) {
          float a = atan(p.y, p.x) + r * 5.0 - uTime * 1.6;
          float n = fbm(vec2(a * 1.3, r * 4.0 - uTime * 0.8));
          v = smoothstep(0.35, 0.85, n) * (1.2 - r * 0.4);
        } else if (uStyle < 3.5) {
          float n = vnoise(vec2(q.x * 0.6, q.y * 6.0 + uTime));
          v = smoothstep(0.7, 0.95, n) * 0.8 + 0.12;
        } else if (uStyle < 4.5) {
          float n = fbm(q * 0.9 + uTime * 0.04);
          v = smoothstep(0.4, 0.8, n) * 0.85 + 0.12;
        } else if (uStyle < 5.5) {
          vec2 g = q * 1.3;
          vec2 id = floor(g);
          float h = hash21(id);
          v = 0.25 + 0.75 * step(0.6, fract(h + uTime * 0.3)) * (1.0 - smoothstep(0.35, 0.5, length(fract(g) - 0.5)));
        } else if (uStyle < 6.5) {
          // storm: thin crackling veins that re-strike several times a second
          float t = floor(uTime * 9.0);
          float n = fbm(q * 1.4 + vec2(t * 3.1, t * 1.7));
          v = pow(1.0 - abs(n - 0.5) * 2.0, 14.0) * 2.0 + 0.1;
        } else if (uStyle < 7.5) {
          // wind: spiral streaks sweeping round
          float a = atan(p.y, p.x) - r * 3.0 + uTime * 3.0;
          v = pow(0.5 + 0.5 * sin(a * 5.0 + vnoise(q) * 2.0), 6.0) * 0.9 + 0.08;
        } else {
          // radiance: slow rays turning from the centre
          float a = atan(p.y, p.x) + uTime * 0.3;
          v = pow(0.5 + 0.5 * sin(a * 12.0), 3.0) * (1.1 - r) + 0.25;
        }
        vec3 col = mix(uColor, uColor2, clamp(v, 0.0, 1.0));
        float a = clamp((v * 0.55 * edge + rim * 0.8) * uOpacity, 0.0, 1.0);
        if (a < 0.003) discard;
        gl_FragColor = vec4(col * (1.0 + rim), a);
        ${OUT}
      }
    `,
  }) as ZoneMat;
}

// ── Domain dome ─────────────────────────────────────────────────────────────
// Inside-out hemisphere around the domain: fresnel horizon glow + an
// animated pattern per style, revealed by a wave sweeping up from the ground.
// uStyle: 0 inferno flames, 1 frozen crackle, 2 spiralling void bands,
// 3 meridians, 4 canopy dapples, 5 hex lattice, 6 storm wall, 7 gale bands,
// 8 radiant rays.
export type DomeMat = FxShader<'uColor' | 'uColor2' | 'uOpacity' | 'uTime' | 'uStyle' | 'uReveal'>;
export function createDomeMaterial(): DomeMat {
  return additive({
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color() },
      uColor2: { value: new THREE.Color() },
      uOpacity: { value: 0 },
      uTime: { value: 0 },
      uStyle: { value: 0 },
      uReveal: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vLocal;
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uColor2; uniform float uOpacity; uniform float uTime;
      uniform float uStyle; uniform float uReveal;
      varying vec3 vN; varying vec3 vV; varying vec3 vLocal;
      ${NOISE}
      #define PI 3.14159265
      void main() {
        vec3 dir = normalize(vLocal);
        float h = dir.y;
        if (h < -0.05) discard;
        float ang = atan(dir.z, dir.x);
        vec2 uv = vec2(ang / (2.0 * PI) + 0.5, h);
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
        float horizon = exp(-h * 5.0);
        float pat;
        if (uStyle < 0.5) {
          float n = fbm(vec2(uv.x * 24.0, h * 4.0 - uTime * 1.4));
          pat = smoothstep(0.45, 0.8, n) * (1.2 - h);
        } else if (uStyle < 1.5) {
          float n = fbm(vec2(uv.x * 30.0, h * 10.0 + uTime * 0.03));
          pat = smoothstep(0.62, 0.66, n) * 1.2 + n * 0.15;
        } else if (uStyle < 2.5) {
          float n = fbm(vec2(uv.x * 10.0 + h * 6.0 - uTime * 0.5, h * 3.0));
          pat = smoothstep(0.4, 0.9, n);
        } else if (uStyle < 3.5) {
          float m = abs(fract(uv.x * 36.0) - 0.5);
          pat = (1.0 - smoothstep(0.0, 0.03, m)) * 0.6 + (1.0 - smoothstep(0.0, 0.01, abs(fract(h * 8.0) - 0.5))) * 0.3;
        } else if (uStyle < 4.5) {
          float n = fbm(vec2(uv.x * 18.0 + uTime * 0.05, h * 6.0));
          pat = smoothstep(0.5, 0.75, n) * 0.9;
        } else if (uStyle < 5.5) {
          vec2 g = vec2(uv.x * 40.0, h * 14.0);
          g.x += mod(floor(g.y), 2.0) * 0.5;
          vec2 f = abs(fract(g) - 0.5);
          float hexEdge = 1.0 - smoothstep(0.0, 0.06, min(0.5 - f.x, 0.5 - f.y));
          pat = hexEdge * (0.6 + 0.4 * sin(uTime * 2.0 + floor(g.x) * 1.7 + floor(g.y)));
        } else if (uStyle < 6.5) {
          float t = floor(uTime * 8.0);
          float n = fbm(vec2(uv.x * 20.0 + t * 1.3, h * 6.0 + t * 0.7));
          pat = pow(1.0 - abs(n - 0.5) * 2.0, 12.0) * 1.8;
        } else if (uStyle < 7.5) {
          pat = pow(0.5 + 0.5 * sin((uv.x * 20.0 + h * 4.0 - uTime * 1.5) * 3.14159), 8.0) * (1.1 - h);
        } else {
          pat = pow(0.5 + 0.5 * sin(uv.x * 60.0 + uTime * 0.4), 4.0) * (1.0 - h * 0.6);
        }
        float reveal = 1.0 - smoothstep(uReveal * 1.15 - 0.1, uReveal * 1.15, h);
        vec3 col = mix(uColor, uColor2, clamp(pat, 0.0, 1.0));
        float a = (fres * 0.6 + horizon * 0.35 + pat * 0.45) * uOpacity * reveal;
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        ${OUT}
      }
    `,
  }) as DomeMat;
}

// ── Shockwave ring ──────────────────────────────────────────────────────────
export type RingMat = FxShader<'uColor' | 'uOpacity' | 'uR' | 'uW'>;
export function createRingMaterial(): RingMat {
  return additive({
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 1 }, uR: { value: 0.5 }, uW: { value: 0.08 } },
    vertexShader: UV_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity; uniform float uR; uniform float uW;
      varying vec2 vUv;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        if (r > 1.0) discard;
        float band = exp(-pow((r - uR) / uW, 2.0));
        float inner = smoothstep(0.0, uR, r) * step(r, uR) * 0.18;
        float a = (band + inner) * uOpacity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * (1.0 + band), clamp(a, 0.0, 1.0));
        ${OUT}
      }
    `,
  }) as RingMat;
}

// ── Shell ───────────────────────────────────────────────────────────────────
// Fresnel bubble (shields, the elemental form aura, status shells): bright
// rim, near-clear middle so the wearer stays readable, a slow hex shimmer.
export type ShellMat = FxShader<'uColor' | 'uOpacity' | 'uTime' | 'uHex'>;
export function createShellMaterial(): ShellMat {
  return additive({
    side: THREE.FrontSide,
    uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 1 }, uTime: { value: 0 }, uHex: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vLocal;
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uHex;
      varying vec3 vN; varying vec3 vV; varying vec3 vLocal;
      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
        vec3 d = normalize(vLocal);
        vec2 g = vec2(atan(d.z, d.x) * 4.0, d.y * 7.0);
        g.x += mod(floor(g.y), 2.0) * 0.5;
        vec2 f = abs(fract(g) - 0.5);
        float hex = (1.0 - smoothstep(0.0, 0.07, min(0.5 - f.x, 0.5 - f.y))) * (0.5 + 0.5 * sin(uTime * 3.0 + g.y * 2.0));
        float a = (fres * 0.9 + hex * 0.25 * uHex) * uOpacity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * (1.0 + fres), clamp(a, 0.0, 1.0));
        ${OUT}
      }
    `,
  }) as ShellMat;
}

// ── Bolt ribbons ────────────────────────────────────────────────────────────
// Lightning, chain arcs and crackle: camera-facing quads per segment, widened
// in view space (world-unit width), white-hot core and coloured glow in one
// pass. Replaces wizard-wars' fat-line Bolt (LineSegments2 reallocated its
// instance buffer on every re-crackle); here one preallocated buffer holds
// every live bolt: one draw call.
export function createRibbonMaterial(): THREE.ShaderMaterial {
  return additive({
    side: THREE.DoubleSide,
    uniforms: { uHdr: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec3 aDir;
      attribute float aSide;
      attribute float aWidth;
      attribute vec4 aColor;
      varying float vAcross;
      varying vec4 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 d = normalize(mat3(modelViewMatrix) * aDir + vec3(1e-5));
        vec3 toCam = normalize(-mv.xyz);
        vec3 perp = normalize(cross(d, toCam) + vec3(0.0, 1e-5, 0.0));
        mv.xyz += perp * aSide * aWidth;
        gl_Position = projectionMatrix * mv;
        vAcross = aSide;
        vColor = aColor;
        // fade bolts right at the lens (your own chain leaving your hand)
        vColor.a *= smoothstep(0.3, 1.2, -mv.z);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uHdr;
      varying float vAcross;
      varying vec4 vColor;
      void main() {
        float x = vAcross * vAcross;
        float core = exp(-x * 22.0);
        float glow = exp(-x * 3.0) * 0.55;
        vec3 col = (vColor.rgb * glow + vec3(1.0) * core * 1.4) * uHdr;
        float a = clamp((core + glow) * vColor.a, 0.0, 1.0);
        if (a < 0.003) discard;
        gl_FragColor = vec4(col, a);
        ${OUT}
      }
    `,
  });
}

/** One representative of every custom program, for the shader warm-up. */
export function materialWarmList(): THREE.Material[] {
  return [createBeamMaterial(), createCircleMaterial(), createZoneMaterial(), createDomeMaterial(), createRingMaterial(), createShellMaterial(), createRibbonMaterial()];
}
