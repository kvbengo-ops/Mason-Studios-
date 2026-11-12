// Build/DB identity for the sidebar footer and the health endpoint — see
// web/components/sidebar-shell.tsx and web/app/api/health/route.ts. The
// point of both readouts is the same: make "the deployed code is ahead of
// the applied migration" visible instead of silent.
//
// RENDER_GIT_COMMIT is injected by Render into every service at RUNTIME, not
// build time — deliberately NOT a NEXT_PUBLIC_ var (see config/theme.ts for
// that pattern's build-time twin). That means this module is only safe to
// read server-side: a client component bundled at build time would freeze
// in whatever value (or lack of one) was present when `next build` ran, not
// the value the running instance actually has.
export const BUILD_SHA = (process.env.RENDER_GIT_COMMIT ?? "dev").slice(0, 7);

// The highest migration file in supabase/migrations/ as of this writing —
// 0140_balance_alerts.sql. (The RPC this value is
// compared against is defined separately, in 0046_applied_schema_version.sql; this
// constant tracks the highest migration, not that RPC's own migration, and
// the two only coincided on the day 0046 landed.) Maintained by
// version.test.ts's drift guard, which reads the migrations directory
// directly and fails CI the moment this constant and the repo disagree —
// bump this by hand whenever a new migration is added.
export const EXPECTED_DB_VERSION = "0140";
