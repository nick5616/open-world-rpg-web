// Scene-side half of the zone connection: draws every remote player from the
// interpolation buffer each frame and feeds the debug HUD's net slots. Mounted
// inside GameCanvas by the networked play screen.
//
// Playtest 2: other players' actions drive their avatars' animation
// (avatarAnim.ts) from the zone Events that already reach us: 214 (an
// attack, cast, form, dash or CR 018's "secondary pressed" started), 222 (an
// enemy hit them), 203 (downed), 707 (CR 018: a pickaxe swing), 2 (a
// teleport: forget their motion history).

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EntityKind, type Event as ZoneEvent } from '@lodestone/contracts';
import { netStats } from '../state/live';
import { Avatar, FullRigBudget } from './avatar';
import { classifyAction, EV_MINE_SWING, MINE_SPEC } from './avatarAnim';
import { drawnRemotes } from './netStore';
import type { RemoteView } from './interpolation';
import type { ZoneSession } from './zoneSession';
import { EV } from '../combat/events';
import { DEBUG } from '../config';

/** Route one zone Event to the avatar it animates (exported for tests). */
export function animateFromEvent(e: ZoneEvent, avatars: ReadonlyMap<number, Avatar>): boolean {
  const a = avatars.get(e.entityId);
  if (!a) return false;
  switch (e.kind) {
    case EV.cast:
      a.anim.trigger(classifyAction(Number(e.targetId), a.weaponKind));
      return true;
    case EV.strikeHit:
      a.anim.hurt();
      return true;
    case EV.playerDowned:
      a.anim.downedEvent();
      a.anim.hurt();
      return true;
    case EV_MINE_SWING:
      a.anim.trigger(MINE_SPEC);
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

  useEffect(
    () => () => {
      for (const a of avatars.values()) a.dispose();
      avatars.clear();
    },
    [avatars],
  );

  useEffect(() => {
    if (!DEBUG || typeof window === 'undefined') return;
    // Headless captures: what each remote avatar is doing.
    (window as unknown as { __lodestoneAvatars?: unknown }).__lodestoneAvatars = () =>
      [...avatars.values()].map((a) => ({ id: a.id, action: a.anim.current, animLevel: a.animLevel, lod: a.lodLevel, weapon: a.weaponKind, x: a.root.position.x, y: a.root.position.y, z: a.root.position.z, glow: a.pose.glow, bowDraw: a.pose.bowDraw }));
  }, [avatars]);

  useEffect(() => {
    const l = (e: ZoneEvent) => {
      if (e.kind === EV.cast || e.kind === EV.strikeHit || e.kind === EV.playerDowned || e.kind === EV_MINE_SWING || e.kind === 2) animateFromEvent(e, avatars);
    };
    session.eventListeners.add(l);
    return () => {
      session.eventListeners.delete(l);
    };
  }, [session, avatars]);

  useFrame((_, delta) => {
    session.views(delta * 1000, views);
    seen.clear();
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
        group.add(a.root);
      }
      a.update(v, camera, delta, fullM);
      if (a.animLevel === 0) budget.full++;
    }
    for (const [id, a] of avatars) {
      if (!seen.has(id)) {
        group.remove(a.root);
        a.dispose();
        avatars.delete(id);
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
