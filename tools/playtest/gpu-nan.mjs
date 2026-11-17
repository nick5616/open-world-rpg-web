// Linux-GPU probe: render the scene into a plain float target and count NaN / Inf / negative pixels,
// in town and out of town; then do the same with each top-level layer shown alone.
//   LODESTONE_CLIENT_URL=<stack url> LODESTONE_ANGLE=gl node tools/playtest/gpu-nan.mjs [--tier high]
import { launch, newCharacter, sleep, dismissCards } from './lib.mjs';
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const T = await launch('tmp/gpu/nan', { width: 640, height: 360 });
const { page, note } = T;
const L = (fn, a) => page.evaluate(fn, a);
const run = (l) => L((x) => window.__lodestoneDev.run(x), l);
await newCharacter(page, 'Nan' + Math.random().toString(36).slice(2, 6));
await dismissCards(page);
let p0 = { x: 0, z: 0 };
for (let i = 0; i < 60 && !p0.x && !p0.z; i++) {
  await sleep(1000);
  p0 = await L(() => window.__lodestone.player().pos);
}
await L((q) => window.__lodestone.setQuality(q), arg('--tier', 'high'));
await run('/time 12');
await sleep(2000);
await L(() => {
  const { post, scene, camera, gl } = window.__lodestonePost;
  const RT = post.composer.inputBuffer.constructor;
  const w = 320;
  const h = 180;
  const rt = new RT(w, h, { type: 1015, format: 1023, depthBuffer: true });
  window.__lsScan = (only, exclude) => {
    const saved = [];
    if (exclude) {
      saved.push([exclude, exclude.visible]);
      exclude.visible = false;
    }
    if (only) {
      const keep = new Set();
      for (let o = only; o; o = o.parent) keep.add(o);
      scene.traverse((o) => {
        if (o === scene || o.isCamera) return;
        saved.push([o, o.visible]);
        let d = false;
        for (let p = o.parent; p; p = p.parent) if (p === only) d = true;
        o.visible = keep.has(o) || d ? o.visible : false;
      });
    }
    const old = gl.getRenderTarget();
    const oldAuto = gl.autoClear;
    gl.setRenderTarget(rt);
    gl.clear();
    gl.render(scene, camera);
    gl.setRenderTarget(old);
    gl.autoClear = oldAuto;
    const f = new Float32Array(w * h * 4);
    gl.readRenderTargetPixels(rt, 0, 0, w, h, f);
    for (const [o, v] of saved) o.visible = v;
    let nan = 0, inf = 0, neg = 0, big = 0, black = 0, max = 0;
    for (let i = 0; i < f.length; i += 4) {
      const r = f[i], g = f[i + 1], b = f[i + 2];
      if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) nan++;
      else if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) inf++;
      else {
        if (r < 0 || g < 0 || b < 0) neg++;
        const m = Math.max(r, g, b);
        if (m > 65000) big++;
        if (m < 1e-5) black++;
        if (m > max) max = m;
      }
    }
    return { px: w * h, nan, inf, neg, big, black, max: +max.toFixed(2) };
  };
});
const spots = [['out300', 300]];
for (const [name, dx] of spots) {
  await run(`/tp ${Math.round(p0.x + dx)} ${Math.round(p0.z)}`);
  await sleep(7000);
  note(`${name} all: ${JSON.stringify(await L(() => window.__lsScan(null)))}`);
  const kids = await L(() => {
    const world = window.__lodestonePost.scene.children.find((c) => c.name === 'world');
    const sc = world.children.find((c) => c.name === 'scatter');
    window.__lsKids = sc.children;
    return window.__lsKids.map((c) => `${c.type}:${c.name}:${c.material?.name ?? ''}:${c.material?.type ?? ''}:${c.count ?? ''}`);
  });
  for (let i = 0; i < kids.length; i++) {
    const r = await L((k) => window.__lsScan(null, window.__lsKids[k]), i);
    if (r.nan < 1) note(`  ${name} without ${i} ${kids[i]}: nan ${r.nan} inf ${r.inf} neg ${r.neg} max ${r.max}`);
  }
}
T.save();
await T.browser.close();
