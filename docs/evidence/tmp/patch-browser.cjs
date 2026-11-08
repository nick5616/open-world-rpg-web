const fs = require('fs');
const p = 'client/src/sim/dev/traversal-browser.ts';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep(`  netDebug(): { phase: string; prediction: { reconciles: number; agreements: number; maxError: number } } | null;`, `  netDebug(): { phase: string; prediction: { reconciles: number; agreements: number; maxError: number }; remotes: { x: number; y: number; z: number; name: string }[] } | null;`);
rep(`    await sleep(3000);
    await shot(page, 'climb-mid');
    await sleep(3600);
    await page.evaluate(() => (window as unknown as W).__lodestone.setLook(Math.PI / 2, -0.1));
    await sleep(1200);
    await page.keyboard.up('KeyW');
    await shot(page, 'climb-top');`, `    await sleep(3000);
    await shot(page, 'climb-mid');
    // Keep climbing until the mantle puts us on the top, then let go and
    // turn around to look back down the cliff.
    await page.waitForFunction(() => {
      const p = (window as unknown as W).__lodestone.player();
      return p.pos.y > 221 && p.mode !== 'climb';
    }, null, { polling: 50, timeout: 15000 });
    await sleep(250);
    await page.keyboard.up('KeyW');
    await shot(page, 'climb-mantled');
    await page.evaluate(() => (window as unknown as W).__lodestone.setLook(-Math.PI / 2, -0.75));
    await sleep(1500);
    await shot(page, 'climb-top-looking-down');`);
rep(`    page = await openGame(clientPort, zone, 'glide', { x: 1122, z: 2301 }, Math.PI, -0.25);`, `    page = await openGame(clientPort, zone, 'glide', { x: 1122, z: 2301 }, Math.PI, -0.45);`);
rep(`    await sleep(4500);
    await shot(page, 'remote-climbing');`, `    for (let i = 0; i < 9; i++) {
      // Keep looking at the climber (remote view from the snapshots).
      await page.evaluate(() => {
        const l = (window as unknown as W).__lodestone;
        const r = l.netDebug()?.remotes?.[0];
        const me = l.player().pos;
        if (r) l.setLook(Math.atan2(-(r.x - me.x), -(r.z - me.z)), Math.atan2(r.y + 1 - (me.y + 1.8), Math.hypot(r.x - me.x, r.z - me.z)));
      });
      await sleep(500);
    }
    await shot(page, 'remote-climbing');`);
fs.writeFileSync(p, s);
console.log('ok');
