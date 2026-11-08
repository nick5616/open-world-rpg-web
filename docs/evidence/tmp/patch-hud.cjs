const fs = require('fs');
let p = 'client/src/hud/DebugHud.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep("          `mode  ${localPlayer.mode}${localPlayer.grounded ? '' : `  air jumps ${localPlayer.airJumps}`}`,", "          `mode  ${localPlayer.mode}${localPlayer.grounded ? '' : `  air jumps ${localPlayer.airJumps}`}`,\n          // WP10: stamina wheel, exhaustion/drowning and the weather stub's rain.\n          `stam  ${localPlayer.stamina.toFixed(1)} / ${localPlayer.staminaMax.toFixed(0)}${localPlayer.exhausted ? '  EXHAUSTED' : ''}${localPlayer.drowned ? '  DROWNING' : ''}${localPlayer.raining ? '  rain' : ''}`,");
fs.writeFileSync(p, s);

p = 'client/src/screens/PlayScreen.tsx';
s = fs.readFileSync(p, 'utf8');
rep(`import { Crosshair, LockHint } from '../hud/Overlays';`, `import { Crosshair, LockHint } from '../hud/Overlays';
import { StaminaWheel } from '../hud/StaminaWheel';`);
rep(`      <Crosshair />
      <LockHint />`, `      <Crosshair />
      <StaminaWheel />
      <LockHint />`);
fs.writeFileSync(p, s);

p = 'client/src/hud/Overlays.tsx';
s = fs.readFileSync(p, 'utf8');
rep(`      Click to look around · WASD move · Shift sprint · Space jump (again in the air to double jump)`, `      Click to look around · WASD move · Shift sprint · Space jump (again in the air: double jump, then glide) · G glider · hold W into a cliff to climb`);
fs.writeFileSync(p, s);
console.log('ok');
