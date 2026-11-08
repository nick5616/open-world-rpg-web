# syntax=docker/dockerfile:1.7
# Director image (login handoff, tickets, wake-on-demand; spec 4, 13). Runs
# on Cloud Run with zero minimum instances; Cloud Run sends traffic to the
# port given with `gcloud run deploy --port`, which matches the default
# LODESTONE_DIRECTOR_PORT below.
#
#   docker build -f infra/docker/director.Dockerfile -t lodestone/director .
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
    go build -ldflags="-s -w" -o /out/director ./server/director

FROM gcr.io/distroless/static-debian12:nonroot
ARG VERSION=dev
COPY --from=build /out/director /usr/local/bin/
ENV LODESTONE_VERSION=${VERSION} LODESTONE_DIRECTOR_PORT=8090
LABEL org.opencontainers.image.title="lodestone-director" org.opencontainers.image.version="${VERSION}"
EXPOSE 8090/tcp
USER nonroot
ENTRYPOINT ["/usr/local/bin/director"]
