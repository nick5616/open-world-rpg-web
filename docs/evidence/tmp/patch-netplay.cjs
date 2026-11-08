const fs = require('fs');
let p = 'client/src/net/NetPlay.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep(`import { envAt } from '../sim/stepEnv';`, `import { envAt } from '../sim/stepEnv';
import { wantsWorldgenGround } from '../sim/dev/debugWorldgen';
import { WorldgenDebugCanvas } from '../sim/dev/WorldgenDebugCanvas';
import type { GroundQuery } from '../sim/ground';`);
rep(`  return (
    <>
      {driver && session && (
        <GameCanvas driver={driver}>
          <RemotePlayers session={session} />
        </GameCanvas>
      )}`, `  // WP10 dev: ?ground=worldgen plays on worldgen.wasm's surface (the zone's
  // own terrain) until WP05's streamed terrain provides the ground.
  const worldgen = wantsWorldgenGround();
  const onGround = useCallback(
    (g: GroundQuery) => {
      session?.prediction.setGround(g);
      session?.interp.setGround(g);
    },
    [session],
  );

  return (
    <>
      {driver && session && worldgen && phase.kind === 'playing' && (
        <WorldgenDebugCanvas seed={phase.welcome.seed} driver={driver} onGround={onGround}>
          <RemotePlayers session={session} />
        </WorldgenDebugCanvas>
      )}
      {driver && session && !worldgen && (
        <GameCanvas driver={driver}>
          <RemotePlayers session={session} />
        </GameCanvas>
      )}`);
fs.writeFileSync(p, s);

p = 'client/src/screens/PlayScreen.tsx';
s = fs.readFileSync(p, 'utf8');
rep(`import { SocialOverlay } from '../social';`, `import { SocialOverlay } from '../social';
// WP10 dev: ?ground=worldgen walks on generated ground offline too.
import { wantsWorldgenGround } from '../sim/dev/debugWorldgen';
import { WorldgenDebugCanvas } from '../sim/dev/WorldgenDebugCanvas';`);
rep(`      {online ? <NetPlay ready={ready} /> : <GameCanvas />}`, `      {online ? <NetPlay ready={ready} /> : wantsWorldgenGround() ? <WorldgenDebugCanvas /> : <GameCanvas />}`);
fs.writeFileSync(p, s);

p = 'client/src/devHandle.ts';
s = fs.readFileSync(p, 'utf8');
rep(`import { netDebug } from './net/netStore';`, `import { netDebug, useNetStore } from './net/netStore';
import type { ReadySession } from './account/types';`);
rep(`    setQuality: (q: QualitySetting) => useQualityStore.getState().setSetting(q),
  };`, `    setQuality: (q: QualitySetting) => useQualityStore.getState().setSetting(q),
    /**
     * WP10 headless runs: connect straight to a zone with a dev ticket (no
     * account/director round trip). Fields not given are stubbed; social is
     * pointed at a dead port and just keeps backing off.
     */
    connectZone: (r: Pick<ReadySession, 'ticket' | 'zoneEndpoint' | 'zoneId' | 'worldId'> & { name?: string }) => {
      const ready: ReadySession = {
        ticket: r.ticket,
        socialTicket: '',
        ticketExpiresAt: Date.now() + 60_000,
        zoneId: r.zoneId,
        zoneEndpoint: r.zoneEndpoint,
        socialEndpoint: 'ws://127.0.0.1:9/ws',
        worldId: r.worldId,
        character: { id: 'dev', name: r.name ?? 'Dev', level: 1 } as ReadySession['character'],
        isLocalProfile: false,
        session: '',
        refreshTickets: () => Promise.reject(new Error('dev connect: no director')),
      };
      useNetStore.getState().setReady(ready);
      useAppStore.getState().setScreen('play');
    },
  };`);
fs.writeFileSync(p, s);
console.log('ok');
