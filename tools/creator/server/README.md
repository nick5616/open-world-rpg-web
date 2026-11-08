# tools/creator/server: creator Go endpoint

Go module `lodestone/tools/creator/server` (in `go.work`). Mints worlds into
the shared `worlds` table, lists them, and (flag on only) turns vibe text into
a WorldSpec. The web app is in `../web` (see `../README.md`).

```
npm run server -w @lodestone/creator     # = go run ./tools/creator/server from the repo root
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `LODESTONE_CREATOR_PORT` | `8094` | Listen port |
| `LODESTONE_PG_URL` | local compose | Postgres (the `worlds` table) |
| `LODESTONE_REDIS_ADDR` | local compose | Redis, used only for the vibe cache and only when the flag is on |
| `LODESTONE_WORLDGEN_WASM` | `worldgen/pkg/worldgen.wasm` found upward from cwd / the binary | The generator to mint with |
| `LODESTONE_WORLDSPEC_SCHEMA` | `contracts/worldspec.schema.json` found the same way | The contract schema (never copied) |
| `LODESTONE_CREATOR_LLM` | off | `1` / `true` / `on` enables the vibe path (also needs the key) |
| `ANTHROPIC_API_KEY` | unset | Messages API key, server-side only |
| `LODESTONE_CREATOR_LLM_MODEL` | `claude-haiku-5-5` | Model id |
| `LODESTONE_CREATOR_LLM_BASE_URL` | `https://api.anthropic.com` | Tests and the e2e run point it at a fake |
| `LODESTONE_CREATOR_VIBE_TTL` | `720h` | Vibe cache lifetime |
| `LODESTONE_CREATOR_TOKEN` | unset | Bearer token required on POSTs; **required** when `LODESTONE_ENV=production` |
| `LODESTONE_CORS_ORIGIN` | `*` | CORS origin (dev uses the Vite proxy anyway) |

## Endpoints

Errors are `{"error": "<code>", "message": "...", "details": [...]}`.

| Route | Body | Response |
| --- | --- | --- |
| `GET /v1/config` | | `{llm, model, genVersion, wasmSha256, specVersion, auth}` |
| `GET /v1/worlds?limit=N` | | `{worlds: [{id, name, seed, spec, genVersion, atlasHash, official, createdAt}]}` newest first |
| `POST /v1/normalize` | `{spec}` | `{spec, changes}` or 422 `invalid_spec` with `details` |
| `POST /v1/mint` | `{seed}` or `{spec, source?}` | 201 `{world, existed:false, source, changes, atlas:{bytes, sites, buildMs, seaY, spawn}, wasmSha256}`; 200 with `existed:true` if that exact world (seed, genVersion, atlasHash) was already minted; 400 `bad_seed`/`bad_request`; 422 `invalid_spec`/`worldgen` |
| `POST /v1/vibe` | `{prompt, seed?}` | `{spec, changes, cached, attempts, model}`; 503 `llm_disabled` (flag off / no key); 400 `bad_prompt` (empty or > 500 chars); 502 `llm_failed` with `details` |
| `GET /healthz`, `GET /metrics` | | `creator_mints_total{source}`, `creator_vibe_total{outcome}`, `creator_rejected_total` |

### What a mint stores

- `{seed}`: `spec_from_seed(seed)` checked against the strict schema, **not**
  clamped (renormalizing its weights would make a different world than "this
  seed").
- `{spec}`: normalized (`internal/spec`, same rules and fixtures as the TS
  page), then built.
- Row: `name` = the spec name, `seed`, `spec` = the canonical spec JSON from the
  atlas SPEC section, `gen_version` = `gen_version()` as decimal text (`"1"`),
  `atlas_hash` = `hash_buffer(atlas)` as 16 lower-case hex digits,
  `official = false`. This is the format WP07's `server/pkg/worldhost` pins
  against, so a creator world opens in a zone unchanged.

The wasm runs under wazero (`internal/worldgen`, adapted from
`worldgen/harness/go/wghost.go`; WP07's worldhost was not on main yet), one
fresh instance per call, one atlas build at a time.

### The vibe path

`internal/vibe`: one `POST /v1/messages` with plain `net/http` (no SDK),
`anthropic-version: 2026-10-21`, model `claude-haiku-5-5`, effort `low`,
structured output `output_config.format = {type: "json_schema", schema}` where
the schema is the contract schema minus the keywords the API cannot enforce
(ranges, lengths, patterns, array size). The answer is normalized like any
other spec (seed replaced by the creator's); a failed call or a rejected spec
gets exactly one retry, then 502. Results are cached in Redis under
`creator:vibe:<sha256(normalized prompt + "\n" + specVersion)>` (normalized =
lowercased, whitespace collapsed). The model client is only constructed when
the flag and the key are both set; `TestFlagOffNeverReachesModel` and the
process test count requests on an injected transport and a fake server to
prove nothing reaches a model with the flag off.

`internal/vibe/vibetest` is the fake Messages API (keyword-driven answers,
deliberately out of range in places, scripted failures `[fail-once]`,
`[fail-always]`, `[refuse]`, `[http500]`); `cmd/fakeclaude` serves it for the
e2e run. No test calls the real API.

## Test

```
cd tools/creator/server
go test ./...                       # unit + TS/Go fixture agreement + store (scratch DB) + process integration
LODESTONE_REQUIRE_INFRA=1 LODESTONE_REQUIRE_WASM=1 go test ./...   # fail instead of skip
```

`creator_integration_test.go` builds the binary and runs it against a scratch
Postgres database (`server/pkg/accountapi/dbtest`), the shared Redis and a fake
Messages API in the test process: mint from seed (golden atlas hash for seed
1234), from sliders and from vibe, rows checked in Postgres, cache entry checked
in Redis, then a restart with the flag off and zero model requests.
