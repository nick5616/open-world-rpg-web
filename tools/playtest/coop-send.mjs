#!/usr/bin/env node
// Send one command to coop-driver.mjs: the body of an async function
// (A, B, H, S, log), from the first argument or a file (-f path).
//   node tools/playtest/coop-send.mjs 'return await H.status(A, B)'
//   node tools/playtest/coop-send.mjs -f step.js [--port 47123]
// No client timeout: a command can walk for many minutes.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const port = args.includes('--port') ? +args[args.indexOf('--port') + 1] : 47123;
const code = args[0] === '-f' ? readFileSync(args[1], 'utf8') : args[0];
const path = code === 'quit' ? '/quit' : code === 'abort' ? '/abort' : '/run';
const body = JSON.stringify({ code });
const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
  let s = '';
  res.on('data', (c) => (s += c));
  res.on('end', () => {
    const o = JSON.parse(s);
    if (o.ok) console.log(typeof o.value === 'string' ? o.value : JSON.stringify(o.value, null, 1), `\n(${((o.ms ?? 0) / 1000).toFixed(1)} s)`);
    else console.log('ERROR', o.error);
  });
});
req.setTimeout(0);
req.on('error', (e) => console.log('ERROR', e.message));
req.end(body);
