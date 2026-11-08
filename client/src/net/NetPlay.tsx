// The online play screen: connect to the zone the director picked (WP04's
// ReadySession), show "connecting" until Welcome, then the world with
// prediction, remote players and the HUD's net slots. On a kick or a dropped
// connection it offers a reconnect (fresh ticket from the director: zone
// tickets live 60 s) or a way back to character select.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Welcome } from '@lodestone/contracts';
import type { ReadySession } from '../account/types';
import { WorldCanvas } from '../world/WorldCanvas';
import type { CollideResult, GroundQuery } from '../sim/ground';
import type { PlayerDriver } from '../scene/PlayerController';
import { DEFAULT_GROUND } from '../scene/groundContext';
import { useAppStore } from '../stores/appStore';
import { useDebugStore } from '../stores/debugStore';
import { localPlayer, netStats } from '../state/live';
import { startSocial, stopSocial } from '../social';
import { netRuntime, useNetStore } from './netStore';
import { RemotePlayers } from './RemotePlayers';
import { ZoneSession, type SessionEnd } from './zoneSession';

type Phase = { kind: 'connecting' } | { kind: 'playing'; welcome: Welcome } | { kind: 'ended'; end: SessionEnd } | { kind: 'error'; message: string };

/** ?transport=ws|wt forces a transport (debugging, the acceptance run). */
function preferredTransport(): 'auto' | 'websocket' | 'webtransport' {
  const t = new URLSearchParams(location.search).get('transport');
  return t === 'ws' ? 'websocket' : t === 'wt' ? 'webtransport' : 'auto';
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div data-testid="net-overlay" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(8,10,16,0.72)', zIndex: 30, font: '15px system-ui, sans-serif', color: '#e9ecef' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', maxWidth: 460, textAlign: 'center' }}>{children}</div>
    </div>
  );
}

/**
 * Prediction and interpolation need the same ground the zone simulates on
 * (WP07: generated terrain), but the world runtime only exists after Welcome
 * tells us the seed and the wasm/atlas load. The session is built first with
 * this forwarding ground, which switches to the terrain before the player
 * controller mounts (WorldCanvas mounts the canvas only once the runtime is
 * loaded), so no predicted step ever runs on the flat placeholder.
 */
function forwardingGround(): GroundQuery & { target: GroundQuery } {
  const g = {
    target: DEFAULT_GROUND as GroundQuery,
    heightAt: (x: number, z: number) => g.target.heightAt(x, z),
    normalAt: (x: number, z: number) => g.target.normalAt?.(x, z) ?? { x: 0, y: 1, z: 0 },
    // WP09: caves. Forward the cave queries too, or prediction would walk
    // the heightfield while the zone walks the cave (identity when the
    // target has no caves, so non-cave grounds step exactly as before).
    floorAt: (x: number, y: number, z: number) => (g.target.floorAt ? g.target.floorAt(x, y, z) : g.target.heightAt(x, z)),
    collide: (x: number, y: number, z: number, out: CollideResult) => {
      if (g.target.collide) return g.target.collide(x, y, z, out);
      out.x = x;
      out.y = y;
      out.z = z;
      out.pushX = 0;
      out.pushZ = 0;
      out.ceiling = false;
      return out;
    },
  };
  return g;
}

export function NetPlay({ ready }: { ready: ReadySession }) {
  const ground = useMemo(forwardingGround, []);
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [session, setSession] = useState<ZoneSession | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [ticket, setTicket] = useState(ready.ticket);
  const setScreen = useAppStore((s) => s.setScreen);

  useEffect(() => {
    // Fly is a client-only debug tool: switch it off while online (the
    // controller also refuses it, this keeps the panel honest).
    useDebugStore.getState().setFly(false);
    const s = new ZoneSession({
      wsUrl: ready.zoneEndpoint,
      wtUrl: ready.zoneWtEndpoint,
      ticket,
      ground,
      saveBlob: ready.save ? new TextEncoder().encode(JSON.stringify(ready.save)) : undefined,
      prefer: preferredTransport(),
    });
    netRuntime.session = s;
    let live = true;
    s.onEnd = (end) => live && setPhase({ kind: 'ended', end });
    s.start().then(
      (welcome) => {
        if (!live) return;
        setSession(s);
        setPhase({ kind: 'playing', welcome });
      },
      (e: unknown) => live && setPhase((p) => (p.kind === 'ended' ? p : { kind: 'error', message: e instanceof Error ? e.message : String(e) })),
    );
    return () => {
      live = false;
      s.close('leaving');
      if (netRuntime.session === s) netRuntime.session = null;
      netStats.transport = netStats.rttMs = netStats.downKbps = netStats.upKbps = null;
      netStats.sync = null;
    };
  }, [ready, ticket, attempt]);

  // Social (WP08) runs alongside the zone connection and outlives zone
  // reconnects, so it is keyed on the ReadySession only. Tickets live 60 s:
  // the socket asks the director for a fresh one on every reconnect.
  useEffect(() => {
    startSocial({
      endpoint: ready.socialEndpoint,
      ticket: ready.socialTicket,
      refreshTicket: () => ready.refreshTickets().then((r) => r.socialTicket),
      zoneId: () => ready.zoneId,
      position: () => ({ x: localPlayer.pos.x, z: localPlayer.pos.z }),
    });
    return () => stopSocial();
  }, [ready]);

  const reconnect = useCallback(async () => {
    setPhase({ kind: 'connecting' });
    setSession(null);
    try {
      const r = await ready.refreshTickets();
      setTicket(r.ticket);
    } catch {
      // The old ticket may still be valid (60 s); try it anyway.
    }
    setAttempt((a) => a + 1);
  }, [ready]);

  const driver = useMemo<PlayerDriver | undefined>(() => {
    if (!session || phase.kind !== 'playing') return undefined;
    const w = phase.welcome;
    return {
      spawn: { x: w.x / 100, y: w.y / 100, z: w.z / 100 },
      online: true,
      onStep: (r) => {
        if (!r.fly) session.pushStep(r.seq, r.input, r.state);
      },
      afterFrame: () => session.flushInput(),
      takeCorrection: () => session.prediction.takeCorrection(),
    };
  }, [session, phase]);

  return (
    <>
      {driver && session && (
        <WorldCanvas driver={driver} seed={phase.kind === 'playing' ? phase.welcome.seed.toString() : undefined} onRuntime={(r) => (ground.target = r.ground)}>
          <RemotePlayers session={session} />
        </WorldCanvas>
      )}
      {phase.kind === 'connecting' && (
        <Overlay>
          <div data-testid="net-connecting">Connecting to {ready.zoneId}…</div>
          <div style={{ opacity: 0.6, fontSize: 13 }}>{ready.character.name}</div>
        </Overlay>
      )}
      {(phase.kind === 'ended' || phase.kind === 'error') && (
        <Overlay>
          <div data-testid="net-ended" style={{ fontSize: 18 }}>
            {phase.kind === 'ended' && phase.end.kick ? `Disconnected: ${phase.end.kick.name.replace('_', ' ')}` : 'Connection lost'}
          </div>
          <div style={{ opacity: 0.7, fontSize: 13 }}>{phase.kind === 'ended' ? phase.end.reason || `code ${phase.end.code}` : phase.message}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setScreen('account')}>Characters</button>
            <button data-testid="net-reconnect" onClick={reconnect}>
              Reconnect
            </button>
          </div>
        </Overlay>
      )}
    </>
  );
}

/** Play screen entry: online when the account screen handed over a session. */
export function useOnlineSession(): ReadySession | null {
  return useNetStore((s) => s.ready);
}
