#!/usr/bin/env node
// Texture pipeline (spec 12). Two outputs from the raw CC0 sets in
// texture-sources/<Set>_SD/ (which never ship):
//
// 1. Per set, client/public/textures/<id>/:
//      color.webp   base color (sRGB)
//      normal.webp  normal map (linear, OpenGL convention)
//      orm.webp     R = ambient occlusion, G = roughness, B = metalness (linear)
//    Loaded by client/src/world/textures/pbrMaterial.ts (props, rocks, ruins).
//
// 2. Terrain texture arrays, client/public/textures/terrain/:
//      color-<hash>.ktx2   2D array, one layer per terrain material, RGBA:
//                          sRGB albedo + height in alpha (height-blended splats)
//      normal-<hash>.ktx2  2D array, linear normals
//      orm-<hash>.ktx2     2D array, linear AO/roughness/metalness
//      manifest.json       layer order, sizes, file names, mean colors
//    512 x 512 per layer with a full mip chain, Basis Universal in KTX2
//    (KHR_texture_basisu), transcoded on the GPU's native format by three's
//    KTX2Loader. The manifest is the only file fetched without a hash, so
//    the arrays can be cached forever.
//
// adapted from 3d-portfolio-website scripts/build-textures.mjs (set table,
// channel packing, per-set size and gain). Changed: map files are found by
// any of the naming schemes 3dtextures.me used over the years, sets come from
// sets.json, and the terrain arrays + manifest are new.
//
//   npm run build -w @lodestone/textures            # everything
//   npm run build -w @lodestone/textures -- --webp  # skip the (slower) KTX2 arrays
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeBasisEncoder } from 'ktx2-encoder';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const SRC = path.join(root, 'texture-sources');
const OUT = path.join(root, 'client', 'public', 'textures');
const BASIS_OUT = path.join(root, 'client', 'public', 'basis');
const config = JSON.parse(fs.readFileSync(path.join(here, 'sets.json'), 'utf8'));
const args = process.argv.slice(2);
const webpOnly = args.includes('--webp');

// 3dtextures.me naming changed over the years: "_basecolor", "_baseColor",
// "_BaseColor", "_COLOR"; "_normal" / "_NORM"; "_ambientOcclusion" / "_OCC";
// "_roughness" / "_ROUGH"; "_height" / "_DISP".
const MAPS = {
  color: /_(basecolor|color)\.(png|jpe?g)$/i,
  normal: /_(normal|norm)\.(png|jpe?g)$/i,
  ao: /_(ambientocclusion|occ)\.(png|jpe?g)$/i,
  rough: /_(roughness|rough)\.(png|jpe?g)$/i,
  metal: /_(metallic|metalness|metal)\.(png|jpe?g)$/i,
  height: /_(height|disp)\.(png|jpe?g)$/i,
};

/** Map file paths of a set folder (null when the set lacks that map). */
export function findMaps(dir) {
  const files = fs.readdirSync(dir);
  const out = {};
  for (const [k, re] of Object.entries(MAPS)) {
    const f = files.find((x) => re.test(x));
    out[k] = f ? path.join(dir, f) : null;
  }
  if (!out.color) throw new Error(`${dir}: no base color map`);
  return out;
}

// Single-channel buffer at size x size, or a constant fill if the map is missing.
const channel = async (file, size, fallback) => {
  if (!file) return Buffer.alloc(size * size, fallback);
  return sharp(file).resize(size, size, { fit: 'fill' }).greyscale().extractChannel(0).raw().toBuffer();
};

async function buildSetWebp(set) {
  const dir = path.join(SRC, set.folder);
  const maps = findMaps(dir);
  const size = set.size ?? 512; // ref used 1024; 512 is plenty at terrain-prop scale
  const normalSize = set.normalSize ?? size;
  const gain = set.gain ?? 1;
  const out = path.join(OUT, set.id);
  fs.mkdirSync(out, { recursive: true });
  await sharp(maps.color).resize(size, size).linear(gain, 0).webp({ quality: 82 }).toFile(path.join(out, 'color.webp'));
  if (maps.normal) await sharp(maps.normal).resize(normalSize, normalSize).webp({ quality: 90 }).toFile(path.join(out, 'normal.webp'));
  const ormSize = size / 2; // AO/roughness/metalness are low-frequency
  const [ao, rough, metal] = await Promise.all([channel(maps.ao, ormSize, 255), channel(maps.rough, ormSize, 200), channel(maps.metal, ormSize, 0)]);
  const orm = Buffer.alloc(ormSize * ormSize * 3);
  for (let i = 0; i < ormSize * ormSize; i++) {
    orm[i * 3] = ao[i];
    orm[i * 3 + 1] = rough[i];
    orm[i * 3 + 2] = metal[i];
  }
  await sharp(orm, { raw: { width: ormSize, height: ormSize, channels: 3 } }).webp({ quality: 88 }).toFile(path.join(out, 'orm.webp'));
  const bytes = fs.readdirSync(out).reduce((sum, f) => sum + fs.statSync(path.join(out, f)).size, 0);
  console.log(`${set.id.padEnd(16)} ${(bytes / 1024).toFixed(0)} KB${maps.normal ? '' : ' (no normal map)'}`);
}

/** RGBA8 raster of one terrain layer for a map type, at size x size. */
async function terrainLayer(set, kind, size) {
  const maps = findMaps(path.join(SRC, set.folder));
  const gain = set.gain ?? 1;
  if (kind === 'color') {
    const rgb = await sharp(maps.color).resize(size, size, { fit: 'fill' }).linear(gain, 0).removeAlpha().raw().toBuffer();
    // Height in alpha drives height-based splat blending (pebbles poke
    // through sand, grass fills the cracks of rock). Sets without a height
    // map use inverted AO, which tracks the same crevices.
    const h = maps.height ? await channel(maps.height, size, 128) : (await channel(maps.ao, size, 255)).map((v) => 255 - v);
    const out = Buffer.alloc(size * size * 4);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < size * size; i++) {
      out[i * 4] = rgb[i * 3];
      out[i * 4 + 1] = rgb[i * 3 + 1];
      out[i * 4 + 2] = rgb[i * 3 + 2];
      out[i * 4 + 3] = h[i];
      r += rgb[i * 3];
      g += rgb[i * 3 + 1];
      b += rgb[i * 3 + 2];
    }
    const n = size * size * 255;
    return { data: out, mean: [r / n, g / n, b / n] };
  }
  if (kind === 'normal') {
    if (!maps.normal) {
      const flat = Buffer.alloc(size * size * 4);
      for (let i = 0; i < size * size; i++) flat.set([128, 128, 255, 255], i * 4);
      return { data: flat };
    }
    const n = await sharp(maps.normal).resize(size, size, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const out = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) out.set([n[i * 3], n[i * 3 + 1], n[i * 3 + 2], 255], i * 4);
    return { data: out };
  }
  const [ao, rough, metal] = await Promise.all([channel(maps.ao, size, 255), channel(maps.rough, size, 200), channel(maps.metal, size, 0)]);
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) out.set([ao[i], rough[i], metal[i], 255], i * 4);
  return { data: out };
}

let basisModule = null;
async function basis() {
  basisModule ??= await new NodeBasisEncoder().init();
  return basisModule;
}

/**
 * Encode RGBA8 layers as one KTX2 2D array texture with mips.
 * Color and ORM use ETC1S (small, fine for low-frequency or noisy natural
 * surfaces); normals use UASTC + Zstandard, because ETC1S block artifacts in
 * normal maps read as faceting under a low sun. Measured (9 layers, 512 px):
 * color 900 KB, normal 2.36 MB, ORM 378 KB. The normal array is the biggest
 * download in the client; it is still far inside the 15 MB budget.
 */
async function encodeArray(layers, size, kind) {
  const m = await basis();
  const enc = new m.BasisEncoder();
  try {
    enc.setDebug(false);
    enc.setCreateKTX2File(true);
    enc.setTexType(1); // cBASISTexType2DArray
    enc.setMipGen(true);
    const srgb = kind === 'color';
    if (enc.setKTX2AndBasisSRGBTransferFunc) enc.setKTX2AndBasisSRGBTransferFunc(srgb);
    else enc.setKTX2SRGBTransferFunc(srgb);
    enc.setPerceptual(srgb);
    if (kind === 'normal') {
      enc.setUASTC(true);
      if (enc.setNormalMapPreset) enc.setNormalMapPreset();
      else enc.setNormalMap();
      enc.setKTX2UASTCSupercompression(true);
      enc.setRDOUASTC(true);
      // 3.0 trades a little normal precision for ~45% smaller zstd output.
      enc.setRDOUASTCQualityScalar(3.0);
    } else {
      enc.setUASTC(false);
      enc.setQualityLevel(kind === 'color' ? 200 : 160);
      if (enc.setETC1SCompressionLevel) enc.setETC1SCompressionLevel(2);
      else enc.setCompressionLevel(2);
    }
    layers.forEach((l, i) => {
      if (enc.setSliceSourceImage(i, new Uint8Array(l.buffer, l.byteOffset, l.byteLength), size, size, 0) === false) throw new Error(`slice ${i} rejected`);
    });
    const out = new Uint8Array(Math.ceil(layers.length * size * size * 4 * 1.4) + 65536);
    const n = enc.encode(out);
    if (!n) throw new Error(`KTX2 encode failed for ${kind}`);
    return out.slice(0, n);
  } finally {
    enc.delete();
  }
}

async function buildTerrainArrays() {
  const t = config.terrain;
  const size = t.size;
  const byId = new Map(config.sets.map((s) => [s.id, s]));
  const layerSets = t.layers.map((id) => {
    const s = byId.get(id);
    if (!s) throw new Error(`terrain layer ${id} not in sets`);
    return s;
  });
  const dir = path.join(OUT, 'terrain');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { version: 1, size, layers: t.layers, files: {}, bytes: {}, mean: {} };
  for (const kind of ['color', 'normal', 'orm']) {
    const started = Date.now();
    const layers = [];
    for (const s of layerSets) {
      const l = await terrainLayer(s, kind, size);
      layers.push(l.data);
      if (l.mean) manifest.mean[s.id] = l.mean.map((v) => Math.round(v * 1000) / 1000);
    }
    const ktx = await encodeArray(layers, size, kind);
    const hash = crypto.createHash('sha256').update(ktx).digest('hex').slice(0, 12);
    const file = `${kind}-${hash}.ktx2`;
    fs.writeFileSync(path.join(dir, file), ktx);
    manifest.files[kind] = file;
    manifest.bytes[kind] = ktx.length;
    console.log(`terrain ${kind.padEnd(6)} ${layers.length} layers ${size}px  ${(ktx.length / 1024).toFixed(0)} KB  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

// three's KTX2Loader loads basis_transcoder.{js,wasm} from a path at runtime.
// Copying them here pins them to the installed three version.
function copyTranscoder() {
  const req = createRequire(path.join(root, 'client', 'package.json'));
  // three's exports map hides package.json; its main entry sits in build/.
  const threeDir = path.resolve(path.dirname(req.resolve('three')), '..');
  const src = path.join(threeDir, 'examples', 'jsm', 'libs', 'basis');
  fs.mkdirSync(BASIS_OUT, { recursive: true });
  for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) fs.copyFileSync(path.join(src, f), path.join(BASIS_OUT, f));
  console.log(`basis transcoder copied to ${path.relative(root, BASIS_OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = args.filter((a) => !a.startsWith('--'));
  for (const s of config.sets) {
    if (s.ship === false) continue;
    if (only.length && !only.includes(s.id)) continue;
    await buildSetWebp(s);
  }
  if (!webpOnly && (!only.length || only.includes('terrain'))) {
    await buildTerrainArrays();
    copyTranscoder();
  }
}
