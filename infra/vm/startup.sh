#!/bin/bash
# GCE startup script for the game VM (WP18). Runs as root on every boot,
# which on this VM means every wake (the director starts it when a player
# signs in), and again on demand after a deploy
# (`sudo google_metadata_script_runner startup`, run by infra/deploy.mjs).
#
# This is the one shell script in the repo: it runs on the Debian VM, never
# on a developer machine (spec 4's "Node or Go only" rule is about the
# scripts people run; this is guest configuration). Everything it needs
# arrives through instance metadata, written by infra/deploy.mjs:
#
#   lodestone-compose     infra/vm/docker-compose.vm.yml
#   lodestone-caddyfile   infra/vm/Caddyfile
#   lodestone-prometheus  infra/vm/prometheus.vm.yml
#   lodestone-backup      infra/vm/pg-backup.sh
#   lodestone-env         KEY=VALUE lines (non-secret: tag, registry, host...)
#   lodestone-secrets     ENV_NAME=secret-manager-name lines
#   lodestone-registry-host, lodestone-backup-bucket
#
# Idempotent: a second run only re-pulls images and recreates containers
# whose image or config changed.
set -euo pipefail
exec > >(logger -t lodestone-startup) 2>&1

MD=http://metadata.google.internal/computeMetadata/v1
md() { curl -fsS -H Metadata-Flavor:Google "$MD/instance/attributes/$1"; }
PROJECT=$(curl -fsS -H Metadata-Flavor:Google "$MD/project/project-id")
APP=/opt/lodestone
DATA=/mnt/lodestone-data

echo "lodestone startup: project $PROJECT"

# 1. Persistent data disk (auto-delete off, survives recreating the VM).
DEV=/dev/disk/by-id/google-lodestone-data
if [ -e "$DEV" ]; then
  if ! blkid "$DEV" >/dev/null 2>&1; then
    echo "formatting $DEV"
    mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard "$DEV"
  fi
  mkdir -p "$DATA"
  if ! mountpoint -q "$DATA"; then mount -o discard,defaults "$DEV" "$DATA"; fi
  grep -q "$DATA" /etc/fstab || echo "$DEV $DATA ext4 discard,defaults,nofail 0 2" >> /etc/fstab
else
  echo "WARNING: no data disk; Docker volumes live on the boot disk"
  mkdir -p "$DATA"
fi

# 2. Docker, with its data-root (images + named volumes: Postgres, Redis
#    AOF, Caddy certificates) on the data disk.
mkdir -p /etc/docker "$DATA/docker"
cat > /etc/docker/daemon.json <<EOF
{ "data-root": "$DATA/docker", "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
EOF
if ! command -v docker >/dev/null 2>&1; then
  echo "installing docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# 3. Files from metadata.
mkdir -p "$APP"
md lodestone-compose > "$APP/docker-compose.yml"
md lodestone-caddyfile > "$APP/Caddyfile"
md lodestone-prometheus > "$APP/prometheus.vm.yml"
md lodestone-backup > "$APP/pg-backup.sh"
chmod 755 "$APP/pg-backup.sh"

# 4. Environment: non-secret metadata, then each secret from Secret Manager
#    (the VM's service account may read exactly these secrets).
umask 077
{
  md lodestone-env
  echo
  md lodestone-secrets | while IFS='=' read -r name secret || [ -n "$name" ]; do
    [ -z "$name" ] && continue
    value=$(gcloud secrets versions access latest --secret="$secret" --project="$PROJECT")
    echo "$name=$value"
  done
} > "$APP/.env.new"
mv "$APP/.env.new" "$APP/.env"
grep '^LODESTONE_METRICS_TOKEN=' "$APP/.env" | cut -d= -f2- | tr -d '\n' > "$APP/metrics-token" || true
chmod 644 "$APP/metrics-token" # read by the prometheus container (nobody)
umask 022

# 5. Pull and (re)start. Compose waits for Postgres, runs migrations, then
#    starts zone and social.
REGISTRY_HOST=$(md lodestone-registry-host)
gcloud auth configure-docker "$REGISTRY_HOST" --quiet
cd "$APP"
# LiveKit asks for bigger UDP socket buffers (its boot log warns at 425984).
sysctl -q -w net.core.rmem_max=5000000 net.core.wmem_max=5000000 || true
docker compose pull --quiet
docker compose up -d --remove-orphans

# 6. Nightly Postgres dump to Cloud Storage while the VM is up (shutdown.sh
#    also dumps on every stop, so days the VM sleeps lose nothing).
if [ ! -f /etc/systemd/system/lodestone-backup.timer ]; then
  cat > /etc/systemd/system/lodestone-backup.service <<EOF
[Unit]
Description=Lodestone nightly Postgres dump to Cloud Storage
[Service]
Type=oneshot
ExecStart=$APP/pg-backup.sh nightly
EOF
  cat > /etc/systemd/system/lodestone-backup.timer <<EOF
[Unit]
Description=Lodestone nightly Postgres dump
[Timer]
OnCalendar=*-*-* 03:30:00 UTC
Persistent=false
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now lodestone-backup.timer
fi

echo "lodestone startup: done ($(grep '^LODESTONE_TAG=' "$APP/.env" | cut -d= -f2))"
