// Playtest 2 dash overhaul (CR 021): how a dash FEELS for the one dashing.
// Driven once a frame from the spell FX layer's useFrame (dashFeelTick):
//
//  - FOV kick: the camera widens with your speed while a dash runs (up to
//    +16 degrees at jet speed) and eases back when it ends;
//  - speed lines: a radial streak overlay over the canvas, opacity by speed
//    (pure CSS, one element, no per-frame allocation);
//  - camera shake on the high and ultra FX tiers (a couple of pixels of the
//    post chain's UV shake: fx/screen.ts), none with reduced motion;
//  - a sustained whoosh: the dash cue every 0.3 s while the dash is held.
//
// Plus Event 230 (a flight dived into the ground): the slam burst at the
// landing point and a hard shake (dashSlamEvent, called from link.ts).

import type * as THREE from 'three';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { localPlayer } from '../state/live';
import { emitSound } from '../audio/bridge';
import { dashLive } from './dashes';
import { spellFxEngine } from './fx/api';
import { currentFxTier } from './fx/quality';
import { screenShake } from './fx/screen';
import { dashSlam } from './fx/dashFx';
import { mobilitySpellForDash, spellVisual } from './fx/spellVisual';

/** Dash speed (m/s) where the kick starts and where it is full. */
const KICK_FROM = 13;
const KICK_FULL = 38;
/** The widest the FOV gets (degrees on top of the base). */
const FOV_KICK = 16;

const feel = { kick: 0, base: 0, applied: 0, nextWhoosh: 0 };
let lines: HTMLDivElement | null = null;

function speedLines(): HTMLDivElement | null {
  if (lines || typeof document === 'undefined') return lines;
  const el = document.createElement('div');
  el.dataset.testid = 'dash-speed-lines';
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'z-index:5',
    'opacity:0',
    'mix-blend-mode:screen',
    // thin bright rays from the centre, masked so the middle of the view stays clear
    'background:repeating-conic-gradient(from 0deg at 50% 50%, rgba(255,255,255,0.0) 0deg 2.2deg, rgba(255,255,255,0.55) 2.4deg 2.6deg, rgba(255,255,255,0.0) 2.8deg 5.3deg)',
    '-webkit-mask-image:radial-gradient(circle at 50% 50%, transparent 0 32%, black 70%)',
    'mask-image:radial-gradient(circle at 50% 50%, transparent 0 32%, black 70%)',
  ].join(';');
  document.body.appendChild(el);
  lines = el;
  return el;
}

/** The current kick (0..1) for tests and the debug HUD. */
export function dashKick(): number {
  return feel.kick;
}

/** Target kick for a speed while a dash (or its carry) runs. */
export function kickFor(speed: number, dashing: boolean): number {
  if (!dashing && speed < KICK_FULL * 0.6) return 0;
  return Math.max(0, Math.min(1, (speed - KICK_FROM) / (KICK_FULL - KICK_FROM)));
}

export function dashFeelTick(camera: THREE.Camera, dt: number): void {
  const cam = camera as THREE.PerspectiveCamera;
  if (cam.isPerspectiveCamera === undefined) return;
  const v = localPlayer.vel;
  const speed = Math.hypot(v.x, v.y, v.z);
  const want = kickFor(speed, localPlayer.dash > 0);
  // Fast in, slower out.
  const k = want > feel.kick ? 1 - Math.exp(-dt * 14) : 1 - Math.exp(-dt * 4);
  feel.kick += (want - feel.kick) * k;
  if (feel.kick < 1e-3) feel.kick = 0;
  // FOV: remember whatever base the game set while we are not kicking.
  if (feel.applied === 0) feel.base = cam.fov;
  const fov = feel.base + FOV_KICK * feel.kick;
  if (Math.abs(fov - cam.fov) > 1e-3) {
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }
  feel.applied = feel.kick > 0 ? FOV_KICK * feel.kick : 0;
  const el = speedLines();
  if (el) el.style.opacity = (Math.min(1, feel.kick * 1.2) * 0.75).toFixed(3);
  const tier = currentFxTier();
  if (feel.kick > 0.25 && (tier === 'high' || tier === 'ultra')) screenShake(0.15 * feel.kick);
  if (dashLive.held && performance.now() >= feel.nextWhoosh) {
    feel.nextWhoosh = performance.now() + 300;
    const sp = mobilitySpellForDash(dashLive.variant);
    emitSound('dash_sustain', { element: sp?.tree });
  }
}

/** Event 230: a flight dived into the ground (the zone already dealt the damage). */
export function dashSlamEvent(ev: ZoneEvent): void {
  const eng = spellFxEngine();
  const x = ev.x / 100;
  const y = ev.y / 100;
  const z = ev.z / 100;
  const radius = Math.max(1, ev.value / 100);
  const sp = mobilitySpellForDash(Number(ev.targetId));
  if (eng && sp) dashSlam(eng.prims, spellVisual(sp), x, y, z, radius, null);
  const d = Math.hypot(localPlayer.pos.x - x, localPlayer.pos.z - z);
  screenShake(Math.max(0, 0.9 * (1 - d / 40)));
}
