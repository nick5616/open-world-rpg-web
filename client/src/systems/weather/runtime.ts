// The client's live weather (playtest 2, CR 030): one module the movement
// env, the world scene, the audio engine and the HUD all read.
//
//   - the climate comes from the loaded world's atlas biome grid (the same
//     vote the zone runs), the seed and wind from the world clock (Event 500;
//     solo: the offline seed and the WorldSpec wind);
//   - the zone says whether it runs dynamic weather and any dev override in
//     Event 500 byte 18; `?weather=<state>` (and WP10's `?rain=1|0`) force a
//     state on this client (solo screenshots, debugging);
//   - movement: weatherField(step) is the shared weather.Field (cached per
//     chemistry step), so prediction reads what the zone reads;
//   - visuals and sound: weatherFrame() eases the blended mix at the camera,
//     remembers wet ground and settled snow, finds rainbows, and runs the
//     lightning: seeded strikes far from you are drawn here from the seed;
//     near ones (which may strike a player) come from the zone (Event 1220).

import { CHEM_STEP_HZ, LIGHTNING_LOCAL_M, WORLD_SIZE_M } from '@lodestone/contracts';
import { create } from 'zustand';
import { chemStep, worldClockState, worldTime } from '../clock';
import { isRaining } from '../../sim/weather';
import { accumulate, easeMix, forecast, forecastLine, mixAt, rainbowAt, STATE_MIX, type WeatherMix, zeroMix } from './blend';
import { arrowAccel, Climate, stateByKey, strikesBetween, tallSpot, W, WeatherField } from './weather';

/** A bolt to draw: from the sky down to (x, y, z). */
export interface Bolt {
  id: number;
  x: number;
  y: number;
  z: number;
  /** performance.now() when it struck. */
  at: number;
  /** Struck a player (brighter, bigger flash). */
  hit: boolean;
  /** Distance to the listener when it struck (thunder delay). */
  distM: number;
}

export interface WeatherHudState {
  active: boolean;
  state: number;
  next: number;
  inS: number;
  line: string;
  chilled: boolean;
  cold: boolean;
  warmS: number;
  /** Seconds until Chilled while out in the cold. */
  onsetS: number;
  set(p: Partial<WeatherHudState>): void;
}

export const useWeatherHud = create<WeatherHudState>((set) => ({
  active: false,
  state: 0,
  next: 0,
  inS: Infinity,
  line: '',
  chilled: false,
  cold: false,
  warmS: 0,
  onsetS: 0,
  set: (p) => set(p),
}));

function param(name: string): string | null {
  try {
    return typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** The weather this client runs. */
export const weatherClient = {
  climate: null as Climate | null,
  /** The zone runs dynamic weather (Event 500 byte 18 > 0); solo: whenever the world has a biome grid. */
  dynamic: true,
  /** The zone's override (-1 none). */
  zoneOverride: -1,
  /** Dev override from the handle (-1 none; null = follow the URL / zone). */
  devOverride: null as number | null,
  /** Seconds since the zone announced the clock (online) or null (solo). */
  online: false,
  /** Dev: a rainbow strength to show regardless of the weather (null: the weather decides). */
  devRainbow: null as number | null,
  /** A time function (world seconds) set by NetPlay; solo uses the wall clock. */
  timeS: null as (() => number) | null,
};

const urlOverride = (() => {
  const k = param('weather');
  if (k) {
    const s = stateByKey(k);
    if (s >= 0) return s;
  }
  const r = param('rain');
  return r === '1' ? W.rain : r === '0' ? W.clear : -1;
})();

/** The forced state (-1 = seeded): dev handle, then URL, then the zone, then the zone's WP10 rain override. */
export function weatherOverride(): number {
  if (weatherClient.devOverride !== null && weatherClient.devOverride >= 0) return weatherClient.devOverride;
  if (urlOverride >= 0) return urlOverride;
  if (weatherClient.zoneOverride >= 0) return weatherClient.zoneOverride;
  if (worldClockState.rain !== null) return worldClockState.rain ? W.rain : W.clear;
  return -1;
}

/** The loaded world's atlas: build the climate (WorldScene, once per runtime). */
export function setWeatherWorld(atlas: { gridN: number; biome: ArrayLike<number>; worldSize?: number }, windDeg?: number): void {
  const ws = atlas.worldSize ?? WORLD_SIZE_M;
  weatherClient.climate = atlas.gridN > 1 ? Climate.fromBiomes(atlas.gridN, Math.floor(ws / (atlas.gridN - 1)), atlas.biome) : null;
  if (!worldClockState.announced && windDeg !== undefined) worldClockState.windDeg = windDeg;
  fieldCache = null;
}

/** Event 500 byte 18 (CR 030): 0 no dynamic weather, 1 seeded, 2 + s forced. */
export function onZoneWeatherByte(b: number | undefined): void {
  weatherClient.online = true;
  weatherClient.dynamic = b === undefined ? false : b > 0;
  weatherClient.zoneOverride = b !== undefined && b >= 2 ? b - 2 : -1;
  fieldCache = null;
}

export function resetZoneWeather(): void {
  weatherClient.online = false;
  weatherClient.dynamic = true;
  weatherClient.zoneOverride = -1;
  weatherClient.timeS = null;
  fieldCache = null;
}

export function weatherOn(): boolean {
  return !!weatherClient.climate && weatherClient.dynamic;
}

/** World time (s) for the weather: the zone's synced clock online, the wall clock solo. */
export function weatherTimeS(): number {
  return weatherClient.timeS ? weatherClient.timeS() : worldTime(Date.now());
}

let fieldCache: { k: number; seed: bigint; o: number; wind: number; f: WeatherField } | null = null;

/** The shared weather field at chemistry step k (null: no dynamic weather here). */
export function weatherField(seed: bigint, k: number): WeatherField | null {
  const c = weatherClient.climate;
  if (!c || !weatherClient.dynamic) return null;
  const o = weatherOverride();
  const wind = worldClockState.windDeg;
  const fc = fieldCache;
  if (fc && fc.k === k && fc.seed === seed && fc.o === o && fc.wind === wind) return fc.f;
  const f = new WeatherField(seed, c, wind, k, o);
  fieldCache = { k, seed, o, wind, f };
  return f;
}

// ---- per frame: the look and sound of the weather here ----

export const liveWeather = {
  /** Eased mix at the camera. */
  mix: zeroMix(),
  /** Ground memory. */
  wet: 0,
  snowCover: 0,
  rainbow: 0,
  /** Lightning flash 0..1 (decays fast). */
  flash: 0,
  /** Bolts struck recently (the scene draws, the audio thunders). */
  bolts: [] as Bolt[],
  /** Thunder to play: distances (m), drained by the audio engine. */
  thunder: [] as number[],
  /** The state where the player stands. */
  state: W.clear as number,
  /** Debug: seeded strikes drawn locally / zone strikes. */
  stats: { local: 0, zone: 0 },
};

const seen = new Set<number>();
let lastK = -1;
let hudAcc = 0;
const lastCam = { x: NaN, z: NaN };

function pushBolt(b: Bolt): void {
  if (seen.has(b.id)) return;
  seen.add(b.id);
  if (seen.size > 512) seen.clear();
  liveWeather.bolts.push(b);
  if (liveWeather.bolts.length > 8) liveWeather.bolts.shift();
  liveWeather.flash = Math.max(liveWeather.flash, Math.min(1, (b.hit ? 1.6 : 1) * (1 - Math.min(0.85, b.distM / 2500))));
  liveWeather.thunder.push(b.distM);
  if (liveWeather.thunder.length > 6) liveWeather.thunder.shift();
}

/** A strike the zone resolved (Event 1220). */
export function zoneBolt(id: number, x: number, y: number, z: number, hit: boolean, listener: { x: number; y: number; z: number }): void {
  liveWeather.stats.zone++;
  pushBolt({ id, x, y, z, at: performance.now(), hit, distM: Math.hypot(x - listener.x, y - listener.y, z - listener.z) });
}

/**
 * Per frame (WorldScene): ease the mix at the camera toward the blended
 * weather, update the ground memory and rainbows, draw the seeded strikes
 * this client is responsible for, and keep the HUD chip current.
 */
export function weatherFrame(cam: { x: number; y: number; z: number }, player: { x: number; z: number }, dt: number, sunElevationRad: number, heightAt: ((x: number, z: number) => number) | null, legacyRain: boolean): void {
  const c = weatherClient.climate;
  const t = weatherTimeS();
  const seed = worldClockState.seed;
  const o = weatherOverride();
  let target: WeatherMix;
  if (c && weatherClient.dynamic) target = mixAt(seed, c, cam.x, cam.z, t, o);
  else target = { ...STATE_MIX[legacyRain || (o === W.rain) ? W.rain : W.clear] };
  // A fast travel or a teleport arrives in the weather there, not the one left behind.
  const jumped = !(Math.hypot(cam.x - lastCam.x, cam.z - lastCam.z) < 150);
  lastCam.x = cam.x;
  lastCam.z = cam.z;
  if (jumped) {
    Object.assign(liveWeather.mix, target);
    liveWeather.wet = Math.min(1, target.rain * 1.4);
    liveWeather.snowCover = Math.min(1, target.snow * 1.3);
  }
  easeMix(liveWeather.mix, target, dt);
  accumulate(liveWeather, liveWeather.mix, dt);
  const rb = weatherClient.devRainbow ?? (c && weatherClient.dynamic && o < 0 ? rainbowAt(seed, c, player.x, player.z, t, sunElevationRad) : 0);
  liveWeather.rainbow += (rb - liveWeather.rainbow) * Math.min(1, dt * 0.5);
  liveWeather.flash *= Math.exp(-dt * 7);
  const now = performance.now();
  liveWeather.bolts = liveWeather.bolts.filter((b) => now - b.at < 1500);

  // Seeded strikes: drawn here when far (online) or always (solo).
  const k = chemStep(t);
  if (c && weatherClient.dynamic && k !== lastK) {
    if (lastK >= 0 && k > lastK && k - lastK < 50) {
      strikesBetween(seed, c, lastK + 1, k + 1, o, (st) => {
        const d0 = Math.hypot(st.x - cam.x, st.z - cam.z);
        if (d0 > 6000) return;
        const [x, z] = heightAt ? tallSpot(heightAt, st.x, st.z) : [st.x, st.z];
        const y = heightAt ? heightAt(x, z) : 0;
        const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
        if (weatherClient.online && Math.hypot(x - player.x, z - player.z) <= LIGHTNING_LOCAL_M) return; // the zone tells us
        liveWeather.stats.local++;
        pushBolt({ id: st.id, x, y, z, at: now, hit: false, distM: d });
      });
    }
    lastK = k;
  }

  // The player's state and the HUD's forecast, a few times a second.
  hudAcc += dt;
  if (hudAcc > 0.25) {
    hudAcc = 0;
    const hud = useWeatherHud.getState();
    if (c && weatherClient.dynamic) {
      const f = forecast(seed, c, player.x, player.z, t, o);
      liveWeather.state = f.now;
      const line = forecastLine(f.now, f.next, f.inS);
      if (!hud.active || hud.state !== f.now || hud.next !== f.next || hud.line !== line) hud.set({ active: true, state: f.now, next: f.next, inS: f.inS, line });
    } else {
      const s = legacyRain ? W.rain : W.clear;
      liveWeather.state = s;
      if (!hud.active || hud.state !== s || hud.line) hud.set({ active: true, state: s, next: s, inS: Infinity, line: '' });
    }
  }
}

/** Legacy rain (atlas-less zones): WP10's global windows. */
export function legacyRaining(seed: bigint, t: number): boolean {
  return worldClockState.rain ?? isRaining(seed, t);
}

/** Chemistry step now (for the dev handle and tests). */
export function weatherStepNow(): number {
  return Math.floor(weatherTimeS() * CHEM_STEP_HZ);
}

/** Downwind drift of an arrow loosed at (x, z) now, m/s^2 (CR 030; [0, 0] when calm or without weather). */
export function arrowWindAt(x: number, z: number): [number, number] {
  const f = weatherField(worldClockState.seed, chemStep(weatherTimeS()));
  if (!f) return [0, 0];
  return arrowAccel(f.stateAt(x, z), f.wind);
}
