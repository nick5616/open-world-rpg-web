// First-person camera + local movement. Per rendered frame: apply mouse look,
// sample held keys, let LocalSim run its fixed 60 Hz steps, then place the
// camera at the interpolated eye position. Writes the live HUD values.
// Playtest 2: or behind the shoulder (third person, scene/thirdPerson.ts),
// with the same look (the raw mouse path is untouched) and a converged aim.
//
// adapted from wizard-wars client/src/components/core/CameraController.tsx
// (look, fixed-step loop, jump-edge latch, reconciliation easing). Offline it
// is the whole story; online (WP06) a PlayerDriver from client/src/net feeds
// each step to the zone connection and hands back server corrections.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PLAYER_HEIGHT, RIDE_EYE_RAISE_M } from '@lodestone/contracts';
import { useKeyboard } from '../input/useKeyboard';
import { useMouseLook } from '../input/useMouseLook';
import { LocalSim, type StepRecord } from '../sim/localSim';
import { NO_BUTTONS } from '../sim/inputFrame';
import { FINE, MoveFlag, type MoveState, type StepEnv, type Vec3 } from '../sim/movement';
import { offlineEnv } from '../sim/stepEnv';
import { useAppStore } from '../stores/appStore';
import { useDebugStore } from '../stores/debugStore';
import { localPlayer, view, type MoveMode } from '../state/live';
import { useGround } from './groundContext';
import { useViewStore } from '../stores/viewStore';
import { lookRouter } from '../input/lookRouter';
import { drawnRemotes } from '../net/netStore';
import { enemyInfo } from '../combat/events';
import { aimFromEye, Boom, CameraProbe, crosshairDistance, forwardOf, THIRD, type AimSphere, type Vec3 as V3 } from './thirdPerson';

/** HUD names for the WP10 modes carried in MoveState.mode (ground/air are refined below). */
const MODE_NAMES: Record<number, MoveMode | undefined> = { 2: 'climb', 3: 'glide', 4: 'swim' };

const MOUSE_SENSITIVITY = 0.002; // rad per pixel (wizard-wars value)
const PITCH_LIMIT = Math.PI / 2 - 0.01;
/** World center: the v1 world spans [0, 4096) on x and z (contracts WORLD_SIZE_M). */
export const SPAWN = { x: 2048, z: 2048 };

// Reconciliation corrections replace the simulated state at once (so the
// simulation never drifts) while the drawn camera eases from where it was over
// this time constant via a decaying offset: a correction never shows as a snap
// and tiny ones are invisible. Beyond the snap distance (server teleport,
// respawn) skip the easing. Values from wizard-wars CameraController.
const CORRECTION_SMOOTH_TAU = 0.09; // s
const CORRECTION_SNAP_DIST = 3; // m
/** CR 027: the third-person boom grows this much in the saddle (the steed fills the old view). */
const RIDE_BOOM_EXTRA_M = 1.6;

/** What the networked play screen plugs in (client/src/net/usePlayerDriver). */
export interface PlayerDriver {
  /** Where the server put us (Welcome). */
  spawn: Vec3;
  /** Online: fly and teleport are client-only debug tools, refused here. */
  online: boolean;
  onStep(r: StepRecord): void;
  /** Called once per rendered frame after the steps ran (sends input). */
  afterFrame(): void;
  /** Newest server correction since the last frame, or null. */
  takeCorrection(): { state: MoveState; error: Vec3; magnitude: number } | null;
  /** WP10: world inputs per step (rain at the synced world time, updrafts). Offline uses offlineEnv. */
  env?(): Readonly<StepEnv>;
  /** WP13 combat: per-step combat bits (client/src/combat/link.ts), after-step hook, and input block while downed. */
  combatHook?(seq: number, before: Readonly<MoveState>, sprinting: boolean): { flags: number; castSlot: number; aim?: { yaw: number; pitch: number } | null };
  afterStep?(seq: number, state: Readonly<MoveState>): void;
  blockInput?(): boolean;
}

interface Props {
  onStep?: (r: StepRecord) => void;
  driver?: PlayerDriver;
}

export function PlayerController({ onStep, driver }: Props) {
  const camera = useThree((s) => s.camera);
  const ground = useGround();
  const held = useKeyboard();
  const consumeLook = useMouseLook();
  // Created once; later ground swaps go through setGround so the player keeps their state.
  const [sim] = useState(() => {
    const p = { ...(driver?.spawn ?? { x: SPAWN.x, y: ground.heightAt(SPAWN.x, SPAWN.z), z: SPAWN.z }) };
    // WP10: Welcome's y is cm-rounded while the zone stands exactly on the
    // ground; start on the identical surface, or the first step is a tiny
    // fall and (on a slope, where it turns into a slide) costs corrections.
    const gy = ground.heightAt(p.x, p.z);
    if (Math.abs(gy - p.y) < 0.01) p.y = gy;
    return new LocalSim(ground, p);
  });
  const look = useRef({ yaw: 0, pitch: 0 });
  const offset = useRef({ x: 0, y: 0, z: 0 });
  const warned = useRef(false);
  const ride = useMemo(() => ({ k: 0 }), []); // CR 027: 0 on foot .. 1 in the saddle, eased
  const euler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), []);
  const render = useMemo(() => ({ x: 0, y: 0, z: 0 }), []);
  // Playtest 2 third person: the boom, its collision probe and the aim scratch (no per-frame allocations).
  const { boom, probe, fwd, aimSpheres, aimPool, aimAt, aimEye, aim } = useMemo(
    () => ({
      boom: new Boom(),
      probe: new CameraProbe(),
      fwd: { x: 0, y: 0, z: -1 } as V3,
      aimSpheres: [] as AimSphere[],
      aimPool: [] as AimSphere[],
      aimAt: { x: 0, y: 0, z: 0 } as V3,
      aimEye: { x: 0, y: 0, z: 0 } as V3,
      aim: { yaw: 0, pitch: 0 },
    }),
    [],
  );

  useEffect(() => sim.setGround(ground), [sim, ground]);
  useEffect(() => {
    sim.envSource = driver?.env ? () => driver.env!() : offlineEnv;
    sim.combatHook = driver?.combatHook ? (seq, before, sprinting) => driver.combatHook!(seq, before, sprinting) : null; // WP13
    sim.afterStep = driver?.afterStep ? (seq, st) => driver.afterStep!(seq, st) : null;
  }, [sim, driver]);
  useEffect(() => {
    sim.onStep = (r) => {
      onStep?.(r);
      driver?.onStep(r);
    };
  }, [sim, onStep, driver]);

  useFrame((_, delta) => {
    const dbg = useDebugStore.getState();
    const app = useAppStore.getState();
    const online = !!driver?.online;

    const tp = dbg.takeTeleport();
    if (tp) {
      if (online) {
        // Teleport would desync from the authoritative zone (the server
        // would reconcile us straight back); refuse it until a server-side
        // admin command exists.
        if (!warned.current) console.warn('[lodestone] teleport is disabled while connected to a zone');
        warned.current = true;
      } else sim.teleport(tp);
    }
    const fly = dbg.fly && !online;

    const corr = driver?.takeCorrection();
    if (corr) {
      const o = offset.current;
      if (corr.magnitude > CORRECTION_SNAP_DIST) {
        o.x = o.y = o.z = 0;
        boom.reset(); // a respawn or server teleport: the third-person camera snaps too
      } else {
        o.x += corr.error.x;
        o.y += corr.error.y;
        o.z += corr.error.z;
      }
      sim.rebase(corr.state);
    }

    // Look: mouse while locked, or a scripted override (headless has no lock).
    const lk = look.current;
    if (dbg.lookOverride) {
      lk.yaw = dbg.lookOverride.yaw;
      lk.pitch = dbg.lookOverride.pitch;
    } else {
      const d = consumeLook();
      // Playtest 2: the emote wheel or photo mode may borrow the mouse (input/lookRouter.ts).
      if (lookRouter.sink) {
        lookRouter.sink(d.x, d.y);
        d.x = d.y = 0;
      }
      lk.yaw -= d.x * MOUSE_SENSITIVITY;
      lk.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, lk.pitch - d.y * MOUSE_SENSITIVITY));
    }
    // Keep yaw bounded so float precision never degrades over a long session.
    lk.yaw = Math.atan2(Math.sin(lk.yaw), Math.cos(lk.yaw));

    // The debug panel takes the keyboard; the player stands still meanwhile.
    const buttons = app.debugPanelOpen || driver?.blockInput?.() || lookRouter.blockMove ? NO_BUTTONS : held.current; // WP13: no moving while downed; playtest 2: photo mode
    sim.frame(delta, { held: buttons, yaw: lk.yaw, pitch: lk.pitch, fly }, render);
    driver?.afterFrame();

    const o = offset.current;
    const decay = Math.exp(-Math.min(delta, 0.25) / CORRECTION_SMOOTH_TAU);
    o.x *= decay;
    o.y *= decay;
    o.z *= decay;
    // Playtest 2: the drawn eye; first person the camera sits there, third
    // person it hangs on a collision-checked boom behind the shoulder.
    const vw = view;
    vw.feet.x = render.x + o.x;
    vw.feet.y = render.y + o.y;
    vw.feet.z = render.z + o.z;
    // CR 027: in the saddle the eye rides higher and the third-person boom
    // pulls back (eased, so mounting and getting off glide).
    const mountedNow = !fly && (sim.state.flags & MoveFlag.mounted) !== 0;
    ride.k += ((mountedNow ? 1 : 0) - ride.k) * (1 - Math.exp(-Math.min(delta, 0.25) / 0.18));
    if (Math.abs(ride.k - (mountedNow ? 1 : 0)) < 1e-3) ride.k = mountedNow ? 1 : 0;
    vw.eye.x = vw.feet.x;
    vw.eye.y = vw.feet.y + PLAYER_HEIGHT + RIDE_EYE_RAISE_M * ride.k;
    vw.eye.z = vw.feet.z;
    const vs = useViewStore.getState();
    const third = vs.mode === 'third' && !fly;
    if (third !== vw.third || tp) boom.reset();
    vw.third = third;
    if (third || ride.k > 0.01) {
      let c: V3;
      if (third) {
        probe.setLevel(ground, vw.feet.y);
        c = boom.update(vw.eye, lk.yaw, lk.pitch, vs.shoulder, vs.distance + RIDE_BOOM_EXTRA_M * ride.k, probe.blocked, delta);
        vw.boom = boom.dist;
        // with a little hysteresis, so a boom hovering at the limit doesn't flicker
        vw.hideBody = boom.dist < THIRD.hideAvatarBelow + (vw.hideBody && vw.third ? 0.15 : 0);
      } else {
        // First person in the saddle: the camera is above the combat eye, so the aim converges too.
        c = vw.eye;
        vw.boom = 0;
        vw.hideBody = true;
        probe.setLevel(ground, vw.feet.y);
      }
      camera.position.set(c.x, c.y, c.z);
      // Converge the combat aim on what the crosshair (the camera ray) is on.
      forwardOf(lk.yaw, lk.pitch, fwd);
      aimSpheres.length = 0;
      for (const e of drawnRemotes.views) {
        if (e.kind !== 2 || e.healthPct <= 0) continue;
        const info = enemyInfo(e);
        if (aimSpheres.length >= aimPool.length) aimPool.push({ x: 0, y: 0, z: 0, r: 0 });
        const s = aimPool[aimSpheres.length];
        s.x = e.x;
        s.y = e.y + info.height;
        s.z = e.z;
        s.r = info.radius + info.height * 0.5;
        aimSpheres.push(s);
      }
      const t = crosshairDistance(c, fwd, (third ? boom.dist : 0) + 0.6, THIRD.aimRange, probe.heightAt, aimSpheres);
      aimAt.x = c.x + fwd.x * t;
      aimAt.y = c.y + fwd.y * t;
      aimAt.z = c.z + fwd.z * t;
      // the combat code shoots from 1.6 m (combat/runtime.ts EYE)
      aimEye.x = vw.feet.x;
      aimEye.y = vw.feet.y + 1.6;
      aimEye.z = vw.feet.z;
      aimFromEye(aimEye, aimAt, lk.yaw, lk.pitch, aim);
    } else {
      camera.position.set(vw.eye.x, vw.eye.y, vw.eye.z);
      vw.boom = 0;
      vw.hideBody = true;
      aim.yaw = lk.yaw;
      aim.pitch = lk.pitch;
    }
    euler.set(lk.pitch, lk.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(euler);

    const s = sim.state;
    const grounded = !fly && sim.grounded();
    const hs = Math.hypot(s.vel.x, s.vel.z);
    const special = MODE_NAMES[s.mode];
    const mode: MoveMode = fly
      ? 'fly'
      : special
        ? special
        : !grounded
          ? 'air'
          : (s.flags & MoveFlag.sliding) !== 0
            ? 'slide'
            : hs < 0.05
              ? 'idle'
              : buttons.sprint && (s.flags & MoveFlag.exhausted) === 0
                ? 'sprint'
                : 'walk';
    localPlayer.pos.x = s.pos.x;
    localPlayer.pos.y = s.pos.y;
    localPlayer.pos.z = s.pos.z;
    localPlayer.vel.x = s.vel.x;
    localPlayer.vel.y = s.vel.y;
    localPlayer.vel.z = s.vel.z;
    localPlayer.yaw = lk.yaw;
    localPlayer.pitch = lk.pitch;
    localPlayer.aimYaw = aim.yaw;
    localPlayer.aimPitch = aim.pitch;
    localPlayer.grounded = grounded;
    localPlayer.airJumps = s.airJumps;
    localPlayer.dash = fly ? 0 : (s.dash ?? 0); // CR 021: camera feel (combat/dashFeel.ts)
    localPlayer.mode = mode;
    localPlayer.seq = sim.seq;
    localPlayer.stamina = s.stamina / FINE;
    localPlayer.staminaMax = s.staminaMax / FINE;
    localPlayer.exhausted = (s.flags & MoveFlag.exhausted) !== 0;
    localPlayer.drowned = (s.flags & MoveFlag.drowned) !== 0;
    localPlayer.raining = sim.lastEnv.raining || (sim.lastEnv.weather?.moveWeatherAt(s.pos.x, s.pos.z).rain ?? false); // CR 030: rain where you stand
    localPlayer.mounted = mountedNow;
    localPlayer.gait = mountedNow ? s.lunge & 3 : 0;
  });

  return null;
}
