#!/usr/bin/env bash
# G5 Linux soak, scenario 2 (1,000 bots, 4 zones, crossings) and its
# scenario 4 variant (thailand + hard kill of a pool zone), run on the bots VM
# from /opt/lodestone. Director, Postgres and Redis (containers on 55432 and
# 56379), netsim and bots run here; the four zones run on ZONE_HOST, each
# pinned to its own 4 vCPUs (2 cores + SMT siblings on a c2d-standard-16).
#
#   ./run-s2.sh clean
#   ./run-s2.sh thailand-failover
set -euo pipefail
cd "$(dirname "$0")"
ZONE_HOST=${ZONE_HOST:-10.128.0.3}
SELF=$(hostname -I | awk '{print $1}')
CPUS=${ZONE_CPUS:-"0,1,8,9;2,3,10,11;4,5,12,13;6,7,14,15"}
ulimit -n 1048576 2>/dev/null || ulimit -n 65536
common=(--bots 1000 --zones 4 --bin-dir bin --zone-host "$ZONE_HOST" --infra-host "$SELF" --zone-cpus "$CPUS" --base-port 18700)
case "${1:-clean}" in
  clean) exec node tools/bots/handoff-soak.mjs "${common[@]}" --duration 5m --evidence-prefix g5-linux-s2 --tag 1000-4z-clean --db g5s2 ;;
  thailand-failover) exec node tools/bots/handoff-soak.mjs "${common[@]}" --duration 6m --profile thailand --kill-after 3m \
    --evidence-prefix g5-linux-s4 --tag 1000-4z-thailand-failover --db g5s4 ;;
  *) echo "usage: $0 clean|thailand-failover" >&2; exit 2 ;;
esac
