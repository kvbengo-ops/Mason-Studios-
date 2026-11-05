# worker

Go service handling everything after an editor clicks Render: submitting
jobs to fal, receiving webhooks, reconciling lost callbacks, and stitching
finished clips into a delivered video. See `../docs/architecture.md` for
the full picture; this file is just the local map.

## The status contract

`scenes.status` is the only column both `web` and `worker` write, split
down the middle:

```
web    →  draft → frame_ready → queued
worker →  queued → rendering → done / failed
```

**web never writes `rendering`. worker never writes `draft` or
`frame_ready`.** The web app's entire involvement in a render is one
update — `status = 'queued'` — after which the worker owns the scene until
it lands on `done` or `failed`. See the comment at the top of
`internal/store/store.go` and `supabase/migrations/0001_init.sql`.

## The three loops

One process, three goroutines ticking independently, plus one HTTP route:

- **dispatch** (every 30s) — claims queued scenes up to the render
  concurrency cap, round-robin across users so one editor queueing 300
  clips can't starve everyone else, and submits them to fal.
- **reconcile** (every 2m) — finds scenes stuck in `rendering` whose
  webhook never arrived (deploy, 500, network blip), checks fal directly,
  and ingests or fails them. The webhook is the fast path; this is the
  correct path. Both are required.
- **assemble** (every 30s) — once a project's scenes are all terminal,
  normalizes and concatenates the finished clips into a final delivered
  video.
- **`POST /webhooks/fal`** — fal's render-completion callback. Must always
  return 200 (a 500 makes fal retry forever) and must be idempotent (fal
  retries on non-200, so duplicate deliveries are expected).

`GET /health` pings the database and is Render's health check target.

## Running locally

```sh
cp .env.example .env   # fill in DATABASE_URL, SUPABASE_*, FAL_* secrets
go run ./cmd/worker
```

`MOCK_FAL_VIDEO=1` short-circuits real fal submissions for local development
without spending real money.

## Verify

```sh
go vet ./...
go build ./...
go test ./...
```
