#!/usr/bin/env bash
# Collects docs/evidence/wp10-goldens.txt (run from the repo root).
export PATH="$HOME/sdk/go/bin:$HOME/go/bin:$PATH"
root=$(pwd)
out="$root/docs/evidence/wp10-goldens.txt"
{
  echo "# WP10 terrain goldens: TS generator summary (npm run golden -w client), the Go replay"
  echo "# (go test ./movement -run 'TerrainGoldens|ClientGoldens' -v) and the zone validation replay"
  echo "# (go test ./internal/game -run ValidationPassesEveryLegitMode -v)."
  echo "# $(date -u +%FT%TZ), worldgen.wasm sha256 $(node -e "console.log(require('./worldgen/pkg/manifest.json').sha256.slice(0,16))"), seed 20261108"
  echo
  (cd client && npx vite-node src/sim/golden/generate.ts 2>&1 | sed 's|^wrote .*golden[\\/]|wrote |')
  echo
  (cd server/pkg && go test ./movement -run 'TerrainGoldens|ClientGoldens$' -v -count=1 2>&1 | grep -E "max|PASS|ok")
  echo
  (cd server/zone && go test ./internal/game -run 'ValidationPassesEveryLegitMode|PerModeValidationRejects' -v -count=1 2>&1 | grep -E "frames applied|PASS|ok")
} > "$out"
cat "$out"
