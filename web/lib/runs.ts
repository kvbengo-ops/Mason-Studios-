// The web app's half of "runs gets a row per attempt, not per success" (see
// worker/internal/store/store.go's MarkDone/MarkFailed for the Go half,
// which every video render already went through). Before this file existed,
// every paid call the web app makes OUTSIDE the render path — the fal image
// generations behind Gate 2's reference frames, a character reference photo,
// a character+product composite, and every Claude compile (a full script or
// a single-scene Apply/Split) — wrote nothing to `runs` at all. They read as
// free to both the daily spend caps (lib/spend.ts) and to /spend, in a
// codebase whose approval-workflow plan (docs/Account_Usage_and_Cost_
// Control_Plan_Proposal.md) is about to grant editors more budget based on
// exactly those numbers.
//
// recordRun is the one place that INSERT happens, so every call site (see
// actions/frames.ts, actions/character.ts, actions/character-library.ts,
// actions/compile.ts, actions/brief.ts) writes the same shape the same way,
// instead of five hand-copied `.from("runs").insert(...)` calls that could
// each drift from what MarkDone/MarkFailed on the Go side actually write.

import { createAdminClient } from "@/lib/supabase/server";
import { BILLING_UNKNOWN_PREFIX } from "./image-attempt";
import { KieTaskPendingError } from "./kie";
import type { Database } from "@/types/db";

export interface RunRecord {
  /**
   * null for the one paid call with no project to attribute cost to at all
   * — web/actions/character-library.ts's createCharacterFromDescription,
   * which generates a Character Library entry shared across every project
   * (0020_characters.sql). See 0030_runs_project_id.sql's header ("Why
   * nullable, not NOT NULL") for what that costs: a null-project run is
   * still counted by the GLOBAL daily cap and /spend's totals
   * (spend_total_usd has no project join), but invisible to the PER-USER
   * cap and to the per-project/per-user breakdown views, which all key off
   * this column. Every other call site has a real project and must pass it.
   */
  projectId: string | null;
  /**
   * Who this attempt is billed to when there is no project to attribute
   * through — the project-less Image Generator (0085_personal_image_
   * generator.sql) is the first writer, and until something else needs it,
   * the only one. Omitted everywhere else, where projects.user_id still
   * answers the question: every per-user read resolves the owner as
   * coalesce(runs.user_id, projects.user_id), so leaving it unset is
   * identical to the behaviour before 0085, not a gap.
   */
  userId?: string | null;
  /**
   * null/omitted for a project-level cost with no single scene to attribute
   * it to (a character reference, a composite, a full-script compile) —
   * `runs.scene_id` has been nullable since 0001_init.sql specifically for
   * this. `runs.project_id` (0030_runs_project_id.sql, applied alongside
   * this change) is what keeps a scene-less run counted by every cap and
   * every aggregate that used to require a scene to find its owner.
   */
  sceneId?: string | null;
  vendor: string;
  model: string;
  /**
   * null when this attempt is known to have FAILED and this codebase
   * cannot honestly say the vendor charged for it — never a guess. See
   * each call site's own comment (and this task's write-up on the
   * fal-image-generation question) for why: lib/fal.ts's generateImage
   * wraps a pre-generation validation rejection, a mid-generation failure,
   * and a plain network error in the same ImageGenerationError, with nothing
   * left in what reaches this file to tell "never billed" apart from
   * "billed and lost." Recording a charge that did not happen is exactly
   * as wrong as missing one that did — so an attempt this codebase cannot
   * confirm was billed gets cost_usd = null here, the same as it would on
   * the Go side (see store.MarkFailed's doc comment for the mirrored rule
   * there, which — unlike this synchronous fal.subscribe path — DOES have
   * a reliable signal: a persisted kie_task_id).
   */
  costUsd: number | null;
  /** Set on a failed attempt; null on success — the reader-facing signal
   * that tells a wasted dollar apart from an earned one (see store.go's
   * MarkFailed doc comment for why this, not a new column, is the answer).
   */
  error?: string | null;
  /**
   * kie's task id, when the call reached the vendor at all.
   *
   * The call sites here record AFTER the outcome, so on success there is
   * nothing left to reconcile and this stays null. It matters on ONE path: a
   * poll-budget timeout, where kie is still drawing and this is the only
   * durable handle on a submission whose result nobody saw. Without it the
   * charge is real, the picture exists, and neither can be found again — see
   * failedRunFields below, which is what fills it in.
   */
  kieTaskId?: string | null;
}

/**
 * Inserts one `runs` row. Uses the admin client, same as every other write
 * in the action files that call this — `runs`' own RLS insert policy
 * (0002_rls.sql, patched by 0030_runs_project_id.sql) would in fact also
 * allow the acting user's own session client to write their own project's
 * run, but every mutation these action files make already goes through
 * createAdminClient() after its own requireProject/requireScene guard, and
 * this follows that established convention rather than being the one write
 * in the file that reaches for a different client.
 *
 * Throws (does not return an ActionResult) on a genuine insert failure —
 * this is infrastructure, not something an operator who just clicked
 * "Regenerate" can act on; see lib/action-result.ts for that split. Callers
 * that need this to not abort an otherwise-successful write path (there are
 * none today — every call site here awaits this before returning success)
 * should catch it explicitly rather than expect a silent no-op.
 */
export async function recordRun(run: RunRecord): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("runs").insert({
    project_id: run.projectId ?? null,
    user_id: run.userId ?? null,
    scene_id: run.sceneId ?? null,
    vendor: run.vendor,
    model: run.model,
    cost_usd: run.costUsd,
    error: run.error ?? null,
    kie_task_id: run.kieTaskId ?? null,
  });
  if (error) {
    throw new Error(
      `Failed to record run for project ${run.projectId ?? "(none — library-wide action)"}: ${error.message}`,
    );
  }
}

/**
 * The `runs` fields for an image call that threw — one rule, read from the four
 * call sites that record their outcome after the fact (actions/frames.ts,
 * actions/character.ts x2, actions/character-library.ts).
 *
 * The ONE distinction it encodes is the one that moves money. A poll-budget
 * timeout (KieTaskPendingError) means kie is STILL DRAWING and will still bill,
 * so the task id is kept and the estimate is HELD under the billing-unknown
 * prefix — the same release-vs-hold rule the Image Generator's reservation path
 * follows, applied to the call sites that have no reservation to hold. Recording
 * `cost_usd: null` there, as every one of them used to, reported a paid
 * generation as free: with a measured 149s generation against a 100s budget,
 * that is not a rare edge but the usual outcome for a slow model.
 *
 * Anything else keeps the old behaviour exactly — null cost, raw message — for
 * the reason RunRecord.costUsd already gives: a failure this codebase cannot
 * confirm was billed must not assert a charge.
 */
export function failedRunFields(
  err: unknown,
  estimateUsd: number,
): Pick<RunRecord, "costUsd" | "error" | "kieTaskId"> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof KieTaskPendingError) {
    return {
      kieTaskId: err.taskId,
      costUsd: estimateUsd,
      error: `${BILLING_UNKNOWN_PREFIX}${message}`,
    };
  }
  return { kieTaskId: null, costUsd: null, error: message };
}

/**
 * Runs one paid call and records its outcome either way: `costUsd` on
 * success, `null` + the error message on failure — then rethrows, so
 * callers keep whatever error handling (ImageGenerationError checks,
 * ActionResult returns) they already had. Exists because "try the paid
 * call, recordRun on success, catch-recordRun(null)-rethrow on failure" is
 * the same six lines at every one of this task's eight call sites; where a
 * call site's own control flow doesn't fit that shape cleanly (e.g.
 * actions/frames.ts's generateSceneFrame, which needs the fal result before
 * two more DB writes happen, or actions/compile.ts's runCompile, which
 * needs to read the model off env once up front), it stays inlined instead
 * of forced through here.
 */
export async function recordedCall<T>(
  meta: Omit<RunRecord, "costUsd" | "error">,
  costUsd: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    await recordRun({ ...meta, costUsd });
    return result;
  } catch (err) {
    await recordRun({
      ...meta,
      costUsd: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The Image Generator's attempt lifecycle (0083_image_generator.sql).
// ---------------------------------------------------------------------------
//
// Everything above records a run AFTER its outcome is known. This section is
// the other shape: a row that exists BEFORE the provider is called, so no paid
// call can happen without an accounting record already standing behind it.
//
//   reserved -> settled (real cost)      success
//            -> released (cost NULL)     kie demonstrably did not bill
//            -> held    (estimate kept)  outcome unknown
//
// Only `released` ever frees money, and only on evidence. Everything else keeps
// the charge counted, because over-reporting for seconds beats under-reporting
// real money.

/**
 * How long an unsettled reservation may sit before the sweep calls it
 * billing-unknown.
 *
 * A generation is ~22s observed, against a poll budget of 100s (lib/kie.ts).
 * Five minutes is 3x that ceiling: comfortably longer than any healthy run, so
 * the sweep never steals a live attempt out from under itself, and short enough
 * that a crashed one does not hold budget for an operator's whole afternoon.
 *
 * Erring long is the safe direction. A sweep that fires too early would mark a
 * still-running attempt as unknown; one that fires late only leaves an honest
 * estimate counted for longer than it needed to be.
 */
export const STALE_RESERVATION_MS = 5 * 60 * 1000;

/**
 * Mirrors worker/internal/store.BillingUnknownPrefix — deliberately the same
 * string, so one operational query finds these rows across both services.
 *
 * ⚠️ ONE DELIBERATE DIVERGENCE FROM THE WORKER, and it matters if you are
 * writing an alert. The worker keeps `cost_usd` NULL on a billing-unknown run
 * and its documented query is:
 *
 *     select ... from runs where error like 'billing-unknown:%' and cost_usd is null
 *
 * The Image Generator keeps the ESTIMATE instead (see holdRunBillingUnknown),
 * because a reservation that is already counted must not be silently released
 * by an outcome we could not read. So a held image attempt has the prefix AND a
 * non-null cost, and that `and cost_usd is null` clause does not match it.
 * Widen the query rather than changing this: dropping the estimate here would
 * free budget for a charge kie may well have made.
 *
 * MOVED to lib/image-attempt.ts and re-exported here, unchanged in value: the
 * status derivation needs it and runs in a Client Component, which cannot
 * import this module without dragging the service-role client into the browser.
 * Every existing importer keeps working.
 */
export { BILLING_UNKNOWN_PREFIX } from "./image-attempt";

type ReserveRow = Database["public"]["Functions"]["reserve_image_attempt"]["Returns"][number];

export type ReserveImageAttemptArgs = {
  /**
   * The project this image belongs to, or null for one generated straight
   * into an account (0085_personal_image_generator.sql). Exactly one of this
   * and `userId` decides how the RPC finds the owner and which idempotency
   * namespace it looks the key up in — see reserve_image_attempt's own
   * comment for why a project, when there is one, still wins over `userId`.
   */
  projectId: string | null;
  /** The account to bill when there is no project. Ignored when there is. */
  userId: string | null;
  idempotencyKey: string;
  estimateUsd: number;
  model: string;
  /**
   * Windows and ceilings exactly as lib/spend.ts's resolveImageAttemptCeilings
   * returns them — spread one in rather than rebuilding these by hand, or the
   * in-flight reduction it applies is silently lost.
   */
  dayStartIso: string;
  weekStartIso: string;
  nowIso: string;
  globalDailyCapUsd: number;
  globalCapEnabled: boolean;
  globalCapPeriod: "daily" | "weekly";
  weeklyCapUsd: number;
  /** Ignored unless dailyCapEnabled. */
  dailyCapUsd: number | null;
  dailyCapEnabled: boolean;
  hourlyCapUsd: number | null;
};

export type ReserveImageAttemptResult =
  | { outcome: "reserved"; runId: string }
  | { outcome: "duplicate"; runId: string }
  | {
      outcome: "blocked";
      blockedBy: NonNullable<ReserveRow["blocked_by"]>;
      spentUsd: number;
    };

/**
 * Checks the ceilings and creates the reservation in ONE transaction.
 *
 * Callers must NOT also call assertWithinSpendCaps: the RPC replaces its
 * arithmetic, and running both counts this request's own estimate twice,
 * refusing at half the real headroom. That is the bug the RPC exists to stop.
 *
 * Throws on an RPC error rather than returning a refusal — a failure here is
 * infrastructure, not something the operator can act on (lib/action-result.ts).
 */
export async function reserveImageAttempt(
  args: ReserveImageAttemptArgs,
): Promise<ReserveImageAttemptResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("reserve_image_attempt", {
    p_project_id: args.projectId,
    p_user_id: args.userId,
    p_idempotency_key: args.idempotencyKey,
    p_estimate_usd: args.estimateUsd,
    p_model: args.model,
    p_day_start_ts: args.dayStartIso,
    p_week_start_ts: args.weekStartIso,
    p_now_ts: args.nowIso,
    p_global_cap_usd: args.globalDailyCapUsd,
    p_global_cap_enabled: args.globalCapEnabled,
    p_global_cap_period: args.globalCapPeriod,
    p_weekly_cap_usd: args.weeklyCapUsd,
    p_daily_cap_usd: args.dailyCapUsd,
    p_daily_cap_enabled: args.dailyCapEnabled,
    p_hourly_cap_usd: args.hourlyCapUsd,
  });

  const subject = args.projectId ? `project ${args.projectId}` : `user ${args.userId}`;

  if (error) {
    throw new Error(`Failed to reserve an image attempt for ${subject}: ${error.message}`);
  }

  const row = data?.[0];
  if (!row) {
    // The function always returns exactly one row. Nothing here can recover
    // from it not doing so, and guessing an outcome would either charge for
    // an image nobody reserved or refuse one that was.
    throw new Error(`reserve_image_attempt returned no row for ${subject}`);
  }

  if (row.outcome === "blocked") {
    return {
      outcome: "blocked",
      blockedBy: row.blocked_by ?? "global",
      spentUsd: row.spent_usd ?? 0,
    };
  }
  if (!row.run_id) {
    throw new Error(`reserve_image_attempt returned ${row.outcome} without a run id`);
  }
  return { outcome: row.outcome, runId: row.run_id };
}

/**
 * True if this attempt is still running — used only to choose between "already
 * processing" and "already completed" after a duplicate.
 *
 * Advisory by nature: the row can settle between this read and the message
 * reaching the operator. Both messages refuse, neither charges, so the race
 * costs nothing worse than slightly stale wording.
 */
export async function isRunInFlight(runId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("runs").select("settled_at").eq("id", runId).single();
  if (error) {
    throw new Error(`Failed to read run ${runId}: ${error.message}`);
  }
  return data.settled_at === null;
}

/**
 * Persists kie's task id the moment createTask returns, BEFORE polling.
 *
 * The id exists for the whole ~22s poll, and a crash during it leaves a charge
 * that can only ever be reconciled if the id was written down first. Writing it
 * after the poll would be writing it after the window that needs it.
 */
export async function attachKieTaskId(runId: string, kieTaskId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("runs").update({ kie_task_id: kieTaskId }).eq("id", runId);
  if (error) {
    throw new Error(`Failed to persist kie task id on run ${runId}: ${error.message}`);
  }
}

/**
 * What a link attempt settled on. The three are genuinely different actions for
 * the caller, which is why this is not a boolean:
 * - `linked`    this write won; the run now points at the caller's asset.
 * - `taken`     another writer got there first. The caller's asset is a
 *               DUPLICATE and must be cleaned up, not left orphaned.
 * - `unknown`   the write itself failed. Nothing can be concluded, so the
 *               caller must keep its asset — deleting a real, paid-for image on
 *               a failed bookkeeping write is the one unrecoverable mistake
 *               here.
 */
export type RunAssetLink = "linked" | "taken" | "unknown";

/**
 * Records WHICH image this attempt produced (0095_image_attempt_recovery.sql).
 *
 * Written after the asset row exists, and deliberately not folded into
 * settleRunSuccess: settling happens BEFORE the upload, because the charge is
 * real the moment kie returns a picture whether or not we manage to keep the
 * file. Waiting for a storage key to settle would lose the true cost every time
 * storage failed. So the money is recorded first and the link second.
 *
 * `is("asset_id", null)` makes this a COMPARE-AND-SWAP, and that is what makes
 * recovery safe to double-click. Two concurrent recoveries of the same attempt
 * each check kie (free), each upload, and each insert an asset — only one can
 * win this update, and the loser is told so and deletes what it made. Postgres
 * serialises the two on the row lock, so the second re-reads asset_id after the
 * first commits and correctly finds it non-null. Without the predicate the
 * second write would silently overwrite the link and strand the first image as
 * an asset row nothing references.
 *
 * Never THROWS, for the same reason it never did: the image is stored and the
 * charge is settled by the time this runs, and turning a saved, paid-for image
 * into an error toast is worse than a missing link. It reports instead.
 */
export async function attachRunAsset(runId: string, assetId: string): Promise<RunAssetLink> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("runs")
    .update({ asset_id: assetId })
    .eq("id", runId)
    .is("asset_id", null)
    .select("id");
  if (error) {
    console.error(`attachRunAsset: run ${runId} could not point at asset ${assetId}`, error);
    return "unknown";
  }
  return (data?.length ?? 0) > 0 ? "linked" : "taken";
}

/**
 * Success: the estimate is replaced by what kie actually charged.
 *
 * Deliberately NOT restricted to unsettled rows. If the sweep already held this
 * attempt at its estimate, a real figure arriving late is strictly better
 * information and should win.
 */
export async function settleRunSuccess(runId: string, costUsd: number | null): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("runs")
    .update({ cost_usd: costUsd, error: null, settled_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) {
    throw new Error(`Failed to settle run ${runId}: ${error.message}`);
  }
}

/**
 * Released: kie demonstrably did not bill, so the allowance is freed at once.
 *
 * The ONLY path that sets cost_usd back to NULL, and the only one that gives
 * budget back. Restricted to still-unsettled rows on purpose: once an attempt
 * has been held as billing-unknown, a late "it failed" must not undo that and
 * free money for a charge kie may have made. Conservative stays conservative.
 */
export async function releaseRun(runId: string, message: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("runs")
    .update({ cost_usd: null, error: message, settled_at: new Date().toISOString() })
    .eq("id", runId)
    .is("settled_at", null);
  if (error) {
    throw new Error(`Failed to release run ${runId}: ${error.message}`);
  }
}

/**
 * Held: the outcome could not be read, so the estimate stays counted and the
 * row is marked for reconciliation.
 *
 * See BILLING_UNKNOWN_PREFIX for why this keeps a cost where the worker's
 * equivalent keeps NULL. Restricted to unsettled rows so it can never overwrite
 * a real settled cost with an estimate.
 */
export async function holdRunBillingUnknown(runId: string, message: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("runs")
    .update({ error: `${BILLING_UNKNOWN_PREFIX}${message}`, settled_at: new Date().toISOString() })
    .eq("id", runId)
    .is("settled_at", null);
  if (error) {
    throw new Error(`Failed to hold run ${runId}: ${error.message}`);
  }
}

/**
 * The two shapes an image attempt has, as a discriminated union on
 * `projectId` — a project's reservations, or one account's project-less ones
 * (0085_personal_image_generator.sql). `userId?: never` on the project arm is
 * what makes it discriminated rather than merely overlapping: passing both is
 * a compile error, not a silently-narrower sweep.
 */
export type ImageReservationScope =
  { projectId: string; userId?: never } | { projectId: null; userId: string };

/**
 * Settles this scope's abandoned reservations before starting a new one.
 *
 * Crash recovery without a cron: a process that died mid-generation leaves a
 * row counting its estimate forever, and the next generation in the same scope
 * is the natural moment to clean up. Lazy in both senses.
 *
 * The SCOPE is a project or an account, matching the two shapes an image
 * attempt now has (0085_personal_image_generator.sql). It is deliberately not
 * widened to "every stale reservation everywhere": a sweep that ranged over
 * other people's rows would let one editor's Generate press settle another's
 * in-flight attempt, and the caller has no business writing to an account it
 * was not acting as.
 *
 * Two things it must never do, both encoded in the filter:
 * - Never RELEASE. It settles at the estimate, because a crash tells us nothing
 *   about whether kie billed. Releasing here would invent evidence.
 * - Never touch another path's rows. `idempotency_key is not null` is what makes
 *   this the Image Generator's own sweep; every other writer in both services
 *   leaves that column NULL and settles on write (0083 gives settled_at a
 *   default of now() so they cannot look in-flight by accident).
 */
export async function sweepStaleImageReservations(scope: ImageReservationScope): Promise<number> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - STALE_RESERVATION_MS).toISOString();
  let query = admin.from("runs").update({
    error: `${BILLING_UNKNOWN_PREFIX}abandoned reservation swept after ${STALE_RESERVATION_MS / 1000}s`,
    settled_at: new Date().toISOString(),
  });

  // `is("project_id", null)` on the personal branch, not just the user filter:
  // reserve_image_attempt writes user_id on BOTH branches, so an account's own
  // project-backed reservations would otherwise be swept from a page that has
  // no business touching them.
  query =
    scope.projectId !== null
      ? query.eq("project_id", scope.projectId)
      : query.is("project_id", null).eq("user_id", scope.userId);

  const { data, error } = await query
    .is("settled_at", null)
    .not("idempotency_key", "is", null)
    .lt("created_at", cutoff)
    .select("id");

  const subject = scope.projectId !== null ? `project ${scope.projectId}` : `user ${scope.userId}`;
  if (error) {
    throw new Error(`Failed to sweep stale reservations for ${subject}: ${error.message}`);
  }
  return data?.length ?? 0;
}
