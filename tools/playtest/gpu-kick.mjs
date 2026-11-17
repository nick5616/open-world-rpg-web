/* global Image */
// Linux-GPU check for the kill flash: fire the spell screen effect's shockwaves (what a kill, Shatter
// or a heavy hit does) in front of the camera, and measure the frame's mean brightness while the
// rings expand. A NaN ring shows as a black or garbled disc (mean collapses).
//   LODESTONE_CLIENT_URL=<stack url> LODESTONE_ANGLE=gl node tools/playtest/gpu-kick.mjs [--out tmp/gpu/kick]
import { launch, newCharacter, sleep, dismissCards } from './lib.mjs';
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const OUT = arg('--out', 'tmp/gpu/kick');
const T = await launch(OUT, { width: 960, height: 540 });
const { page, note } = T;
const L = (fn, a) => page.evaluate(fn, a);
const run = (l) => L((x) => window.__lodestoneDev.run(x), l);
await newCharacter(page, 'Kick' + Math.random().toString(36).slice(2, 6));
await dismissCards(page);
let p0 = { x: 0, z: 0 };
for (let i = 0; i < 60 && !p0.x && !p0.z; i++) {
  await sleep(1000);
  p0 = await L(() => window.__lodestone.player().pos);
}
await L((q) => window.__lodestone.setQuality(q), arg('--tier', 'high'));
await run('/time 12');
await run(`/tp ${Math.round(p0.x + 120)} ${Math.round(p0.z)}`);
await sleep(7000);
const mean = async (tag) => {
  const buf = await page.screenshot({ type: 'jpeg', quality: 40 });
  if (tag) await page.screenshot({ path: `${OUT}/${tag}.jpg`, type: 'jpeg', quality: 40 });
  return L(async (b64) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 36;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 64, 36);
    const d = g.getImageData(8, 6, 48, 24).data;
    let s = 0;
    let dark = 0;
    for (let q = 0; q < d.length; q += 4) {
      const v = d[q] + d[q + 1] + d[q + 2];
      s += v;
      if (v < 6) dark++;
    }
    return { mean: +(s / (48 * 24 * 3)).toFixed(1), darkFrac: +(dark / (48 * 24)).toFixed(3) };
  }, buf.toString('base64'));
};
note('base ' + JSON.stringify(await mean('base')));
const info = await L(async () => {
  const m = await import('/src/combat/fx/screen.ts');
  window.__lsKick = m;
  const cam = window.__lodestonePost.camera;
  const dir = cam.getWorldDirection(new cam.position.constructor());
  window.__lsKickAt = (s, r, d) => m.screenKick(cam.position.x + dir.x * 8, cam.position.y + dir.y * 8, cam.position.z + dir.z * 8, s, cam.position, r, d);
  return Object.keys(m);
});
note('screen exports ' + info.join(','));
for (const [i, [s, r, d]] of [[1, 0.35, 0.55], [1, 0.6, 0.9], [0.4, 0.2, 0.4]].entries()) {
  await L(([a, b, c]) => window.__lsKickAt(a, b, c), [s, r, d]);
  for (let k = 0; k < 6; k++) {
    await sleep(110);
    note(`kick ${i} +${(k + 1) * 110}ms ${JSON.stringify(await mean(`kick${i}-${k}`))}`);
  }
  await sleep(800);
}
T.save();
await T.browser.close();
