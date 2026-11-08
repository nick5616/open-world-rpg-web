#!/usr/bin/env bash
# WP14 evidence: runs the three process tests and keeps their logs in
# docs/evidence (wp14-g4-loop, wp14-kill-mid-grant, wp14-drop-pickup-despawn).
# Needs the shared infra (Postgres) and worldgen/pkg/worldgen.wasm.
set -u
cd "$(dirname "$0")"
out=../../docs/evidence
export LODESTONE_EVIDENCE=1
go test . -run 'TestG4LoopForgeSunsteelBlade' -v -count=1 > "$out/wp14-g4-loop.txt" 2>&1; echo "g4 loop: exit $?"
go test . -run 'TestZoneProcessKillMidGrantNeverDuplicates' -v -count=1 > "$out/wp14-kill-mid-grant.txt" 2>&1; echo "kill mid-grant: exit $?"
go test . -run 'TestZoneProcessDropPickupDespawn' -v -count=1 > "$out/wp14-drop-pickup-despawn.txt" 2>&1; echo "drop/pickup/despawn: exit $?"
