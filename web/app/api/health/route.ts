import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { BUILD_SHA, EXPECTED_DB_VERSION } from "@/lib/version";
import { mode } from "@/lib/mode";

// Render polls this on every deploy and keeps polling to decide whether the
// instance is alive. It has to be reachable without a session, which is why it
// lives outside the (app) group and is exempted in proxy.ts — pointing the
// health check at a guarded route means every deploy fails on a 307.
//
// The check is shallow on purpose: a trivially cheap query that proves the
// database is reachable, not a full readiness probe. Anything heavier here runs
// on a timer forever.
//
// It uses the admin client because anon holds no table grants by design (see
// 0007_grants.sql) — there is no unauthenticated surface in this app. A probe
// on the anon client would report a permanently degraded database when nothing
// is actually wrong.
export const dynamic = "force-dynamic";

// Read alongside the reachability check below, but never allowed to change
// its outcome — see this file's own header on why the check has to stay
// shallow, and app/(app)/layout.tsx's identical fail-soft wrapper for the
// same RPC. Uses the admin client (unlike the layout's user-scoped read):
// this endpoint runs with no session at all, and applied_schema_version()
// is only granted to `authenticated` — an anon call would just report a
// permission error, not the DB's actual version. Any failure (missing
// function, i.e. not migrated yet; network; anything else) degrades to
// `null`, same "diagnostic, not a gate" contract as the sidebar footer.
// Takes the caller's client rather than building its own: the reachability
// check has already constructed one, and this runs alongside that check
// (Promise.all below) rather than after it — Render polls this endpoint
// continuously during a deploy, so a second sequential round trip is a cost
// paid on every poll for a value that is only ever diagnostic.
async function readDbVersion(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("applied_schema_version");
    if (error) return null;
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * What THIS PROCESS's MODE is, or null in a production build.
 *
 * The worker reports the same thing at its own GET /health, and for the same
 * reason: on 2026-08-31 worker/.env carried MOCK_FAL_VIDEO=1 while the
 * running worker had it false — godotenv does not override a variable
 * already set in the shell — and the file was read three times as proof that
 * local was mocked before a real $2.52 render said otherwise. A file is a
 * claim about a process; this is the process answering. MODE replaced that
 * pair of independent per-vendor flags with one switch (lib/mode.ts), so
 * there is exactly one value to report now, not two that could disagree.
 *
 * Omitted entirely in production rather than reported. MODE is a
 * local-development fact, and a deployed health endpoint that echoes it
 * invites someone to wonder whether it's ever wrong there.
 *
 * The worker's own MODE is deliberately NOT proxied here. The two services
 * share nothing but Postgres by design, and a cross-service call for a
 * diagnostic would be the first exception to that.
 */
/**
 * Whether the database this build is talking to is the schema this build was
 * written against.
 *
 * `dbVersion` alone could already answer this, but only for a reader who
 * happens to know which migration the deployed code expects — and nothing
 * anywhere printed that number next to it.
 *
 * WHY THIS EXISTS. On 2026-09-03 production answered `dbVersion 0075` while
 * the newest migration in the repo, on every pushed branch, was 0074:
 * `0075_revoke_allowance_grants` had been applied straight from an unpushed
 * working copy. Nothing caught it. version.test.ts guards this constant
 * against the migrations DIRECTORY, so CI stays green while the repo and the
 * live database drift apart — the one comparison that had no home is
 * repo-versus-production, and this endpoint is the only place both numbers
 * are in the same process at the same time.
 *
 * "code-ahead" is the older, better-known half (deploy landed, migration did
 * not) and was already visible in the sidebar footer. "database-ahead" is the
 * half that had never been seen and is the more dangerous one: it is additive
 * and harmless the day it happens, then becomes a schema nobody can rebuild
 * from the repo.
 *
 * Diagnostic, never a gate — same contract as dbVersion itself. `null` when
 * the version read failed, because "unknown" and "aligned" must not look
 * alike.
 */
function schemaDrift(dbVersion: string | null): string | null {
  if (dbVersion === null) return null;
  if (dbVersion === EXPECTED_DB_VERSION) return "aligned";
  // String compare, not numeric: these are zero-padded four-character ids
  // ("0074"), which sort correctly as text and have no numeric type anywhere
  // else in this codebase to agree with.
  return dbVersion > EXPECTED_DB_VERSION ? "database-ahead" : "code-ahead";
}

function modeState(): { mode: string } | null {
  // A plain NODE_ENV test. The first version called isDevAgainstHostedDb
  // with a dummy URL to reuse its non-production branch — which answered the
  // right question by accident, through a function whose name promises
  // something else entirely. A reader changing that function's URL handling
  // would have silently changed this.
  if (process.env.NODE_ENV === "production") return null;
  return { mode: mode() };
}

export async function GET(): Promise<NextResponse> {
  try {
    const supabase = createAdminClient();
    // Concurrent, not sequential: the version read is never allowed to change
    // the reachability verdict (see readDbVersion's comment), so there is no
    // ordering to preserve between them.
    const [{ error }, dbVersion] = await Promise.all([
      supabase.from("prompt_templates").select("id").limit(1),
      readDbVersion(supabase),
    ]);

    if (error) {
      return NextResponse.json(
        { status: "degraded", database: error.message, buildSha: BUILD_SHA, dbVersion },
        { status: 503 },
      );
    }

    return NextResponse.json({
      status: "ok",
      database: "reachable",
      buildSha: BUILD_SHA,
      dbVersion,
      expectedDbVersion: EXPECTED_DB_VERSION,
      schemaDrift: schemaDrift(dbVersion),
      ...(modeState() ?? {}),
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "down",
        error: err instanceof Error ? err.message : "unknown",
        buildSha: BUILD_SHA,
        // Always null here, stated outright rather than re-derived: reaching
        // this branch means createAdminClient() or the query above threw, so
        // asking the same client for a version could only fail the same way.
        // Retrying it would cost a round trip to report the null we already
        // know we have.
        dbVersion: null,
      },
      { status: 503 },
    );
  }
}
