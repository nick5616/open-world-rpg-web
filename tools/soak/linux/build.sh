#!/usr/bin/env bash
# G5 Linux soak: cross-compile every binary the soaks start and stage the
# files they read (scripts, netsim, migrations, worldgen.wasm, voice soak
# testdata) into one directory that mirrors the repo layout, ready to copy to
# the VMs. See README.md here.
#
#   tools/soak/linux/build.sh <stage-dir>
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p "${1:?usage: build.sh <stage-dir>}/bin"
STAGE=$(cd "$1" && pwd)
export GOOS=linux GOARCH=amd64 CGO_ENABLED=0
for spec in zone:./server/zone director:./server/director social:./server/social bots:./tools/bots \
  seedbots:./tools/bots/cmd/seedbots mintworld:./server/pkg/cmd/mintworld devdb:./server/account/cmd/devdb; do
  go build -o "$STAGE/bin/${spec%%:*}" "${spec#*:}"
done
# The voice soak is its own module (outside go.work).
(cd server/social/voice/voicebots && GOWORK=off go build -o "$STAGE/bin/voicebots" .)
test -f worldgen/pkg/worldgen.wasm || node worldgen/scripts/build-wasm.mjs
mkdir -p "$STAGE/scripts" "$STAGE/tools/bots" "$STAGE/tools/netsim" "$STAGE/contracts" "$STAGE/worldgen/pkg" \
  "$STAGE/server/social/voice/voicebots/testdata" "$STAGE/docs/evidence"
cp scripts/lib.mjs "$STAGE/scripts/"
cp tools/bots/*.mjs "$STAGE/tools/bots/"
cp tools/netsim/proxy.mjs tools/netsim/profiles.mjs tools/netsim/package.json "$STAGE/tools/netsim/"
cp -r contracts/migrations "$STAGE/contracts/"
cp worldgen/pkg/worldgen.wasm worldgen/pkg/manifest.json "$STAGE/worldgen/pkg/"
cp server/social/voice/voicebots/testdata/speech.opus.bin "$STAGE/server/social/voice/voicebots/testdata/"
cp tools/soak/linux/*.sh "$STAGE/"
echo '{"type":"module","private":true}' > "$STAGE/package.json"
ls -la "$STAGE/bin"
