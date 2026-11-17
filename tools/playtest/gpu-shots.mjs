// Linux-GPU repro: world shots in town and out of town at each tier, by day and night,
// on a chosen ANGLE backend (LODESTONE_ANGLE=gl|vulkan|d3d11|swiftshader).
//   LODESTONE_CLIENT_URL=<stack url> LODESTONE_ANGLE=gl node tools/playtest/gpu-shots.mjs --out tmp/gpu/gl [--tiers low,medium,high]
import { launch, newCharacter, sleep, dismissCards } from './lib.mjs';
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const OUT = arg('--out', 'tmp/gpu/x');
const TIERS = arg('--tiers', 'low,medium,high').split(',');
const T = await launch(OUT, { width: 1280, height: 720 });
const { page, note } = T;
let stacks = 0;
page.on('pageerror', (e) => { if (stacks++ < 2) note('STACK ' + (e.stack ?? '').slice(0, 900)); });
const L = (fn, a) => page.evaluate(fn, a);
const run = (l) => L((x) => window.__lodestoneDev.run(x), l);
await newCharacter(page, 'Gpu' + Math.random().toString(36).slice(2, 6));
await dismissCards(page);
const info = await L(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  return { renderer: gl.getParameter(e.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(e.UNMASKED_VENDOR_WEBGL), version: gl.getParameter(gl.VERSION) };
});
note('GL ' + JSON.stringify(info));
const clean = (on) =>
  L((v) => {
    let s = document.getElementById('ls-clean');
    if (!s) {
      s = document.createElement('style');
      s.id = 'ls-clean';
      s.textContent = 'body.ls-clean *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }';
      document.head.appendChild(s);
    }
    document.body.classList.toggle('ls-clean', v);
  }, on);
const shot = async (n) => {
  await clean(true);
  await sleep(300);
  await page.screenshot({ path: `${OUT}/${n}.jpg`, type: 'jpeg', quality: 70 });
  await clean(false);
};
const settle = async () => {
  for (let i = 0; i < 60; i++) {
    const st = await L(() => window.__lodestoneWorld?.stats?.());
    if (!st?.terrain || (st.terrain.queued + st.terrain.inFlight === 0 && st.terrain.missingWanted === 0)) break;
    await sleep(250);
  }
  await sleep(1500);
};
let p0 = { x: 0, y: 0, z: 0 };
for (let i = 0; i < 60 && !p0.x && !p0.z; i++) {
  await sleep(1000);
  p0 = await L(() => window.__lodestone.player().pos);
}
note('spawn ' + JSON.stringify(p0));
await run('/time 12');
for (const t of TIERS) {
  await L((q) => window.__lodestone.setQuality(q), t);
  await sleep(2500);
  for (const [name, dx, dz] of [['town', 0, 0], ['out120', 120, 0], ['out300', 300, 0], ['out700', 700, 300]]) {
    await run(`/tp ${Math.round(p0.x + dx)} ${Math.round(p0.z + dz)}`);
    await sleep(700);
    await settle();
    await shot(`${t}-day-${name}`);
  }
}
await run('/time 0');
await sleep(1500);
for (const t of TIERS.slice(-1)) {
  await L((q) => window.__lodestone.setQuality(q), t);
  await sleep(2000);
  for (const [name, dx, dz] of [['town', 0, 0], ['out300', 300, 0]]) {
    await run(`/tp ${Math.round(p0.x + dx)} ${Math.round(p0.z + dz)}`);
    await sleep(700);
    await settle();
    await shot(`${t}-night-${name}`);
  }
}
T.save();
await T.browser.close();
