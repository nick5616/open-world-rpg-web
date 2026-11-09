#!/usr/bin/env bash
# The G5 runs after scenario 1 (bots VM, /opt/lodestone): scenario 2,
# scenario 4 (S2 + thailand + hard kill), scenario 3 and its thailand
# variant, then scenario 1 once more under real tc netem "thailand" between
# the two VMs (zone on 4 physical cores). Waits for queue-s1.sh first.
# Resumable: a step whose evidence file exists is skipped.
# Logs: /tmp/g5-<name>.log
cd "$(dirname "$0")"
ZONE_HOST=${ZONE_HOST:-10.128.0.3}
SELF=$(hostname -I | awk '{print $1}')
EV=docs/evidence
have() { [ -f "$EV/$1" ]; }
until [ -f /tmp/g5-s1-queue.done ] || have g5-linux-s1-cores4-thailand.txt; do sleep 5; done
have g5-linux-s2-1000-4z-clean.txt || ./run-s2.sh clean > /tmp/g5-s2-clean.log 2>&1 || true
have g5-linux-s4-1000-4z-thailand-failover.txt || ./run-s2.sh thailand-failover > /tmp/g5-s4-s2.log 2>&1 || true
have g5-linux-s3-50.txt || ./run-s3.sh clean > /tmp/g5-s3-clean.log 2>&1 || true
have g5-linux-s4-voice-thailand-50.txt || ./run-s3.sh thailand > /tmp/g5-s4-voice.log 2>&1 || true
sudo docker rm -f lodestone-soak-livekit >/dev/null 2>&1 || true
# Real netem both ways, only between the two VMs.
{
  sudo ./netem.sh on "$ZONE_HOST"
  scp -q netem.sh "$ZONE_HOST":/tmp/netem.sh && ssh "$ZONE_HOST" "sudo bash /tmp/netem.sh on $SELF"
  ping -c 20 -i 0.2 "$ZONE_HOST" | tail -2
} > /tmp/g5-netem-setup.log 2>&1
have g5-linux-s1-cores4-netem-thailand.txt || ./run-s1.sh cores4-netem-thailand 0-3 clean > /tmp/g5-s1-cores4-netem-thailand.log 2>&1 || true
{
  sudo ./netem.sh show
  ssh "$ZONE_HOST" "sudo bash /tmp/netem.sh show"
  sudo ./netem.sh off
  ssh "$ZONE_HOST" "sudo bash /tmp/netem.sh off"
} >> /tmp/g5-netem-setup.log 2>&1
echo done > /tmp/g5-rest-queue.done
