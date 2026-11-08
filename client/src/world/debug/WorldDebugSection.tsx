// World section of the debug panel (spec 14 dev tools): regenerate the chunk
// under the player and compare its hash against the one its mesh was built
// from (worker build, main-thread build, stored), plus a teleport list of
// biome showcase spots. Tile/LOD borders ride on WP02's border toggle (F4).

import { useState } from 'react';
import { BIOMES } from '@lodestone/worldgen';
import { worldDebug, type RegenResult } from './worldDebug';
import { useDebugStore } from '../../stores/debugStore';

export function WorldDebugSection() {
  const [res, setRes] = useState<RegenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const teleport = useDebugStore((s) => s.teleport);
  const r = worldDebug.runtime;

  const regen = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await worldDebug.regenerateCurrentChunk());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // One site per biome to jump to (settlements first: they are on flat land).
  const spots = r
    ? BIOMES.map((b) => r.data.sites.find((s) => s.biome === b && s.category === 'settlement') ?? r.data.sites.find((s) => s.biome === b)).filter((s): s is NonNullable<typeof s> => !!s)
    : [];

  return (
    <div data-testid="world-debug" style={{ borderTop: '1px solid #343a40', marginTop: 8, paddingTop: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>World {r ? `seed ${r.seed}` : ''}</div>
      <button disabled={busy} onClick={regen}>
        {busy ? 'Regenerating...' : 'Regenerate chunk + compare hash'}
      </button>
      {res && (
        <pre data-testid="regen-result" style={{ margin: '6px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', color: res.match ? '#8ce99a' : '#ff6b6b' }}>
          {`${res.chunk}: ${res.match ? 'MATCH' : 'MISMATCH'}\nstored ${res.stored ?? '(tile not loaded)'}\nworker ${res.worker} (${res.workerMs.toFixed(1)} ms)\nmain   ${res.main}`}
        </pre>
      )}
      {err && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{err}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
        {spots.map((s) => (
          <button key={s.index} style={{ fontSize: 11 }} onClick={() => teleport({ x: s.x + s.radius * 0.4, z: s.z })}>
            {s.biome}
          </button>
        ))}
      </div>
    </div>
  );
}
