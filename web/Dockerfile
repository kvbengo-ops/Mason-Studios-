# syntax=docker/dockerfile:1

# --- deps -------------------------------------------------------------
# Installs dependencies only, so this layer is cached across code changes.
FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# --- build --------------------------------------------------------------
# NEXT_PUBLIC_* vars are inlined into the client bundle at BUILD time, not
# read at runtime — Next.js replaces `process.env.NEXT_PUBLIC_*` with literal
# values during `next build`. They must be passed as --build-arg at
# `docker build` time (Render: "Build-time environment variables" on the
# service), or the browser bundle ships with `undefined` for these values.
# They are not secret (they end up in client JS either way), unlike
# SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY / FAL_KEY, which must stay
# runtime-only env vars and must never be passed as build args.
#
# Node, not Bun, runs the build. `bun run build` crashed here with
#   panic: Segmentation fault / terminated by signal SIGILL
# on Render's linux/amd64 builder — an illegal instruction inside Bun
# itself, not our code, and it took the whole deploy down. Next is
# developed and tested against Node, so the build step runs there;
# Bun keeps the jobs it is good at and reliable for, installing deps
# above and serving in the runtime stage below.
FROM node:22-alpine AS build
WORKDIR /app

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_THEME
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_THEME=$NEXT_PUBLIC_THEME \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/ is optional (this repo has none yet); ensure it exists so the
# runtime stage's COPY below never fails if/when one is added later.
RUN mkdir -p public
# Next's own incremental build cache (.next/cache) persisted across builds
# via a cache mount — subsequent builds only recompile changed modules
# instead of a fully cold Next compile.
RUN --mount=type=cache,id=nextcache,target=/app/.next/cache \
    node_modules/.bin/next build

# `sharp` ships in the image: lib/to-jpeg.ts converts PNG/WebP uploads with it.
# It used to be deleted here wholesale (nothing imported it then), and #148
# took prod down by adding an import on top of that rm. `bun install` ignores
# npm's `libc` field and pulls every `@img/sharp-*` platform variant, so prune
# only the ones this Alpine (musl) runtime can never load — keep sharp itself,
# the linuxmusl binaries, and any non-platform @img package (e.g. @img/colour).
RUN find .next/standalone/node_modules/@img -mindepth 1 -maxdepth 1 \
      -name 'sharp-*' ! -name '*linuxmusl*' -exec rm -rf {} +

# --- runtime --------------------------------------------------------------
FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0

# oven/bun:1.4.2-alpine already ships a non-root `bun` user (uid 1000) — reuse
# it instead of creating a new one.

# `output: "standalone"` (web/next.config.ts) produces a pruned server.js +
# node_modules; static assets and public/ are not included and must be
# copied in separately.
COPY --from=build --chown=bun:bun /app/.next/standalone ./
COPY --from=build --chown=bun:bun /app/.next/static ./.next/static
COPY --from=build --chown=bun:bun /app/public ./public

USER bun

# Render injects $PORT at runtime; the standalone server.js reads
# process.env.PORT directly, so no fixed EXPOSE/hardcoded port here.
# HOSTNAME=0.0.0.0 above ensures it binds all interfaces, not just
# localhost — a container bound to localhost is unreachable on Render.
CMD ["bun", "server.js"]
