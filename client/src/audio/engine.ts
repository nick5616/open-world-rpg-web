// The audio engine: owns the SFX player, the music director and player, the
// ambience beds, and wires them to the game. Loaded as a lazy chunk by
// AudioRoot after the first playable frame (spec 12: nothing audio is in
// the first-frame download), into the context and buses context.ts made on
// the first user gesture.
//
// Per animation frame it moves the listener with the camera and turns the
// local player's movement into steps and splashes; ten times a second it
// samples where the listener is (roof, walls, cave depth, what is underfoot,
// the fires and water around) and steers the ambience, the positional loops,
// the reverb and the bus damping (envTick); four times a second it feeds the
// music director and the ducking (slowTick). Zone Events arrive through
// session.eventListeners and go through the trigger map.

import { DAY_LENGTH_S, DEFENSE_WARNING_S, type Event as ZoneEvent } from '@lodestone/contracts';
import { localPlayer, worldClock } from '../state/live';
import { netRuntime } from '../net/netStore';
import { useCombatHud } from '../combat/store';
import { nightRuntime, useNightHud } from '../systems/night';
import { useVoiceStore } from '../voice/store';
import { voiceLevels } from '../voice/levels';
import { worldDebug } from '../world/debug/worldDebug';
import { useExploration } from '../ui/map/store';
import { useInventory } from '../ui/inventory/store';
import { useSocialStore } from '../social/store';
import { useAudioSettings } from './settings';
import { busEnvFilter, busInput, getAudioContext, masterNode, onAudioReady } from './context';
import { audioWorld, loopSources, setTriggerSink, type Vec3 } from './bridge';
import { SfxEngine, type PlayOpts } from './sfx';
import { CUES, type CueId } from './cues';
import { Ambience } from './ambience';
import { MovementSounds } from './movement';
import { MusicDirector, type MusicInputs, type TimedInput } from './music/director';
import { MusicPlayer } from './music/player';
import { runTrigger, runZoneEvent, type TriggerApi, type TriggerName, type TriggerPayload } from './triggers';
import { caveLeak, duckLevels, interiorMix, RainIntensity, Smooth, weatherMix } from './acoustics';
import { LoopVoices } from './loops';
import { selectLoops, type LoopEmitter } from './loopPool';
import { nextStrike } from './emitters';
import { SPACE_CAVE } from './spatial';
import type { StepSurface } from './surface';
import { WorldProbe } from './worldProbe';
import { useStory } from '../ui/story/store';
import { wildlifeTargets } from './wildlife';
import { FINALE } from '../ui/story/events';
// Playtest 2 weather (CR 030): rain level, wind, storm, sand, thunder from real strikes.
import { liveWeather, weatherOn } from '../systems/weather/runtime';
// Playtest 2 vibe explorer: the composer aids' seam (dev builds; nothing registers otherwise).
import { composerHook } from './composer/hook';

/** What the Heartfall asks of the music (playtest 2 immersion pass; director.ts `finale`). */
function finaleMusic(): 'intro' | 'fight' | 'won' | null {
  const s = useStory.getState();
  if (s.cinematic) return 'intro';
  const f = s.finale;
  if (!f) return null;
  if (f.phase === FINALE.intro) return 'intro';
  if (f.phase === FINALE.fight || f.phase === FINALE.choir) return 'fight';
  if (f.phase === FINALE.won) return performance.now() - f.at < 60000 ? 'won' : null;
  return null;
}

const EYE = 1.6;
const HOUR_S = DAY_LENGTH_S / 24;
/** Listener / occlusion / loop pass (ms): 10 Hz, not per frame of every source. */
const ENV_MS = 100;
/** Water probe (ms). */
const WATER_MS = 500;
/** Fires further than this are not even scored. */
const FIRE_SCAN_M = 70;
/** A smith is heard hammering within this range, by day. */
const HAMMER_M = 36;
/** Below this `underground` the listener is still on the surface (shelter, water, smiths). */
const CAVE_IN = 0.3;
/** Cues decoded right after boot (the ones that must answer instantly). */
const PRELOAD: CueId[] = ['ui_click', 'ui_confirm', 'ui_open', 'ui_close', 'ui_error', 'map_open', 'map_close', 'step_soft', 'step_hard', 'jump', 'land', 'swing_sword', 'swing_heavy', 'thrust_spear', 'bow_draw', 'bow_release', 'bolt', 'hit', 'hit_crit', 'arrow_hit', 'player_hurt', 'mine_stone', 'mine_gem', 'vein_break', 'loot_common', 'telegraph', 'splash', 'glide_open', 'climb_grab', 'cast_fire', 'cast_ice', 'impact_fire', 'impact_ice'];

export class AudioEngine {
  readonly sfx: SfxEngine;
  readonly music: MusicPlayer;
  readonly director = new MusicDirector();
  readonly ambience: Ambience;
  readonly loops: LoopVoices;
  readonly probe = new WorldProbe();
  private movement = new MovementSounds();
  private rain = new RainIntensity();
  private roof = new Smooth(0, 0.3);
  private indoors = new Smooth(0, 0.3);
  private surface: StepSurface = 'soft';
  private lastEnv = 0;
  private lastWater = -1e9;
  private water: LoopEmitter | null = null;
  private hammers = new Map<string, { next: number; left: number }>();
  private hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  /** The last environment pass (debug handle). */
  env: Record<string, unknown> = {};
  private unsubs: (() => void)[] = [];
  /** The instant cues are decoded. */
  preloaded = false;
  /** Every cue is downloaded (the instant set decoded, the rest compressed). */
  allLoaded = false;
  private raf = 0;
  private lastFrame = 0;
  private lastSlow = 0;
  private session: { eventListeners: Set<(e: ZoneEvent) => void> } | null = null;
  private onEvent = (e: ZoneEvent) => runZoneEvent(e, this.api);
  private mem: Record<string, number> = {};
  private stingDuckUntil = 0;
  private analyser: AnalyserNode;
  private meterBuf = new Float32Array(2048);
  /** Forced rain for tests and the debug handle (null = follow the weather). */
  forcedRain: boolean | null = null;
  /** Forced music state for tests and the debug handle (null = follow the world). */
  forced: Partial<MusicInputs> | null = null;
  private voidUntil = 0;
  private lastInputs: MusicInputs | null = null;

  readonly api: TriggerApi = {
    play: (cue: CueId, opts?: PlayOpts) => this.play(cue, opts),
    selfId: () => netRuntime.session?.welcome?.entityId ?? -1,
    selfPos: () => ({ x: localPlayer.pos.x, y: localPlayer.pos.y + 1, z: localPlayer.pos.z }),
    markCombat: (s: number) => {
      audioWorld.combatUntil = Math.max(audioWorld.combatUntil, performance.now() + s * 1000);
    },
    mem: this.mem,
  };

  constructor(readonly ctx: AudioContext) {
    const sfxBus = busInput('sfx')!;
    this.sfx = new SfxEngine(ctx, { sfx: sfxBus, ui: busInput('ui')!, ambience: busInput('ambience')! });
    this.music = new MusicPlayer(ctx, busInput('music')!);
    this.ambience = new Ambience(ctx, busInput('ambience')!, this.sfx.reverbSend);
    this.loops = new LoopVoices(ctx, busInput('ambience')!, this.sfx.reverbSend);
    // A hidden tab fades music, ambience and effects out (voice chat stays);
    // rAF stops in the background, so this cannot wait for slowTick.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      this.unsubs.push(() => document.removeEventListener('visibilitychange', this.onVisibility));
    }
    // UI panels opening and closing (map, inventory, sound settings): their
    // stores, so the panels themselves need no audio code.
    let mapOpen = useExploration.getState().mapOpen;
    let invOpen = useInventory.getState().invOpen;
    let station = useInventory.getState().station;
    let soundOpen = useAudioSettings.getState().panelOpen;
    this.unsubs.push(
      useExploration.subscribe((s) => {
        if (s.mapOpen !== mapOpen) this.trigger(s.mapOpen ? 'map_open' : 'map_close', {});
        mapOpen = s.mapOpen;
      }),
      useInventory.subscribe((s) => {
        if (s.invOpen !== invOpen) this.trigger(s.invOpen ? 'panel_open' : 'panel_close', {});
        if (!!s.station !== !!station) this.trigger(s.station ? 'panel_open' : 'panel_close', {});
        invOpen = s.invOpen;
        station = s.station;
      }),
      // Spec 9: a whisper sound when the chat is closed.
      useSocialStore.subscribe((s, p) => {
        if (s.open) return;
        for (const [tab, n] of Object.entries(s.unread)) if (tab.startsWith('w:') && n > (p.unread[tab] ?? 0)) return this.trigger('whisper', {});
      }),
      useAudioSettings.subscribe((s) => {
        if (s.panelOpen !== soundOpen) this.trigger(s.panelOpen ? 'panel_open' : 'panel_close', {});
        soundOpen = s.panelOpen;
      }),
    );
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    masterNode()?.connect(this.analyser);
    setTriggerSink((name, payload) => this.trigger(name, payload));
    void this.preload();
    this.raf = requestAnimationFrame(this.frame);
  }

  private async preload(): Promise<void> {
    // A few at a time: decoding is off the main thread, but a burst of
    // fetches competes with chunk streaming. ~150 KB in all.
    const queue = [...PRELOAD];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) await this.sfx.preload(c);
      }),
    );
    this.preloaded = true;
    void this.music.prefetchTimed();
    // Then download everything else, two at a time in the background (~1 MB
    // of Opus in all), kept compressed: decoded it would be ~35 MB of PCM.
    // A sting's first play then costs a decode (milliseconds), not a fetch.
    const rest = (Object.keys(CUES) as CueId[]).filter((c) => !PRELOAD.includes(c));
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        for (let c = rest.shift(); c; c = rest.shift()) await this.sfx.prefetch(c);
      }),
    );
    this.allLoaded = true;
  }

  play(cue: CueId, opts?: PlayOpts): void {
    if (this.sfx.play(cue, opts) && CUES[cue].duckMusic) this.stingDuckUntil = performance.now() + 2600;
  }

  trigger(name: TriggerName, payload: TriggerPayload): void {
    if (name === 'cast' && payload.element === 'void' && payload.kind === 'domain') this.voidUntil = performance.now() + 6000;
    runTrigger(name, payload, this.api);
  }

  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 0;
    this.lastFrame = t;
    this.updateListener();
    if (dt > 0) {
      for (const [name, payload] of this.movement.update({ mode: localPlayer.mode, grounded: localPlayer.grounded, pos: localPlayer.pos, vel: localPlayer.vel, airJumps: localPlayer.airJumps, underground: audioWorld.underground, inTown: audioWorld.inTown, surface: this.surface, mounted: localPlayer.mounted, gait: localPlayer.gait }, dt)) this.trigger(name, payload);
    }
    this.ambience.tick(t);
    if (t - this.lastEnv >= ENV_MS) {
      const envDt = this.lastEnv ? Math.min(0.5, (t - this.lastEnv) / 1000) : ENV_MS / 1000;
      this.lastEnv = t;
      this.envTick(t, envDt);
    }
    if (t - this.lastSlow > 250) {
      this.lastSlow = t;
      this.slowTick(t);
    }
  };

  private updateListener(): void {
    const L = this.ctx.listener;
    const p = localPlayer.pos;
    const yaw = localPlayer.yaw;
    const pitch = localPlayer.pitch;
    const fx = -Math.sin(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);
    const tt = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, tt, 0.02);
      L.positionY.setTargetAtTime(p.y + EYE, tt, 0.02);
      L.positionZ.setTargetAtTime(p.z, tt, 0.02);
      L.forwardX.setTargetAtTime(fx, tt, 0.02);
      L.forwardY.setTargetAtTime(fy, tt, 0.02);
      L.forwardZ.setTargetAtTime(fz, tt, 0.02);
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      L.setPosition(p.x, p.y + EYE, p.z);
      L.setOrientation(fx, fy, fz, 0, 1, 0);
    }
    this.sfx.listener.x = p.x;
    this.sfx.listener.y = p.y + EYE;
    this.sfx.listener.z = p.z;
  }

  private attachSession(): void {
    const s = netRuntime.session;
    if (s === this.session) return;
    this.session?.eventListeners.delete(this.onEvent);
    this.session = s;
    s?.eventListeners.add(this.onEvent);
  }

  private inTown(): boolean {
    const towns = worldDebug.runtime?.towns?.settlements;
    if (!towns) return false;
    const p = localPlayer.pos;
    for (const s of towns) {
      const r = Math.max(s.radius, s.wallRadius) + 4;
      const dx = p.x - s.x;
      const dz = p.z - s.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /** The timed objective in play, if any (town defense now; boss enrage). */
  private timed(nowMs: number): TimedInput | null {
    const d = useNightHud.getState().defense;
    if (d && d.phase !== 'ended') {
      if (d.phase === 'warning') {
        const startedAt = (this.mem.warnAt ??= nowMs);
        const left = Math.max(0, DEFENSE_WARNING_S - (nowMs - startedAt) / 1000);
        return { key: `defense:${d.town}`, secondsLeft: left, urgent: false, intro: true };
      }
      delete this.mem.warnAt;
      return { key: `defense:${d.town}`, secondsLeft: null, urgent: d.wardMax > 0 && d.ward / d.wardMax < 0.3, intro: false };
    }
    delete this.mem.warnAt;
    // Playtest 2 immersion pass: the Heartfall's endless night is a countdown (the time crunch, "5 sec left" before it falls)
    const fin = useStory.getState().finale;
    if (fin && fin.phase === FINALE.night) return { key: `finale:night:${Math.round(fin.at / 1000)}`, secondsLeft: Math.max(0, (fin.nightMs - (nowMs - fin.at)) / 1000), urgent: false, intro: false };
    const boss = useCombatHud.getState().boss;
    // Boss enrage: the last phase of a multi-phase boss is a race.
    if (boss && boss.phases > 1 && boss.phase >= boss.phases) return { key: `boss:${boss.id}`, secondsLeft: null, urgent: boss.pct < 15, intro: false };
    return null;
  }

  private anyoneSpeaking(): boolean {
    const v = useVoiceStore.getState();
    if (v.status !== 'connected') return false;
    for (const s of v.speakers) if (voiceLevels.isSpeaking(s.name)) return true;
    return false;
  }

  private slowTick(nowMs: number): void {
    this.attachSession();
    audioWorld.inTown = this.inTown();
    const hud = useCombatHud.getState();
    const hour = worldClock.timeOfDayS / HOUR_S;
    let inputs: MusicInputs = {
      playing: worldDebug.firstPlayableMs !== null,
      hour,
      underground: audioWorld.underground,
      inTown: audioWorld.inTown,
      layer: audioWorld.layer,
      combat: audioWorld.combatUntil > nowMs || !!hud.boss,
      voidMoment: this.voidUntil > nowMs,
      timed: this.timed(nowMs),
      finale: finaleMusic(),
      ...this.forced,
    };
    const ch = composerHook.current;
    if (ch) inputs = ch.inputs(inputs); // a forced music state (vibe explorer)
    this.lastInputs = inputs;
    const decision = this.director.update(inputs, nowMs / 1000);
    this.director.introSeconds = this.music.introSeconds;
    // The composer's deck (a forced track, a loaded file mapped to this vibe) takes over: the game's music fades out.
    let takeover = false;
    try {
      takeover = ch ? ch.tick(this, decision, inputs, nowMs) : false;
    } catch {
      /* a dev tool must never stop the game's music */
    }
    this.music.apply(takeover ? { ...decision, state: 'silence', timedPhase: null } : decision);

    this.applyDucks(nowMs);
  }

  /**
   * Ducking (acoustics.ts duckLevels): voices first (spec 10: voice keeps
   * priority), then big stings (music and a little ambience); a hidden tab
   * fades music, ambience and effects out.
   */
  private applyDucks(nowMs: number): void {
    const t = this.ctx.currentTime;
    const d = duckLevels({ speaking: this.anyoneSpeaking(), sting: this.stingDuckUntil > nowMs, hidden: this.hidden, instrument: audioWorld.instrumentUntil > nowMs });
    busInput('music')?.gain.setTargetAtTime(d.music, t, this.hidden ? 0.25 : d.music < 1 ? 0.08 : 0.6);
    busInput('ambience')?.gain.setTargetAtTime(d.ambience, t, this.hidden ? 0.25 : 0.3);
    busInput('sfx')?.gain.setTargetAtTime(d.sfx, t, this.hidden ? 0.25 : 0.3);
  }

  private onVisibility = () => {
    this.hidden = document.visibilityState === 'hidden';
    this.applyDucks(performance.now());
  };

  /**
   * The 10 Hz environment pass: where the listener is (shelter, cave, what
   * is underfoot) -> weather through the shelter, interior reverb and
   * damping, the positional loops (fires, water), far voices re-placed,
   * the smiths' hammering.
   */
  private envTick(nowMs: number, dt: number): void {
    this.probe.attach(worldDebug.runtime ?? null);
    if (this.probe.ready && !this.sfx.spaceOf) this.sfx.spaceOf = (x, y, z) => this.probe.spaceOf(x, y, z);
    const feet = localPlayer.pos;
    const u = audioWorld.underground;
    const cave = u > CAVE_IN;
    const leak = caveLeak(u, audioWorld.caveMouthM);
    const sh = this.probe.shelterAt(feet.x, feet.y, feet.z);
    const roof = this.roof.update(cave ? 0 : sh.roof, dt);
    const indoors = this.indoors.update(cave ? 0 : sh.indoors, dt);
    const space = cave ? SPACE_CAVE : sh.building;
    this.sfx.listenerSpace = space;
    this.sfx.leak = leak;
    this.surface = this.probe.surfaceAt(feet.x, feet.y, feet.z, u, audioWorld.inTown);

    // Weather through the shelter.
    const night = useNightHud.getState();
    // CR 030: the weather's rain level where you are (drizzle is quieter than a storm).
    const wm = liveWeather.mix;
    const dyn = weatherOn();
    const raining = this.forcedRain ?? (dyn ? wm.rain > 0.12 : night.online ? night.raining : localPlayer.raining);
    const rain = this.rain.update(raining, dt, nowMs / 1000, this.forcedRain !== null || !dyn ? 1 : Math.min(1, wm.rain * 1.15));
    // Thunder from the strikes the weather drew (delayed by distance in thunderFor).
    while (liveWeather.thunder.length) this.ambience.thunder(liveWeather.thunder.shift()!);
    const shelter = { roof, indoors };
    const w = weatherMix(rain, shelter, leak);
    const v = localPlayer.vel;
    const speed = Math.hypot(v.x, v.y, v.z);
    const gliding = localPlayer.mode === 'glide' || (localPlayer.mode === 'air' && v.y < -8);
    const altitude = Math.min(1, Math.max(0, (feet.y - 60) / 160));
    const hour = worldClock.timeOfDayS / HOUR_S;
    const isNight = hour >= 18.5 || hour < 6;
    // CR 038: the sky over an archipelago is all wind; the vast caverns hum
    // and lap; the Depths rumble and bubble.
    const skyAir = audioWorld.sky;
    const cav = audioWorld.cavern;
    const deep = audioWorld.depths;
    const crystal = audioWorld.chamberKind === 0 || audioWorld.chamberKind === 3 ? 1 : 0.55;
    this.ambience.setTargets({
      wind: Math.min(1, 0.18 + altitude * 0.4 + rain * 0.25 + wm.wind * 0.45 + (gliding ? Math.min(0.6, speed / 30) : 0) + skyAir * 0.45),
      windSpeed: gliding ? Math.min(1, speed / 25) : Math.min(1, altitude * 0.4 + wm.wind * 0.5 + skyAir * 0.3),
      storm: Math.min(1, wm.storm * 0.9 + wm.wind * 0.15 * wm.cloud),
      gust: Math.max(Math.max(0, wm.wind - 0.5) * 2, skyAir * 0.8),
      hum: cav * crystal * (1 - deep),
      lap: audioWorld.chamberKind === 1 || audioWorld.chamberKind === 2 ? cav : cav * 0.4,
      rumble: deep,
      lava: deep,
      sand: wm.dust,
      syncedThunder: dyn,
      rain: w.rain,
      roofRain: w.roofRain,
      insects: isNight && rain < 0.2 && wm.snow < 0.2 && wm.wind < 0.6 && !audioWorld.inTown ? 1 : 0,
      // playtest 2 immersion pass: birdsong by day, a hawk over the heights, frogs and owls at night, by biome
      wild: wildlifeTargets({ biome: cave ? null : this.probe.biomeAt(feet.x, feet.z), hour, rain, snow: wm.snow, wind: wm.wind, inTown: audioWorld.inTown, underground: u }),
      water: localPlayer.mode === 'swim' ? 1 : 0,
      drips: u,
      weatherGain: w.gain,
      weatherLowpassHz: w.lowpassHz,
    });

    // Interior: small-room reverb indoors, the chamber reverb underground, a touch of damping.
    const im = interiorMix(shelter, sh.roomRadius, u, audioWorld.chamberRadius);
    if (im.reverb > 0.02) this.sfx.setChamberRadius(im.radius);
    this.sfx.setReverb(im.reverb);
    const t = this.ctx.currentTime;
    busEnvFilter('sfx')?.frequency.setTargetAtTime(im.busLowpassHz, t, 0.3);
    busEnvFilter('ambience')?.frequency.setTargetAtTime(im.busLowpassHz, t, 0.3);

    // Positional loops: fires near, burning grass, water.
    if (nowMs - this.lastWater > WATER_MS) {
      this.lastWater = nowMs;
      this.water = cave ? null : this.probe.waterNear(feet.x, feet.z);
    }
    const emitters: LoopEmitter[] = [...this.probe.firesNear(feet.x, feet.z, FIRE_SCAN_M), ...this.probe.chemistryFires(nightRuntime.view)];
    for (const src of loopSources)
      for (const e of src(feet.x, feet.z)) {
        if (Number.isNaN(e.space)) e.space = this.probe.spaceOf(e.x, e.y, e.z); // playtest 2: loot hums are muffled indoors and in caves like the fires
        emitters.push(e); // CR 025: camp campfires; playtest 2: loot hums
      }
    if (this.water) emitters.push(this.water);
    const L = this.sfx.listener;
    this.loops.update(selectLoops(emitters, { x: L.x, y: L.y, z: L.z, space, leak }, this.loops.playing));
    this.sfx.updateSpatial();
    this.hammering(nowMs, hour, cave);

    this.env = { roof: +roof.toFixed(2), indoors: +indoors.toFixed(2), building: sh.building, space, leak: +leak.toFixed(3), rain: +rain.toFixed(2), weatherGain: +w.gain.toFixed(2), weatherLowpassHz: Math.round(w.lowpassHz), roofRain: +w.roofRain.toFixed(2), reverb: +im.reverb.toFixed(2), busLowpassHz: Math.round(im.busLowpassHz), surface: this.surface, loops: this.loops.debug(), water: this.water?.kind ?? null, thunders: this.ambience.thunders, probe: this.probe.stats };
  }

  /** A smith at every forge nearby hammers in bursts by day (emitters.ts nextStrike). */
  private hammering(nowMs: number, hour: number, cave: boolean): void {
    if (cave || hour < 7 || hour >= 19) {
      this.hammers.clear();
      return;
    }
    const feet = localPlayer.pos;
    const seen = new Set<string>();
    for (const h of this.probe.forgesNear(feet.x, feet.z, HAMMER_M)) {
      if (Math.hypot(h.x - feet.x, h.z - feet.z) > HAMMER_M) continue;
      seen.add(h.id);
      let st = this.hammers.get(h.id);
      if (!st) this.hammers.set(h.id, (st = { next: nowMs + 400 + Math.random() * 2500, left: 0 }));
      // Due before the next pass: start it on time (sample-exact), not on the tick.
      if (st.next < nowMs + ENV_MS) {
        this.play('forge_hammer', { at: { x: h.x, y: h.y, z: h.z }, volume: 0.55, delay: Math.max(0, (st.next - nowMs) / 1000) });
        const n = nextStrike(st.left);
        st.left = n.left;
        st.next += n.delayS * 1000;
        if (st.next < nowMs) st.next = nowMs + n.delayS * 1000;
      }
    }
    for (const id of this.hammers.keys()) if (!seen.has(id)) this.hammers.delete(id);
  }

  /** Output level (RMS dBFS of the master), for the headless check. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let s = 0;
    for (const x of this.meterBuf) s += x * x;
    return 20 * Math.log10(Math.sqrt(s / this.meterBuf.length) + 1e-9);
  }

  debug() {
    return {
      ctxState: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      preloaded: this.preloaded,
      allLoaded: this.allLoaded,
      decodedMB: this.sfx.decodedMB,
      music: this.music.status(),
      director: this.director.state,
      inputs: this.lastInputs,
      levelDb: Math.round(this.level() * 10) / 10,
      voices: this.sfx.activeVoices,
      stolen: this.sfx.stolen,
      culled: this.sfx.culled,
      suppressed: this.sfx.suppressed,
      loopVoices: this.loops.count,
      env: this.env,
      played: Object.fromEntries(this.sfx.played),
      recent: this.sfx.log.slice(-30),
      world: { ...audioWorld },
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const u of this.unsubs) u();
    setTriggerSink(null);
    this.session?.eventListeners.delete(this.onEvent);
    this.music.dispose();
    this.ambience.dispose();
    this.loops.clear();
  }
}

let engine: AudioEngine | null = null;

/** Boot once the context exists (after the gesture); idempotent. */
export function bootAudio(): () => void {
  const off = onAudioReady((ctx) => {
    if (!engine) engine = new AudioEngine(ctx);
    installDebug();
  });
  return () => {
    off();
    engine?.dispose();
    engine = null;
  };
}

export function audioEngine(): AudioEngine | null {
  return engine;
}

function installDebug(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __lodestoneAudio?: unknown }).__lodestoneAudio = {
    state: () => engine?.debug() ?? { ctxState: getAudioContext()?.state ?? 'none' },
    play: (cue: CueId, at?: Vec3) => engine?.play(cue, at ? { at } : undefined),
    trigger: (name: TriggerName, payload: TriggerPayload = {}) => engine?.trigger(name, payload),
    /** Run a zone Event through the trigger map, as if the zone sent it (data: bytes or a JSON value). */
    zoneEvent: (kind: number, f: { entityId?: number; targetId?: number; value?: number; x?: number; y?: number; z?: number; json?: unknown } = {}) => {
      if (!engine) return;
      const data = f.json === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(f.json));
      runZoneEvent({ type: 'Event', kind, entityId: f.entityId ?? 0, targetId: f.targetId ?? 0, value: f.value ?? 0, x: f.x ?? 0, y: f.y ?? 0, z: f.z ?? 0, data }, engine.api);
    },
    /** Force music inputs (e.g. {hour: 22} or {underground: 1}); null follows the world again. */
    force: (p: Partial<MusicInputs> | null) => {
      if (engine) engine.forced = p;
    },
    level: () => engine?.level() ?? -200,
    /** The environment pass: shelter, cave leak, rain, surface, loop voices. */
    env: () => engine?.env ?? null,
    /** Force rain on/off for the ambience (null follows the weather). */
    forceRain: (r: boolean | null) => {
      if (engine) engine.forcedRain = r;
    },
    /** A thunder rumble from a strike this far away (m). */
    thunder: (m = 1500) => engine?.ambience.thunder(m),
    /** Are these cues decoded (headless checks wait on it)? */
    loaded: (cues: CueId[]) => !!engine && cues.every((c) => engine!.sfx.isLoaded(c)),
    /** Decode these cues now. */
    preload: (cues: CueId[]) => engine && Promise.all(cues.map((c) => engine!.sfx.preload(c))).then(() => true),
    /** The engine itself (console poking). */
    engine: () => engine,
  };
}
