// Playtest 2 dash overhaul (CR 021): what a dash looks like while it runs,
// per element, on top of the WP13 dash trail (recipes.ts dashTrail). The
// engine's dash() keeps a dash's Ongoing alive while its caster moves at
// dash speed (held dashes last as long as the key; other players' too, read
// from their drawn speed) and calls dashFxStep every frame with the segment
// the caster covered.
//
//   fire     a jet: flame tongues blasted back along the velocity, smoke
//   ice      frost on the path and ice spikes along it (the frozen path)
//   lightning a bolt and a flash at every blink, scorch "shock marks"
//   earth    rock spikes bursting up along the path
//   wind     swirling gusts and streaks
//   light    golden motes and a fading ring of light on the ground (the heal trail)
//   dark     blood mist; void: violet wisps and phase flickers
//
// Everything goes through the pooled primitives (no allocation per frame:
// hoisted options), scaled by the engine's distance LOD and FX tier.

import type * as THREE from 'three';
import { fxTime, rand } from './core';
import { SHAPE_PUFF, SHAPE_SPARK, SHAPE_STAR } from './particles';
import * as R from './recipes';
import type { FxPrims } from './transients';
import type { SpellVisual } from './spellVisual';

type V3 = { x: number; y: number; z: number };
type BurstOpts = NonNullable<Parameters<typeof R.burst>[5]>;

/** A dash counts as running (its FX stay up) while its caster moves at least this fast (m/s). */
export const DASH_FX_MIN_SPEED = 14;
/** The longest a dash's FX are kept alive (a held flight). */
export const DASH_FX_MAX_S = 12;

export interface DashFxState {
  lastMark: number;
  lastSpike: number;
  dir: V3;
}

export function newDashFxState(): DashFxState {
  return { lastMark: 0, lastSpike: 0, dir: { x: 0, y: 0, z: 0 } };
}

const FLAME: BurstOpts = { speed: [6, 14], life: [0.18, 0.4], size: [0.25, 0.5], bias: 0.85, drag: 3 };
const SMOKE: BurstOpts = { speed: [0.5, 2], life: [0.8, 1.4], size: [0.8, 1.4], shape: SHAPE_PUFF, drag: 1.5 };
const FROST: BurstOpts = { life: [0.6, 1.1], size: [0.06, 0.12], shape: SHAPE_STAR, speed: [0, 0.6] };
const SPARKS: BurstOpts = { life: [0.12, 0.3], size: [0.03, 0.06], shape: SHAPE_SPARK, speed: [2, 7], gravity: -6 };
const DUST: BurstOpts = { life: [0.6, 1.1], size: [0.6, 1.1], shape: SHAPE_PUFF, speed: [0.5, 2], drag: 2, up: 0.6 };
const GUST: BurstOpts = { life: [0.25, 0.5], size: [0.05, 0.09], shape: SHAPE_SPARK, speed: [1, 3], drag: 2 };
const MOTES: BurstOpts = { life: [0.8, 1.4], size: [0.05, 0.1], speed: [0, 0.5], gravity: -0.6 };
const MIST: BurstOpts = { life: [0.6, 1.0], size: [0.5, 0.9], shape: SHAPE_PUFF, speed: [0, 0.6], drag: 1 };
const WISP: BurstOpts = { life: [0.4, 0.8], size: [0.08, 0.16], speed: [0.2, 1.2], drag: 2 };
const BLINK_BOLT = { width: 0.07, duration: 0.18, forks: 2, segs: 8, jitter: 0.5 };

/** One frame of a running dash: the caster went from a to b (feet) at `speed` m/s. */
export function dashFxStep(fx: FxPrims, v: SpellVisual, a: V3, b: V3, speed: number, st: DashFxState): void {
  const c = R.cols(v.palette);
  const t = fxTime();
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  st.dir.x = -dx / len;
  st.dir.y = -dy / len;
  st.dir.z = -dz / len;
  const fast = Math.min(1, speed / 30);
  const cy = b.y + 0.9;
  switch (v.family) {
    case 'fire':
      // The jet: flame blasted back along the velocity from the feet and hands, smoke behind.
      FLAME.dir = st.dir;
      R.burst(b.x, b.y + 0.4, b.z, c.k('hmd') as THREE.Color[], 10 * fast + 3, FLAME);
      R.burst(b.x, cy, b.z, c.k('hm') as THREE.Color[], 4 * fast, FLAME);
      if (Math.random() < 0.5) R.burst(a.x, a.y + 0.5, a.z, c.k('s') as THREE.Color[], 1, SMOKE);
      break;
    case 'ice':
    case 'crystal':
      R.lineEmit({ x: a.x, y: a.y + 0.05, z: a.z }, { x: b.x, y: b.y + 0.05, z: b.z }, c.k('ha') as THREE.Color[], 6, FROST);
      if (t - st.lastSpike > 0.22) {
        st.lastSpike = t;
        fx.spikeRing(v.spike, b.x, b.z, fx.heightAt(b.x, b.z, b.y), 0.9, 3, 0.6, { hold: 0.9 });
        fx.ring(b.x, b.y + 0.05, b.z, c.main, { radius: 1.4, duration: 0.6, width: 0.06 });
      }
      break;
    case 'lightning':
      // Chained blinks: a step longer than 1.2 m is a teleport pulse.
      if (len > 1.2) {
        fx.bolt(a.x, a.y + 0.9, a.z, b.x, cy, b.z, c.main, BLINK_BOLT);
        fx.flash(b.x, cy, b.z, c.mainH, { size: 1.6, duration: 0.12 });
        R.burst(b.x, cy, b.z, c.k('hm') as THREE.Color[], 10, SPARKS);
        if (t - st.lastMark > 0.08) {
          st.lastMark = t;
          fx.scorch(a.x, fx.heightAt(a.x, a.z, a.y), a.z, 0.7, 4, 0.6); // a shock mark where you left
        }
      }
      break;
    case 'nature':
    case 'stone':
      if (t - st.lastSpike > 0.16) {
        st.lastSpike = t;
        fx.spikeRing('stone', b.x, b.z, fx.heightAt(b.x, b.z, b.y), 1.1, 4, 1.1, { hold: 0.35 });
        R.burst(b.x, b.y + 0.2, b.z, R.cols(v.palette).k('s') as THREE.Color[], 2, DUST);
      }
      break;
    case 'wind':
      R.ringBurst(b.x, b.y + 0.3, b.z, 0.7, c.k('hm') as THREE.Color[], 6 * fast + 2, 3, GUST);
      if (Math.random() < 0.3) R.burst(a.x, a.y + 0.6, a.z, c.k('s') as THREE.Color[], 1, SMOKE);
      break;
    case 'light':
      R.lineEmit({ x: a.x, y: a.y + 0.3, z: a.z }, { x: b.x, y: b.y + 0.3, z: b.z }, c.k('hm') as THREE.Color[], 5, MOTES);
      if (t - st.lastMark > 0.3) {
        st.lastMark = t;
        fx.ring(b.x, fx.heightAt(b.x, b.z, b.y) + 0.05, b.z, c.mainH, { radius: 2.2, duration: 1.2, width: 0.1 });
      }
      break;
    case 'dark':
    case 'blood':
      R.lineEmit({ x: a.x, y: a.y + 0.8, z: a.z }, { x: b.x, y: b.y + 0.8, z: b.z }, c.k('ma') as THREE.Color[], 1.5, MIST);
      break;
    case 'void':
      R.lineEmit({ x: a.x, y: a.y + 0.9, z: a.z }, { x: b.x, y: b.y + 0.9, z: b.z }, c.k('ma') as THREE.Color[], 4, WISP);
      if (Math.random() < 0.15) fx.flash(b.x, cy, b.z, c.main, { size: rand(1, 1.6), duration: 0.08 });
      break;
  }
}

/** Event 230: a flight dived into the ground. */
export function dashSlam(fx: FxPrims, v: SpellVisual, x: number, y: number, z: number, radius: number, cam: THREE.Vector3 | null): void {
  R.explosion(fx, v, x, y + 0.3, z, radius, cam);
  fx.spikeRing(v.spike, x, z, y, radius * 0.6, 8, 1.2, { hold: 0.5 });
  fx.ring(x, y + 0.05, z, R.cols(v.palette).main, { radius: radius * 1.3, duration: 0.5, width: 0.12 });
}
