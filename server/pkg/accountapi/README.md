# server/pkg/accountapi

What the account service, the director and (later) the social service share about players (WP04):

| File | What |
| --- | --- |
| `session.go` | Session tokens: `SignSession` / `VerifySession` (`lss1.<payload>.<Ed25519 sig>`, 12 h), `BearerToken`, key loading (`LODESTONE_SESSION_PRIVATE_KEY` / `_PUBLIC_KEY`, dev fallback), `IsProduction` |
| `db.go` | `DB` over a pgx pool: accounts, local profiles, worlds (official-world seeding), characters (account and local, cross-table name uniqueness under an advisory lock), `UpgradeLocalProfile` (one transaction) |
| `names.go` | `ValidateName`, `ValidateDevUsername`, `RegionOf` (position → region) |
| `uuid.go` | UUID validation / generation for ids that arrive from browsers |
| `dbtest/` | Test helper: a fresh, migrated scratch database per test (dropped afterwards) and a Redis client; skips when infra is down unless `LODESTONE_REQUIRE_INFRA=1` |

Session format and every HTTP endpoint built on this are documented in `server/account/README.md` and `server/director/README.md`.

Test: `go test ./accountapi/...` (needs `npm run infra:up`; uses its own databases).
