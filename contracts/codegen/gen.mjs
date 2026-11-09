#!/usr/bin/env node
// Contract code generator. `npm run gen` writes every generated file;
// `npm run gen:check` fails if any generated file is stale (CI runs this).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { parseProtocol, genTs, genGo, genGoVectorTest, buildVectors } from './lib/protocol.mjs';
import { parseConstants, genConstantsTs, genConstantsGo, genConstantsRust } from './lib/constants.mjs';
import { parseSocial, genSocialTs, genSocialGo } from './lib/social.mjs';
import { parseWorldSpec, genWorldSpecTs, genWorldSpecGo, genWorldSpecRust } from './lib/worldspec.mjs';
import { parseCombat, genCombatTs, genCombatJson } from './lib/combat.mjs'; // WP13 (CR 009)
import { parseItems, genItemsTs, genItemsJson } from './lib/items.mjs'; // WP14 (CR 010)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const check = process.argv.includes('--check');

const protocol = parseProtocol(YAML.parse(rd('contracts', 'protocol.yaml')));
const constants = parseConstants(YAML.parse(rd('contracts', 'constants.yaml')));
const social = parseSocial(YAML.parse(rd('contracts', 'social.yaml')));
const worldspec = parseWorldSpec(JSON.parse(rd('contracts', 'worldspec.schema.json')));
const combat = parseCombat(YAML.parse(rd('contracts', 'combat.yaml')), constants);
const items = parseItems(YAML.parse(rd('contracts', 'items.yaml')), combat);

const outputs = {
  'contracts/ts/src/gen/protocol.ts': genTs(protocol),
  'contracts/ts/src/gen/constants.ts': genConstantsTs(constants),
  'contracts/ts/src/gen/social.ts': genSocialTs(social),
  'contracts/ts/src/gen/worldspec.ts': genWorldSpecTs(worldspec),
  'contracts/golden/protocol_vectors.json': JSON.stringify(buildVectors(protocol), null, 2) + '\n',
  'server/pkg/proto/protocol_gen.go': genGo(protocol),
  'server/pkg/proto/protocol_vectors_gen_test.go': genGoVectorTest(),
  'server/pkg/constants/constants_gen.go': genConstantsGo(constants),
  'server/pkg/socialproto/social_gen.go': genSocialGo(social),
  'server/pkg/worldspec/worldspec_gen.go': genWorldSpecGo(worldspec),
  'worldgen/src/gen/constants.rs': genConstantsRust(constants),
  'worldgen/src/gen/worldspec.rs': genWorldSpecRust(worldspec),
  'contracts/ts/src/gen/combat.ts': genCombatTs(combat),
  'server/pkg/combatdefs/combat_gen.json': genCombatJson(combat),
  'contracts/ts/src/gen/items.ts': genItemsTs(items),
  'server/pkg/itemdefs/items_gen.json': genItemsJson(items),
};

let stale = 0;
for (const [rel, content] of Object.entries(outputs)) {
  const abs = path.join(root, ...rel.split('/'));
  const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (cur === content) continue;
  if (check) {
    console.error(`stale: ${rel}`);
    stale++;
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    console.log(`wrote ${rel}`);
  }
}
if (check && stale) {
  console.error(`${stale} generated file(s) out of date: run \`npm run gen\``);
  process.exit(1);
}
if (check) console.log('generated files up to date');
