const fs = require('fs');
function patch(p, pairs) {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 70));
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
}
patch('client/README.md', [
  [`Controls: click the canvas to capture the mouse, WASD move, Shift sprint, Space
jump (press again in the air to double jump). Debug builds (dev, solo, or
\`?debug=1\`): F3 HUD, backquote debug panel (teleport, fly, freeze time, time of
day, borders, quality), V fly (Space up, Ctrl/C down), F4 cell/chunk/region
borders. \`?autoplay=1\` skips the title screen.`, `Controls: click the canvas to capture the mouse, WASD move, Shift sprint, Space
jump (press again in the air to double jump, a third time while falling to
open the glider), G open/close the glider, hold W into a steep slope to climb
(Space on a wall = lunge, Space + S = kick off). The stamina wheel shows beside
the crosshair while it is not full (WP10). Debug builds (dev, solo, or
\`?debug=1\`): F3 HUD, backquote debug panel (teleport, fly, freeze time, time of
day, borders, quality), V fly (Space up, Ctrl/C down), F4 cell/chunk/region
borders. \`?autoplay=1\` skips the title screen. WP10 dev params:
\`?ground=worldgen\` walks on worldgen.wasm's terrain with a debug heightfield
visual (offline: \`&spawn=x,z\`), \`?rain=1|0\`, \`?updraft=x,z,r,top,lift\`.
Traversal acceptance: \`npm run traversal:accept -w client\` (Node client vs
the zone binary) and \`npm run traversal:browser -w client\` (headless
Chromium); see \`src/sim/README.md\`.`],
]);
patch('client/src/net/README.md', [
  ["| `prediction.ts` | Port of wizard-wars `ClientPrediction`. It runs on WP02's `stepMovement` and checks the server's SelfState against the predicted step at `ackInputSeq`, replaying only when they disagree. |", "| `prediction.ts` | Port of wizard-wars `ClientPrediction`. It runs on WP02's `stepMovement` and checks the server's SelfState against the predicted step at `ackInputSeq`, replaying only when they disagree. Since WP10 the check also covers mode, flags and `moveExt` (exact stamina and timers), replays start from `fromSelf` (the whole movement state) and reuse each step's stored env (rain, updrafts). |"],
]);
console.log('ok');
