# syntax=docker/dockerfile:1.7
# Social service image (chat, parties, friends, presence; spec 10). Runs on
# the game VM. It does not generate terrain, so no worldgen.wasm.
#
#   docker build -f infra/docker/social.Dockerfile -t lodestone/social .
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
    go build -ldflags="-s -w" -o /out/social ./server/social && \
    go build -ldflags="-s -w" -o /out/social-admin ./server/social/cmd/admin

FROM gcr.io/distroless/static-debian12:nonroot
ARG VERSION=dev
# social-admin is the moderation CLI (WP08): docker compose exec social social-admin reports
COPY --from=build /out/social /out/social-admin /usr/local/bin/
ENV LODESTONE_VERSION=${VERSION} LODESTONE_SOCIAL_PORT=8093
LABEL org.opencontainers.image.title="lodestone-social" org.opencontainers.image.version="${VERSION}"
EXPOSE 8093/tcp
USER nonroot
ENTRYPOINT ["/usr/local/bin/social"]
