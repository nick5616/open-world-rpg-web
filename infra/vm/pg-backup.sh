#!/bin/bash
# Postgres dump to Cloud Storage (spec 13: "nightly dumps to Cloud Storage").
# Usage: pg-backup.sh nightly|shutdown|manual
#
# Writes gs://<bucket>/pg/<UTC timestamp>-<reason>.sql.gz (the bucket's
# lifecycle rule deletes these after 60 days) and overwrites pg/latest.sql.gz,
# which is never deleted, so a world nobody played for months still has its
# newest dump. Restore: infra/README.md "Restore a backup".
set -euo pipefail
reason=${1:-manual}
BUCKET=$(curl -fsS -H Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/attributes/lodestone-backup-bucket)
ts=$(date -u +%Y%m%dT%H%M%SZ)
cd /opt/lodestone
tmp=$(mktemp /tmp/lodestone-pg.XXXXXX)
trap 'rm -f "$tmp"' EXIT
docker compose exec -T postgres pg_dump -U lodestone -d lodestone --no-owner | gzip -9 > "$tmp"
gcloud storage cp --quiet --content-type=application/gzip "$tmp" "gs://$BUCKET/pg/$ts-$reason.sql.gz"
gcloud storage cp --quiet --content-type=application/gzip "$tmp" "gs://$BUCKET/pg/latest.sql.gz"
echo "pg-backup: gs://$BUCKET/pg/$ts-$reason.sql.gz ($(stat -c %s "$tmp") bytes)"
