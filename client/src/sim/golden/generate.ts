// Writes the golden trajectory files: `npm run golden -w client`.
// WP02's flat/plane files need nothing; WP10's terrain files need the built
// worldgen.wasm (npm run build:wasm) and are skipped with a warning without it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SCENARIOS, runScenario } from './scenarios';
import { goldenPath, serializeGolden, wasmPath } from './io';
import { loadWorldgenGround } from '../worldgenGround';
import { runWp10, scenarioGround, summarize, WP10_SCENARIOS, WP10_SEED } from './wp10';
import { runWp13, WP13_SCENARIOS } from './wp13';
import { RIDE_SCENARIOS, rideRun, rideSummary } from './ride';
import { WEATHER_SCENARIOS, weatherRun, weatherSummary } from './weather';
import { runVertical, VERTICAL_SCENARIOS, verticalGround } from './vertical';

for (const sc of SCENARIOS) {
  const g = runScenario(sc);
  writeFileSync(goldenPath(sc.name), serializeGolden(g));
  console.log(`wrote ${goldenPath(sc.name)} (${g.states.length} steps)`);
}

// WP13: dodge + dash variants on flat/plane ground.
for (const sc of WP13_SCENARIOS) {
  const g = runWp13(sc.name);
  writeFileSync(goldenPath(`wp13_${sc.name}`), serializeGolden(g));
  console.log(`wrote ${goldenPath(`wp13_${sc.name}`)} (${g.states.length} steps)`);
}

// CR 027: riding the spirit steed (flat, plane, two synthetic courses).
for (const sc of RIDE_SCENARIOS) {
  const g = rideRun(sc.name);
  writeFileSync(goldenPath(`pt2_${sc.name}`), serializeGolden(g));
  console.log(`wrote ${goldenPath(`pt2_${sc.name}`)} ${JSON.stringify(rideSummary(g))}`);
}

// CR 030: snow, rain from the weather field and a gale under the glider.
for (const sc of WEATHER_SCENARIOS) {
  const g = weatherRun(sc.name);
  writeFileSync(goldenPath(`pt2_${sc.name}`), serializeGolden(g));
  console.log(`wrote ${goldenPath(`pt2_${sc.name}`)} ${weatherSummary(g)}`);
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
  // CR 038: the vertical world (sky islands, lifts, the Underground).
  const vw = verticalGround(ground);
  for (const name of VERTICAL_SCENARIOS) {
    const g = runVertical(name, vw, ground.wg.genVersion);
    const p = goldenPath(`pt2_vertical_${name}`);
    writeFileSync(p, serializeGolden(g));
    console.log(`wrote ${p} (${g.states.length} steps)`);
  }
}
