#!/usr/bin/env node
// The player-facing "What's new" changelog (client/src/ui/whatsnew/changelog.json,
// newest first). Players see the entries above the last one their browser showed.
//
//   node scripts/whatsnew.mjs add --id pt3-fishing --title "Gone fishing" "Fish at any lake (E with a rod)." "Cook what you catch."
//        (date: today; --date YYYY-MM-DD to override) prepends one entry and checks the file
//   node scripts/whatsnew.mjs check
//        exits 1 on a malformed file (the same rules as the client's validEntries and its vitest)
//   node scripts/whatsnew.mjs list
//
// Write for players: short, friendly lines about what they will notice, no
// internals. One entry per deploy (or per theme of a big deploy); never
// reuse or rename an id that has shipped (browsers remember it).
import fs from 'node:fs';
import path from 'node:path';
import { root } from './lib.mjs';

const FILE = path.join(root, 'client', 'src', 'ui', 'whatsnew', 'changelog.json');
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function problems(list) {
  if (!Array.isArray(list)) return ['the changelog is not a list'];
  const out = [];
  const ids = new Set();
  let prev = '9999-99-99';
  list.forEach((e, i) => {
    const at = `entry ${i}${e && typeof e.id === 'string' ? ` (${e.id})` : ''}`;
    if (!e || typeof e !== 'object') return out.push(`${at}: not an object`);
    if (typeof e.id !== 'string' || !ID.test(e.id)) out.push(`${at}: id must be lowercase letters, digits, . _ - (got ${JSON.stringify(e.id)})`);
    else if (ids.has(e.id)) out.push(`${at}: duplicate id`);
    else ids.add(e.id);
    if (typeof e.date !== 'string' || !DATE.test(e.date) || Number.isNaN(Date.parse(e.date))) out.push(`${at}: date must be YYYY-MM-DD`);
    else if (e.date > prev) out.push(`${at}: newer than the entry above it (newest first)`);
    else prev = e.date;
    if (typeof e.title !== 'string' || !e.title.trim()) out.push(`${at}: no title`);
    if (!Array.isArray(e.items) || e.items.length === 0 || e.items.some((s) => typeof s !== 'string' || !s.trim())) out.push(`${at}: items must be a non-empty list of lines`);
  });
  return out;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error(`✗ ${path.relative(root, FILE)} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

function check(list) {
  const p = problems(list);
  if (p.length) {
    for (const x of p) console.error(`✗ ${x}`);
    console.error(`${p.length} problem(s) in ${path.relative(root, FILE)} (the client skips malformed entries; fix before deploying)`);
    process.exit(1);
  }
  console.log(`✓ ${list.length} entries, newest ${list[0]?.id ?? '(none)'}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'check') check(load());
else if (cmd === 'list') for (const e of load()) console.log(`${e.date}  ${e.id.padEnd(24)} ${e.title} (${e.items?.length ?? 0})`);
else if (cmd === 'add') {
  const opt = (k) => {
    const i = rest.indexOf(`--${k}`);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    rest.splice(i, 2);
    return v;
  };
  const id = opt('id');
  const title = opt('title');
  const date = opt('date') ?? new Date().toISOString().slice(0, 10);
  const items = rest;
  if (!id || !title || !items.length) {
    console.error('usage: node scripts/whatsnew.mjs add --id <id> --title "<title>" "<line>" ["<line>" ...] [--date YYYY-MM-DD]');
    process.exit(2);
  }
  const list = load();
  const next = [{ id, date, title, items }, ...list];
  const p = problems(next);
  if (p.length) {
    for (const x of p) console.error(`✗ ${x}`);
    process.exit(1);
  }
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`✓ added ${id} (${date}) with ${items.length} line(s) to ${path.relative(root, FILE)}`);
} else {
  console.error('usage: node scripts/whatsnew.mjs add|check|list (see the header of this file)');
  process.exit(2);
}
