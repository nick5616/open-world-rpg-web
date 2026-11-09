#!/usr/bin/env bash
# Real packet impairment between the two soak VMs (spec 14 "netem profiles";
# the-circle e2e/netem.sh "thailand": delay 80ms 20ms distribution normal
# loss 3%, each way). Only packets to PEER go through netem (a 4-band prio
# root with every TOS on band 1 and a u32 filter on the peer address), so IAP
# SSH and everything else on the VM stay unimpaired. Run on BOTH VMs, each
# naming the other, for ~160 ms RTT and 3% loss in each direction.
#
#   sudo ./netem.sh on  <peer-ip> [netem args...]   # default: thailand
#   sudo ./netem.sh off
#   ./netem.sh show
set -euo pipefail
DEV=${DEV:-$(ip route show default | awk '{print $5; exit}')}
case "${1:-show}" in
  on)
    PEER=${2:?peer ip}
    shift 2
    ARGS=("$@")
    [ ${#ARGS[@]} -gt 0 ] || ARGS=(delay 80ms 20ms distribution normal loss 3%)
    tc qdisc del dev "$DEV" root 2>/dev/null || true
    tc qdisc add dev "$DEV" root handle 1: prio bands 4 priomap 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
    tc qdisc add dev "$DEV" parent 1:4 handle 40: netem "${ARGS[@]}"
    tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 match ip dst "$PEER/32" flowid 1:4
    ;;
  off) tc qdisc del dev "$DEV" root 2>/dev/null || true ;;
  show) ;;
  *) echo "usage: $0 on <peer-ip> [netem args] | off | show" >&2; exit 2 ;;
esac
tc qdisc show dev "$DEV"
tc -s qdisc show dev "$DEV" | grep -A2 netem || true
