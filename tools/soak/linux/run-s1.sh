#!/usr/bin/env bash
# G5 Linux soak, scenario 1 (and its thailand variant), run on the bots VM
# from /opt/lodestone. The zone runs on ZONE_HOST over ssh, pinned with
# taskset. Usage:
#
#   ./run-s1.sh <tag> <zone-cpus> [clean|thailand]
#   ./run-s1.sh vcpu4-run1-clean  0,1,8,9          # 4 vCPU = 2 cores + SMT siblings (c2d)
#   ./run-s1.sh cores4-run1-clean 0-3              # 4 physical cores, siblings idle
#   ./run-s1.sh vcpu4-thailand    0,1,8,9 thailand
#   PREFIX=g5-linux-vcpu4-confirm ./run-s1.sh vcpu4-run1-clean 0,1,8,9   # evidence as <PREFIX>-s1-<tag>.*
set -euo pipefail
cd "$(dirname "$0")"
ZONE_HOST=${ZONE_HOST:-10.128.0.3}
ulimit -n 1048576 2>/dev/null || ulimit -n 65536
exec node tools/bots/scale-soak.mjs --bots 300 --enemies 2000 --duration 4m --profile "${3:-clean}" \
  --bin-dir bin --zone-host "$ZONE_HOST" --zone-cpus "$2" --prefix "${PREFIX:-g5-linux}" --tag "$1"
