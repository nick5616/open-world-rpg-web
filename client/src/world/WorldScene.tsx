// The world inside the R3F Canvas: one component that owns the imperative
// managers (terrain, scatter, water, horizon, sky, sun shadows, post) and
// drives them from a single useFrame at priority 1, which also renders the
// frame through the post chain (R3F skips its own render when a positive
// priority subscriber exists). React owns only the lifetime; nothing here
// re-renders per frame.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { DAY_LENGTH_S } from '@lodestone/contracts';
import { PARAM } from '@lodestone/worldgen';
import { localPlayer, netStats, worldClock } from '../state/live';
import { useDebugStore } from '../stores/debugStore';
import { QUALITY_PRESETS, useQualityStore } from '../stores/qualityStore';
import type { WorldRuntime } from './core/runtime';
import { CAMERA_FAR, WORLD_TIERS } from './config';
import { TerrainManager } from './terrain/terrainManager';
import { applyManifestMeans, makeTerrainShared } from './terrain/terrainMaterial';
import { loadTerrainTextures, terrainManifest } from './terrain/terrainTextures';
import { createHorizonMesh } from './terrain/horizon';
import { atlasHeightTexture, createSeaPlane, createWaterMaterial, makeWaterUniforms } from './water/water';
import { ScatterManager } from './scatter/scatterManager';
import { createSkyDome } from './sky/skyDome';
import { makeSkyLighting, skyLighting, sunVisibility } from './sky/atmosphere';
import { SunShadows } from './sky/sunShadows';
import { PostFX } from './post/postfx';
import { advanceWind, setPrevailingWind } from './wind';
import { worldDebug, frameInfo } from './debug/worldDebug';
import { LodOverlay } from './debug/lodOverlay';
import { CaveManager } from './caves/caveManager';

interface Props {
  runtime: WorldRuntime;
}

const GRADE = {
  day: { gain: new THREE.Vector3(1.0, 1.0, 1.0), lift: new THREE.Vector3(0.0, 0.0, 0.01), sat: 1.15, contrast: 1.1 },
  golden: { gain: new THREE.Vector3(1.03, 0.99, 0.93), lift: new THREE.Vector3(0.0, 0.0, 0.01), sat: 1.06, contrast: 1.08 },
  night: { gain: new THREE.Vector3(0.82, 0.92, 1.12), lift: new THREE.Vector3(0.0, 0.005, 0.02), sat: 0.7, contrast: 1.02 },
};
/** Per-biome grade offsets (gain multiplier, saturation delta), BIOMES order. */
const BIOME_GRADE: [THREE.Vector3, number][] = [
  [new THREE.Vector3(1.02, 1.01, 0.97), 0.04], // meadow: warm, lush
  [new THREE.Vector3(0.98, 1.02, 0.97), 0.0], // forest: a touch green
  [new THREE.Vector3(0.99, 1.0, 1.02), -0.04], // highlands: cooler
  [new THREE.Vector3(0.96, 0.99, 1.06), -0.08], // snowpeak: cold
  [new THREE.Vector3(1.05, 0.99, 0.92), 0.02], // badlands: sun-baked
  [new THREE.Vector3(0.97, 1.02, 0.98), -0.06], // wetland: muted
];

export function WorldScene({ runtime }: Props) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const tierName = useQualityStore((s) => s.tier);
  const preset = QUALITY_PRESETS[tierName];
  const tier = WORLD_TIERS[tierName];
  const showTiles = useDebugStore((s) => s.showCells);

  // Long-lived world objects (independent of tier).
  const world = useMemo(() => {
    const shared = makeTerrainShared();
    const waterU = makeWaterUniforms();
    waterU.uSeaY.value = runtime.seaY;
    const waterMat = createWaterMaterial(waterU, false);
    const terrain = new TerrainManager(runtime.pool, runtime.data, shared, waterMat, {
      lodSplit: tier.lodSplit,
      viewDistance: preset.viewDistance,
      uploadsPerFrame: tier.uploadsPerFrame,
      uploadBudgetMs: tier.uploadBudgetMs,
      normalMaps: preset.normalMaps,
    });
    waterU.uCoverage.value = terrain.coverage;
    waterU.uAtlasHeight.value = atlasHeightTexture(runtime.data.height, runtime.data.gridN);
    const sea = createSeaPlane(createWaterMaterial(waterU, true), runtime.seaY);
    const sky = createSkyDome();
    // The sky is the first object of the main pass (renderOrder -10), so the
    // counters at this moment are the shadow passes alone: lets the HUD and
    // benchmark split shadow-map work from visible triangles.
    sky.mesh.onBeforeRender = (r) => {
      frameInfo.shadowCalls = r.info.render.calls;
      frameInfo.shadowTris = r.info.render.triangles;
    };
    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a3a, 1);
    const lightU = { uSunDir: waterU.uSunDir, uLightColor: waterU.uLightColor, uAmbient: waterU.uAmbient };
    const scatter = new ScatterManager(runtime.pool, gl, tier, lightU);
    const root = new THREE.Group();
    root.name = 'world';
    root.add(terrain.group, scatter.group, sea, sky.mesh, hemi);
    // WP09: caves (streamed near mouths and underground; the light pool lives in it).
    const caves = runtime.caveGraph ? new CaveManager(runtime, QUALITY_PRESETS[useQualityStore.getState().tier].maxLights) : null;
    if (caves) root.add(caves.group);
    setPrevailingWind(runtime.data.params[PARAM.windDirDeg] ?? 0, 3 + (runtime.data.params[PARAM.stormFrequency] ?? 0.3) * 4);
    return { shared, waterU, terrain, sea, sky, hemi, scatter, caves, root, lighting: makeSkyLighting(), horizon: null as THREE.Mesh | null };
    // Built once per runtime; tier changes go through setParams/applyTier below.
  }, [runtime, gl]);

  // Scene graph, camera far plane, textures, horizon.
  useEffect(() => {
    scene.add(world.root);
    const prevFar = camera.far;
    camera.far = CAMERA_FAR;
    camera.updateProjectionMatrix();
    const prevTone = gl.toneMapping;
    gl.toneMapping = THREE.NoToneMapping; // ACES runs in the post chain
    scene.fog = null; // fog runs in the post chain, from depth
    scene.background = null;
    let alive = true;
    terrainManifest()
      .then((m) => {
        if (!alive) return;
        applyManifestMeans(world.shared, m.mean);
        world.horizon = createHorizonMesh(runtime.data, world.shared, world.terrain.coverage);
        world.root.add(world.horizon);
      })
      .catch((err) => console.warn('[world] terrain manifest', err));
    return () => {
      alive = false;
      scene.remove(world.root);
      camera.far = prevFar;
      camera.updateProjectionMatrix();
      gl.toneMapping = prevTone;
    };
  }, [scene, camera, gl, world, runtime]);

  // Texture arrays (normals only when the tier wants them; pbrMaterial rule).
  useEffect(() => {
    let alive = true;
    const t0 = performance.now();
    loadTerrainTextures(gl, preset.normalMaps, tierName === 'high' ? 8 : 4)
      .then((tx) => {
        if (!alive) return;
        world.shared.tColor.value = tx.color;
        world.shared.tNormal.value = tx.normal;
        world.shared.tOrm.value = tx.orm;
        world.shared.uTexReady.value = 1;
        worldDebug.textureBytes = tx.bytes;
        worldDebug.textureMs = performance.now() - t0;
      })
      .catch((err) => console.warn('[world] terrain textures failed, staying on flat colours', err));
    return () => {
      alive = false;
    };
  }, [gl, world, preset.normalMaps, tierName]);

  // Tier-dependent pieces: shadows, post chain, manager knobs.
  const fx = useRef<{ sun: SunShadows; post: PostFX } | null>(null);
  useEffect(() => {
    world.terrain.setParams({ lodSplit: tier.lodSplit, viewDistance: preset.viewDistance, uploadsPerFrame: tier.uploadsPerFrame, uploadBudgetMs: tier.uploadBudgetMs, normalMaps: preset.normalMaps });
    world.scatter.applyTier(tier);
    world.waterU.uDetail.value = tier.waterDetail ? 1 : 0;
    const sun = new SunShadows(world.root, camera, { cascades: preset.shadows ? preset.shadowCascades : 0, distance: tier.shadowDistance, mapSize: tier.shadowMapSize });
    world.terrain.onMaterial = (m) => sun.setupMaterial(m);
    world.terrain.onMaterialDisposed = (m) => sun.forget(m);
    world.scatter.onMaterial = (m) => sun.setupMaterial(m);
    for (const m of world.scatter.allMaterials()) if (m instanceof THREE.MeshStandardMaterial) sun.setupMaterial(m);
    for (const m of world.caves?.sunMaterials() ?? []) if (m instanceof THREE.MeshStandardMaterial) sun.setupMaterial(m);
    world.terrain.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
        sun.setupMaterial(o.material);
        o.material.needsUpdate = true;
      }
    });
    gl.shadowMap.enabled = preset.shadows;
    const post = new PostFX(gl, scene, camera, { multisampling: tierName === 'high' ? 4 : tierName === 'medium' ? 2 : 0, bloom: tier.bloom, godRays: tier.godRays });
    const s = gl.getSize(new THREE.Vector2());
    post.setSize(s.x, s.y);
    fx.current = { sun, post };
    return () => {
      fx.current = null;
      world.terrain.onMaterial = null;
      world.scatter.onMaterial = null;
      sun.dispose();
      post.dispose();
    };
  }, [world, camera, gl, scene, tierName, tier, preset]);

  useEffect(() => {
    fx.current?.post.setSize(size.width, size.height);
    fx.current?.sun.updateFrustums();
  }, [size.width, size.height]);

  // Debug: LOD tile overlay (on with the WP02 cell-border toggle, F4).
  const overlay = useMemo(() => new LodOverlay(runtime.ground), [runtime]);
  useEffect(() => {
    scene.add(overlay.lines);
    return () => {
      scene.remove(overlay.lines);
      overlay.dispose();
    };
  }, [scene, overlay]);

  // Debug/benchmark handle.
  useEffect(() => {
    worldDebug.attach(runtime, world.terrain, world.scatter);
    return () => worldDebug.detach();
  }, [runtime, world]);

  useEffect(
    () => () => {
      world.terrain.dispose();
      world.scatter.dispose();
    },
    [world],
  );

  const vel = useMemo(() => new THREE.Vector3(), []);
  const biomeGrade = useMemo(() => ({ gain: new THREE.Vector3(1, 1, 1), sat: 0 }), []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const now = performance.now();
    if (!useDebugStore.getState().freezeTime) worldClock.timeOfDayS = (worldClock.timeOfDayS + Math.min(delta, 0.25)) % DAY_LENGTH_S;
    advanceWind(dt);

    // WP09: caves first, so this frame's light knows how far underground we are.
    world.caves?.update(camera, dt, now);
    const under = world.caves?.underground ?? 0;
    // Light and sky for this time of day.
    const L = skyLighting(worldClock.timeOfDayS, world.lighting);
    world.sky.uniforms.uSunDir.value.copy(L.sunDir);
    world.sky.mesh.position.copy(camera.position);
    world.hemi.color.copy(L.skyColor);
    world.hemi.groundColor.copy(L.groundColor);
    // Underground: no sun or sky light, ambient near black (spec 7).
    world.hemi.intensity = L.hemiIntensity * (1 - 0.9 * under);
    const w = world.waterU;
    w.uSunDir.value.copy(L.sunDir);
    w.uLightColor.value.copy(L.lightColor).multiplyScalar(L.lightIntensity / 3);
    w.uAmbient.value.copy(L.skyColor).multiplyScalar(L.hemiIntensity * (1 - 0.9 * under));
    w.uTime.value += dt;
    world.sea.position.set(Math.round(camera.position.x / 64) * 64, runtime.seaY, Math.round(camera.position.z / 64) * 64);
    world.sea.updateMatrixWorld();

    const f = fx.current;
    if (f) {
      f.sun.update(camera, L.lightDir, L.lightColor, L.lightIntensity * (1 - under));
      // Valley fog: thick at dawn, thin by midday, a little back at dusk.
      const hour = (worldClock.timeOfDayS / DAY_LENGTH_S) * 24;
      const morning = Math.exp(-(((hour - 6.5) / 1.8) ** 2));
      const evening = Math.exp(-(((hour - 19) / 1.5) ** 2)) * 0.4;
      const fogU = f.post.fog;
      fogU.u('uSunDir').value.copy(L.sunDir);
      (fogU.u('uSunColor').value as THREE.Color).copy(L.lightColor).multiplyScalar(L.lightIntensity * 0.6 * sunVisibility(L.sunDir.y));
      fogU.u('uFogDensity').value = (0.0004 + 0.0045 * morning + 0.0015 * evening) * (1 - under);
      fogU.u('uFogFalloff').value = 1 / 38;
      fogU.u('uFogBase').value = runtime.seaY + 18;
      fogU.u('uHaze').value = (1 / 14000) * (1 - under);
      fogU.u('uExposure').value = (1.0 + (1 - L.day) * 1.6) * (1 - under) + 1.6 * under;
      // Grade: time of day, then the biome under the player (eased, so crossing a border is a drift, not a cut).
      const g = f.post.grade;
      const day = L.day;
      const gold = L.golden;
      const gain = g.u('uGain').value as THREE.Vector3;
      const lift = g.u('uLift').value as THREE.Vector3;
      gain.copy(GRADE.night.gain).lerp(GRADE.day.gain, day).lerp(GRADE.golden.gain, gold);
      lift.copy(GRADE.night.lift).lerp(GRADE.day.lift, day).lerp(GRADE.golden.lift, gold);
      let sat = THREE.MathUtils.lerp(GRADE.night.sat, GRADE.day.sat, day);
      sat = THREE.MathUtils.lerp(sat, GRADE.golden.sat, gold);
      const d = runtime.data;
      const gi = Math.max(0, Math.min(d.gridN - 1, Math.round(camera.position.x / d.macroRes)));
      const gj = Math.max(0, Math.min(d.gridN - 1, Math.round(camera.position.z / d.macroRes)));
      const [bg, bs] = BIOME_GRADE[d.biome[gj * d.gridN + gi]] ?? BIOME_GRADE[0];
      biomeGrade.gain.lerp(bg, Math.min(1, dt * 0.5));
      biomeGrade.sat += (bs - biomeGrade.sat) * Math.min(1, dt * 0.5);
      gain.multiply(biomeGrade.gain);
      g.u('uSaturation').value = sat + biomeGrade.sat;
      g.u('uContrast').value = THREE.MathUtils.lerp(GRADE.night.contrast, GRADE.day.contrast, day);
      f.post.update(L.sunDir, L.lightColor, sunVisibility(L.sunDir.y) * (1 - under));
    }

    // Streaming. Velocity from the simulated player (feet), for prediction.
    vel.set(localPlayer.vel.x, localPlayer.vel.y, localPlayer.vel.z);
    world.terrain.update(camera, vel, dt, now);
    world.scatter.update(camera, now);
    netStats.chunkQueue = runtime.pool.queued + runtime.pool.inFlight;
    netStats.chunksLoaded = world.terrain.stats.loaded;
    overlay.update(showTiles, world.terrain.drawnTiles(), camera.position, now);

    // Render (counting the whole frame: shadow passes, scene, post).
    const info = gl.info;
    info.autoReset = false;
    info.reset();
    if (f) f.post.render(dt);
    else gl.render(scene, camera);
    if (!f) frameInfo.shadowCalls = frameInfo.shadowTris = 0;
    frameInfo.calls = info.render.calls;
    frameInfo.triangles = info.render.triangles;
    frameInfo.geometries = info.memory.geometries;
    frameInfo.textures = info.memory.textures;
  }, 1);

  return null;
}
