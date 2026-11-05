# Running the project in each environment

Four ways to run this repo. They differ in **two axes only** — which database the
services talk to, and what `MODE` is — and every other difference follows from those.

| # | Environment | Database | `MODE` | Vendor calls | Cost |
| --- | --- | --- | --- | --- | --- |
| 1 | [Local](#1-local) | local Supabase in Docker | `development` | all mocked | $0 |
| 2 | [Shared dev](#2-shared-dev-hosted-db-mocked-vendors) | hosted Supabase | `development` | all mocked | $0 |
| 3 | [Live-fire](#3-live-fire-hosted-db-real-vendors) | hosted Supabase | `production` | **real** | **real money** |
| 4 | [Production](#4-production-render) | hosted Supabase | `production` | real | real money |

There is no separate staging database. `scenes.dev` is what keeps 2 and 3 apart on the
same tables: a `development` web app writes `dev = true`, and a worker claims only rows
matching its own `MODE`. A mismatch leaves a queue unclaimed — it never cross-bills.

Prerequisites for anything host-run: Docker Desktop (Linux containers), Bun 1.4.2,
Go 1.25, and `ffmpeg`/`ffprobe` on PATH.

---

## 1. Local

Everything on your machine. This is the default and the one to use unless you have a
reason not to.

```bash
make install          # bun + go modules + pinned Supabase CLI
make db-start         # Docker: Postgres, Auth, Storage, Realtime, Studio
make db-env           # back up env files, point BOTH services at local Supabase
make dev              # web on :9000, worker on :8080
```

Windows without Make — same thing, three terminals:

```powershell
# repo root
bun install
bun run db:start
bun run db:env

# terminal 1
cd web; bun install; bun run dev

# terminal 2
cd worker; go mod download; go run ./cmd/worker
```

`db-env` rewrites `web/.env.local` and `worker/.env.local`: local Supabase credentials,
`MODE=development`, vendor keys **blanked**. It backs up whatever was there first as
`.env.local.before-local-<timestamp>.bak` beside each file. Unrelated settings survive.
Restart both processes after running it — and drop any exported shell variables, which
beat env files.

| What | Where |
| --- | --- |
| App | http://localhost:9000 |
| Worker health | http://127.0.0.1:8080/health |
| Supabase API | http://127.0.0.1:54321 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable` |
| Studio | http://127.0.0.1:54323 |
| Email inbox | http://127.0.0.1:54324 |

First login: sign up in the local app, then in **local** Studio → Table Editor →
`public.profiles`, set your row's `role` to `admin` and `status` to `active`. That admin
approves everyone else from `/users`.

Verify the wiring — and that the run really is mocked — with:

```bash
make doctor
```

Migrations, resets, and connection details: [local-development.md](local-development.md).

## 2. Shared dev (hosted DB, mocked vendors)

Host-run services against the **hosted** Supabase project, still fully mocked. Use this
to reproduce something that only happens with production data, or to work with rows a
teammate created. It writes real rows into the real database — just `dev = true` ones.

Restore the env files that `db-env` backed up (or set them by hand) so both services
have hosted credentials, and keep in both:

```
MODE=development
ANTHROPIC_API_KEY=
KIE_API_KEY=
```

Then `make dev` as usual. Blank vendor keys are the belt to `MODE`'s braces: a missed
gate fails loudly instead of billing.

`MODE` must be identical in `web/.env.local` and `worker/.env.local`, and so must
`AUDIO_ENABLED`, `ASSEMBLE_ENABLED`, and `CAPTIONS_ENABLED` — the web app quotes a price
from those flags that the worker then has to charge.

## 3. Live-fire (hosted DB, real vendors)

**Every render here bills a real kie account.** Only for measuring a price or proving a
vendor path end to end.

Set `MODE=production` and real keys in *both* env files, and say so out loud to whoever
owns the budget. `make doctor` prints `SET — a local run should not need this` next to a
vendor key precisely so this state is never accidental.

Webhooks do not reach localhost. Without one, completions arrive 45–90s late through the
reconcile poll — slow, not broken. For a real callback:

```bash
make tunnel           # cloudflared public URL → localhost:8080
```

Then point `APP_BASE_URL` at that URL and set `KIE_WEBHOOK_SECRET` to a `webhookHmacKey`
generated in kie's settings. Unset means every callback is rejected.

Put the env files back afterwards. A stale `MODE=production` is the shape that costs
money exactly once.

### Container parity (optional)

Same two images Render builds, against hosted Supabase:

```bash
docker compose --env-file web/.env.local up --build
```

The `--env-file` is load-bearing: `env_file:` is runtime-only in Compose and does not
feed build args, so without it the `NEXT_PUBLIC_*` values come through blank and the
browser bundle ships `undefined`. Loopback URLs from `db-env` do **not** work inside
these containers — this workflow is for hosted credentials only.

## 4. Production (Render)

Two services in Singapore, `ugc-web` and `ugc-worker`, both `MODE=production`,
configured entirely by [`render.yaml`](../render.yaml).

Deploy = merge to `main`. `ci.yml` runs lint/typecheck/test/build for web and
gofmt/vet/build/test for worker; only on green does `deploy.yml` deploy to Lightsail.
It no longer triggers Render deploys; `make deploy` does that by hand.

Migrations are a separate, deliberate step:

```bash
make db-push-remote   # applies supabase/migrations/ to the LINKED hosted project
```

Two things that have cost time here:

- **Any env var change needs a rebuild, not a restart** — and `NEXT_PUBLIC_*` doubly so,
  since Next inlines it into the client bundle at `next build`. A restarted container
  keeps serving the old value.
- Role cap defaults remain in `render.yaml`. The optional global cap is managed in Accounts Control and stored in `app_settings`, so its enabled state, daily/weekly window, and amount can change without a deploy.

---

## Which one am I in?

```bash
make doctor           # env files, MODE, vendor keys, all three services
grep -hs '^MODE=' web/.env.local worker/.env.local
```

`MODE` is read once at startup by each service, and anything that is not literally
`production` is development. The safe direction is the one you get by doing nothing.
