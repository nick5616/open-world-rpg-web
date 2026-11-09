// First-person view model: right forearm holding a wand, left forearm with an
// open hand (spec 8 loadout: weapon in the main hand, spells from the off
// hand). Parented to the camera through a portal, so it needs no per-frame
// copy of the camera pose; only the bob/sway offsets are animated.
//
// adapted from wizard-wars client/src/components/core/ArmAndWand.tsx (shapes,
// rest pitch, local -Z forward) and LocalPlayerModel.tsx (imperative
// useFrame driving instead of React props). Cast poses come back with
// combat (WP09+); this keeps the rig and the motion that sells movement:
// walk bob scaled by speed, a lift while airborne, a dip on landing.

import { useRef } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { localPlayer, view } from '../state/live';
import { useCombatHud } from '../combat/store';
import { weaponGeometry } from '../combat/weapons/models';
import { tickWeaponMaterial, weaponMaterial } from '../combat/weapons/material';

/** The pre-combat wand: an ice gem at the tip (cached, shared with combat). */
const wandGeo = weaponGeometry({ weapon: 'wand', material: '', gem: 1 }, 2);

const REST_PITCH = 0.35; // wizard-wars rest pose: wand tipped up toward the crosshair
const SKIN = '#c9a27e';
const SLEEVE = '#3b4a6b';
/** Meters of travel per full bob cycle (two footfalls). */
const STRIDE_M = 2.4;

function Arms() {
  const rig = useRef<THREE.Group>(null);
  const phase = useRef(0);
  const wasGrounded = useRef(true);
  const lastAirVy = useRef(0);
  const dip = useRef(0);
  const lift = useRef(0);

  useFrame((state, delta) => {
    const g = rig.current;
    if (!g) return;
    g.visible = !view.third; // playtest 2: third person shows the whole body instead
    const dt = Math.min(delta, 0.1);
    const lp = localPlayer;
    const hs = Math.hypot(lp.vel.x, lp.vel.z);
    const onGround = lp.grounded || lp.mode === 'fly';

    if (onGround) phase.current += (hs * dt * Math.PI * 2) / STRIDE_M;
    // Landing: dip proportional to the fall speed just before touchdown
    // (the step zeroes vy on the snap, so remember it while airborne).
    if (!lp.grounded) lastAirVy.current = lp.vel.y;
    if (lp.grounded && !wasGrounded.current) dip.current = Math.min(0.07, Math.max(0, -lastAirVy.current) * 0.008);
    wasGrounded.current = lp.grounded;
    dip.current *= Math.exp(-dt / 0.12);
    // Airborne: arms trail the vertical motion a little, eased.
    const liftTarget = lp.grounded ? 0 : Math.max(-0.05, Math.min(0.05, -lp.vel.y * 0.006));
    lift.current += (liftTarget - lift.current) * (1 - Math.exp(-dt / 0.08));

    const amp = onGround ? 0.014 * Math.min(hs / 5, 1.6) : 0;
    g.position.set(Math.cos(phase.current) * amp, Math.abs(Math.sin(phase.current)) * -amp * 1.4 - dip.current + lift.current, 0);
    g.rotation.z = Math.cos(phase.current) * amp * 0.6;

    tickWeaponMaterial(state.scene, performance.now()); // the wand's gem shimmer
  });

  return (
    <group ref={rig}>
      {/* right arm + wand */}
      <group position={[0.27, -0.32, -0.32]} rotation={[REST_PITCH, -0.08, 0]}>
        <mesh position={[0, 0, 0.05]} rotation={[-Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.055, 0.065, 0.42, 8]} />
          <meshStandardMaterial color={SLEEVE} roughness={0.8} />
        </mesh>
        <mesh position={[0, 0, -0.2]}>
          <sphereGeometry args={[0.05, 10, 8]} />
          <meshStandardMaterial color={SKIN} roughness={0.7} />
        </mesh>
        {/* pt/ux: the procedural wand (combat/weapons), grip in the hand, tip forward */}
        <mesh position={[0, 0, -0.21]} rotation={[-Math.PI / 2, 0, 0]} geometry={wandGeo} material={weaponMaterial()} />
      </group>
      {/* left forearm, open hand for casting */}
      <group position={[-0.3, -0.36, -0.36]} rotation={[REST_PITCH * 0.7, 0.12, 0.25]}>
        <mesh position={[0, 0, 0.05]} rotation={[-Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.055, 0.065, 0.42, 8]} />
          <meshStandardMaterial color={SLEEVE} roughness={0.8} />
        </mesh>
        <mesh position={[0, 0, -0.2]} scale={[1, 0.45, 1.2]}>
          <sphereGeometry args={[0.06, 10, 8]} />
          <meshStandardMaterial color={SKIN} roughness={0.7} />
        </mesh>
      </group>
    </group>
  );
}

/** Mount once inside the Canvas; requires the camera to be part of the scene (GameCanvas adds it). */
export function FirstPersonArms() {
  const camera = useThree((s) => s.camera);
  // WP13: online, the combat layer draws the equipped weapon instead.
  const combat = useCombatHud((s) => s.active);
  if (combat) return null;
  return createPortal(<Arms />, camera);
}
