# server/zone/internal/night

The pure half of night (WP15, spec 8 "Night and demons"): wards (settlement
radius + WARD_MARGIN_M) and road lanterns from the towns buffer, the demon
budget under this moon, where a pack rises, which towns are attacked on
which night (seeded per seed/town/night, so every zone agrees) and what a
defense wave is made of. The zone glue is `internal/game/night.go`; demons
themselves are combat enemies (`internal/combat/demon.go`); the clock is
`server/pkg/weather`. Decision: docs/decisions/0015-night-chemistry.md.

Test (from `server/zone`): `go test ./internal/night`.
