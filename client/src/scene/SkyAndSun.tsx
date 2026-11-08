// Placeholder sky and sun driven by the world clock: a gradient sky dome with
// a sun disk, a sun directional light that follows the player so its shadow
// frustum stays small, a hemisphere fill, and fog matched to the horizon so
// the ground fades into the sky. Spec 12 asks for analytic scattering, height
// fog, cascades and god rays; those belong to the rendering packages. This is
// just enough light to judge movement by.
//
// Why not drei <Sky> (Preetham): with the default ACES tone mapping it blew
// out to a flat white at exposure 1, and taming it needs a global exposure
// change that also darkens everything else.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { DAY_LENGTH_S } from '@lodestone/contracts';
import { localPlayer, worldClock } from '../state/live';
import { useDebugStore } from '../stores/debugStore';
import { QUALITY_PRESETS, useQualityStore } from '../stores/qualityStore';

/** Unit vector toward the sun at a time of day (0 = midnight). Rises in +x, sets in -x, tilted toward +z. */
export function sunDirection(timeOfDayS: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = (timeOfDayS / DAY_LENGTH_S) * Math.PI * 2 - Math.PI / 2; // 06:00 -> 0 (horizon), 12:00 -> pi/2
  return out.set(Math.cos(a), Math.sin(a), Math.sin(a) * 0.35).normalize();
}

const C = (hex: string) => new THREE.Color(hex);
const DAY = { zenith: C('#2f6fc4'), horizon: C('#b9d3ea') };
const NIGHT = { zenith: C('#03060d'), horizon: C('#0e1626') };
const DUSK_HORIZON = C('#e8925a');
const SHADOW_EXTENT = 40; // m around the player; WP05+ replaces with cascades

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // on the far plane: never occludes anything
  }
`;
const skyFragment = /* glsl */ `
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 sunDir;
  uniform float sunStrength;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.5)) : mix(horizon, horizon * 0.55, pow(-h, 0.4));
    float s = max(dot(d, sunDir), 0.0);
    col += vec3(1.0, 0.95, 0.85) * (pow(s, 1200.0) * 6.0 + pow(s, 24.0) * 0.18) * sunStrength;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export function SkyAndSun() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const tier = useQualityStore((s) => s.tier);
  const preset = QUALITY_PRESETS[tier];
  const sky = useRef<THREE.Mesh>(null);
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const dir = useMemo(() => new THREE.Vector3(), []);
  const horizon = useMemo(() => new THREE.Color(), []);
  const skyMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: skyVertex,
        fragmentShader: skyFragment,
        uniforms: {
          zenith: { value: new THREE.Color() },
          horizon: { value: new THREE.Color() },
          sunDir: { value: new THREE.Vector3(0, 1, 0) },
          sunStrength: { value: 1 },
        },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => () => skyMat.dispose(), [skyMat]);

  useEffect(() => {
    scene.fog = new THREE.Fog(DAY.horizon.clone(), preset.viewDistance * 0.25, preset.viewDistance);
    scene.background = DAY.horizon.clone();
    // Canvas camera props apply only at creation; keep far in step with the tier.
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.far = preset.viewDistance;
      camera.updateProjectionMatrix();
    }
    return () => {
      scene.fog = null;
      scene.background = null;
    };
  }, [scene, camera, preset.viewDistance]);

  useEffect(() => {
    if (!sun.current) return;
    const t = sun.current.target;
    scene.add(t);
    return () => {
      scene.remove(t);
    };
  }, [scene]);

  useFrame((_, delta) => {
    if (!useDebugStore.getState().freezeTime) {
      worldClock.timeOfDayS = (worldClock.timeOfDayS + Math.min(delta, 0.25)) % DAY_LENGTH_S;
    }
    sunDirection(worldClock.timeOfDayS, dir);
    const day = THREE.MathUtils.smoothstep(dir.y, -0.12, 0.3);
    // Dusk/dawn: warm the horizon while the sun is near it.
    const dusk = Math.max(0, 1 - Math.abs(dir.y) / 0.18) * 0.6;

    horizon.copy(NIGHT.horizon).lerp(DAY.horizon, day).lerp(DUSK_HORIZON, dusk);
    const u = skyMat.uniforms;
    (u.zenith.value as THREE.Color).copy(NIGHT.zenith).lerp(DAY.zenith, day);
    (u.horizon.value as THREE.Color).copy(horizon);
    (u.sunDir.value as THREE.Vector3).copy(dir);
    u.sunStrength.value = THREE.MathUtils.smoothstep(dir.y, -0.05, 0.05);
    // The dome follows the camera; its vertices are pushed to the far plane in the shader.
    sky.current?.position.copy(camera.position);

    const p = localPlayer.pos;
    if (sun.current) {
      sun.current.position.set(p.x + dir.x * 120, p.y + dir.y * 120, p.z + dir.z * 120);
      sun.current.target.position.set(p.x, p.y, p.z);
      sun.current.intensity = 2.4 * day;
    }
    if (hemi.current) hemi.current.intensity = 0.12 + 0.9 * day;
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(horizon);
    if (scene.background instanceof THREE.Color) scene.background.copy(horizon);
  });

  return (
    <>
      {/* renderOrder -2: drawn first so the depth-less ground plane (FlatTerrain) paints over it */}
      <mesh ref={sky} material={skyMat} renderOrder={-2} frustumCulled={false}>
        <sphereGeometry args={[10, 32, 16]} />
      </mesh>
      <hemisphereLight ref={hemi} args={['#cfe3ff', '#4a5a3a', 1]} />
      <directionalLight
        ref={sun}
        castShadow={preset.shadows}
        color="#fff4e0"
        shadow-mapSize-width={tier === 'high' ? 2048 : 1024}
        shadow-mapSize-height={tier === 'high' ? 2048 : 1024}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={1}
        shadow-camera-far={300}
        shadow-bias={-0.0005}
      />
    </>
  );
}
