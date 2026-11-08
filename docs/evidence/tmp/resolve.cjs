const fs = require('fs');
// Resolve a conflicted file: fn(ours, theirs) -> text for each conflict block.
function resolve(p, fn) {
  const s = fs.readFileSync(p, 'utf8');
  const re = /<<<<<<< HEAD\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> main\n/g;
  let i = 0;
  const out = s.replace(re, (_, ours, theirs) => fn(ours, theirs, i++));
  if (out.includes('<<<<<<<')) throw new Error(p + ' unresolved');
  fs.writeFileSync(p, out);
}
resolve('client/package.json', (o, t) => o.replace('"traversal:browser": "vite-node src/sim/dev/traversal-browser.ts"', '"traversal:browser": "vite-node src/sim/dev/traversal-browser.ts",') + t);
resolve('contracts/events.md', (o, t) => o + t);
resolve('client/src/screens/PlayScreen.tsx', (o, t) => t);
resolve('client/src/net/NetPlay.tsx', (o, t) => t);
let n = fs.readFileSync('client/src/net/NetPlay.tsx', 'utf8');
n = n.replace(`import { wantsWorldgenGround } from '../sim/dev/debugWorldgen';
import { WorldgenDebugCanvas } from '../sim/dev/WorldgenDebugCanvas';
import type { GroundQuery } from '../sim/ground';
`, '');
n = n.replace(/  \/\/ WP10 dev: \?ground=worldgen plays[\s\S]*?\[session\],\n  \);\n\n/, '');
fs.writeFileSync('client/src/net/NetPlay.tsx', n);
console.log('ok');
