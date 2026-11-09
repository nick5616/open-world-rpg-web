#!/usr/bin/env bash
# G5 (4 vCPU follow-up): the in-process scenario 1 benchmark (300 players +
# 2,000 awake enemies, the whole zone tick without sockets, on the official
# world's terrain) on the zone VM, pinned like run-s1.sh's zone. Run on the
# zone VM from /opt/lodestone after build.sh staged bin/game.test:
#
#   ./bench-inprocess.sh                 # 0,1,8,9 (4 vCPU = 2 cores + SMT) and 0-3 (4 cores), 3 runs each, alternating
#   ./bench-inprocess.sh 5 0,1,8,9       # 5 runs, one CPU set
#
# Prints one BenchmarkScale line per run (tick p50/p99/max and the mean ms of
# each phase). Reference: docs/evidence/g5-linux-inprocess-bench.txt (main @
# 1d1f626) and docs/evidence/g5-tick-vcpu4-inprocess.txt.
set -euo pipefail
cd "$(dirname "$0")"
RUNS=${1:-3}
shift || true
if [ $# -gt 0 ]; then SETS=("$@"); else SETS=(0,1,8,9 0-3); fi
export LODESTONE_BENCH_TERRAIN=1 LODESTONE_WORLDGEN_WASM="$PWD/worldgen/pkg/worldgen.wasm" GOMAXPROCS=4
for r in $(seq 1 "$RUNS"); do
  for cpus in "${SETS[@]}"; do
    line=$(taskset -c "$cpus" bin/game.test -test.run NONE_ -test.bench 'Scale/p300_e2000' -test.cpu 4 -test.benchtime 900x | grep Benchmark)
    echo "run=$r cpus=$cpus $line"
  done
done
