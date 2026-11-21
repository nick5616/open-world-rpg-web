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
import { useQualityStore } from '../stores/qualityStore';
import { getGraphics, useGraphics } from '../stores/graphics';
import { useNightHud } from '../systems/night';
import type { WorldRuntime } from './core/runtime';
import { Clearance } from './buildings/clearance';
import { CAMERA_FAR, WORLD_TIERS } from './config';
import { TerrainManager } from './terrain/terrainManager';
import { applyManifestMeans, makeTerrainShared } from './terrain/terrainMaterial';
import { loadTerrainTextures, terrainManifest } from './terrain/terrainTextures';
import { createHorizonMesh } from './terrain/horizon';
import { atlasHeightTexture, createSeaPlane, createWaterMaterial, makeWaterUniforms } from './water/water';
import { ScatterManager } from './scatter/scatterManager';
import { scatterSnowUniforms } from './scatter/scatterMaterials';
import { createSkyDome } from './sky/skyDome';
import { makeSkyLighting, skyLighting, sunVisibility } from './sky/atmosphere';
import { SunShadows } from './sky/sunShadows';
import { RainStreaks } from './sky/rainStreaks';
// Playtest 2 weather (CR 030): snow, sand, lightning, per-style looks; the live weather (systems/weather).
import { SAND, SNOW, WeatherParticles } from './sky/weatherParticles';
import { LightningBolts } from './sky/lightningBolts';
import { WEATHER_LOOK, WEATHER_PARTICLES } from './sky/weatherStyle';
import { liveWeather, setWeatherWorld, weatherFrame } from '../systems/weather/runtime';
import { PostFX } from './post/postfx';
import { photoLive, usePhoto } from '../ui/photo/store';
import { advanceWind, setPrevailingWind, windState, windUniforms } from './wind';
// Playtest 2 graphics styles: per-frame uniforms, no recompiles (style/styles.ts).
import { liveStyle, STYLES } from './style/styles';
import { lsRetro, lsStyle } from './style/styleShader';
import { worldDebug, frameInfo } from './debug/worldDebug';
import { LodOverlay } from './debug/lodOverlay';
import { CaveManager } from './caves/caveManager';
import { WorldEditManager } from './edits/worldEdits'; // CR 040: chopping, breaking, digging
import { audioWorld } from '../audio/bridge';
import { ShelterIndex } from '../audio/shelter';
import { CAMPS } from '@lodestone/contracts';
import { useCamps } from '../ui/camps/store';
import { inRift } from '../rift/store';
import { baseRoofCover, exposureTarget, liveExposure, lightningThrough, WeatherExposure, type PlacedPiece } from './sky/exposure';
// CR 038: sky archipelagos, the Underground and the Depths.
import { VerticalManager } from './vertical/verticalManager';
import { usePalace } from './palace/palaceStore';
import { useRace } from './vertical/race';
import { warmShaders } from './warmup';
import { warmExtras } from './warmExtras';
import { AmbientLife } from './life/ambientLife';
import { DEBUG } from '../config';

// `?nowarmup` (debug builds): skip the shader warm-up, to measure without it.
const NO_WARMUP = DEBUG && typeof location !== 'undefined' && new URLSearchParams(location.search).has('nowarmup');

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

/** Inside a settlement's radius (ambient life thins out in streets). */
function inSettlement(towns: { settlements: { x: number; z: number; radius: number }[] } | null, x: number, z: number): boolean {
  if (!towns) return false;
  for (const t of towns.settlements) {
    const r = t.radius + 6;
    if ((x - t.x) ** 2 + (z - t.z) ** 2 < r * r) return true;
  }
  return false;
}

/** CR 054: the roofs of player-built bases (CR 041 roof, ridge cap and gable pieces) near you, for the weather's cover test. */
const ROOF_KINDS = new Set(CAMPS.pieces.filter((p) => p.build && ['roof', 'roof_cap', 'gable'].includes(p.build.base)).map((p) => p.id));
function* placedRoofs(): Generator<PlacedPiece> {
  const pieces = useCamps.getState().pieces;
  for (const k in pieces) {
    const p = pieces[k];
    if (ROOF_KINDS.has(p.kind)) yield { x: p.x, y: p.y, z: p.z, roof: true };
  }
}

export function WorldScene({ runtime }: Props) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  // Playtest 2 graphics settings: preset + tier + the player's overrides +
  // style, resolved in one place (stores/graphics.ts). WP19: shader-shaping
  // knobs (shadows, post chain, normal maps, MSAA) follow shaderTier, which
  // auto steps leave alone; the cheap ones follow the stepped tier.
  const g = useGraphics();
  const dpr = useThree((s) => s.viewport.dpr);
  const showTiles = useDebugStore((s) => s.showCells);

  // Long-lived world objects (independent of tier).
  const world = useMemo(() => {
    const g0 = getGraphics();
    const shared = makeTerrainShared();
    const waterU = makeWaterUniforms();
    waterU.uSeaY.value = runtime.seaY;
    const waterMat = createWaterMaterial(waterU, false);
    const terrain = new TerrainManager(runtime.pool, runtime.data, shared, waterMat, {
      lodSplit: g0.world.lodSplit,
      viewDistance: g0.controls.viewDistance,
      uploadsPerFrame: g0.world.uploadsPerFrame,
      uploadBudgetMs: g0.world.uploadBudgetMs,
      normalMaps: g0.normalMaps,
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
    const scatter = new ScatterManager(runtime.pool, gl, g0.world, lightU);
    // Dense grass must not grow through streets, plazas and floors (CR 045; the towns manager hides the sparse scatter).
    if (runtime.towns) scatter.setClearance(new Clearance(runtime.towns));
    const root = new THREE.Group();
    root.name = 'world';
    const rainStreaks = new RainStreaks();
    // Playtest 2 weather (CR 030): snow, blowing sand, lightning (capacity by tier: low stays cheap).
    const wp = WEATHER_PARTICLES[g0.tier] ?? WEATHER_PARTICLES.medium;
    const snow = new WeatherParticles(SNOW, wp.snow, 'snow');
    const sand = new WeatherParticles(SAND, wp.sand, 'sand');
    const bolts = new LightningBolts();
    // Playtest 2 immersion pass: birds, butterflies, fireflies, falling leaves and motes (Low: half as many).
    const life = new AmbientLife();
    life.setScale(g0.tier === 'low' ? 0.5 : 1);
    if (DEBUG && typeof window !== 'undefined') (window as unknown as { __lodestoneLife?: AmbientLife }).__lodestoneLife = life;
    root.add(terrain.group, scatter.group, sea, sky.mesh, hemi, rainStreaks.object, snow.object, sand.object, bolts.object, life.group);
    // WP09: caves (streamed near mouths and underground; the light pool lives in it).
    const caves = runtime.caveGraph ? new CaveManager(runtime, g0.maxLights) : null;
    if (caves) root.add(caves.group);
    const edits = new WorldEditManager(runtime, scatter, terrain);
    root.add(edits.group);
    const vertical = runtime.vertical ? new VerticalManager(runtime) : null;
    if (vertical) root.add(vertical.group);
    vertical?.setLow(g0.tier === 'low');
    if (DEBUG && vertical && typeof window !== 'undefined') Object.assign(window, { __lodestoneVertical: vertical, __lodestoneVerticalWorld: runtime.vertical, __lodestoneVerticalGround: runtime.verticalGround, __lodestonePalace: usePalace, __lodestoneRace: useRace });
    const windBase = 3 + (runtime.data.params[PARAM.stormFrequency] ?? 0.3) * 4;
    setPrevailingWind(runtime.data.params[PARAM.windDirDeg] ?? 0, windBase);
    setWeatherWorld(runtime.data, runtime.data.params[PARAM.windDirDeg] ?? 0); // CR 030: the climate per weather cell
    return { shared, waterU, terrain, sea, sky, hemi, scatter, caves, edits, vertical, root, lighting: makeSkyLighting(), horizon: null as THREE.Mesh | null, rain: 0, capAcc: 0, exposure: new WeatherExposure(), shelter: null as ShelterIndex | null, shelterFor: null as unknown, rainStreaks, snow, sand, bolts, life, windBase, drift: new THREE.Vector2() };
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
    loadTerrainTextures(gl, g.normalMaps, g.anisotropy)
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
  }, [gl, world, g.normalMaps, g.anisotropy]);

  // Tier-dependent pieces: shadows, post chain, manager knobs.
  const fx = useRef<{ sun: SunShadows; post: PostFX } | null>(null);
  // WP19b: the post chain the last shader warm-up ran for (useFrame).
  const warm = useRef<{ post: PostFX | null; pending: boolean }>({ post: null, pending: false });
  // Cheap knobs (no recompile): auto quality steps move these.
  const wt = g.world;
  const viewDistance = g.controls.viewDistance;
  useEffect(() => {
    world.terrain.setParams({ lodSplit: wt.lodSplit, viewDistance, uploadsPerFrame: wt.uploadsPerFrame, uploadBudgetMs: wt.uploadBudgetMs, normalMaps: g.normalMaps });
    // Dev: ?veg=0..3 forces the vegetation art (before/after benchmarks on one build).
    const vegOverride = DEBUG && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('veg') : null;
    world.scatter.setVegetation(vegOverride !== null ? Number(vegOverride) : WORLD_TIERS[g.shaderTier].vegetation);
    world.scatter.applyTier(wt);
    world.waterU.uDetail.value = wt.waterDetail ? 1 : 0;
  }, [world, wt, viewDistance, g.normalMaps, g.shaderTier]);
  const { shadowCascades, shadowDistance, shadowMapSize, bloom, godRays, msaa, fxaa, spellScreen } = g;
  useEffect(() => {
    const sun = new SunShadows(world.root, camera, { cascades: shadowCascades, distance: shadowDistance, mapSize: shadowMapSize });
    world.terrain.onMaterial = (m) => sun.setupMaterial(m);
    world.terrain.onMaterialDisposed = (m) => sun.forget(m);
    world.scatter.onMaterial = (m) => sun.setupMaterial(m);
    for (const m of world.scatter.allMaterials()) if (m instanceof THREE.MeshStandardMaterial) sun.setupMaterial(m);
    for (const m of world.caves?.sunMaterials() ?? []) if (m instanceof THREE.MeshStandardMaterial) sun.setupMaterial(m);
    for (const m of world.vertical?.sunMaterials() ?? []) if (m instanceof THREE.MeshStandardMaterial) sun.setupMaterial(m);
    world.terrain.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
        sun.setupMaterial(o.material);
        o.material.needsUpdate = true;
      }
    });
    // Playtest 5 (CR 057): materials that already had a program for this cascade
    // count (a tier visited before) keep the previous compile's uniform arrays,
    // which are sized for the other count ("reading 'toArray'" on the next frame
    // when Medium -> High). Re-size every cascade uniform now, not at the next resize.
    sun.updateFrustums();
    gl.shadowMap.enabled = shadowCascades > 0;
    // Playtest 2 spell screen effect (shockwave/shake/flash): medium and up, never in Retro (it is meant to be cheap).
    const post = new PostFX(gl, scene, camera, { multisampling: msaa, bloom, godRays, fxaa, spellScreen });
    const s = gl.getSize(new THREE.Vector2());
    post.setSize(s.x, s.y);
    fx.current = { sun, post };
    if (DEBUG && typeof window !== 'undefined') (window as unknown as { __lodestonePost?: unknown }).__lodestonePost = { post, scene, camera, gl, world };
    return () => {
      fx.current = null;
      world.terrain.onMaterial = null;
      world.scatter.onMaterial = null;
      sun.dispose();
      post.dispose();
    };
  }, [world, camera, gl, scene, shadowCascades, shadowDistance, shadowMapSize, bloom, godRays, msaa, fxaa, spellScreen]);

  // Resize, and a pixel-ratio change (render scale, DPR cap, Retro's low
  // internal resolution) resizes the post chain's buffers too.
  useEffect(() => {
    fx.current?.post.setSize(size.width, size.height);
    fx.current?.sun.updateFrustums();
  }, [size.width, size.height, dpr]);

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
      // G4: the cave manager's DOM HUD/toasts and window E/mouse listeners
      // outlived a remount (leave the play screen and come back): a frozen
      // "Vein broken" toast stayed on screen and E still swung at the old vein.
      world.caves?.dispose();
      world.edits.dispose();
      world.vertical?.dispose();
      world.rainStreaks.dispose();
      world.snow.dispose();
      world.sand.dispose();
      world.bolts.dispose();
      world.life.dispose();
    },
    [world],
  );

  const vel = useMemo(() => new THREE.Vector3(), []);
  const biomeGrade = useMemo(() => ({ gain: new THREE.Vector3(1, 1, 1), sat: 0 }), []);

  useFrame((_, frameDelta) => {
    // Playtest 2 frame-rate cap (Graphics screen): skip whole frames (no
    // streaming, no render; the canvas keeps the last image) until the
    // interval is up, then run once with the accumulated time.
    const q = useQualityStore.getState();
    const cap = q.overrides.maxFps ?? 0;
    let delta = frameDelta;
    if (cap > 0) {
      world.capAcc += frameDelta;
      if (world.capAcc < 1 / cap - 0.0015) return;
      delta = Math.min(world.capAcc, 0.25);
      world.capAcc = 0;
    }
    const dt = Math.min(delta, 0.1);
    const now = performance.now();
    const st = STYLES[q.style] ?? STYLES.lodestone;
    if (!useDebugStore.getState().freezeTime) worldClock.timeOfDayS = worldClock.source ? worldClock.source() : (worldClock.timeOfDayS + Math.min(delta, 0.25)) % DAY_LENGTH_S; // WP15: the world clock online
    advanceWind(dt);

    // CR 038: the vertical world first (it lends the cave light pool its emitters).
    world.vertical?.update(camera, dt, now, localPlayer.pos);
    if (world.caves && world.vertical) world.caves.extraEmitters = world.vertical.lightEmitters() as never;
    if (world.vertical) {
      // CR 038: where the listener is, for the ambience, the reverb and the music.
      const vm = world.vertical;
      audioWorld.layer = vm.layer;
      audioWorld.sky = vm.sky;
      audioWorld.cavern = vm.cavern;
      audioWorld.depths = vm.depths;
      audioWorld.chamberKind = vm.chamber ? vm.chamber.kind : -1;
      // A vast cavern rings for seconds; its tunnels are tight.
      if (vm.layer === 2 || vm.layer === 3) audioWorld.chamberRadius = vm.chamber ? Math.min(60, vm.chamber.radius * 0.35) : 5;
    }
    // WP09: caves first, so this frame's light knows how far underground we are.
    world.caves?.update(camera, dt, now);
    const under = world.caves?.underground ?? 0;
    // Light and sky for this time of day.
    // Playtest 2 photo mode: a client-only time-of-day preview of the light (the world clock itself runs on).
    const ph = usePhoto.getState();
    const tod = ph.active && ph.hour !== null ? (ph.hour / 24) * DAY_LENGTH_S : worldClock.timeOfDayS;
    const L = skyLighting(tod, world.lighting);
    world.vertical?.setLight(L.skyColor, L.hemiIntensity * L.day + 0.05, L.lightColor, L.skyColor);
    // Playtest 2 weather (CR 030, systems/weather): the blended weather at the
    // camera, eased so a front rolls in: cloud, rain, snow, fog banks, sand,
    // heat shimmer, storm darkness, wet ground and settled snow that linger,
    // rainbows after a shower, lightning (bolts, flash, thunder). Atlas-less
    // zones keep WP10's on/off rain (online: the zone's; solo: the local sim's).
    const night = useNightHud.getState();
    const legacyRain = night.online ? night.raining : localPlayer.raining;
    weatherFrame(camera.position, localPlayer.pos, dt, Math.asin(Math.max(-1, Math.min(1, L.sunDir.y))), runtime.terrainGround ? (x, z) => runtime.terrainGround.heightAt(x, z) : null, legacyRain);
    const wm = liveWeather.mix;
    const look = WEATHER_LOOK[q.style] ?? WEATHER_LOOK.lodestone;
    const above = 1 - under;
    // CR 054: no weather indoors, under a base's roof or underground: the camera's exposure (eased over 0.5 s).
    if (world.shelterFor !== runtime) {
      world.shelterFor = runtime;
      world.shelter = runtime.towns && runtime.townCollision ? new ShelterIndex(runtime.towns.buildings, runtime.townCollision) : null;
    }
    const expo = world.exposure.update(dt, () => {
      const f = localPlayer.pos;
      const sh = world.shelter ? world.shelter.probe(f.x, f.y, f.z) : { roof: 0, indoors: 0 };
      // playtest 6 polish: a rift is its own realm (the zone has no weather there): no sandstorm haze over the arena
      return exposureTarget(sh, inRift() ? 1 : under, baseRoofCover(f.x, f.y + 1.9, f.z, placedRoofs()));
    });
    liveExposure.value = expo;
    const rain = Math.min(1, wm.rain);
    const storm = Math.min(1, wm.storm * look.stormDark);
    // Lightning no longer flashes the whole world (Nicole, prod: "the screen
    // flashes to the beat of the music... make it not do that": distant
    // seeded strikes pulsed the sky, the hemisphere light and the post pass
    // every second or two in a storm). The bolts themselves still glow.
    void liveWeather.flash;
    void look.flash;
    const flash = 0;
    const overcast = Math.min(1, Math.max(rain, storm, wm.cloud * 0.5, wm.snow * 0.7, wm.dust * 0.8, wm.fog * 0.6));
    world.rain = rain;
    world.shared.uWet.value = liveWeather.wet * above;
    world.shared.uSnowCover.value = liveWeather.snowCover * above;
    scatterSnowUniforms.uSnowCover.value = world.shared.uSnowCover.value; // grass and trees whiten with the ground
    world.rainStreaks.update(camera, dt, rain * above * expo);
    world.snow.update(camera, dt, wm.snow * above * expo, wm.wind, size.height, look.flake, look.square);
    world.sand.update(camera, dt, wm.dust * above * expo, wm.wind, size.height);
    world.bolts.update(camera, liveWeather.bolts, now, look.boltWidth, look.boltIntensity * lightningThrough(expo));
    world.life.update({
      camera,
      dt,
      hour: (tod / DAY_LENGTH_S) * 24,
      day: L.day,
      rain: rain * expo,
      snow: Math.min(1, wm.snow) * expo,
      under: Math.max(under, 1 - expo), // no leaves, birds or butterflies indoors either
      inTown: inSettlement(runtime.towns, camera.position.x, camera.position.z),
      biomeAt: (x, z) => {
        const d = runtime.data;
        const gi = Math.max(0, Math.min(d.gridN - 1, Math.round(x / d.macroRes)));
        const gj = Math.max(0, Math.min(d.gridN - 1, Math.round(z / d.macroRes)));
        return d.biome[gj * d.gridN + gi];
      },
      groundAt: (x, z) => (runtime.terrainGround ? runtime.terrainGround.heightAt(x, z) : null),
      waterAt: (x, z) => (runtime.terrainGround ? runtime.terrainGround.waterAt(x, z) : Math.max(runtime.seaY, -Infinity)),
      viewportH: size.height,
    });
    world.sky.uniforms.uCloudCover.value = 0.42 + 0.5 * Math.min(1, wm.cloud);
    world.sky.uniforms.uWeatherSky.value.set(storm * above * expo, liveWeather.rainbow * look.rainbow, flash, Math.min(1, wm.dust));
    // A gale bends the grass (online the chemistry wind reset it this frame; solo the WorldSpec's).
    windState.speed = (night.online ? windState.speed : world.windBase) * (1 + 1.4 * wm.wind);
    world.drift.x += windState.dirX * (0.002 + 0.01 * wm.wind) * dt;
    world.drift.y += windState.dirZ * (0.002 + 0.01 * wm.wind) * dt;
    // Style uniforms shared by every lit material (styleShader.ts) and the wind field.
    lsStyle[0] = st.toon;
    lsStyle[1] = st.rim;
    lsStyle[2] = st.toonBands;
    lsStyle[3] = st.toonSoft;
    lsRetro[0] = st.retro ? st.retro.snap[0] : 0;
    lsRetro[1] = st.retro ? st.retro.snap[1] : 0;
    lsRetro[2] = st.retro ? st.retro.affine : 0;
    lsRetro[3] = st.retro ? 1 : 0;
    windUniforms.uWindSweep.value.set(st.windSweep, st.windSheen);
    liveStyle.torch = st.torch;
    world.sky.uniforms.uSkyStyle.value.set(st.skySat * (1 - 0.35 * overcast), st.skyBright * (1 - 0.25 * overcast), st.skyBands, st.retro ? 0 : 0.6 * (1 - overcast));
    world.waterU.uWaterStyle.value.set(st.waterTurquoise * (1 - 0.6 * overcast), st.waterFoam, st === STYLES.lodestone ? 0.25 : 0, 0);
    L.lightIntensity *= (1 - 0.55 * overcast) * (1 - 0.35 * storm * expo);
    L.hemiIntensity = L.hemiIntensity * (1 - 0.2 * overcast) * (1 - 0.35 * storm * expo) + flash * 1.4; // a strike lights the world for a blink
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
    w.uRain.value = rain * above; // rain rings the water
    world.sea.position.set(Math.round(camera.position.x / 64) * 64, runtime.seaY, Math.round(camera.position.z / 64) * 64);
    world.sea.updateMatrixWorld();

    const f = fx.current;
    if (f) {
      // Playtest 2 immersion pass: clouds soften the shadows (rain, snow, fog banks: faint, diffuse)
      f.sun.update(camera, L.lightDir, L.lightColor, L.lightIntensity * (1 - under), 1 - 0.72 * overcast);
      // Valley fog: thick at dawn, thin by midday, a little back at dusk.
      const hour = (tod / DAY_LENGTH_S) * 24;
      const morning = Math.exp(-(((hour - 6.5) / 1.8) ** 2));
      const evening = Math.exp(-(((hour - 19) / 1.5) ** 2)) * 0.4;
      const fogU = f.post.fog;
      fogU.u('uSunDir').value.copy(L.sunDir);
      (fogU.u('uSunColor').value as THREE.Color).copy(L.lightColor).multiplyScalar(L.lightIntensity * 0.6 * sunVisibility(L.sunDir.y));
      // Styles: valley fog thickens toward dusk and stays through the night
      // (Valheim's moody hollows), moonlit faintly blue; the haze sets how
      // strongly distance dissolves into the sky (aerial perspective).
      const dusk = Math.exp(-(((hour - 18.8) / 1.6) ** 2));
      const nightFog = st.nightFog * Math.max(dusk, 1 - L.day);
      fogU.u('uFogDensity').value = ((0.0004 + 0.0045 * morning + 0.0015 * evening) * st.fog + st.fogFloor + nightFog + (0.0035 * rain + 0.003 * wm.snow + 0.006 * wm.dust) * expo) * (1 - under);
      fogU.u('uFogFalloff').value = 1 / 38;
      fogU.u('uFogBase').value = runtime.seaY + 18;
      fogU.u('uHaze').value = (st.haze / 14000) * (1 + (1.5 * rain + 0.8 * wm.snow + 2.5 * wm.dust + 1.2 * wm.haze) * expo) * (1 - under);
      // CR 030: fog banks (view distance ~100 m inside one), blowing sand, the strike's flash, heat shimmer.
      // CR 038: the Depths shimmer with heat.
      (fogU.u('uWeather').value as THREE.Vector4).set(Math.min(1, wm.fog) * look.fogBank * above * expo, Math.min(1, wm.dust) * above * expo, flash, wm.haze * look.shimmer * above * expo + (world.vertical ? world.vertical.depths * 0.55 : 0));
      (fogU.u('uWeatherDrift').value as THREE.Vector4).set(world.drift.x, world.drift.y, now / 1000, storm * above * expo);
      (fogU.u('uMoonColor').value as THREE.Color).setRGB(0.012, 0.018, 0.034).multiplyScalar((1 - L.day) * (1 - under) * (st.nightFog > 0 ? 1 : 0));
      (fogU.u('uSkyStyle').value as THREE.Vector4).copy(world.sky.uniforms.uSkyStyle.value);
      const fr = fogU.u('uFogRange').value as THREE.Vector4;
      // Retro's short fog, pushed out as you go underground (a cave keeps its
      // own darkness, never the sky's fog colour); a fog bank pulls it in.
      if (st.fogRange && above > 0.02) fr.set(st.fogRange[0] / above, (st.fogRange[1] * (1 - (0.3 * rain + 0.55 * Math.min(1, wm.fog + wm.dust)) * expo)) / above, above, 0);
      else fr.set(0, 0, 0, 0);
      fogU.u('uExposure').value = (1.0 + (1 - L.day) * 1.6 * st.nightExposure) * (1 - under) + (world.vertical && world.vertical.cavern + world.vertical.depths > 0.2 ? 1.2 : 1.6) * under;
      // CR 038: the air of the vast caverns (teal haze) and the Depths (ember red).
      const vm = world.vertical;
      const cf = fogU.u('uCaveFog').value as THREE.Vector4;
      if (vm && (vm.cavern > 0.01 || vm.depths > 0.01)) {
        const k = Math.max(vm.cavern, vm.depths);
        const d = vm.depths;
        cf.set(0.006 * (1 - d) + 0.07 * d, 0.03 * (1 - d) + 0.016 * d, 0.038 * (1 - d) + 0.006 * d, (0.0024 * (1 - d) + 0.0045 * d) * k);
      } else cf.set(0, 0, 0, 0);
      // Bloom and god rays per style (built per quality; tuned per style without a rebuild).
      if (f.post.bloom) {
        // Underground the cave's own glow (mushrooms, gems, lantern) keeps the stock bloom.
        f.post.bloom.intensity = THREE.MathUtils.lerp(st.bloomIntensity, 0.45, under);
        f.post.bloom.luminanceMaterial.threshold = THREE.MathUtils.lerp(st.bloomThreshold, 1.25, under);
      }
      if (f.post.godRays) (f.post.godRays.godRaysMaterial.uniforms.weight as THREE.IUniform<number>).value = f.post.godRayWeight * st.rays * (1 - 0.7 * overcast);
      // The style's screen pass: outlines (thickness in internal pixels), posterize, vignette, dithered quantize.
      f.post.style.outline.set(st.outline, Math.max(1, gl.getPixelRatio() * 1.3), 0.04, 260);
      f.post.style.look.set(st.posterize, st.vignette, st.quantize, st.quantize > 0 ? 1 : 0);
      // Playtest 2 photo mode: depth of field, vignette, grain (a pass that only runs in photo mode).
      const phOn = ph.active && (ph.dof > 0 || ph.vignette > 0 || ph.grain > 0);
      f.post.setPhoto(phOn);
      if (phOn) f.post.photo.photo.set(ph.dof, ph.focusM > 0 ? ph.focusM : photoLive.autoFocusM, ph.vignette, ph.grain);
      // Grade: time of day, then the biome under the player (eased, so crossing a border is a drift, not a cut).
      const gr = f.post.grade;
      const day = L.day;
      const gold = L.golden;
      const gain = gr.u('uGain').value as THREE.Vector3;
      const lift = gr.u('uLift').value as THREE.Vector3;
      gain.copy(GRADE.night.gain).lerp(GRADE.day.gain, day).lerp(GRADE.golden.gain, gold);
      lift.copy(GRADE.night.lift).lerp(GRADE.day.lift, day).lerp(GRADE.golden.lift, gold);
      let sat = THREE.MathUtils.lerp(GRADE.night.sat, GRADE.day.sat, day);
      sat = THREE.MathUtils.lerp(sat, GRADE.golden.sat, gold);
      sat += st.saturation - 0.15 * overcast - 0.1 * storm;
      const d = runtime.data;
      const gi = Math.max(0, Math.min(d.gridN - 1, Math.round(camera.position.x / d.macroRes)));
      const gj = Math.max(0, Math.min(d.gridN - 1, Math.round(camera.position.z / d.macroRes)));
      const [bg, bs] = BIOME_GRADE[d.biome[gj * d.gridN + gi]] ?? BIOME_GRADE[0];
      biomeGrade.gain.lerp(bg, Math.min(1, dt * 0.5));
      biomeGrade.sat += (bs - biomeGrade.sat) * Math.min(1, dt * 0.5);
      gain.multiply(biomeGrade.gain);
      gain.x *= st.tint[0];
      gain.y *= st.tint[1];
      gain.z *= st.tint[2];
      gr.u('uSaturation').value = Math.max(0, sat + biomeGrade.sat);
      gr.u('uContrast').value = THREE.MathUtils.lerp(GRADE.night.contrast, GRADE.day.contrast, day) * st.contrast;
      f.post.update(L.sunDir, L.lightColor, sunVisibility(L.sunDir.y) * (1 - under));
    }

    // Streaming. Velocity from the simulated player (feet), for prediction.
    vel.set(localPlayer.vel.x, localPlayer.vel.y, localPlayer.vel.z);
    world.terrain.update(camera, vel, dt, now);
    world.scatter.update(camera, now);
    world.edits.update(camera, dt, now);
    netStats.chunkQueue = runtime.pool.queued + runtime.pool.inFlight;
    netStats.chunksLoaded = world.terrain.stats.loaded;
    overlay.update(showTiles, world.terrain.drawnTiles(), camera.position, now);

    // WP19b shader warm-up (warmup.ts): once per post chain (load, and an
    // explicit shader-tier change), as soon as the first terrain is in the
    // scene, compile every material in parallel before drawing with it.
    // While it runs nothing is drawn (the loading veil is up at load; on a
    // tier change the last frame stays on screen) so no draw call forces a
    // synchronous compile.
    if (f && warm.current.post !== f.post && world.terrain.stats.loaded > 0 && !NO_WARMUP) {
      const w = { post: f.post, pending: true };
      warm.current = w;
      worldDebug.shadersWarm = false;
      // Playtest 2: the post chain's full-screen programs too (style pass, FXAA).
      warmShaders(gl, scene, camera, warmExtras(), undefined, f.post.warmObjects())
        .then((r) => {
          worldDebug.warmup = r;
          if (!r.done) console.warn('[world] shader warm-up hit its time limit', r);
        })
        .catch((err) => console.warn('[world] shader warm-up failed', err))
        .finally(() => {
          w.pending = false;
          worldDebug.shadersWarm = true;
        });
    }
    if (f && warm.current.pending) return;

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
