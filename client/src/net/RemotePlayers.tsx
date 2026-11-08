// Scene-side half of the zone connection: draws every remote player from the
// interpolation buffer each frame and feeds the debug HUD's net slots. Mounted
// inside GameCanvas by the networked play screen.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EntityKind } from '@lodestone/contracts';
import { netStats } from '../state/live';
import { Avatar } from './avatar';
import { drawnRemotes } from './netStore';
import type { RemoteView } from './interpolation';
import type { ZoneSession } from './zoneSession';

export function RemotePlayers({ session }: { session: ZoneSession }) {
  const camera = useThree((s) => s.camera);
  const group = useMemo(() => new THREE.Group(), []);
  const avatars = useMemo(() => new Map<number, Avatar>(), []);
  const views = useMemo<RemoteView[]>(() => [], []);
  const hud = useMemo(() => ({ last: 0 }), []);

  useEffect(
    () => () => {
      for (const a of avatars.values()) a.dispose();
      avatars.clear();
    },
    [avatars],
  );

  useFrame((_, delta) => {
    session.views(delta * 1000, views);
    const seen = new Set<number>();
    for (const v of views) {
      if (v.kind !== EntityKind.player) continue; // enemies etc. get their own renderers (WP10+)
      seen.add(v.id);
      let a = avatars.get(v.id);
      if (!a) {
        a = new Avatar(v.id);
        avatars.set(v.id, a);
        group.add(a.root);
      }
      a.update(v, camera, delta);
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
