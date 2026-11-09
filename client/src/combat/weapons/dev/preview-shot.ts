// Screenshots of the weapon art preview (preview.html) for quick iteration:
//   npx vite-node src/combat/weapons/dev/preview-shot.ts <outDir> [query ...]   (from client/)
// Each query string ("sunsteel=1&gem=5", "d=1", "zoom=sword&y=0.1") is one
// screenshot. Starts its own Vite dev server on a random port in 20000-45000.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { repoRoot, waitHttp } from '../../../sim/dev/traversalRun';

async function main() {
  const [outDir, ...queries] = process.argv.slice(2);
  if (!outDir) throw new Error('usage: preview-shot.ts <outDir> [query ...]');
  const port = 20000 + Math.floor(Math.random() * 25000);
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  try {
    await waitHttp(`http://127.0.0.1:${port}/`, 90000);
    const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && console.log(`console: ${m.text()}`));
    let i = 0;
    for (const q of queries.length ? queries : ['']) {
      await page.goto(`http://127.0.0.1:${port}/src/combat/weapons/dev/preview.html?${q}`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => (window as unknown as { __previewReady?: boolean }).__previewReady === true, null, { timeout: 60000 });
      await page.waitForTimeout(500);
      const file = path.join(outDir, `preview-${i++}.png`);
      await page.screenshot({ path: file });
      console.log(`${file}  ${q}`);
    }
    await browser.close();
  } finally {
    vite.kill();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
