.DEFAULT_GOAL := help
.PHONY: help install dev dev-web dev-worker build check \
        web-lint web-typecheck web-test worker-vet worker-test \
        compile db-start db-stop db-status db-env db-push db-push-remote db-reset db-diff types db-test db-test-scratch tunnel doctor clean deploy deploy-status

# Polyglot repo: web/ is Next.js, worker/ is Go. Targets are the same either way,
# so nobody has to remember which toolchain owns which command.

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies for both services
	bun install
	cd web && bun install
	cd worker && go mod download

# ----------------------------------------------------------------------- dev
#
# `make dev` is safe to run: both services read MODE from their own .env.local,
# which is development unless it literally says production. In development no
# vendor is called at all — the worker mocks the render and the web app mocks
# Claude and kie — so a local run cannot spend money. `make doctor` checks that
# claim before you trust it.
#
# MOCK_FAL/MOCK_CLAUDE/MOCK_FAL_IMAGE are gone. Three independent per-vendor
# flags meant a half-mocked run was a legal configuration, which is a shape
# that costs money exactly once; MODE replaced all three.

dev: ## Run web and worker together — web on :9000, worker on :8080
	@$(MAKE) -j2 dev-web dev-worker

dev-web: ## Run the Next.js app only
	cd web && bun run dev

dev-worker: ## Run the Go worker only
	cd worker && go run ./cmd/worker

# --------------------------------------------------------------------- build

build: ## Production build, both services
	cd web && bun run build
	cd worker && go build -o ../bin/worker ./cmd/worker

check: web-lint web-typecheck web-test worker-vet worker-test ## Everything CI runs

web-lint:
	cd web && bun run lint

web-typecheck:
	cd web && bunx tsc --noEmit

web-test:
	cd web && bun run test

worker-vet:
	cd worker && go vet ./...

worker-test:
	cd worker && go test ./...

# ------------------------------------------------------------- phase 0 CLI

compile: ## Compile a script into scene prompts — make compile SCRIPT=ad.txt
	@test -n "$(SCRIPT)" || { echo "usage: make compile SCRIPT=path/to/script.txt"; exit 1; }
# --conditions=react-server is load-bearing. web/lib/claude.ts imports
# "server-only" to keep the Anthropic SDK out of client bundles (it once
# shipped whole to the browser). That package is a deliberate landmine: it
# throws on import unless resolved under the `react-server` export condition,
# which Next's bundler sets and bun's plain resolution does not. Without this
# flag the guard fires here and `make compile` dies before reading the script.
	cd web && bun --conditions=react-server run scripts/compile.ts ../$(SCRIPT)

# ------------------------------------------------------------------ supabase

db-start: ## Start local Supabase (Postgres, Auth, Storage, Realtime) in Docker
	bun run db:start

db-stop: ## Stop local Supabase, preserving its data
	bun run db:stop

db-status: ## Show local Supabase URLs and development keys
	bun run db:status

db-env: ## Back up env files and point web + worker at local Supabase
	bun run db:env

db-push: ## Apply pending migrations to the LOCAL database
	bun run db:push

db-push-remote: ## Apply migrations to the LINKED HOSTED database
	bun run db:push:remote

db-reset: ## Drop and rebuild the local database
	bun run db:reset

db-diff: ## Generate a migration from local changes — make db-diff NAME=add_x
	@test -n "$(NAME)" || { echo "usage: make db-diff NAME=add_something"; exit 1; }
	bunx --no-install supabase db diff --local -f $(NAME)

types: ## Regenerate TypeScript types from the schema
	bunx --no-install supabase gen types typescript --local > web/types/db.ts

# db-test always points at the local `supabase` CLI's disposable Postgres
# (localhost:54322, default local-stack password) — never DATABASE_URL /
# a live database. That's the whole reason the store tests gate on
# TEST_DATABASE_URL instead: pointing this at anything but a scratch DB
# would let `go test` write/delete real rows.
#
# `supabase db reset` re-applies every migration from scratch each run,
# which is also our isolation story: the tests share tables and mostly
# don't clean up after themselves (only preserve_cost_history_test.go
# does), so without a full reset repeated local runs accumulate rows.
# This resets the schema before each run but does NOT give per-test
# isolation — tests within a single run can still see each other's rows.
db-test: ## Reset local DB, apply migrations, run gated store tests
	bun run db:reset
	cd worker && TEST_DATABASE_URL="postgres://postgres:postgres@localhost:54322/postgres?sslmode=disable" go test ./internal/store/... -v

# The same tests against a plain Postgres on 55432, bootstrapped the way CI
# does it rather than by the Supabase CLI.
#
# db-test above needs `supabase start`, and when that is broken on a machine
# the store tests do not fail — they SKIP, and `go test ./internal/...` still
# prints "ok". That is the whole hazard: a suite that reports green while
# never touching a database. This repo has already paid for it once (see
# "Actually run the store tests that had only ever skipped").
#
# Bring the scratch DB up the way .github/workflows/ci.yml does — the CI leg
# runs scripts/ci/test-db-bootstrap.sql first, because a bare postgres image
# has none of the Supabase-managed schemas the migrations assume — then apply
# every migration in order. Reset it by dropping the container, not by
# expecting these tests to clean up: they share tables and mostly do not.
db-test-scratch: ## Run gated store tests against a plain Postgres on :55432
	cd worker && TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:55432/postgres?sslmode=disable" go test ./internal/store/... -v

# ----------------------------------------------------------------- local dev

tunnel: ## Public URL so kie webhooks can reach the local worker
	cloudflared tunnel --url http://localhost:8080

doctor: ## Check a local run is wired up and actually mocked
	@echo "— env files (gitignored; the worker reads .env.local FIRST, then .env)"
	@test -f web/.env.local && echo "  ok    web/.env.local" \
		|| echo "  MISSING web/.env.local — the web app will use production defaults"
	@test -f worker/.env.local && echo "  ok    worker/.env.local" \
		|| echo "  MISSING worker/.env.local — the worker exits with 'required environment variable DATABASE_URL is not set', which does NOT tell you the file is the problem"
	@echo "— MODE"
	@grep -hs '^MODE=' web/.env.local worker/.env.local | sed 's/^/  /' || echo "  MODE unset — defaults to development, which is the safe direction"
	@echo "— vendor keys (blank is correct locally: a missed gate then fails instead of billing)"
	@for f in web/.env.local worker/.env.local; do \
		grep -hs -E '^(KIE_API_KEY|ANTHROPIC_API_KEY)=' $$f | sed -E 's/=(.+)/= SET — a local run should not need this/; s/=$$/= blank/' | sed 's/^/  /'; \
	done
	@echo "— services"
	@curl -sf -o /dev/null http://127.0.0.1:54321/rest/v1/ && echo "  ok    supabase   127.0.0.1:54321" \
		|| echo "  down  supabase   127.0.0.1:54321 — run 'make db-start'"
	@curl -sf http://localhost:8080/health 2>/dev/null | sed 's/^/  ok    worker     /' \
		|| echo "  down  worker     localhost:8080 — run 'make dev-worker'"
	@curl -so /dev/null -w '  %{http_code}   web        localhost:9000/ugc (307 = the auth redirect, which is a healthy answer)\n' http://localhost:9000/ugc \
		|| echo "  down  web        localhost:9000 — run 'make dev-web'"
	@echo "— store tests (these SKIP silently and still print 'ok', so ask before trusting a green run)"
	@if [ -n "$$TEST_DATABASE_URL" ]; then \
		echo "  ok    TEST_DATABASE_URL is set — 'go test ./internal/store/...' will really run"; \
	elif psql "postgres://postgres:postgres@127.0.0.1:55432/postgres?sslmode=disable" -Atc 'select 1' >/dev/null 2>&1; then \
		echo "  SKIP  TEST_DATABASE_URL unset, but a scratch db IS up on 55432 — run 'make db-test-scratch'"; \
		echo "        Without it the store suite skips every case and the package still reports ok."; \
	else \
		echo "  SKIP  TEST_DATABASE_URL unset and nothing on 54322/55432 — the store suite will skip"; \
		echo "        every case and STILL print ok. Start a scratch db, or 'make db-test'."; \
	fi

clean: ## Remove build output
	rm -rf web/.next web/dist bin

# -------------------------------------------------------------------- deploy
#
# Hand-triggered Render deploy for when deploy.yml cannot run (Actions billing
# block). Ships origin/main's HEAD, or SHA=<commit> if it is already on
# origin/main. Key lives in .claude/render.env (gitignored). Apply any new
# migration to prod BEFORE this, never after.

RENDER_SERVICES := ugc-web:srv-da03ags9v7es738ga6tg ugc-worker:srv-da03ags9v7es738ga6t0

deploy: ## Deploy origin/main (or SHA=...) to Render, web and worker
	@set -e; \
	[ -f .claude/render.env ] || { echo "missing .claude/render.env (RENDER_API_KEY=...)"; exit 1; }; \
	set -a; . ./.claude/render.env; set +a; \
	git fetch -q origin main; \
	sha=$$(git rev-parse --verify "$${SHA:-origin/main}^{commit}"); \
	git merge-base --is-ancestor $$sha origin/main || { echo "$$sha is not on origin/main"; exit 1; }; \
	echo "deploying $$(git log -1 --format='%h %s' $$sha)"; \
	for pair in $(RENDER_SERVICES); do \
		name=$${pair%%:*}; id=$${pair#*:}; \
		resp=$$(curl -sS -w '\n%{http_code}' -X POST "https://api.render.com/v1/services/$$id/deploys" \
			-H "Authorization: Bearer $$RENDER_API_KEY" -H 'Content-Type: application/json' \
			-d "{\"commitId\":\"$$sha\"}"); \
		code=$$(printf '%s' "$$resp" | tail -n1); \
		case $$code in 2*) echo "  $$name: triggered ($$code)";; *) echo "  $$name: FAILED ($$code) $$(printf '%s' "$$resp" | sed '$$d')"; exit 1;; esac; \
	done; \
	echo "watch: make deploy-status"

deploy-status: ## Latest Render deploy per service
	@set -a; . ./.claude/render.env; set +a; \
	for pair in $(RENDER_SERVICES); do \
		name=$${pair%%:*}; id=$${pair#*:}; \
		printf '  %-12s ' $$name; \
		curl -sS "https://api.render.com/v1/services/$$id/deploys?limit=1" -H "Authorization: Bearer $$RENDER_API_KEY" \
			| jq -r '.[0].deploy | "\(.status)  \(.commit.id[0:7])  \(.createdAt)"'; \
	done
