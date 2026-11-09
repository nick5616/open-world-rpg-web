#!/bin/bash
# G5 Linux soak: VM startup script (passed as --metadata-from-file
# startup-script=...). The bots VM gets Docker (Postgres, Redis, LiveKit as
# containers) and Node 20 (the soak drivers and netsim proxies); the zone VM
# only needs the zone binary, so it skips both. Marks /var/run/soak-ready.
set -eux
ROLE=$(curl -fs -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/soak-role || echo zone)
if [ "$ROLE" = bots ]; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io xz-utils
  curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1
  for img in postgres:16-alpine redis:7-alpine livekit/livekit-server:v1.8; do docker pull -q "$img"; done
fi
# Many sockets per process (1,000 bots, netsim proxies, zones).
cat > /etc/security/limits.d/90-soak.conf <<'EOF'
* soft nofile 1048576
* hard nofile 1048576
EOF
sysctl -w net.core.somaxconn=4096 net.ipv4.tcp_max_syn_backlog=4096 net.ipv4.ip_local_port_range="10240 65000"
mkdir -p /opt/lodestone && chmod 777 /opt/lodestone
touch /var/run/soak-ready
