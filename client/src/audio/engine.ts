// The audio engine: owns the SFX player, the music director and player, the
// ambience beds, and wires them to the game. Loaded as a lazy chunk by
// AudioRoot after the first playable frame (spec 12: nothing audio is in
// the first-frame download), into the context and buses context.ts made on
// the first user gesture.
//
// Per animation frame it moves the listener with the camera and turns the
// local player's movement into steps and splashes; four times a second it
// samples the world for the music director and the ambience. Zone Events
// arrive through session.eventListeners and go through the trigger map.

import { DAY_LENGTH_S, DEFENSE_WARNING_S, type Event as ZoneEvent } from '@lodestone/contracts';
import { localPlayer, worldClock } from '../state/live';
import { netRuntime } from '../net/netStore';
import { useCombatHud } from '../combat/store';
import { useNightHud } from '../systems/night';
import { useVoiceStore } from '../voice/store';
import { voiceLevels } from '../voice/levels';
import { worldDebug } from '../world/debug/worldDebug';
import { useExploration } from '../ui/map/store';
import { useInventory } from '../ui/inventory/store';
import { useSocialStore } from '../social/store';
import { useAudioSettings } from './settings';
import { busInput, getAudioContext, masterNode, onAudioReady } from './context';
import { audioWorld, setTriggerSink, type Vec3 } from './bridge';
import { SfxEngine, type PlayOpts } from './sfx';
import { CUES, type CueId } from './cues';
import { Ambience } from './ambience';
import { MovementSounds } from './movement';
import { MusicDirector, type MusicInputs, type TimedInput } from './music/director';
import { MusicPlayer } from './music/player';
import { runTrigger, runZoneEvent, type TriggerApi, type TriggerName, type TriggerPayload } from './triggers';

const EYE = 1.6;
const HOUR_S = DAY_LENGTH_S / 24;
/** Cues decoded right after boot (the ones that must answer instantly). */
const PRELOAD: CueId[] = ['ui_click', 'ui_confirm', 'ui_open', 'ui_close', 'ui_error', 'map_open', 'map_close', 'step_soft', 'step_hard', 'jump', 'land', 'swing_sword', 'swing_heavy', 'thrust_spear', 'bow_draw', 'bow_release', 'bolt', 'hit', 'hit_crit', 'arrow_hit', 'player_hurt', 'mine_stone', 'mine_gem', 'vein_break', 'loot_common', 'telegraph', 'splash', 'glide_open', 'climb_grab', 'cast_fire', 'cast_ice', 'impact_fire', 'impact_ice'];

export class AudioEngine {
  readonly sfx: SfxEngine;
  readonly music: MusicPlayer;
  readonly director = new MusicDirector();
  readonly ambience: Ambience;
  private movement = new MovementSounds();
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
      for (const [name, payload] of this.movement.update({ mode: localPlayer.mode, grounded: localPlayer.grounded, pos: localPlayer.pos, vel: localPlayer.vel, airJumps: localPlayer.airJumps, underground: audioWorld.underground, inTown: audioWorld.inTown }, dt)) this.trigger(name, payload);
    }
    this.ambience.tick(t);
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
    const night = useNightHud.getState();
    const hud = useCombatHud.getState();
    const hour = worldClock.timeOfDayS / HOUR_S;
    const inputs: MusicInputs = {
      playing: worldDebug.firstPlayableMs !== null,
      hour,
      underground: audioWorld.underground,
      inTown: audioWorld.inTown,
      combat: audioWorld.combatUntil > nowMs || !!hud.boss,
      voidMoment: this.voidUntil > nowMs,
      timed: this.timed(nowMs),
      ...this.forced,
    };
    this.lastInputs = inputs;
    const decision = this.director.update(inputs, nowMs / 1000);
    this.director.introSeconds = this.music.introSeconds;
    this.music.apply(decision);

    // Ducking: voices first (spec 10: voice keeps priority), then big stings.
    const t = this.ctx.currentTime;
    const speaking = this.anyoneSpeaking();
    const musicDuck = speaking ? 0.35 : this.stingDuckUntil > nowMs ? 0.5 : 1;
    busInput('music')?.gain.setTargetAtTime(musicDuck, t, musicDuck < 1 ? 0.08 : 0.6);
    busInput('ambience')?.gain.setTargetAtTime(speaking ? 0.6 : 1, t, 0.3);
    busInput('sfx')?.gain.setTargetAtTime(speaking ? 0.8 : 1, t, 0.3);

    // Cave reverb follows the cave state CaveManager writes.
    this.sfx.setChamberRadius(audioWorld.chamberRadius);
    this.sfx.setReverb(audioWorld.underground);

    // Ambience targets.
    const surface = 1 - audioWorld.underground;
    const raining = night.online ? night.raining : localPlayer.raining;
    const v = localPlayer.vel;
    const speed = Math.hypot(v.x, v.y, v.z);
    const gliding = localPlayer.mode === 'glide' || (localPlayer.mode === 'air' && v.y < -8);
    const altitude = Math.min(1, Math.max(0, (localPlayer.pos.y - 60) / 160));
    const isNight = hour >= 18.5 || hour < 6;
    this.ambience.setTargets({
      wind: surface * Math.min(1, 0.18 + altitude * 0.4 + (raining ? 0.2 : 0) + (gliding ? Math.min(0.6, speed / 30) : 0)),
      windSpeed: gliding ? Math.min(1, speed / 25) : altitude * 0.4,
      rain: raining ? surface * (audioWorld.inTown ? 0.8 : 1) : 0,
      fire: surface * Math.min(1, night.burning / 30),
      insects: isNight && !raining && !audioWorld.inTown ? surface : 0,
      water: localPlayer.mode === 'swim' ? 1 : 0,
      drips: audioWorld.underground,
    });
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
    /** Are these cues decoded (headless checks wait on it)? */
    loaded: (cues: CueId[]) => !!engine && cues.every((c) => engine!.sfx.isLoaded(c)),
    /** Decode these cues now. */
    preload: (cues: CueId[]) => engine && Promise.all(cues.map((c) => engine!.sfx.preload(c))).then(() => true),
    /** The engine itself (console poking). */
    engine: () => engine,
  };
}
