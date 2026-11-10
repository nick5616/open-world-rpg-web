// In-world steeds that nobody sits on (playtest 2 mounts, CR 027): yours and
// other players' as Event 1141 describes them: galloping in from where the
// zone chose (or materializing in a swirl of light), standing where they
// were left, bolting off when a demon spooks them. A ridden steed is drawn
// under its rider by the avatar (net/avatar.ts), not here.

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useGround } from '../../scene/groundContext';
import { PHASE, steedPose } from './events';
import { SteedRig } from './model';
import { useMounts } from './store';

interface Drawn {
  rig: SteedRig;
  yaw: number;
  seen: boolean;
}

export function SteedLayer() {
  const ground = useGround();
  const group = useMemo(() => new THREE.Group(), []);
  const drawn = useMemo(() => new Map<number, Drawn>(), []);

  useEffect(
    () => () => {
      for (const d of drawn.values()) d.rig.dispose();
      drawn.clear();
    },
    [drawn],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Headless captures: the free-standing steeds drawn now.
    (window as unknown as { __lodestoneSteeds?: unknown }).__lodestoneSteeds = () => [...drawn.entries()].map(([owner, d]) => ({ owner, x: d.rig.root.position.x, y: d.rig.root.position.y, z: d.rig.root.position.z, gait: d.rig.gait, visible: d.rig.root.visible }));
  }, [drawn]);

  useFrame((_, dt) => {
    const now = performance.now();
    const steeds = useMounts.getState().steeds;
    for (const d of drawn.values()) d.seen = false;
    for (const key in steeds) {
      const v = steeds[key];
      if (v.phase === PHASE.ridden || v.phase === PHASE.gone) continue;
      let d = drawn.get(v.owner);
      if (!d) {
        d = { rig: new SteedRig(v.colour), yaw: 0, seen: true };
        drawn.set(v.owner, d);
        group.add(d.rig.root);
      }
      d.seen = true;
      d.rig.setColour(v.colour);
      const p = steedPose(v, now);
      if (p.speed > 0.2) d.yaw = p.yaw;
      const y = v.phase === PHASE.standing ? v.y : ground.heightAt(p.x, p.z);
      d.rig.root.position.set(p.x, Number.isFinite(y) ? y : v.y, p.z);
      d.rig.root.rotation.y = d.yaw;
      d.rig.setOpacity(p.alpha);
      d.rig.update(dt, p.speed);
    }
    for (const [owner, d] of drawn) {
      if (d.seen) continue;
      group.remove(d.rig.root);
      d.rig.dispose();
      drawn.delete(owner);
    }
  });

  return <primitive object={group} />;
}
