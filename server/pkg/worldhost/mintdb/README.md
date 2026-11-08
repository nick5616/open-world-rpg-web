# server/pkg/worldhost/mintdb

Writes minted worlds into Postgres `worlds` rows (WP07). `EnsureOfficial`:

- official row missing: insert a minted one (`spec_from_seed(seed)`, the
  wasm's `gen_version`, `atlas_hash`);
- placeholder row (WP04 seeded `gen_version = 'placeholder'` before worldgen
  was wired in): fill spec, gen_version and atlas_hash in place, keeping its
  id and seed (characters already live there). Compare-and-set on
  gen_version, so concurrent account instances can't interleave;
- minted row: untouched, and the wasm is not even loaded.

`SetMint` refuses to change a minted world (`ErrMinted`) unless the values
are identical: a world is pinned forever (spec 5 rule 6).

Callers: `server/account` (`seedWorld` at startup) and
`server/pkg/cmd/mintworld -official`.

Test: `go test ./worldhost/mintdb` from `server/pkg` (needs `npm run infra:up`
and the built wasm; scratch databases per test).
