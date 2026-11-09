#!/usr/bin/env bash
# The G5 scenario 1 runs in sequence (bots VM, /opt/lodestone): three clean
# runs with the zone on a 4 vCPU slice (2 cores + SMT siblings), three on 4
# physical cores, and the thailand variant of each. Logs: /tmp/g5-s1-<tag>.log
cd "$(dirname "$0")"
for spec in "vcpu4-run2-clean 0,1,8,9" "vcpu4-run3-clean 0,1,8,9" \
  "cores4-run1-clean 0-3" "cores4-run2-clean 0-3" "cores4-run3-clean 0-3" \
  "vcpu4-thailand 0,1,8,9 thailand" "cores4-thailand 0-3 thailand"; do
  set -- $spec
  ./run-s1.sh "$@" > "/tmp/g5-s1-$1.log" 2>&1 || true
done
echo done > /tmp/g5-s1-queue.done
