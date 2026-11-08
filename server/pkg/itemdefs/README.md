# itemdefs (WP14)

Go view of `contracts/items.yaml`: rarities and odds, materials (incl. the
WP15 `KillsDemons` / `DemonStagger` flags), gems and cuts, ores, every base
item, affixes, uniques, names, recipes, the starter kit and loot tables.
`npm run gen` writes `items_gen.json` (embedded here) and the client's
`contracts/ts/src/gen/items.ts` from the same normalized object. Do not edit
the JSON; edit the YAML and regenerate. Item keys are a contract (stored in
the database): add, never rename.

`D.KillsDemons("weapon:sunsteel_blade")` is the sunsteel rule check.

Tested through `server/zone/internal/items` and `npm run gen:check`.
