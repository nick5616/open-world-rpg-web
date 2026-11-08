// First-person camera + local movement. Per rendered frame: apply mouse look,
// sample held keys, let LocalSim run its fixed 60 Hz steps, then place the
// camera at the interpolated eye position. Writes the live HUD values.
//
// adapted from wizard-wars client/src/components/core/CameraController.tsx
// (look, fixed-step loop, jump-edge latch, reconciliation easing). Offline it
// is the whole story; online (WP06) a PlayerDriver from client/src/net feeds
// each step to the zone connection and hands back server corrections.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PLAYER_HEIGHT } from '@lodestone/contracts';
import { useKeyboard } from '../input/useKeyboard';
import { useMouseLook } from '../input/useMouseLook';
import { LocalSim, type StepRecord } from '../sim/localSim';
import { NO_BUTTONS } from '../sim/inputFrame';
import { FINE, MoveFlag, type MoveState, type StepEnv, type Vec3 } from '../sim/movement';
import { offlineEnv } from '../sim/stepEnv';
import { useAppStore } from '../stores/appStore';
import { useDebugStore } from '../stores/debugStore';
import { localPlayer, type MoveMode } from '../state/live';
import { useGround } from './groundContext';

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
  const euler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), []);
  const render = useMemo(() => ({ x: 0, y: 0, z: 0 }), []);

  useEffect(() => sim.setGround(ground), [sim, ground]);
  useEffect(() => {
    sim.envSource = driver?.env ? () => driver.env!() : offlineEnv;
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
      lk.yaw -= d.x * MOUSE_SENSITIVITY;
      lk.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, lk.pitch - d.y * MOUSE_SENSITIVITY));
    }
    // Keep yaw bounded so float precision never degrades over a long session.
    lk.yaw = Math.atan2(Math.sin(lk.yaw), Math.cos(lk.yaw));

    // The debug panel takes the keyboard; the player stands still meanwhile.
    const buttons = app.debugPanelOpen ? NO_BUTTONS : held.current;
    sim.frame(delta, { held: buttons, yaw: lk.yaw, pitch: lk.pitch, fly }, render);
    driver?.afterFrame();

    const o = offset.current;
    const decay = Math.exp(-Math.min(delta, 0.25) / CORRECTION_SMOOTH_TAU);
    o.x *= decay;
    o.y *= decay;
    o.z *= decay;
    camera.position.set(render.x + o.x, render.y + o.y + PLAYER_HEIGHT, render.z + o.z);
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
    localPlayer.grounded = grounded;
    localPlayer.airJumps = s.airJumps;
    localPlayer.mode = mode;
    localPlayer.seq = sim.seq;
    localPlayer.stamina = s.stamina / FINE;
    localPlayer.staminaMax = s.staminaMax / FINE;
    localPlayer.exhausted = (s.flags & MoveFlag.exhausted) !== 0;
    localPlayer.drowned = (s.flags & MoveFlag.drowned) !== 0;
    localPlayer.raining = sim.lastEnv.raining;
  });

  return null;
}
