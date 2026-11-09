# syntax=docker/dockerfile:1.7
# Zone server image (spec 13: one container per service, configured only by
# environment variables). Runs on the game VM next to social, LiveKit,
# Postgres and Redis. Also carries the migrate tool + migrations and
# mintworld, so the VM's compose file migrates and mints the official world
# (before the zone looks it up) with the same build that serves.
#
# Build from the repo root after `npm run build:wasm` (infra/deploy.mjs does
# both):  docker build -f infra/docker/zone.Dockerfile -t lodestone/zone .
ARG GO_IMAGE=golang:1.27-alpine
FROM ${GO_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=local
# Module files first so dependency downloads cache across source edits.
COPY go.work ./
COPY server/pkg/go.mod server/pkg/go.sum server/pkg/
COPY server/account/go.mod server/account/
COPY server/director/go.mod server/director/
COPY server/social/go.mod server/social/
COPY server/zone/go.mod server/zone/
COPY tools/bots/go.mod tools/bots/
COPY tools/creator/server/go.mod tools/creator/server/go.sum tools/creator/server/
COPY worldgen/harness/go/go.mod worldgen/harness/go/go.sum worldgen/harness/go/
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server/ server/
COPY tools/bots/ tools/bots/
COPY tools/creator/server/ tools/creator/server/
COPY worldgen/harness/go/ worldgen/harness/go/
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -ldflags="-s -w" -o /out/zone ./server/zone && \
    go build -ldflags="-s -w" -o /out/migrate ./server/pkg/cmd/migrate && \
    go build -ldflags="-s -w" -o /out/mintworld ./server/pkg/cmd/mintworld

FROM gcr.io/distroless/static-debian12:nonroot
ARG VERSION=dev
COPY --from=build /out/zone /out/migrate /out/mintworld /usr/local/bin/
# The same worldgen.wasm bytes the client build ships (content hash in the
# manifest; LODESTONE_WORLDGEN_WASM_SHA256 can pin it per deployment).
COPY worldgen/pkg/worldgen.wasm worldgen/pkg/manifest.json /app/worldgen/
# Archived generators for worlds pinned to an older genVersion (CR 014;
# worldgen/archive/README.md): the zone and `mintworld -renew` load them.
COPY worldgen/archive/ /app/worldgen/archive/
COPY contracts/migrations/ /app/migrations/
ENV LODESTONE_WORLDGEN_WASM=/app/worldgen/worldgen.wasm     LODESTONE_WORLDGEN_ARCHIVE=/app/worldgen/archive \
    LODESTONE_MIGRATIONS=/app/migrations \
    LODESTONE_VERSION=${VERSION} \
    LODESTONE_ZONE_PORT=8092
LABEL org.opencontainers.image.title="lodestone-zone" org.opencontainers.image.version="${VERSION}"
# 8092/tcp: WebSocket + /healthz + /metrics. 8092/udp: WebTransport (HTTP/3)
# unless LODESTONE_ZONE_WT_ADDR moves it.
EXPOSE 8092/tcp 8092/udp
USER nonroot
ENTRYPOINT ["/usr/local/bin/zone"]
