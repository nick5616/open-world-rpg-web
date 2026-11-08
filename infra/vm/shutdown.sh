#!/bin/bash
# GCE shutdown script for the game VM (WP18). Runs when the director stops
# the VM after 15 idle minutes (and on any other stop). GCE allows about 90 s
# for a regular VM, so the order matters:
#   1. stop the edge and the game services first: the zone kicks players,
#      checkpoints every character and flushes its write-behind queue into
#      Postgres (stop_grace_period 20 s);
#   2. dump Postgres to Cloud Storage (the "nightly" dump also happens here,
#      because a sleeping VM never sees 03:30);
#   3. stop everything else.
set -uo pipefail
exec > >(logger -t lodestone-shutdown) 2>&1
cd /opt/lodestone 2>/dev/null || exit 0
docker compose stop -t 20 caddy zone social
/opt/lodestone/pg-backup.sh shutdown || echo "backup failed"
docker compose stop -t 10
echo "lodestone shutdown: done"
