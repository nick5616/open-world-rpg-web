// First-person camera + local movement. Per rendered frame: apply mouse look,
// sample held keys, let LocalSim run its fixed 60 Hz steps, then place the
// camera at the interpolated eye position. Writes the live HUD values.
//
// adapted from wizard-wars client/src/components/core/CameraController.tsx
// (look, fixed-step loop, jump-edge latch). No networking here: WP06 hooks
// LocalSim.onStep to send InputFrames and adds reconciliation.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PLAYER_HEIGHT } from '@lodestone/contracts';
import { useKeyboard } from '../input/useKeyboard';
import { useMouseLook } from '../input/useMouseLook';
import { LocalSim, type StepRecord } from '../sim/localSim';
import { NO_BUTTONS } from '../sim/inputFrame';
import { useAppStore } from '../stores/appStore';
import { useDebugStore } from '../stores/debugStore';
import { localPlayer, type MoveMode } from '../state/live';
import { useGround } from './groundContext';

const MOUSE_SENSITIVITY = 0.002; // rad per pixel (wizard-wars value)
const PITCH_LIMIT = Math.PI / 2 - 0.01;
/** World center: the v1 world spans [0, 4096) on x and z (contracts WORLD_SIZE_M). */
export const SPAWN = { x: 2048, z: 2048 };

interface Props {
  onStep?: (r: StepRecord) => void;
}

export function PlayerController({ onStep }: Props) {
  const camera = useThree((s) => s.camera);
  const ground = useGround();
  const held = useKeyboard();
  const consumeLook = useMouseLook();
  // Created once; later ground swaps go through setGround so the player keeps their state.
  const [sim] = useState(() => new LocalSim(ground, { x: SPAWN.x, y: ground.heightAt(SPAWN.x, SPAWN.z), z: SPAWN.z }));
  const look = useRef({ yaw: 0, pitch: 0 });
  const euler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), []);
  const render = useMemo(() => ({ x: 0, y: 0, z: 0 }), []);

  useEffect(() => sim.setGround(ground), [sim, ground]);
  useEffect(() => {
    sim.onStep = onStep ?? null;
  }, [sim, onStep]);

  useFrame((_, delta) => {
    const dbg = useDebugStore.getState();
    const app = useAppStore.getState();

    const tp = dbg.takeTeleport();
    if (tp) sim.teleport(tp);

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
    sim.frame(delta, { held: buttons, yaw: lk.yaw, pitch: lk.pitch, fly: dbg.fly }, render);

    camera.position.set(render.x, render.y + PLAYER_HEIGHT, render.z);
    euler.set(lk.pitch, lk.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(euler);

    const s = sim.state;
    const grounded = !dbg.fly && sim.grounded();
    const hs = Math.hypot(s.vel.x, s.vel.z);
    const mode: MoveMode = dbg.fly ? 'fly' : !grounded ? 'air' : hs < 0.05 ? 'idle' : buttons.sprint ? 'sprint' : 'walk';
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
  });

  return null;
}
