// Writes the golden trajectory files: `npm run golden -w client`.
// WP02's flat/plane files need nothing; WP10's terrain files need the built
// worldgen.wasm (npm run build:wasm) and are skipped with a warning without it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SCENARIOS, runScenario } from './scenarios';
import { goldenPath, serializeGolden, wasmPath } from './io';
import { loadWorldgenGround } from '../worldgenGround';
import { runWp10, scenarioGround, summarize, WP10_SCENARIOS, WP10_SEED } from './wp10';

for (const sc of SCENARIOS) {
  const g = runScenario(sc);
  writeFileSync(goldenPath(sc.name), serializeGolden(g));
  console.log(`wrote ${goldenPath(sc.name)} (${g.states.length} steps)`);
}

if (!existsSync(wasmPath)) {
  console.warn(`${wasmPath} not built: WP10 terrain goldens not regenerated (npm run build:wasm)`);
} else {
  const ground = await loadWorldgenGround(readFileSync(wasmPath), WP10_SEED);
  for (const sc of WP10_SCENARIOS) {
    const g = runWp10(sc, scenarioGround(sc, ground), ground.wg.genVersion);
    const p = goldenPath(`wp10_${sc.name}`);
    writeFileSync(p, serializeGolden(g));
    console.log(`wrote ${p}
  ${summarize(g)}`);
  }
}
