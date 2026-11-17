/// <reference lib="webworker" />
// The buildings worker (WP20, spec 5: "building meshes are assembled in
// workers from the kit on demand"). Long-lived: it compiles worldgen.wasm,
// loads the atlas, rebuilds the towns buffer itself (towns_build is a pure
// function of the atlas, ~0.2 s: cheaper than cloning the parsed layer from
// the main thread), paints the texture array and the road network once, then
// assembles settlement and structure meshes when asked. Every result goes
// back as transferred typed arrays; the main thread only uploads them.
//
// It also finds scatter (trees, rocks, bushes, tufts) standing in buildings,
// on streets and on roads, so the scene can hide it (scatter is generated
// without knowledge of towns; worldgen README "Roads are drawn on the
// terrain").

import { loadWorldgen, parseTowns, townsBytes, type AtlasHandle, type Towns, type Worldgen } from '@lodestone/worldgen';
import { buildSettlementMesh } from './kit';
import { meshTransferables } from './meshBuilder';
import { buildRoadCells } from './roads';
import { buildStructureMesh } from './structures';
import { paintTownTextures, TEX_LAYERS } from './textures';
import { setDetail, textureSizeOf, type Detail } from './detail';
import { Clearance } from './clearance';
import type { BuildingsIn, BuildingsOut } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let wg: Worldgen | null = null;
let atlas: AtlasHandle | null = null;
let towns: Towns | null = null;
let clearance: Clearance | null = null;
const clearedChunks = new Set<string>();
let queue: BuildingsIn[] = [];
let ready = false;

const post = (m: BuildingsOut, transfer: Transferable[] = []) => self.postMessage(m, transfer);
const heightAt = (x: number, z: number) => wg!.collisionHeight(atlas!, x, z);

async function init(atlasBytes: Uint8Array, wasmUrl: string, art: Detail): Promise<void> {
  setDetail(art);
  const t0 = performance.now();
  const module = await WebAssembly.compileStreaming(fetch(wasmUrl)).catch(async () => WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer()));
  wg = await loadWorldgen(module);
  atlas = wg.loadAtlas(atlasBytes);
  towns = parseTowns(townsBytes(wg, atlas));
  const t1 = performance.now();
  const textures = paintTownTextures(textureSizeOf(art));
  const t2 = performance.now();
  const cells = buildRoadCells(towns, heightAt);
  clearance = new Clearance(towns);
  const t3 = performance.now();
  const transfer: Transferable[] = [textures.buffer];
  for (const c of cells) transfer.push(...meshTransferables(c.decal), ...meshTransferables(c.furniture), c.lights.buffer);
  post({ type: 'ready', textures, size: textureSizeOf(art), layers: TEX_LAYERS, cells, ms: { towns: t1 - t0, textures: t2 - t1, roads: t3 - t2 } }, transfer);
  ready = true;
  const q = queue;
  queue = [];
  for (const m of q) handle(m);
}

/** Scatter ids inside the clearance shapes, for the chunks within `radius` of (x, z) not done yet (nearest first). */
function clear(x: number, z: number, radius: number, max: number): void {
  if (!clearance) return;
  const want: [number, number, number][] = [];
  const c0x = Math.floor((x - radius) / 64);
  const c1x = Math.floor((x + radius) / 64);
  const c0z = Math.floor((z - radius) / 64);
  const c1z = Math.floor((z + radius) / 64);
  for (let cz = c0z; cz <= c1z; cz++)
    for (let cx = c0x; cx <= c1x; cx++) {
      const key = `${cx},${cz}`;
      if (clearedChunks.has(key) || !clearance.touchesChunk(cx, cz)) continue;
      const d = Math.hypot(cx * 64 + 32 - x, cz * 64 + 32 - z);
      if (d <= radius) want.push([d, cx, cz]);
    }
  want.sort((a, b) => a[0] - b[0]);
  const ids: bigint[] = [];
  const t0 = performance.now();
  let n = 0;
  for (const [, cx, cz] of want.slice(0, max)) {
    clearedChunks.add(`${cx},${cz}`);
    const c = wg!.buildChunk(atlas!, cx, cz, 0);
    const sc = c.scatter;
    for (let i = 0; i < sc.count; i++) if (clearance.blocked(sc.x(i), sc.z(i))) ids.push(sc.id(i));
    n++;
  }
  if (n === 0) return;
  const arr = BigUint64Array.from(ids);
  post({ type: 'clear', ids: arr, chunks: n, ms: performance.now() - t0, more: want.length > max }, [arr.buffer]);
}

function handle(m: BuildingsIn): void {
  if (!ready && m.type !== 'init') {
    queue.push(m);
    return;
  }
  try {
    switch (m.type) {
      case 'init':
        void init(m.atlas, m.wasmUrl, m.detail).catch((err) => post({ type: 'error', id: 0, message: `init: ${String(err)}` }));
        break;
      case 'settlement': {
        const t0 = performance.now();
        const mesh = buildSettlementMesh(towns!, m.index, heightAt);
        post({ type: 'settlement', id: m.id, index: m.index, mesh, ms: performance.now() - t0 }, [...meshTransferables(mesh.shell), ...meshTransferables(mesh.interior), mesh.lights.buffer, mesh.smoke.buffer]);
        break;
      }
      case 'structure': {
        const t0 = performance.now();
        const mesh = buildStructureMesh(towns!, m.index, heightAt);
        post({ type: 'structure', id: m.id, index: m.index, mesh, ms: performance.now() - t0 }, [...meshTransferables(mesh.shell), mesh.lights.buffer]);
        break;
      }
      case 'clear':
        clear(m.x, m.z, m.radius, m.max);
        break;
    }
  } catch (err) {
    post({ type: 'error', id: 'id' in m ? m.id : 0, message: String(err) });
  }
}

self.onmessage = (e: MessageEvent<BuildingsIn>) => handle(e.data);
