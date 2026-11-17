// Night, demons, weather and chemistry on the client (WP15): the zone
// session's Events 500-526 become the world clock (sky, rain, wind), the
// chemistry view (fire, ice, pillars: one ChemView, events or bitmap path)
// and the HUD's night state (moon, demons, town defense). NetPlay calls
// attachNight right after it builds the session and nightWorld once the
// world runtime (terrain, atlas) is loaded.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import type { WorldRuntime } from '../world/core/runtime';
import { worldClock } from '../state/live';
import { setPrevailingWind } from '../world/wind';
import { chemStep, hourOf, isNight, moonPhase, nightIndex, rainingAtStep, timeOfDayS, windAtStep, worldClockState, worldTime } from './clock';
import { TerrainMaterial } from './chem/material';
import { chemRuntime } from './chem/ground';
import { createChemView, type ChemMode, type ChemView } from './chem/sync';
import type { ChemEvent } from './chem/codec';
// Playtest 2 weather (CR 030): the zone's weather byte, Events 1220-1222, rain where you stand.
import { liveWeather, onZoneWeatherByte, resetZoneWeather, setWeatherWorld, weatherClient, weatherOn, weatherOverride } from './weather/runtime';
import { onWeatherEvent } from './weather/link';
// CR 038: hard landings, the Depths' lava, the palace / activity hooks (Events 1700-1719).
import { onVerticalEvent } from '../world/vertical/events';
import { isWet } from './weather/weather';

/** Event kinds (contracts/events.md 500-599). */
export const EV = {
  worldClock: 500,
  dusk: 501,
  dawn: 502,
  demonBurned: 503,
  demonShrugged: 504,
  demonsRose: 505,
  lordRisen: 506,
  defenseWarning: 510,
  defenseWave: 511,
  wardHealth: 512,
  defenseEnded: 513,
  defenseReward: 514,
  chemRefused: 526,
} as const;

export interface DefenseHud {
  town: number;
  name: string;
  phase: 'warning' | 'wave' | 'ended';
  wave: number;
  waves: number;
  ward: number;
  wardMax: number;
  demons: number;
  result: number;
  x: number;
  z: number;
}

export interface NightHud {
  online: boolean;
  hour: number;
  night: boolean;
  moon: number;
  nightIdx: number;
  raining: boolean;
  notices: { id: number; text: string; until: number; tone: 'night' | 'dawn' | 'danger' | 'info' }[];
  defense: DefenseHud | null;
  shrugged: number;
  chemMode: ChemMode;
  burning: number;
  set(p: Partial<NightHud>): void;
  notice(text: string, tone?: NightHud['notices'][number]['tone'], ms?: number): void;
}

let noticeId = 1;

export const useNightHud = create<NightHud>((set, get) => ({
  online: false,
  hour: 0,
  night: false,
  moon: 0,
  nightIdx: 0,
  raining: false,
  notices: [],
  defense: null,
  shrugged: 0,
  chemMode: 'events',
  burning: 0,
  set: (p) => set(p),
  notice: (text, tone = 'info', ms = 5000) => {
    const now = performance.now();
    set({ notices: [...get().notices.filter((n) => n.until > now), { id: noticeId++, text, until: now + ms, tone }].slice(-4) });
  },
}));

/** One-shot visual effects for the 3D layer (demons rising, burning at dawn). */
export type NightFx = { t: 'rose' | 'burned' | 'fled'; x: number; y: number; z: number; at: number };
export const nightFx: NightFx[] = [];

interface SessionLike {
  eventListeners: Set<(e: ZoneEvent) => void>;
  clock: { serverNow(): number };
  welcome: { seed: bigint; entityId: number } | null;
  sendInteract(kind: number, id: bigint, action: number, arg: number): void;
}

/** The live night runtime (the 3D layer, the dev handle). */
export const nightRuntime = {
  session: null as SessionLike | null,
  runtime: null as WorldRuntime | null,
  view: null as ChemView | null,
  mode: 'events' as ChemMode,
  /** Chemistry events that arrived before the world loaded. */
  queue: [] as ChemEvent[],
  /** Called after each simulated chemistry step (evidence harnesses). */
  onStep: null as ((step: number, hash: number, burning: number) => void) | null,
};

const td = new TextDecoder();

function forceMode(): ChemMode | null {
  try {
    const m = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('chem');
    return m === 'bitmap' ? 'bitmap' : m === 'events' ? 'events' : null;
  } catch {
    return null;
  }
}

function zoneStep(): number {
  const s = nightRuntime.session;
  return s ? chemStep(worldTime(s.clock.serverNow())) : 0;
}

/** Build the chemistry view once both the clock (Event 500) and the world are known. */
function rebuildView(): void {
  const rt = nightRuntime.runtime;
  if (!rt || !worldClockState.announced) return;
  if (nightRuntime.view && nightRuntime.view.mode === nightRuntime.mode) return;
  const src = new TerrainMaterial(rt.terrainGround, worldClockState.seed, rt.data);
  const view = createChemView(nightRuntime.mode, worldClockState.seed, worldClockState.windDeg, src, zoneStep() - 2);
  if ('sim' in view) {
    const ev = view as ChemView & { sim: { rain: boolean | null; weather: unknown }; onStep: ((s: number, sim: { hash(): number; burning(): number }) => void) | null };
    ev.sim.rain = worldClockState.rain;
    // CR 030: rain where each burning cell is (the zone's chem.Sim.Weather).
    if (weatherOn() && weatherClient.climate) {
      ev.sim.rain = null;
      ev.sim.weather = { climate: weatherClient.climate, override: weatherOverride() };
    }
    ev.onStep = (s, sim) => nightRuntime.onStep?.(s, sim.hash(), sim.burning());
  }
  nightRuntime.view = view;
  chemRuntime.view = view;
  for (const e of nightRuntime.queue) view.onEvent(e);
  nightRuntime.queue = [];
}

/** NetPlay: the world runtime is loaded (terrain + atlas for the chemistry materials). */
export function nightWorld(rt: WorldRuntime): void {
  nightRuntime.runtime = rt;
  setWeatherWorld(rt.data); // CR 030: the climate before the chemistry view reads it
  rebuildView();
}

function onClock(e: { data: Uint8Array }): void {
  const d = e.data;
  if (d.length < 18 || d[0] !== 1) return;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const offset = v.getFloat64(1, true);
  if (worldClockState.announced && offset !== worldClockState.offsetS) {
    // The world clock jumped (dev "set time"): the zone rebased its
    // chemistry and re-sends baselines; start a fresh view.
    nightRuntime.view = null;
    chemRuntime.view = null;
  }
  worldClockState.offsetS = offset;
  worldClockState.windDeg = v.getUint16(10, true);
  const zoneMode: ChemMode = d[12] === 2 ? 'bitmap' : 'events';
  worldClockState.demonIntensity = v.getFloat32(13, true);
  worldClockState.rain = d[17] === 1 ? true : d[17] === 2 ? false : null;
  onZoneWeatherByte(d.length > 18 ? d[18] : undefined); // CR 030
  worldClockState.announced = true;
  const s = nightRuntime.session;
  if (s?.welcome) worldClockState.seed = s.welcome.seed;
  const want = forceMode();
  if (want && want !== zoneMode && s) {
    s.sendInteract(51, 0n, 10, want === 'bitmap' ? 2 : 1); // ask the zone for the other path
  }
  if (nightRuntime.mode !== zoneMode) {
    nightRuntime.mode = zoneMode;
    nightRuntime.view = null;
    chemRuntime.view = null;
  }
  if (!nightRuntime.view) nightRuntime.queue = [];
  useNightHud.getState().set({ online: true, chemMode: zoneMode });
  rebuildView();
}

function data16(d: Uint8Array, o: number): number {
  return d.length >= o + 2 ? d[o] | (d[o + 1] << 8) : 0;
}

export function attachNight(session: SessionLike): () => void {
  nightRuntime.session = session;
  const hud = useNightHud.getState();
  const onEvent: Parameters<SessionLike['eventListeners']['add']>[0] = (e) => {
    if (e.kind >= 1220 && e.kind <= 1239) {
      onWeatherEvent(e, session.welcome?.entityId ?? 0); // CR 030
      return;
    }
    if ((e.kind >= 1700 && e.kind <= 1719) || (e.kind >= 1880 && e.kind <= 1899)) {
      onVerticalEvent(e, session.welcome?.entityId ?? 0); // CR 038
      return;
    }
    if (e.kind >= 520 && e.kind <= 525) {
      if (nightRuntime.view) nightRuntime.view.onEvent(e);
      else nightRuntime.queue.push(e);
      return;
    }
    const s = useNightHud.getState();
    switch (e.kind) {
      case EV.worldClock:
        onClock(e);
        break;
      case EV.dusk:
        s.notice(td.decode(e.data) || 'Night falls.', 'night', 7000);
        break;
      case EV.dawn:
        s.notice(`${td.decode(e.data) || 'Dawn breaks.'}${e.value ? ` (${e.value} burned)` : ''}`, 'dawn', 7000);
        break;
      case EV.demonBurned:
        nightFx.push({ t: e.value ? 'burned' : 'fled', x: e.x / 100, y: e.y / 100, z: e.z / 100, at: performance.now() });
        break;
      case EV.demonsRose:
        nightFx.push({ t: 'rose', x: e.x / 100, y: e.y / 100, z: e.z / 100, at: performance.now() });
        break;
      case EV.demonShrugged:
        s.set({ shrugged: performance.now() });
        break;
      case EV.lordRisen:
        s.notice(`${td.decode(e.data)} walks the night.`, 'danger', 8000);
        break;
      case EV.defenseWarning:
        s.set({ defense: { town: e.targetId, name: td.decode(e.data), phase: 'warning', wave: 0, waves: 3, ward: 1000, wardMax: 1000, demons: 0, result: 0, x: e.x / 100, z: e.z / 100 } });
        s.notice(`The ward of ${td.decode(e.data) || 'the town'} falters! Demons are coming.`, 'danger', 8000);
        break;
      case EV.defenseWave: {
        const d = s.defense ?? { town: e.targetId, name: '', phase: 'wave' as const, wave: 0, waves: 3, ward: 1000, wardMax: 1000, demons: 0, result: 0, x: e.x / 100, z: e.z / 100 };
        s.set({ defense: { ...d, phase: 'wave', wave: e.value, waves: e.data[0] ?? 3, demons: data16(e.data, 2) } });
        if (e.value > 0) s.notice(`Wave ${e.value} of ${e.data[0] ?? 3}`, 'danger', 3500);
        break;
      }
      case EV.wardHealth:
        if (s.defense) s.set({ defense: { ...s.defense, ward: e.value, demons: data16(e.data, 0) || s.defense.demons } });
        break;
      case EV.defenseEnded:
        if (s.defense) s.set({ defense: { ...s.defense, phase: 'ended', result: e.value } });
        s.notice(td.decode(e.data), e.value === 1 ? 'dawn' : 'danger', 8000);
        setTimeout(() => useNightHud.getState().defense?.phase === 'ended' && useNightHud.getState().set({ defense: null }), 9000);
        break;
      case EV.defenseReward:
        s.notice(`Town defended: +${e.value} XP`, 'info', 5000);
        break;
    }
  };
  session.eventListeners.add(onEvent);
  worldClock.source = () => timeOfDayS(worldTime(session.clock.serverNow()));
  weatherClient.timeS = () => worldTime(session.clock.serverNow()); // CR 030
  hud.set({ online: true });
  const w = typeof window !== 'undefined' ? (window as unknown as { __lodestoneNight?: unknown }) : null;
  if (w) {
    w.__lodestoneNight = {
      hud: () => ({ ...useNightHud.getState() }),
      state: () => {
        const v = nightRuntime.view;
        return { mode: v?.mode, step: v?.step, hash: v?.hash(), stats: v?.stats, zoneStep: zoneStep(), offsetS: worldClockState.offsetS };
      },
      ignite: (x: number, z: number, r = 1) => session.sendInteract(51, BigInt(Math.round(x * 100) >>> 0) | (BigInt(Math.round(z * 100) >>> 0) << 32n), 1, r),
      freeze: (x: number, z: number, r = 3) => session.sendInteract(51, BigInt(Math.round(x * 100) >>> 0) | (BigInt(Math.round(z * 100) >>> 0) << 32n), 2, r),
      pillar: (x: number, z: number) => session.sendInteract(51, BigInt(Math.round(x * 100) >>> 0) | (BigInt(Math.round(z * 100) >>> 0) << 32n), 4, 0),
      setTime: (hour: number) => {
        // Offset so that now is `hour` o'clock (dev zones only).
        const now = session.clock.serverNow() / 1000;
        const off = Math.round(((((hour / 24) * 3600 - (now % 3600)) % 3600) + 3600) % 3600);
        session.sendInteract(52, 0n, 2, off >>> 0);
      },
      raiseDemons: (rank = 0) => session.sendInteract(52, 0n, 3, rank),
      defense: () => session.sendInteract(52, 0n, 1, 0),
      sunsteel: (loadout = 0) => session.sendInteract(50, 0n, 6, loadout | (3 << 8)),
    };
  }
  return () => {
    session.eventListeners.delete(onEvent);
    if (nightRuntime.session === session) nightRuntime.session = null;
    nightRuntime.view = null;
    nightRuntime.runtime = null;
    nightRuntime.queue = [];
    chemRuntime.view = null;
    worldClock.source = null;
    worldClockState.announced = false;
    worldClockState.offsetS = 0;
    worldClockState.rain = null;
    resetZoneWeather();
    useNightHud.getState().set({ online: false, defense: null });
  };
}

/** Per frame (the 3D layer): advance the chemistry, keep the HUD's clock and the grass wind in step. */
export function nightFrame(px: number, pz: number): void {
  const s = nightRuntime.session;
  const t = s ? worldTime(s.clock.serverNow()) : worldClock.timeOfDayS;
  const k = chemStep(t);
  const v = nightRuntime.view;
  if (v) {
    v.advanceTo(k);
    if ((k & 15) === 0) v.prune(px, pz);
  }
  const w = windAtStep(worldClockState.seed, worldClockState.windDeg, k);
  setPrevailingWind(w.sector * 45, 2 + w.strength * 1.5);
  const hud = useNightHud.getState();
  const n = nightIndex(t);
  const raining = weatherOn() ? isWet(liveWeather.state) : rainingAtStep(worldClockState.seed, k);
  const burning = v && 'sim' in v ? (v as unknown as { sim: { burning(): number } }).sim.burning() : 0;
  const hour = Math.floor(hourOf(t) * 4) / 4;
  if (hud.hour !== hour || hud.raining !== raining || hud.nightIdx !== n || hud.burning !== burning) {
    hud.set({ hour, night: isNight(t), moon: moonPhase(worldClockState.seed, n), nightIdx: n, raining, burning });
  }
}
