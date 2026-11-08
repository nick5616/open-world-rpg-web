// Node host of the WP07 height comparison. Run through vite-node so the
// TypeScript sources of @lodestone/worldgen load as-is:
//   HEIGHTCMP_IN=in.json HEIGHTCMP_OUT=out.json HEIGHTCMP_WASM=worldgen.wasm \
//     node node_modules/vite-node/vite-node.mjs server/pkg/worldhost/jscheck/heights.mjs
// server/pkg/cmd/heightcmp drives it; see that command for the comparison.
import fs from 'node:fs';
import { loadWorldgen, chunkSurfaceHeight, hex64 } from '@lodestone/worldgen';
import { runCheck } from './check.mjs';

const input = JSON.parse(fs.readFileSync(process.env.HEIGHTCMP_IN, 'utf8'));
const wg = await loadWorldgen(fs.readFileSync(process.env.HEIGHTCMP_WASM));
const out = runCheck(wg, { chunkSurfaceHeight, hex64 }, input);
out.host = `node ${process.version} (${process.platform} ${process.arch})`;
fs.writeFileSync(process.env.HEIGHTCMP_OUT, JSON.stringify(out));
