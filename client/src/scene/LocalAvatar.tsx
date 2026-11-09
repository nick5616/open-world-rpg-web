// Your own body in third person (playtest 2): the same Avatar rig other
// players see (net/avatar.ts), fed from local state every frame instead of
// snapshots: the drawn feet position and the view's yaw/pitch, ground speed,
// the movement mode as Activity bits, health from the combat HUD, the
// equipped weapon's look, and your actions straight from the combat runtime
// (whatever started, the held secondary button for the parry / spear charge /
// bow draw, mining swings, losing health). Hidden in first person and when
// the third-person camera is pulled into the head.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Activity } from '@lodestone/contracts';
import { Avatar } from '../net/avatar';
import { CAST_FX_GUARD, classifyAction, MINE_SPEC } from '../net/avatarAnim';
import type { RemoteView } from '../net/interpolation';
import { localActions, localPlayer, view, type MoveMode } from '../state/live';
import { combatRuntime } from '../combat/link';
import { useCombatHud } from '../combat/store';
import { materialKey, packLook, type WeaponKind } from '../combat/weapons/look';

const ACTIVITY: Partial<Record<MoveMode, number>> = {
  air: Activity.airborne,
  glide: Activity.gliding | Activity.airborne,
  climb: Activity.climbing,
  swim: Activity.swimming,
  fly: Activity.airborne,
};
/** Offline (no combat), the first-person arms hold the ice wand: so does the body. */
const OFFLINE_LOOK = packLook({ weapon: 'wand', material: '', gem: 1 });
const STAFFY = new Set<WeaponKind>(['staff', 'wand']);

export function LocalAvatar() {
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const st = useMemo(
    () => ({
      avatar: null as Avatar | null,
      v: { id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, kind: 1, name: '', level: 0, healthPct: 100, activity: 0, partyId: 0, typeId: 0, ring: 'near', delayMs: 0, mode: 'interp' } as RemoteView,
      started: -1,
      held: false,
      mines: localActions.mineSwings,
      health: -1,
    }),
    [],
  );

  useEffect(
    () => () => {
      if (st.avatar) {
        st.avatar.root.removeFromParent();
        st.avatar.dispose();
        st.avatar = null;
      }
    },
    [st],
  );

  useFrame((_, delta) => {
    const rt = combatRuntime.current;
    const id = rt ? rt.selfId() : 0;
    let a = st.avatar;
    if (!a || a.id !== id) {
      if (a) {
        a.root.removeFromParent();
        a.dispose();
      }
      a = st.avatar = new Avatar(id, { nameplate: false });
      scene.add(a.root);
    }
    const show = view.third && !view.hideBody;
    a.root.visible = show;
    if (!view.third) return; // first person: nothing to animate

    const v = st.v;
    v.id = id;
    v.x = view.feet.x;
    v.y = view.feet.y;
    v.z = view.feet.z;
    v.yaw = localPlayer.yaw;
    v.pitch = localPlayer.pitch;
    v.speed = Math.hypot(localPlayer.vel.x, localPlayer.vel.z);
    v.activity = ACTIVITY[localPlayer.mode] ?? 0;
    const hud = useCombatHud.getState();
    if (rt && hud.active) {
      v.healthPct = rt.timeline.downed ? 0 : Math.max(1, Math.round((hud.health / Math.max(1, hud.healthMax)) * 100));
      const lo = hud.loadouts[hud.activeLoadout];
      const kind = rt.weaponName() as WeaponKind;
      v.typeId = packLook({ weapon: kind, material: materialKey(lo?.material ?? 0), gem: lo?.gem ?? -1 });
      // Lost health: flinch.
      if (st.health >= 0 && hud.health < st.health && hud.health > 0) a.anim.hurt();
      st.health = hud.health;
      // Whatever started (attack, cast, form, mobility dash).
      if (st.started < 0) st.started = rt.startedCount;
      if (rt.startedCount !== st.started) {
        st.started = rt.startedCount;
        if (rt.lastStarted) a.anim.trigger(classifyAction(rt.lastStarted.id, kind));
      }
      // The held secondary: sword parry, spear charge, bow draw (staff/wand use it as a heavy attack).
      const held = rt.timeline.heldSteps > 0 && !STAFFY.has(kind);
      if (held && !st.held) a.anim.trigger(classifyAction(CAST_FX_GUARD, kind));
      else if (!held && st.held) a.anim.release();
      st.held = held;
    } else {
      v.healthPct = 100;
      v.typeId = OFFLINE_LOOK;
    }
    if (localActions.mineSwings !== st.mines) {
      st.mines = localActions.mineSwings;
      a.anim.trigger(MINE_SPEC);
    }
    a.update(v, camera, delta);
  });

  return null;
}
