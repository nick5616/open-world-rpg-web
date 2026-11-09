// The one AudioContext (spec 3/10: the-circle's "one AudioContext" rule) and
// its mixer buses. Deliberately tiny and dependency-free: it is in the main
// bundle so the very first user gesture (the title screen's Play click, or
// Enter) can create and resume the context synchronously, as browsers'
// autoplay rules require. Everything that actually makes sound (the engine,
// the music director, the cue table) loads later, after the first playable
// frame (spec 12), and plugs into these buses.
//
//   music ─┐
//   sfx ───┤  each: duck gain -> volume gain ─> master -> limiter -> destination
//   ambience┤
//   ui ────┤
//   voice ─┘  (WP11's VoiceMixer output)

import { BUSES, useAudioSettings, type BusName } from './settings';

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  /** Bus inputs (the duck stage); connect sources here. */
  input: Record<Exclude<BusName, 'master'>, GainNode>;
  /** The user volume stage of each bus. */
  volume: Record<BusName, GainNode>;
}

let graph: Graph | null = null;
const readyListeners = new Set<(g: Graph) => void>();

/** Perceptual slider -> gain (a squared curve: half the slider is about -12 dB). */
export function sliderToGain(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c * c;
}

function build(ctx: AudioContext): Graph {
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  // A gentle safety limiter: many overlapping one-shots never clip.
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  master.connect(limiter).connect(ctx.destination);
  const volume = { master } as Record<BusName, GainNode>;
  const input = {} as Graph['input'];
  for (const b of BUSES) {
    if (b === 'master') continue;
    const duck = ctx.createGain();
    const vol = ctx.createGain();
    duck.connect(vol).connect(master);
    input[b] = duck;
    volume[b] = vol;
  }
  return { ctx, master, limiter, input, volume };
}

function applySettings(): void {
  if (!graph) return;
  const s = useAudioSettings.getState();
  const t = graph.ctx.currentTime;
  for (const b of BUSES) {
    const g = b === 'master' ? (s.muted ? 0 : sliderToGain(s.volumes.master)) : sliderToGain(s.volumes[b]);
    graph.volume[b].gain.setTargetAtTime(g, t, 0.03);
  }
}

/**
 * Create (first call) and resume the context. Call from a user gesture; a
 * browser without Web Audio, or one that refuses, leaves the game silent,
 * never broken (wizard-wars AudioManager's rule).
 */
export function unlockAudio(): AudioContext | null {
  if (!graph) {
    const Ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      graph = build(new Ctor({ latencyHint: 'interactive' }));
    } catch {
      graph = null;
      return null;
    }
    applySettings();
    for (const l of readyListeners) l(graph);
  }
  if (graph.ctx.state === 'suspended') graph.ctx.resume().catch(() => {});
  return graph.ctx;
}

/** The context if a gesture already created it (never creates one). */
export function getAudioContext(): AudioContext | null {
  return graph?.ctx ?? null;
}

/** A bus input to connect sources to (null before the first gesture). */
export function busInput(bus: Exclude<BusName, 'master'>): GainNode | null {
  return graph?.input[bus] ?? null;
}

/** The master gain (analysers and tests tap here). */
export function masterNode(): GainNode | null {
  return graph?.master ?? null;
}

/** Run once the context exists (now, if it already does). */
export function onAudioReady(fn: (ctx: AudioContext) => void): () => void {
  const l = (g: Graph) => fn(g.ctx);
  if (graph) l(graph);
  else readyListeners.add(l);
  return () => readyListeners.delete(l);
}

let installed = false;

/**
 * Listen for the first user gestures on the whole page (capture phase, so a
 * click on Play counts even though the button handles it). Keeps listening
 * until the context is actually running: some browsers need a second
 * gesture after a tab switch.
 */
export function installAudioUnlock(target: Window = window): void {
  if (installed) return;
  installed = true;
  const events = ['pointerdown', 'keydown', 'touchend', 'click'] as const;
  let watching = false;
  const onGesture = () => {
    const ctx = unlockAudio();
    if (!ctx || ctx.state === 'running') {
      for (const e of events) target.removeEventListener(e, onGesture, true);
      // Re-arm on suspension (a tab switch on iOS, a device change).
      if (ctx && !watching) {
        watching = true;
        ctx.addEventListener('statechange', () => {
          if (ctx.state !== 'running' && ctx.state !== 'closed') for (const e of events) target.addEventListener(e, onGesture, true);
        });
      }
    }
  };
  for (const e of events) target.addEventListener(e, onGesture, true);
  useAudioSettings.subscribe(applySettings);
}

/** Tests only: drop the graph. */
export function resetAudioForTests(): void {
  graph = null;
  installed = false;
  readyListeners.clear();
}
