// Ground heights through the browser/Node path of @lodestone/worldgen, for
// the WP07 cross-host comparison (server/pkg/cmd/heightcmp). Shared by
// heights.mjs (Node, via vite-node) and page/main.mjs (headless Chromium).
//
// Input: { spec, points: [[xHex, zHex], ...] } where each coordinate is the
// IEEE-754 bit pattern of an f64 as 16 hex digits (decimal text could round).
// Output: per point, collisionHeight (the wasm export, what the client's
// movement asks) and chunkSurfaceHeight (the pure-TS formula on LOD 0 chunk
// heights, what a renderer/predictor can use without a wasm call), both as
// f64 bit patterns; null for chunkSurfaceHeight outside chunk_build's range.

const bits = new DataView(new ArrayBuffer(8));
const toF64 = (hex) => {
  bits.setBigUint64(0, BigInt('0x' + hex), true);
  return bits.getFloat64(0, true);
};
const toHex = (v) => {
  bits.setFloat64(0, v, true);
  return bits.getBigUint64(0, true).toString(16).padStart(16, '0');
};

export function runCheck(wg, lib, input) {
  const t0 = performance.now();
  const atlas = wg.buildAtlas(input.spec);
  const atlasMs = performance.now() - t0;
  const pts = input.points.map(([xh, zh]) => [toF64(xh), toF64(zh)]);

  const t1 = performance.now();
  const wasm = pts.map(([x, z]) => toHex(wg.collisionHeight(atlas, x, z)));
  const wasmMs = performance.now() - t1;

  // Group points by chunk so each chunk is built once and then dropped
  // (keeping ~4,000 chunks alive would cost hundreds of MB).
  const chunk = new Array(pts.length).fill(null);
  const byChunk = new Map();
  pts.forEach(([x, z], i) => {
    const cx = Math.floor(Math.floor(x) / 64);
    const cz = Math.floor(Math.floor(z) / 64);
    if (cx < -64 || cx > 127 || cz < -64 || cz > 127) return;
    const k = cx * 1000 + cz;
    if (!byChunk.has(k)) byChunk.set(k, { cx, cz, idx: [] });
    byChunk.get(k).idx.push(i);
  });
  const t2 = performance.now();
  for (const { cx, cz, idx } of byChunk.values()) {
    const c = wg.buildChunk(atlas, cx, cz, 0);
    for (const i of idx) chunk[i] = toHex(lib.chunkSurfaceHeight(c, pts[i][0], pts[i][1]));
  }
  const chunkMs = performance.now() - t2;
  const atlasHash = lib.hex64(atlas.hash);
  atlas.free();
  return { atlasHash, wasm, chunk, chunks: byChunk.size, atlasMs, wasmMs, chunkMs };
}
