// Your own body in third person (playtest 2): the same Avatar rig other
// players see (net/avatar.ts), fed from local state every frame instead of
// snapshots: the drawn feet position and the view's yaw/pitch, ground speed,
// the movement mode as Activity bits, health from the combat HUD, the
// equipped weapon's look, and your actions from your caster record (CR 022,
// combat/castState.ts: whatever started, the stream / charge / guard you
// hold, your held dash's flight, mining swings), posed by the same
// followCaster other players' bodies use, plus losing health. Hidden in
// first person and when the third-person camera is pulled into the head.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Activity } from '@lodestone/contracts';
import { Avatar } from '../net/avatar';
import { followCaster, followEmote } from '../net/avatarAnim';
import { liveAvatars, SELF_AVATAR } from '../net/avatar';
import { emoteOf, SELF } from '../ui/emotes/store';
import { castState, CAST_FX_MINE } from '../combat/castState';
import type { RemoteView } from '../net/interpolation';
import { localActions, localPlayer, view, type MoveMode } from '../state/live';
import { combatRuntime } from '../combat/link';
import { useCombatHud } from '../combat/store';
import { materialKey, packLook, type WeaponKind } from '../combat/weapons/look';
import { TYPE_RIDING } from '../ui/mounts/events';

const ACTIVITY: Partial<Record<MoveMode, number>> = {
  air: Activity.airborne,
  glide: Activity.gliding | Activity.airborne,
  climb: Activity.climbing,
  swim: Activity.swimming,
  fly: Activity.airborne,
};
/** Offline (no combat), the first-person arms hold the ice wand: so does the body. */
const OFFLINE_LOOK = packLook({ weapon: 'wand', material: '', gem: 1 });

export function LocalAvatar() {
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const st = useMemo(
    () => ({
      avatar: null as Avatar | null,
      v: { id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, kind: 1, name: '', level: 0, healthPct: 100, activity: 0, partyId: 0, typeId: 0, ring: 'near', delayMs: 0, mode: 'interp' } as RemoteView,
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
        if (liveAvatars.get(SELF_AVATAR) === st.avatar) liveAvatars.delete(SELF_AVATAR);
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
      liveAvatars.set(SELF_AVATAR, a); // playtest 2: the fishing line leaves your rod's tip
    }
    // Playtest 2: photo mode shows your body from its free camera, in first person too.
    const third = view.third || view.photo;
    // CR 027: first person in the saddle you still see your steed (its neck and head below the view).
    const steedOnly = !third && localPlayer.mounted;
    const show = (view.third && !view.hideBody) || view.photo || steedOnly;
    a.root.visible = show;
    a.setRiderVisible(!steedOnly);
    const me = castState.get('self');
    if (localActions.mineSwings !== st.mines) {
      st.mines = localActions.mineSwings;
      castState.action('self', CAST_FX_MINE, performance.now()); // CR 022: a swing on your caster record
    }
    followEmote(a.anim, emoteOf(SELF)); // playtest 2: your emotes and fishing pose (ui/emotes)
    if (!third && !steedOnly) {
      a.anim.seenActions = me.actions; // first person: nothing to animate (no replay on switching)
      if (!a.anim.currentEmote) return;
      // playtest 2: an emote keeps its clock in first person (switching view mid-emote shows it at the right moment)
    }

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
      // CR 022: what you started and hold (the runtime keeps your caster record), posed like everyone's.
      if (third) followCaster(a.anim, me, kind);
    } else {
      v.healthPct = 100;
      v.typeId = OFFLINE_LOOK;
      if (third) followCaster(a.anim, me, 'wand');
    }
    if (localPlayer.mounted) v.typeId = (v.typeId ?? 0) | TYPE_RIDING; // CR 027: you ride (the zone's bit for everyone else)
    a.update(v, camera, delta);
    if (typeof window !== 'undefined') {
      // CR 022 parity runs: what your own body is doing (the remote avatars' twin is __lodestoneAvatars).
      (window as unknown as { __lodestoneLocalAvatar?: unknown }).__lodestoneLocalAvatar = () => ({ action: a!.anim.current, held: a!.anim.heldSpec?.kind ?? null, glow: a!.pose.glow, bodyPitch: a!.pose.bodyPitch });
    }
  });

  return null;
}
