# 0017: WorldSpec creator tool (WP17)

Date: 2026-11-08

## Validate structurally, then clamp, then validate strictly

Spec 6 says a creator or model spec is validated and rejected on any failure,
*and* that every number is clamped and unknown tags dropped. Taken literally
those conflict (a schema-valid spec has nothing left to clamp). We read it as:
validate the *structure* (required keys, no extra keys, JSON types, the enums
that cannot be clamped: palette, nameGrammar, the seed pattern), then clamp
what can be repaired (numeric ranges, integer rounding, name characters and
length, loot tags), then validate against the contract schema unchanged. The
relaxed schema is derived from `contracts/worldspec.schema.json` at load time
by the same rules in TS and Go; nothing is copied.

## Weights are renormalized by their max, not their sum

The generator already divides biome weights by their max (atlas/climate.rs),
so storing max-normalized weights keeps the numbers equal to what the
generator effectively uses, keeps every weight inside [0, 1], and is exactly
idempotent in IEEE arithmetic (max/max == 1). Sum-normalizing would shrink
six weights to ~0.17 each and drift in the last bit on re-normalization.

## Seed-only mints are not normalized

`spec_from_seed` output is in range by construction but its weights are not
max-normalized. Normalizing it would mint a different world than "this
seed" (the atlas embeds the spec, so its hash would differ from the golden
one). A `{seed}` mint stores the generator's spec untouched after a strict
schema check; the page tracks "seed only" vs "edited" for the same reason.

## TS and Go must agree bit for bit

The preview hashes the exact spec the endpoint mints. `normalize.ts` and
`normalize.go` are line-by-line ports; `tools/creator/fixtures/normalize.json`
(generated from the TS side) is replayed by the Go tests with exact float
comparison. Details that mattered: rounding is `floor(x + 0.5)` (JS
`Math.round` and Go `math.Round` disagree on negative halves); `-0` is turned
into `0` (Go marshals `-0`, JS `0`); fields are walked in the schema's
`required` array order so change lists match (Go maps are unordered).

## Name blocklist by word prefix

The worldgen name blocklist matches substrings, which is right for generated
syllable soup but would refuse creator words like "Lavender" or "Wanderer".
The creator blocks a name when any word starts with a blocked stem.

## World rows match WP07's worldhost

`gen_version` is the generator major version as decimal text ("1"),
`atlas_hash` 16 lower-case hex digits of `hash_buffer(atlas)`, `spec` the
canonical spec from the atlas SPEC section: the format WP07's
`server/pkg/worldhost/mint.go` pins against. WP07's package was not on main,
so the creator carries its own small wazero host adapted from the golden
harness; switching to worldhost later is a drop-in change in
`internal/worldgen`. Minting the same `(seed, genVersion, atlasHash)` twice
returns the existing row (advisory lock, no new index: that would be a
migration for a cosmetic race).

## Vibe: structured outputs, not forced tool use

One Messages API call with `output_config.format` (JSON schema) rather than a
forced `tool_choice`, because forced tool choice is being withdrawn on newer
models and JSON output needs no tool round trip. The schema sent is the
contract schema minus the keywords the API cannot enforce (ranges, lengths,
patterns, array size); the normalize gate enforces those afterwards. Model
`claude-haiku-5-5`, effort `low`, `anthropic-version: 2026-10-21` (which
rejects sampling parameters; we send none). One retry, no repair loop. The
cache lives in Redis (`creator:vibe:<sha256(normalized prompt + "\n" +
specVersion)>`, 30 days): losing it only costs a call, and Postgres would
have needed a migration. The model never picks the seed: the creator's seed
replaces whatever the model wrote, so a cached vibe can be re-rolled.

## The flag is structural

The model client is constructed only when `LODESTONE_CREATOR_LLM` is on and a
key is present; otherwise no object in the process can make the call. Tests
count requests on an injected transport and a fake Messages API (in process
and across the process boundary) to show zero calls with the flag off.
