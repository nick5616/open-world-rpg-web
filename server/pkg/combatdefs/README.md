# server/pkg/combatdefs

Go view of `contracts/combat.yaml` (WP13, CR 009). `npm run gen` writes
`combat_gen.json` (embedded here) from the same normalized object as the
client's `contracts/ts/src/gen/combat.ts`, so the zone and the client read
identical numbers. Lookups by id/key, the element effectiveness table, the
skill XP curve, mana, and the wire typeId packing for enemies.

Never edit `combat_gen.json`: edit the YAML and run `npm run gen`
(`npm run gen:check` fails on a stale file).

Tests: `go -C server/pkg test ./combatdefs` (feel limits re-checked from Go,
names from the name table, trees complete, effectiveness, typeId round trip).
