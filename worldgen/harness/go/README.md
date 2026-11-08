# lodestone/worldgen/harness (Go)

Go/wazero host of the worldgen golden table: `wghost.go` binds the wasm ABI
(documented in `worldgen/README.md`), `golden_test.go` checks every hash in
`worldgen/golden/golden.json` with the wazero compiler (and, under
`LODESTONE_REQUIRE_WASM=1`, the interpreter). See `../README.md`.

```
npm run build:wasm
cd worldgen/harness/go && go test -v ./...
```
