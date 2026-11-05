# syntax=docker/dockerfile:1

FROM golang:1.25-alpine AS build

WORKDIR /src

# No `apk add git` here on purpose: every dependency in go.mod resolves through
# the module proxy, so nothing fetches over VCS. Add it back only if a
# dependency ever needs a direct VCS fetch.

COPY go.mod go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/worker ./cmd/worker

FROM alpine:3.20

RUN apk add --no-cache ffmpeg ca-certificates \
    && addgroup -S worker && adduser -S worker -G worker

COPY --from=build /out/worker /usr/local/bin/worker

USER worker

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/worker"]
