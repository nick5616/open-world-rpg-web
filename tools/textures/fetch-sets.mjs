#!/usr/bin/env node
// Downloads the CC0 SD texture sets listed in sets.json from 3dtextures.me
// into texture-sources/<Folder>/ (spec 12: raw sets live outside public/ so
// they never ship). Each 3dtextures.me post links a public Google Drive
// folder; we read the folder page for its file ids and fetch each map
// directly. Preview renders ("Material_*", "*_preview") are skipped.
//
//   node tools/textures/fetch-sets.mjs              # every set missing locally
//   node tools/textures/fetch-sets.mjs grass-meadow # just these ids
//   node tools/textures/fetch-sets.mjs --search snow
//
// The site rate-limits bursts (it answered empty pages after ~6 quick
// searches), so requests are spaced out and retried.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const SRC = path.join(root, 'texture-sources');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) lodestone-texture-fetch';
const sets = JSON.parse(fs.readFileSync(path.join(here, 'sets.json'), 'utf8')).sets;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, binary = false) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (r.ok) {
      const body = binary ? new Uint8Array(await r.arrayBuffer()) : await r.text();
      // A rate-limited search page comes back 200 with a ~1 KB stub.
      if (binary || body.length > 4096) return body;
    }
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(`fetch failed: ${url}`);
}

/** Drive folder listing: [fileId, [folderId], "Name.ext"] tuples in escaped JS. */
function listDriveFolder(html, folderId) {
  const re = new RegExp(String.raw`\\x5b\\x22([A-Za-z0-9_-]{20,})\\x22,\\x5b\\x22${folderId}\\x22\\x5d,\\x22([^\\]+?)\\x22`, 'g');
  const out = new Map();
  for (const m of html.matchAll(re)) out.set(m[2], m[1]);
  return [...out].map(([name, id]) => ({ name, id }));
}

async function fetchSet(s) {
  const dir = path.join(SRC, s.folder);
  if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /basecolor/i.test(f))) {
    console.log(`= ${s.id.padEnd(16)} ${s.folder} (already present)`);
    return;
  }
  const page = await get(s.page);
  // Newer posts link /drive/folders/<id>, older ones /open?id=<id> (also a folder).
  const folder = page.match(/https:\/\/drive\.google\.com\/(?:drive\/folders\/|open\?id=)([A-Za-z0-9_-]+)/);
  if (!folder) throw new Error(`${s.id}: no Drive folder link on ${s.page}`);
  await sleep(800);
  const listing = await get(`https://drive.google.com/drive/folders/${folder[1]}`);
  const files = listDriveFolder(listing, folder[1]).filter((f) => /\.(png|jpe?g)$/i.test(f.name) && !/^material|preview|sphere|render/i.test(f.name));
  if (!files.length) throw new Error(`${s.id}: Drive folder listing had no image files`);
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const f of files) {
    const data = await get(`https://drive.usercontent.google.com/download?id=${f.id}&export=download`, true);
    if (data[0] === 0x3c) throw new Error(`${s.id}: ${f.name} came back as HTML (Drive interstitial)`);
    fs.writeFileSync(path.join(dir, f.name), data);
    bytes += data.length;
    await sleep(300);
  }
  console.log(`+ ${s.id.padEnd(16)} ${s.folder}: ${files.length} maps, ${(bytes / 1048576).toFixed(1)} MB`);
}

const args = process.argv.slice(2);
if (args[0] === '--search') {
  const html = await get(`https://3dtextures.me/?s=${encodeURIComponent(args.slice(1).join(' '))}`);
  const links = [...new Set(html.match(/https:\/\/3dtextures\.me\/20[0-9/]+[a-z0-9-]+\//g) ?? [])];
  console.log(links.join('\n'));
} else {
  const only = new Set(args);
  for (const s of sets) {
    if (only.size && !only.has(s.id)) continue;
    if (!s.page) continue; // reused from refs, copied by hand (see sets.json "from")
    try {
      await fetchSet(s);
    } catch (err) {
      console.error(`! ${s.id}: ${err.message}`);
      process.exitCode = 1;
    }
    await sleep(1200);
  }
}
