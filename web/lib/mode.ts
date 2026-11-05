// The MODE contract — the fix for the incident that made this file exist.
//
// On 2026-08-31 an operator set a mock flag on their LOCAL machine, queued
// a render, and a REAL fal render was billed and delivered anyway — not by
// their own process, but by the DEPLOYED PRODUCTION worker. web/.env.local
// points at the one Supabase project that exists (production), and the
// deployed worker's dispatch loop polls that exact same `scenes` table on a
// 30s timer, claiming any row with status='queued' regardless of which
// process — or which laptop — put it there. A mock flag set on ONE process
// changes what THAT process does AFTER it claims a job; it has no say in
// who claims the job first. Two workers watching one queue is a coin flip
// per scene, and a local mock flag loses that coin flip every time the
// deployed worker also has a free slot. It was diagnosed three times as a
// stale .env file before anyone asked whose queue it actually was.
//
// The fix is not a better flag — an env var only one of the two processes
// reads can never fix a bug that lives in which process reaches the row
// FIRST. The fix is a fact that travels WITH the row, so both processes are
// answering the same question about the same scene:
//
//   1. MODE is read once per process, here, for the WHOLE process — not
//      per-vendor. The old MOCK_CLAUDE/MOCK_FAL_IMAGE/MOCK_FAL_VIDEO could
//      be set independently (mock Claude, pay for real frames; or the
//      reverse), which is exactly the kind of per-vendor disagreement this
//      collapses away. development: no vendor is ever called — every
//      generation is a deterministic local fixture. production: every call
//      is real and billable.
//   2. scenes.dev (boolean not null default false, supabase/migrations)
//      records, on the row itself, which MODE wrote it: a MODE=development
//      web app writes dev=true on every scene it queues; MODE=production
//      always writes dev=false. See web/actions/enqueue.ts's six
//      status='queued' writes.
//   3. A worker claims ONLY rows matching its own mode
//      (worker/internal/store/store.go's ClaimQueuedScenes, CountRendering
//      and StaleRendering all filter on scenes.dev) — a development worker
//      can never claim, submit, or bill a production row, and a production
//      worker can never touch a development one, no matter how many
//      processes are polling the same table at the same time.
//
// Default is "development" — the safe direction. Garbage input (a typo, a
// stray "Production" with a capital P) falls back to "development" rather
// than being guessed toward "production", for the same reason the old
// isMockFalImage fell back toward staying mocked on a stale legacy value:
// the costly failure mode is a process that silently starts spending real
// money, not one that stays mocked when it didn't strictly have to.
//
// mode() re-reads process.env.MODE on every call rather than caching it in
// a top-level const. That still means one value for the WHOLE process, same
// as "read once at startup" — nothing in this codebase mutates process.env
// once a real process is running, so every call returns the identical
// answer for the life of that process. What a top-level const would give up
// is the thing isMockClaude()/isMockFalImage() (the flags this file
// replaces) were deliberately built the same way to keep: a test can
// vi.stubEnv("MODE", ...) per `it`/`describe` block and have it take effect
// immediately, with no vi.resetModules() dance to reload a module whose
// top-level code already ran — the same reasoning imageVendor() (also
// removed with fal) was built on.
export type Mode = "development" | "production";

function parseMode(raw: string | undefined): Mode {
  return raw === "production" ? "production" : "development";
}

/** This process's MODE — see this file's header for why this reads fresh on every call. */
export function mode(): Mode {
  return parseMode(process.env.MODE);
}

/** True in development: no vendor call is ever made, every generation is a fixture. */
export function isDev(): boolean {
  return mode() === "development";
}

/** True in production: every vendor call is real and billable. */
export function isProd(): boolean {
  return mode() === "production";
}
