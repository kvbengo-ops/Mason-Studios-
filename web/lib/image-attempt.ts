// What state an image attempt is in, DERIVED from the columns that already
// record the facts rather than stored as a sixth fact that has to agree with
// them.
//
// AGENTS.md: "Project status is derived from `scenes` on every read — storing
// it drifts." An attempt's status is the same shape of thing. `settled_at`,
// `kie_task_id`, `error` and `asset_id` are each written at the moment their
// fact becomes true, by the one writer that knows it; a status column would be
// a copy of all four, updated by hand, wrong the first time any path forgot it.
//
// Pure, and importable from a Client Component: no Supabase client, no env, no
// secrets. lib/runs.ts does the writing and pulls the prefix below from here,
// not the other way around — importing runs.ts into the browser would ship the
// service-role client with it.

/**
 * Mirrors worker/internal/store.BillingUnknownPrefix — the same string in both
 * services, so one operational query finds these rows across the whole system.
 * Defined here rather than in lib/runs.ts because both the writer and this
 * derivation need it, and only this module is safe to import from the client.
 */
export const BILLING_UNKNOWN_PREFIX = "billing-unknown: ";

/**
 * The five states the operator is shown.
 *
 * `queued` and `generating` are both "unfinished", and the difference is worth
 * keeping: a reservation with no task id has NOT reached the vendor, so nothing
 * can have been billed for it yet, while one with a task id has and may have
 * been. That is the same distinction the money path already turns on (see
 * lib/runs.ts's release-vs-hold discriminator) — this just gives it a name the
 * UI can print.
 */
export type ImageAttemptStatus =
  "queued" | "generating" | "completed" | "failed" | "billing_unknown";

/** The columns the derivation reads. A `runs` row, narrowed to what matters. */
export interface ImageAttemptFacts {
  settledAt: string | null;
  kieTaskId: string | null;
  error: string | null;
}

export function imageAttemptStatus(facts: ImageAttemptFacts): ImageAttemptStatus {
  // Unsettled is unfinished, whatever else the row says. Checked first because
  // an in-flight row can carry a stale error from nothing — the error column is
  // only meaningful once the outcome is known.
  if (facts.settledAt === null) {
    return facts.kieTaskId ? "generating" : "queued";
  }
  if (facts.error === null) return "completed";
  // The prefix is the marker, not the presence of text: a held attempt keeps
  // its ESTIMATE counted (lib/runs.ts's holdRunBillingUnknown), so calling it a
  // plain failure would tell the operator no money is at stake when it may be.
  return facts.error.startsWith(BILLING_UNKNOWN_PREFIX) ? "billing_unknown" : "failed";
}

/** True while the attempt may still change on its own. */
export function isImageAttemptUnfinished(status: ImageAttemptStatus): boolean {
  return status === "queued" || status === "generating";
}

/**
 * The reason to show, with the billing-unknown marker stripped.
 *
 * The prefix is an operational marker for a `like` query across both services,
 * not a sentence — leaving it in front of the vendor's own message makes the
 * one line the operator reads start with jargon that repeats what the status
 * badge beside it already says.
 */
export function imageAttemptReason(error: string | null): string | null {
  if (!error) return null;
  return error.startsWith(BILLING_UNKNOWN_PREFIX)
    ? error.slice(BILLING_UNKNOWN_PREFIX.length)
    : error;
}
