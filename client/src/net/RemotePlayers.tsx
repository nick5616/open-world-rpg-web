// Scene-side half of the zone connection: draws every remote player from the
// interpolation buffer each frame and feeds the debug HUD's net slots. Mounted
// inside GameCanvas by the networked play screen.
//
// Playtest 2: other players' actions drive their avatars' animation
// (avatarAnim.ts). CR 022 (shared spell visuals): their spell and action
// poses come from their caster record (combat/castState.ts), the same state
// your own third-person body is posed from: replication fills it from Events
// 214 / 223 / 226 / 707 and, every frame here, their drawn Activity bits
// (the casting bit: a held action or a held dash's thrust). Events 222 (an
// enemy hit them), 203 (downed) and 2 (a teleport: forget their motion
// history) still go straight to the animator.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EntityKind, type Event as ZoneEvent } from '@lodestone/contracts';
import { netStats } from '../state/live';
import { Avatar, FullRigBudget } from './avatar';
import { EV_MINE_SWING, followCaster, followEmote } from './avatarAnim';
import { liveAvatars } from './avatar';
import { emoteOf } from '../ui/emotes/store';
import { drawnRemotes } from './netStore';
import type { RemoteView } from './interpolation';
import type { ZoneSession } from './zoneSession';
import { EV } from '../combat/events';
import { DEBUG } from '../config';
import { castHooks } from '../combat/fx/castOrigin';
import { castState, remoteEvent } from '../combat/castState';
import { spellFx } from '../combat/fx/api';
import { unpackLook } from '../combat/weapons/look';

/** Route one zone Event to the avatar it animates (exported for tests). */
export function animateFromEvent(e: ZoneEvent, avatars: ReadonlyMap<number, Avatar>): boolean {
  const a = avatars.get(e.entityId);
  if (!a) return false;
  switch (e.kind) {
    case EV.strikeHit:
      a.anim.hurt();
      return true;
    case EV.playerDowned:
      a.anim.downedEvent();
      a.anim.hurt();
      return true;
    case 2: // core teleport
      a.anim.resetMotion();
      return true;
  }
  return false;
}

export function RemotePlayers({ session }: { session: ZoneSession }) {
  const camera = useThree((s) => s.camera);
  const group = useMemo(() => new THREE.Group(), []);
  const avatars = useMemo(() => new Map<number, Avatar>(), []);
  const views = useMemo<RemoteView[]>(() => [], []);
  const seen = useMemo(() => new Set<number>(), []);
  const hud = useMemo(() => ({ last: 0 }), []);
  const budget = useMemo(() => ({ rigs: new FullRigBudget(), full: 0 }), []);

  useEffect(() => {
    // Playtest 2: spells leave another player's staff/wand tip or off hand (combat/fx/castOrigin.ts).
    castHooks.weaponOf = (id) => avatars.get(id)?.weaponKind ?? null;
    castHooks.gemOf = (id) => {
      const a = avatars.get(id);
      return a ? unpackLook(a.weaponType).gem : -1;
    };
    return () => {
      castHooks.weaponOf = null;
      castHooks.gemOf = null;
      for (const [id, a] of avatars) {
        a.dispose();
        if (liveAvatars.get(id) === a) liveAvatars.delete(id);
      }
      avatars.clear();
    };
  }, [avatars]);

  useEffect(() => {
    if (!DEBUG || typeof window === 'undefined') return;
    // Headless captures: what each remote avatar is doing.
    (window as unknown as { __lodestoneAvatars?: unknown }).__lodestoneAvatars = () =>
      [...avatars.values()].map((a) => ({ id: a.id, action: a.anim.current, held: a.anim.heldSpec?.kind ?? null, bodyPitch: a.pose.bodyPitch, animLevel: a.animLevel, lod: a.lodLevel, weapon: a.weaponKind, x: a.root.position.x, y: a.root.position.y, z: a.root.position.z, glow: a.pose.glow, bowDraw: a.pose.bowDraw, emote: a.anim.currentEmote, rod: a.pose.rod, fish: a.pose.fish, steed: a.steedGait, heading: a.heading }));
  }, [avatars]);

  useEffect(() => {
    const l = (e: ZoneEvent) => {
      if (e.kind === EV.strikeHit || e.kind === EV.playerDowned || e.kind === 2) animateFromEvent(e, avatars);
      // CR 022: a pickaxe swing is an action on their caster record (the combat runtime routes the spell Events).
      else if (e.kind === EV_MINE_SWING) remoteEvent(e, session.welcome?.entityId ?? 0, performance.now(), spellFx);
    };
    session.eventListeners.add(l);
    return () => {
      session.eventListeners.delete(l);
    };
  }, [session, avatars]);

  useFrame((_, delta) => {
    session.views(delta * 1000, views);
    seen.clear();
    const now = performance.now();
    castState.flush(now); // replication events whose drawn moment has come (before the poses: a dash start is not a dodge)
    // Playtest 2: at most ~32 full animated rigs; a dense crowd shrinks their radius.
    const fullM = budget.rigs.step(budget.full);
    budget.full = 0;
    for (const v of views) {
      if (v.kind !== EntityKind.player) continue; // enemies etc. get their own renderers (WP10+)
      seen.add(v.id);
      let a = avatars.get(v.id);
      if (!a) {
        a = new Avatar(v.id);
        avatars.set(v.id, a);
        liveAvatars.set(v.id, a);
        group.add(a.root);
      }
      // CR 022: their caster record (drawn look, casting bit, interpolation delay), then the pose from it.
      castState.activity(v.id, v.activity, v.yaw, v.pitch, v.delayMs, now, spellFx);
      followCaster(a.anim, castState.peek(v.id), a.weaponKind);
      followEmote(a.anim, emoteOf(v.id)); // playtest 2: emotes and the fishing pose (Event 1090, ui/emotes)
      a.update(v, camera, delta, fullM);
      if (a.animLevel === 0) budget.full++;
    }
    for (const [id, a] of avatars) {
      if (!seen.has(id)) {
        group.remove(a.root);
        a.dispose();
        avatars.delete(id);
        if (liveAvatars.get(id) === a) liveAvatars.delete(id);
        castState.forget(id);
      }
    }
    drawnRemotes.views = views.map((v) => ({ ...v }));
    for (const [id, a] of avatars) drawnRemotes.lod[id] = a.lodLevel;

    // HUD slots ~4 Hz (spec 13: transport, RTT, bandwidth).
    const t = performance.now();
    if (t - hud.last > 250) {
      hud.last = t;
      const bw = session.bandwidth();
      netStats.transport = session.transport?.kind ?? null;
      netStats.rttMs = session.clock.isSynced ? Math.round(session.clock.minRtt) : null;
      netStats.downKbps = Math.round(bw.downKbps * 10) / 10;
      netStats.upKbps = Math.round(bw.upKbps * 10) / 10;
      const p = session.prediction;
      const m = session.interp.metrics;
      netStats.sync = `tick #${session.decoder.latest}  remotes ${views.length}  delay ${Math.round(session.interp.linkDelay)} ms  unacked ${p.unacked}  corr ${p.reconciles} (max ${(p.maxError * 100).toFixed(1)} cm)  extrap ${m.extrapEvents}  tp ${m.teleports}`;
    }
  });

  return <primitive object={group} />;
}
