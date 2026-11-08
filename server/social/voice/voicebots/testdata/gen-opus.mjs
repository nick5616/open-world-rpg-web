#!/usr/bin/env node
// Generates speech.opus.bin: 4 s of a speech-like synthetic voice encoded as
// 20 ms Opus packets, for the voice soak bots to publish as "fake microphone
// audio". There is no C compiler on the dev machine (no cgo libopus), so the
// encoder is headless Chromium's WebCodecs AudioEncoder.
//
// Signal: a 140-190 Hz glottal-ish pulse train through two moving formants,
// amplitude-gated at a ~4 Hz syllable rate with pauses, so analysers and
// LiveKit's speaker detection see something that rises and falls like talk.
//
// Format: repeated [u16 little-endian length][packet bytes].
// Run: node server/social/voice/voicebots/testdata/gen-opus.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'speech.opus.bin');
const browser = await chromium.launch();
const page = await browser.newPage();
// WebCodecs needs a secure context; http://localhost is one. Serve an empty
// page from a route instead of starting a server.
await page.route('http://localhost/', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>opus</title>' }));
await page.goto('http://localhost/');
const packets = await page.evaluate(async () => {
  const rate = 48000;
  const seconds = 4;
  const n = rate * seconds;
  const pcm = new Float32Array(n);
  let phase = 0;
  let f1 = 0, f2 = 0, f1v = 0, f2v = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const pitch = 140 + 50 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += pitch / rate;
    const pulse = phase % 1 < 0.08 ? 1 : 0; // glottal pulses
    // Two resonators whose centre frequencies wander like vowels.
    const c1 = 500 + 300 * Math.sin(2 * Math.PI * 1.3 * t);
    const c2 = 1500 + 600 * Math.sin(2 * Math.PI * 0.9 * t + 1);
    const r = 0.995;
    const w1 = (2 * Math.PI * c1) / rate, w2 = (2 * Math.PI * c2) / rate;
    f1v = f1v * r - f1 * w1 + pulse * 0.2; f1 += f1v * w1;
    f2v = f2v * r - f2 * w2 + pulse * 0.1; f2 += f2v * w2;
    // Syllables at ~4 Hz, a pause every ~1.6 s.
    const syl = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.6;
    const breath = (t % 1.6) < 1.3 ? 1 : 0;
    pcm[i] = Math.tanh((f1 + f2) * 2) * syl * breath * 0.6;
  }
  const chunks = [];
  const enc = new AudioEncoder({ output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push(Array.from(b)); }, error: (e) => { throw e; } });
  enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: 32000, opus: { frameDuration: 20000 } });
  const frame = 960 * 50; // feed 1 s at a time
  for (let off = 0; off < n; off += frame) {
    const len = Math.min(frame, n - off);
    enc.encode(new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: len, numberOfChannels: 1, timestamp: (off / rate) * 1e6, data: pcm.slice(off, off + len) }));
  }
  await enc.flush();
  return chunks;
});
await browser.close();
const total = packets.reduce((s, p) => s + 2 + p.length, 0);
const buf = Buffer.alloc(total);
let o = 0;
for (const p of packets) {
  buf.writeUInt16LE(p.length, o);
  o += 2;
  Buffer.from(p).copy(buf, o);
  o += p.length;
}
writeFileSync(out, buf);
console.log(`wrote ${out}: ${packets.length} packets (${(packets.length * 0.02).toFixed(2)} s), ${total} bytes`);
