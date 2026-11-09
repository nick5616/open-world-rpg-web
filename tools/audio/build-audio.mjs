#!/usr/bin/env node
// Builds the game's audio assets from the sound design in cues.config.mjs:
// slices, layers, filters and loudness-matches the source material with
// ffmpeg, then encodes each result twice (Ogg Opus + AAC .m4a) into
// client/src/audio/assets/. Also writes client/src/audio/cueFiles.gen.ts
// (cue -> files), tools/audio/manifest.json (every output with its sources
// and size) and the audio block of CREDITS.md.
//
//   node tools/audio/build-audio.mjs            # everything
//   node tools/audio/build-audio.mjs --only hit,ui_click
//   node tools/audio/build-audio.mjs --sfx | --music
//
// Sources are read-only and never committed: Nicole's tracks
// (LODESTONE_AUDIO_RPG, default C:\Users\nickb\Documents\ableton\rpg) and
// the Novation packs (LODESTONE_AUDIO_SAMPLES, default C:\Samples).
// Needs ffmpeg/ffprobe with libopus on PATH.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUSIC, PACKS, ROOTS, SFX } from './cues.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const OUT = path.join(repo, 'client/src/audio/assets');
const TMP = path.join(tmpdir(), 'lodestone-audio-build');
const SR = 48000;
const PEAK_DB = -1;

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const doSfx = !args.includes('--music');
const doMusic = !args.includes('--sfx');

function resolveSrc(s) {
  const [root, rest] = s.split(/:(.*)/s);
  return path.join(ROOTS[root], rest);
}

function packOf(s) {
  let best = '';
  for (const k of Object.keys(PACKS)) if (s.startsWith(k) && k.length > best.length) best = k;
  return best ? PACKS[best] : '?';
}

function shortName(s) {
  return s.replace(/^[A-Z]+:/, '').split('/').slice(-2).join('/');
}

const durCache = new Map();
function duration(file) {
  if (durCache.has(file)) return durCache.get(file);
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = Number(r.stdout.trim());
  durCache.set(file, d);
  return d;
}

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} ${argv.join(' ')}\n${err.slice(-2000)}`))));
  });
}

async function measure(wav) {
  const { err } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', 'ebur128=peak=true,volumedetect', '-f', 'null', '-']);
  const sum = err.slice(err.lastIndexOf('Summary'));
  const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(sum)?.[1] ?? -70);
  const peak = Number(/max_volume:\s+(-?[\d.]+) dB/.exec(err)?.[1] ?? 0);
  const tp = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(sum)?.[1] ?? peak);
  return { I, peak, tp };
}

async function encode(wav, base, gainDb, { mono, music }) {
  const vol = `volume=${gainDb.toFixed(2)}dB`;
  const ch = mono ? ['-ac', '1'] : ['-ac', '2'];
  const opusRate = music ? '72k' : mono ? '40k' : '56k';
  const aacRate = music ? '96k' : mono ? '56k' : '80k';
  await run('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-af', vol, ...ch, '-c:a', 'libopus', '-b:a', opusRate, '-vbr', 'on', '-application', 'audio', `${base}.ogg`]);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-af', vol, ...ch, '-ar', music ? '44100' : '48000', '-c:a', 'aac', '-b:a', aacRate, '-movflags', '+faststart', `${base}.m4a`]);
  return statSync(`${base}.ogg`).size + statSync(`${base}.m4a`).size;
}

/** Render one SFX variant (layers mixed) to a float WAV; returns its length. */
async function renderVariant(variant, wav, { mono, fade }) {
  const inputs = [];
  const chains = [];
  let total = 0;
  variant.layers.forEach((L, i) => {
    const rate = L.rate ?? 1;
    let len;
    if (L.synth) {
      len = L.t;
      inputs.push('-f', 'lavfi', '-t', String(L.t), '-i', `aevalsrc=exprs=${L.synth}:s=${SR}`);
    } else {
      const file = resolveSrc(L.f);
      if (!existsSync(file)) throw new Error(`missing source ${file}`);
      len = L.t ?? duration(file) - (L.ss ?? 0);
      if (L.ss) inputs.push('-ss', String(L.ss));
      if (L.t) inputs.push('-t', String(L.t));
      inputs.push('-i', file);
    }
    const out = len / rate + (L.delay ?? 0) / 1000;
    total = Math.max(total, out);
    const parts = [`aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`];
    if (rate !== 1) parts.push(`asetrate=${SR}*${rate}`, `aresample=${SR}`);
    if (L.af) parts.push(L.af);
    // de-click the slice edges
    parts.push('afade=t=in:d=0.002', `afade=t=out:st=${Math.max(0, len / rate - 0.012).toFixed(3)}:d=0.012`);
    if (L.db) parts.push(`volume=${L.db}dB`);
    if (L.delay) parts.push(`adelay=${L.delay}:all=1`);
    chains.push(`[${i}:a]${parts.join(',')}[l${i}]`);
  });
  const n = variant.layers.length;
  const f = fade ?? Math.min(0.08, total * 0.3);
  let graph = `${chains.join(';')};${Array.from({ length: n }, (_, i) => `[l${i}]`).join('')}amix=inputs=${n}:normalize=0:duration=longest,afade=t=out:st=${Math.max(0, total - f).toFixed(3)}:d=${f.toFixed(3)}`;
  if (mono) graph += ',pan=mono|c0=0.5*c0+0.5*c1';
  graph += '[o]';
  await run('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[o]', '-c:a', 'pcm_f32le', '-ar', String(SR), wav]);
  return total;
}

async function buildSfx(cue) {
  const files = [];
  const sources = new Set();
  let bytes = 0;
  for (let k = 0; k < cue.variants.length; k++) {
    const variant = cue.variants[k];
    const name = `${cue.id}_${k + 1}`;
    const wav = path.join(TMP, `${name}.wav`);
    const len = await renderVariant(variant, wav, { mono: cue.mono, fade: variant.fade ?? cue.fade });
    const { peak } = await measure(wav);
    bytes += await encode(wav, path.join(OUT, 'sfx', name), PEAK_DB - peak, { mono: cue.mono });
    files.push(`sfx/${name}`);
    for (const L of variant.layers) sources.add(L.synth ? 'synth' : L.f);
    rmSync(wav, { force: true });
    void len;
  }
  return { id: cue.id, kind: 'sfx', files, sources: [...sources], bytes };
}

async function buildMusic(m) {
  const wav = path.join(TMP, `${m.id}.wav`);
  const sources = new Set();
  if (m.mix) {
    const inputs = [];
    const segs = [];
    let idx = 0;
    m.mix.forEach((seg, s) => {
      const labels = [];
      for (const L of seg) {
        inputs.push('-i', resolveSrc(L.f));
        sources.add(L.f);
        segs.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${L.db ?? 0}dB[i${idx}]`);
        labels.push(`[i${idx}]`);
        idx++;
      }
      segs.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[s${s}]`);
    });
    const concat = `${m.mix.map((_, s) => `[s${s}]`).join('')}concat=n=${m.mix.length}:v=0:a=1[o]`;
    await run('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${segs.join(';')};${concat}`, '-map', '[o]', '-c:a', 'pcm_f32le', wav]);
  } else {
    const file = resolveSrc(m.src);
    sources.add(m.src);
    const af = ['aformat=sample_fmts=fltp:channel_layouts=stereo'];
    if (m.af) af.push(m.af);
    if (m.fadeIn) af.push(`afade=t=in:d=${m.fadeIn}`);
    if (m.fadeOut) {
      const len = (m.t ?? duration(file)) / (m.af?.includes('0.8909') ? 0.8909 : 1);
      af.push(`afade=t=out:st=${(len - m.fadeOut).toFixed(3)}:d=${m.fadeOut}`);
    }
    const a = ['-v', 'error', '-y'];
    if (m.ss) a.push('-ss', String(m.ss));
    if (m.t) a.push('-t', String(m.t));
    a.push('-i', file, '-af', af.join(','), '-c:a', 'pcm_f32le', wav);
    await run('ffmpeg', a);
  }
  const meas = await measure(wav);
  let gain = m.gainDb ?? m.lufs - meas.I;
  let src = wav;
  if (meas.tp + gain > PEAK_DB) {
    if (m.exact) gain = PEAK_DB - meas.tp;
    else {
      // Loudness first, then a gentle limiter (lengths of these tracks don't matter).
      const lim = path.join(TMP, `${m.id}.lim.wav`);
      await run('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=false:latency=1`, '-c:a', 'pcm_f32le', lim]);
      src = lim;
      gain = 0;
    }
  }
  const bytes = await encode(src, path.join(OUT, 'music', m.id), gain, { music: true });
  const after = await measure(src);
  rmSync(wav, { force: true });
  if (src !== wav) rmSync(src, { force: true });
  return { id: m.id, kind: 'music', files: [`music/${m.id}`], sources: [...sources], bytes, lufs: Math.round((after.I + gain) * 10) / 10, seconds: Math.round(duration(path.join(OUT, 'music', `${m.id}.ogg`)) * 100) / 100 };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
        process.stdout.write('.');
      }
    }),
  );
  process.stdout.write('\n');
  return out;
}

function writeGenerated(manifest) {
  const sfx = manifest.filter((e) => e.kind === 'sfx');
  const lines = sfx.map((e) => `  ${e.id}: [${e.files.map((f) => `'${f}'`).join(', ')}],`);
  writeFileSync(
    path.join(repo, 'client/src/audio/cueFiles.gen.ts'),
    `// Generated by tools/audio/build-audio.mjs from tools/audio/cues.config.mjs. Do not edit.\n// Cue id -> processed asset names (variants) under ./assets/.\n\nexport const CUE_FILES: Record<string, string[]> = {\n${lines.join('\n')}\n};\n`,
  );
  writeFileSync(path.join(here, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');

  // CREDITS.md audio block
  const rows = manifest.map((e) => `| \`${e.files.length > 1 ? `${e.id}_1..${e.files.length}` : e.files[0].split('/')[1]}\` | ${e.sources.map((s) => (s === 'synth' ? 'synthesized (ffmpeg aevalsrc)' : `${packOf(s)}: \`${shortName(s)}\``)).join('<br>')} |`);
  const total = manifest.reduce((a, e) => a + e.bytes, 0);
  const block = [
    '<!-- audio:begin (generated by tools/audio/build-audio.mjs) -->',
    '## Audio',
    '',
    "Music: Nicole's original tracks for Lodestone (`Documents/ableton/rpg`): future land 1 and 2, void realm, time crunch (intro, loop, 5 sec left), level up sounds 1-3. All rights hers.",
    '',
    'Sound effects are cut, layered and processed from the **Novation Anniversary** sample packs (1st Drop Soundpack, 2nd Drop Pack, 3rd Drop), which Novation released as royalty-free sample packs for use in productions. The packs ship no license text of their own (only a pack description document); the samples are used here as processed parts of new sounds, never redistributed as a sample library. "The Gentleman Library" (a Native Instruments Kontakt piano in encrypted .nkx/.nkc containers, under the NI EULA) is not usable as raw audio and was not used.',
    '',
    'Continuous ambience (wind, rain, fire crackle, night insects, underwater, cave drips) is synthesized at runtime in `client/src/audio/ambience.ts`; the town-defense horn and the wooden creaks (doors, chests, stations, bow) are synthesized in the build.',
    '',
    `Pipeline: \`tools/audio/build-audio.mjs\` (ffmpeg). ${manifest.length} cues, ${manifest.reduce((a, e) => a + e.files.length, 0)} files, each as Ogg Opus + AAC: ${(total / 1e6).toFixed(2)} MB committed. Cue sheet: \`client/src/audio/README.md\`.`,
    '',
    '| Output | Made from |',
    '| --- | --- |',
    ...rows,
    '<!-- audio:end -->',
  ].join('\n');
  const credits = path.join(repo, 'CREDITS.md');
  let text = readFileSync(credits, 'utf8');
  const re = /<!-- audio:begin[\s\S]*?<!-- audio:end -->/;
  text = re.test(text) ? text.replace(re, block) : `${text.trimEnd()}\n\n${block}\n`;
  writeFileSync(credits, text);
  return total;
}

async function main() {
  mkdirSync(TMP, { recursive: true });
  for (const d of ['sfx', 'music']) mkdirSync(path.join(OUT, d), { recursive: true });
  const prev = existsSync(path.join(here, 'manifest.json')) ? JSON.parse(readFileSync(path.join(here, 'manifest.json'), 'utf8')) : [];
  const keep = new Map(prev.map((e) => [e.id, e]));
  const sfx = doSfx ? SFX.filter((c) => !only || only.has(c.id)) : [];
  const music = doMusic ? MUSIC.filter((m) => !only || only.has(m.id)) : [];
  // Full sfx rebuild: drop old sfx files (variants may have shrunk).
  if (doSfx && !only) for (const f of readdirSync(path.join(OUT, 'sfx'))) rmSync(path.join(OUT, 'sfx', f));
  console.log(`sfx ${sfx.length} cues, music ${music.length} tracks`);
  const built = [...(await pool(sfx, 6, buildSfx)), ...(await pool(music, 3, buildMusic))];
  for (const e of built) keep.set(e.id, e);
  const order = [...SFX.map((c) => c.id), ...MUSIC.map((m) => m.id)];
  const manifest = order.filter((id) => keep.has(id)).map((id) => keep.get(id));
  const total = writeGenerated(manifest);
  const music$ = manifest.filter((e) => e.kind === 'music');
  for (const m of music$) console.log(`  music/${m.id}: ${m.seconds}s, ${m.lufs} LUFS, ${(m.bytes / 1e6).toFixed(2)} MB (ogg+m4a)`);
  const sfxBytes = manifest.filter((e) => e.kind === 'sfx').reduce((a, e) => a + e.bytes, 0);
  console.log(`sfx: ${(sfxBytes / 1e6).toFixed(2)} MB, music: ${((total - sfxBytes) / 1e6).toFixed(2)} MB, total ${(total / 1e6).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
