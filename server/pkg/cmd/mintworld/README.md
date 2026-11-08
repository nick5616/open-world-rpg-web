# server/pkg/cmd/mintworld

Mints a world with `worldgen.wasm` (WP07): WorldSpec (`spec_from_seed`, or
`-spec file.json`), atlas build, and the row values
`(seed, spec, gen_version, atlas_hash)` as JSON. With `-official` it writes
the official `worlds` row in `LODESTONE_PG_URL` through `worldhost/mintdb`
(insert if missing, upgrade a placeholder in place, never touch a minted
world). The account service does the same at startup when the wasm is built,
so this is for operators and for inspecting seeds.

```
npm run build:wasm
go run ./server/pkg/cmd/mintworld -seed 20261108       # print only
go run ./server/pkg/cmd/mintworld -official             # mint/upgrade the official row
```

Test: covered by `worldhost/mintdb` tests (same code path).
