// Play-screen mount for the generated world: loads the world runtime (wasm,
// atlas, workers), then renders WP02's GameCanvas with the wasm-backed ground
// query, the streamed terrain and the world's own sky/post chain. A loading
// veil stays up until the ground under the player is actually drawn (the
// "first playable frame" the benchmark measures).
//
// Takes the same props as GameCanvas (minus ground/terrain/environment), so
// WP06 can pass onStep here exactly as it would to GameCanvas.

import { useEffect, useState, type ComponentProps } from 'react';
import { GameCanvas } from '../scene/GameCanvas';
import { useDebugStore } from '../stores/debugStore';
import { localPlayer } from '../state/live';
import { SOLO } from '../config';
import { WorldRuntime } from './core/runtime';
import { MESH_CACHE, worldSeed } from './config';
import { WorldScene } from './WorldScene';
import { worldDebug } from './debug/worldDebug';
import { tileSize } from './terrain/quadtree';
// WP12: towers and waypoint stones (structure overlay visuals).
import { StructuresLayer } from './structures/StructuresLayer';
// WP20: towns, roads, structures and townsfolk (client/src/world/buildings/README.md).
import { TownsLayer } from './buildings/TownsLayer';

type Props = Omit<ComponentProps<typeof GameCanvas>, 'ground' | 'terrain' | 'environment' | 'ownComposer'> & {
  /** Teleport to the atlas spawn once loaded. Default: in solo (online, the zone server places you). */
  spawnOnLand?: boolean;
  /** World seed; online play passes the zone's Welcome seed, solo uses the URL/env default. */
  seed?: string;
  /** The world's genVersion (online: Welcome.genVersion), so a world pinned to an older generator loads its archived wasm. */
  genVersion?: string;
  /** Called with the loaded runtime before the canvas mounts (online play swaps its prediction ground to it). */
  onRuntime?: (r: WorldRuntime) => void;
};

export function WorldCanvas({ spawnOnLand = SOLO, seed, genVersion, onRuntime, ...rest }: Props) {
  const [runtime, setRuntime] = useState<WorldRuntime | null>(null);
  const [status, setStatus] = useState('Loading world');
  const [error, setError] = useState<string | null>(null);
  const [playable, setPlayable] = useState(false);

  useEffect(() => {
    let alive = true;
    let loaded: WorldRuntime | null = null;
    WorldRuntime.load(seed ?? worldSeed(), { meshCache: MESH_CACHE, genVersion, onStatus: (s) => alive && setStatus(s) })
      .then((r) => {
        if (!alive) {
          r.dispose();
          return;
        }
        loaded = r;
        onRuntime?.(r);
        setRuntime(r);
        setStatus('Raising the land');
        if (spawnOnLand) {
          const s = r.spawnPoint();
          useDebugStore.getState().teleport({ x: s.x, z: s.z });
        }
      })
      .catch((err: unknown) => {
        console.error('[world] failed to load', err);
        if (alive) setError(String((err as Error)?.message ?? err));
      });
    return () => {
      alive = false;
      loaded?.dispose();
    };
  // onRuntime is read once per load on purpose (a new callback identity must not reload the world).
  }, [spawnOnLand, seed, genVersion]);

  // First playable frame: a tile at lod <= 1 drawn under the player and the
  // terrain textures in (or given up on: the flat fallback is playable too).
  useEffect(() => {
    if (!runtime || playable) return;
    const t0 = performance.now();
    const id = setInterval(() => {
      const p = localPlayer.pos;
      const under = worldDebug.terrain?.drawnTiles().some((t) => {
        const s = tileSize(t.lod);
        return t.lod <= 1 && p.x >= t.cx * 64 && p.x < t.cx * 64 + s && p.z >= t.cz * 64 && p.z < t.cz * 64 + s;
      });
      if ((under && worldDebug.textureBytes > 0) || performance.now() - t0 > 15000) {
        worldDebug.firstPlayableMs = performance.now();
        setPlayable(true);
      }
    }, 50);
    return () => clearInterval(id);
  }, [runtime, playable]);

  return (
    <>
      {runtime && <GameCanvas {...rest} ground={runtime.ground} terrain={<><WorldScene runtime={runtime} /><StructuresLayer runtime={runtime} /><TownsLayer runtime={runtime} /></>} environment={false} ownComposer />}
      {!playable && (
        <div data-testid="world-loading" style={{ position: 'fixed', inset: 0, zIndex: 40, display: 'grid', placeItems: 'center', background: runtime ? 'rgba(12,16,24,0.55)' : '#0c1018', color: '#e9ecef', font: '15px system-ui, sans-serif', pointerEvents: 'none', transition: 'background 0.4s' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 22, letterSpacing: 2, marginBottom: 8 }}>LODESTONE</div>
            <div style={{ opacity: 0.75 }}>{error ? `World failed to load: ${error}` : `${status}...`}</div>
          </div>
        </div>
      )}
    </>
  );
}
