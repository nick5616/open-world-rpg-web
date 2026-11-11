# worldgen archive

Superseded generator builds, kept loadable for worlds pinned to them (spec 5
rule 6 and "keeping old worlds working"; decision 0007: a world row pins
`gen_version`, and `atlas_hash` proves the output).

| genVersion | File | Golden table | Source |
| --- | --- | --- | --- |
| 1 | `worldgen-42a66cc191bee49d.wasm` (579,496 B) | `worldgen/golden/golden-v1.json` | git `56a0d36`, rustc 1.99.1 |
| 2 | `worldgen-1dcd2ffc09618d97.wasm` (617,354 B) | `worldgen/golden/golden-v2.json` | git `73f436c`, rustc 1.99.1 (rebuilt from that commit, bit-identical to the dev build) |

The current build (`worldgen/pkg/worldgen.wasm`, `npm run build:wasm`) is
genVersion 3 (`docs/cr/038-vertical-world.md`, the vertical world).

## Who loads it

- **Zone** (`server/zone/terrain.go`) and **bots** (`tools/bots/terrain.go`)
  call `worldhost.LoadForGenVersion(row.gen_version)`: the default wasm when
  it matches, else the archived build named here (sha256 and genVersion
  checked against `manifest.json`), else the default (and `OpenRow` refuses
  with the usual pin error). `LODESTONE_WORLDGEN_ARCHIVE` overrides the
  directory (default `worldgen/archive`, searched upward like the wasm).
- **Client**: online play passes the zone's Welcome `genVersion` to the world
  runtime, which compiles the matching archived wasm (bundled as a hashed
  asset by Vite) instead of the current one (`client/src/world/core/wasmFor.ts`).
- **Golden**: `npm run test:golden` checks every entry against its own table
  in Node and Go/wazero (Chromium and native Rust run the current build).

## Rules

- Never edit or rebuild a file here: it is the pinned artifact. A genVersion
  bump moves the outgoing `worldgen-<hash>.wasm` here with its golden table
  (`git mv worldgen/golden/golden.json worldgen/golden/golden-v<N>.json`).
- Retire an entry only when no world row uses that `gen_version`.
- Deployments ship this directory next to `worldgen.wasm`; the object-storage
  archive (`gs://<project>-lodestone-worldgen/worldgen/`) already holds every
  `worldgen-<hash>.wasm` ever uploaded (decision 0018 section 8).
