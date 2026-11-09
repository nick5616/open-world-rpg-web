# internal/items (WP14)

Pure item logic for the zone: the item record, seeded rolls (rarity with
luck, affixes keyed by element and loot theme, uniques, generated names,
sockets), loot tables (kills, bosses, containers), the inventory (40 slots,
gem pouch, ore pouch, purse, equipment) with stacking, socketing,
unsocketing, gem combining and crafting, and the gear stats combat reads.
No I/O, no clocks, no goroutines; numbers from `contracts/items.yaml`
through `server/pkg/itemdefs`.

Every operation records its changes in a `Delta` (rows created, updated,
deleted); `internal/game` turns a delta into one ordered Postgres
transaction (`items_journal.go`).

The zone glue (sessions, loot hooks, drops, TransferItem, stations,
persistence, handoff) lives in `internal/game/items*.go` and `loot.go`; see
`server/zone/README.md` "Items and loot (WP14)" and decision 0014.

Test: `go test ./internal/items/` (odds, a 2 M-roll distribution check,
every tier's shape, element/theme weighting, stacking and capacity, forging
the sunsteel blade, sockets, gear, loot tables).
