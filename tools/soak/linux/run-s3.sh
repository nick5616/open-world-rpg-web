#!/usr/bin/env bash
# G5 Linux soak, scenario 3 (50 voice bots) and its thailand variant, all on
# the bots VM from /opt/lodestone: LiveKit 1.8 as a container (host network,
# one muxed UDP port, nothing exposed: the VPC firewall only admits IAP SSH
# and internal traffic), zone + social spawned by voicebots from bin/,
# Redis/Postgres containers (a scratch database for social).
#
#   ./run-s3.sh clean       # docs/evidence/g5-linux-s3-50.*
#   ./run-s3.sh thailand    # docs/evidence/g5-linux-s4-voice-thailand-50.*
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
ulimit -n 1048576 2>/dev/null || ulimit -n 65536
if ! sudo docker ps --format '{{.Names}}' | grep -qx lodestone-soak-livekit; then
  sudo docker run -d --name lodestone-soak-livekit --network host livekit/livekit-server:v1.8 \
    --dev --bind 127.0.0.1 --node-ip 127.0.0.1 --config-body "rtc: {udp_port: 7882, tcp_port: 7881, use_external_ip: false}" >/dev/null
  until curl -fs http://127.0.0.1:7880/ >/dev/null; do sleep 1; done
fi
PG=$(bin/devdb create lodestone_wp04_g5voice | tail -1)
world=$(cat /proc/sys/kernel/random/uuid)
cd server/social/voice/voicebots
case "${1:-clean}" in
  clean) LODESTONE_PG_URL=$PG "$ROOT/bin/voicebots" -spawn -bin-dir "$ROOT/bin" -livekit ws://127.0.0.1:7880 -world "$world" \
    -out "$ROOT/docs/evidence/g5-linux-s3-50" ;;
  thailand) LODESTONE_PG_URL=$PG "$ROOT/bin/voicebots" -spawn -bin-dir "$ROOT/bin" -livekit ws://127.0.0.1:7880 -world "$world" \
    -netsim thailand -out "$ROOT/docs/evidence/g5-linux-s4-voice-thailand-50" ;;
esac
