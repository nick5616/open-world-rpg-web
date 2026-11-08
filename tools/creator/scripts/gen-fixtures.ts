// npm run fixtures -w @lodestone/creator: rewrite tools/creator/fixtures/normalize.json
// from test/fixture-cases.ts (see test/build-fixtures.ts for why it exists).
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_FILE, fixtureText } from '../test/build-fixtures';

fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
fs.writeFileSync(FIXTURE_FILE, fixtureText());
console.log(`wrote ${FIXTURE_FILE}`);
