// Writes the golden trajectory files: `npm run golden -w client`.
import { writeFileSync } from 'node:fs';
import { SCENARIOS, runScenario } from './scenarios';
import { goldenPath, serializeGolden } from './io';

for (const sc of SCENARIOS) {
  const g = runScenario(sc);
  writeFileSync(goldenPath(sc.name), serializeGolden(g));
  console.log(`wrote ${goldenPath(sc.name)} (${g.states.length} steps)`);
}
