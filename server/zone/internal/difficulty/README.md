# internal/difficulty: discovery-stamped areas (playtest 1)

Decision: `docs/decisions/0021-discovery-difficulty.md`. Contract: `docs/cr/012-progression-difficulty.md`.

- `Map` (tick-owned): the world's 256 m areas (`combat.yaml difficulty.cellM`)
  as a flat array of levels; the Haven (areas within 420 m of the world
  spawn: level 1, tier `haven`, never stored); tiers by level; `Near` (the
  areas within a radius, own first), `NeedsClaim`, `Set` (stamps are
  immutable; a provisional level is replaced by the real stamp). Implements
  `combat.Areas` (`AreaAt`), so combat reads it directly.
- `Propose`: the stamp rule (discoverer's level + danger bonus, pulled to
  the stamped neighbours' mean, clamped within `maxStep` of them).
- `Store`: `PGStore` (Postgres `area_difficulty`, migration 0021: read the
  neighbours, propose, `INSERT ... ON CONFLICT DO NOTHING`, read back the
  winner) and `MemStore` (the same semantics in memory, safe to share
  between in-process zones). Both are called only from the zone's
  difficulty worker goroutine (`internal/game/difficulty.go`), never from
  the tick. `Geometry` is the immutable snapshot the worker uses.

Tests: `difficulty_test.go` (rule, Haven, immutability, reach covers the
enemy spawn radius, first writer wins in memory), `pgstore_test.go` (two
pools racing on a scratch Postgres; skipped without infra).
