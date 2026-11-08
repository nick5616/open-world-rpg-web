# syntax=docker/dockerfile:1.7
# Account service image (sign-in, local profiles, characters; spec 4). Runs
# on Cloud Run with zero minimum instances. Carries worldgen.wasm because it
# mints the official world on startup (WP07 mintdb).
#
#   docker build -f infra/docker/account.Dockerfile -t lodestone/account .
ARG GO_IMAGE=golang:1.27-alpine
FROM ${GO_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=local
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
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -ldflags="-s -w" -o /out/account ./server/account

FROM gcr.io/distroless/static-debian12:nonroot
ARG VERSION=dev
COPY --from=build /out/account /usr/local/bin/
COPY worldgen/pkg/worldgen.wasm worldgen/pkg/manifest.json /app/worldgen/
ENV LODESTONE_WORLDGEN_WASM=/app/worldgen/worldgen.wasm \
    LODESTONE_VERSION=${VERSION} \
    LODESTONE_ACCOUNT_PORT=8091
LABEL org.opencontainers.image.title="lodestone-account" org.opencontainers.image.version="${VERSION}"
EXPOSE 8091/tcp
USER nonroot
ENTRYPOINT ["/usr/local/bin/account"]
