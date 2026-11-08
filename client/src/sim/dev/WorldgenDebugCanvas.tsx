// Play on generated ground (`?ground=worldgen`, dev only, WP10): loads
// worldgen.wasm for the world's seed, then the normal GameCanvas with a
// WorldgenGround and the DebugTerrain visual. Offline, `?spawn=x,z` picks
// where to start (default: the official world's spawn meadow); online
// (NetPlay) the zone's Welcome position is used and the session's
// prediction/interpolation switch to the same ground via onGround.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { GameCanvas } from '../../scene/GameCanvas';
import type { PlayerDriver } from '../../scene/PlayerController';
import type { WorldgenGround } from '../worldgenGround';
import { OFFLINE_SEED } from '../stepEnv';
import { browserWorldgenGround } from './debugWorldgen';
import { DebugTerrain } from './DebugTerrain';

function spawnParam(): { x: number; z: number } {
  const v = new URLSearchParams(location.search).get('spawn')?.split(',').map(Number);
  return v && v.length === 2 && v.every(Number.isFinite) ? { x: v[0], z: v[1] } : { x: 1920, z: 2272 };
}

interface Props {
  seed?: bigint;
  /** Online driver (NetPlay); offline a local one is made from ?spawn. */
  driver?: PlayerDriver;
  onGround?: (g: WorldgenGround) => void;
  children?: ReactNode;
}

export function WorldgenDebugCanvas({ seed = OFFLINE_SEED, driver, onGround, children }: Props) {
  const [ground, setGround] = useState<WorldgenGround | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    browserWorldgenGround(seed).then(
      (g) => {
        if (!live) return;
        onGround?.(g);
        setGround(g);
      },
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [seed, onGround]);
  const d = useMemo<PlayerDriver | null>(() => {
    if (!ground) return null;
    if (driver) {
      // Welcome's y is cm-rounded while the zone stands exactly on the ground
      // (dev spawns are cm-exact in x/z): take y from the identical surface,
      // or the first steps start a few mm up and reconcile once.
      const s = driver.spawn;
      const gy = ground.heightAt(s.x, s.z);
      return Math.abs(gy - s.y) < 0.01 ? { ...driver, spawn: { ...s, y: gy } } : driver;
    }
    const sp = spawnParam();
    return { spawn: { x: sp.x, y: ground.heightAt(sp.x, sp.z), z: sp.z }, online: false, onStep: () => {}, afterFrame: () => {}, takeCorrection: () => null };
  }, [ground, driver]);
  if (error) return <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', color: '#ff6b6b', font: '14px system-ui' }}>{error}</div>;
  if (!ground || !d) return null;
  return (
    <GameCanvas ground={ground} terrain={<DebugTerrain ground={ground} />} driver={d}>
      {children}
    </GameCanvas>
  );
}
