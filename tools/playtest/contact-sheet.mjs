/* global Image */
// A labelled contact sheet from several screenshots (keeps evidence small).
//   cd client && node ../tools/playtest/contact-sheet.mjs <out.jpg> <cols> <cellWidth> <img> [<img> ...]
// Each label is the file name without extension.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright');
const [out, colsS, cwS, ...files] = process.argv.slice(2);
const cols = +colsS;
const cw = +cwS;
const imgs = files.map((f) => ({ label: basename(f).replace(/\.[a-z]+$/, ''), url: `data:image/jpeg;base64,${readFileSync(f).toString('base64')}` }));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const dataUrl = await page.evaluate(
  async ({ imgs, cols, cw }) => {
    const loaded = await Promise.all(imgs.map((i) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = i.url; })));
    const ch = Math.round((cw * loaded[0].height) / loaded[0].width);
    const rows = Math.ceil(loaded.length / cols);
    const cv = document.createElement('canvas');
    cv.width = cols * cw;
    cv.height = rows * (ch + 16);
    const g = cv.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, cv.width, cv.height);
    g.font = '12px sans-serif';
    loaded.forEach((im, i) => {
      const x = (i % cols) * cw;
      const y = Math.floor(i / cols) * (ch + 16);
      g.drawImage(im, x, y + 16, cw, ch);
      g.fillStyle = '#ffd166';
      g.fillText(imgs[i].label, x + 4, y + 12);
    });
    return cv.toDataURL('image/jpeg', 0.6);
  },
  { imgs, cols, cw },
);
await import('node:fs').then((fs) => fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64')));
await browser.close();
