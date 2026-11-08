#!/usr/bin/env node
// Re-runs the WP13 simulation and PvP-immunity tests verbosely and writes
// them to docs/evidence (wp13-sim.txt, wp13-pvp-immunity.txt).
//   node server/zone/internal/combat/evidence.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const zone = path.join(root, 'server', 'zone');
const ev = path.join(root, 'docs', 'evidence');
const go = (pkg, run) => {
  const r = spawnSync('go', ['-C', zone, 'test', pkg, '-run', run, '-v', '-count=1'], { encoding: 'utf8' });
  return (r.stdout ?? '') + (r.stderr ?? '');
};
const stamp = new Date().toISOString();
fs.writeFileSync(
  path.join(ev, 'wp13-sim.txt'),
  `# WP13 time-to-kill and boss simulations (${stamp})\n# go -C server/zone test ./internal/combat -run 'TimeToKill|BossFight|PartyOfTwo' -v\n# In-process combat world, the combatbot brain with the real weapon timelines and hit claims, flat ground, simulated time.\n# Fight length = from the enemy noticing the player to its death; hits = accepted claims on it.\n\n` +
    go('./internal/combat/', 'TestCommonEnemyTimeToKill|TestEliteTimeToKill|TestBossFightLength|TestPartyOfTwoClearsCampAndBoss'),
);
fs.writeFileSync(
  path.join(ev, 'wp13-pvp-immunity.txt'),
  `# WP13 PvP immunity (spec 2 and 8: no attack or spell can damage a player) (${stamp})\n\n## 1) combat package: every weapon move and every spell started and claimed at a player; structural check that only enemies call hurtPlayer\n\n` +
    go('./internal/combat/', 'TestNoAttackOrSpellCanDamageAPlayer|TestOnlyEnemiesCallHurtPlayer') +
    `\n## 2) the real session path (WebSocket, zone tick): every move and spell id claimed on player B is refused with code 1 and B's SelfState health stays full; the same sword swing claimed on a brute is accepted\n\n` +
    go('./internal/game/', 'TestZonePvPImmunityAndEnemyHits'),
);
console.log('wrote docs/evidence/wp13-sim.txt and wp13-pvp-immunity.txt');
