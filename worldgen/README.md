# worldgen

Deterministic world generator (spec 5), compiled once to `worldgen.wasm` and
run unchanged in browsers, Node and Go (wazero). WP00 skeleton: generated
contracts in `src/gen/` and the content hash; WP01 builds the generator.

Build: `cargo build -p worldgen --target wasm32-unknown-unknown --release`
Test: `cargo test -p worldgen` · Lint: `cargo clippy -p worldgen -- -D warnings`
