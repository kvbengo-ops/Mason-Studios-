// Username rules for the signup form, expressed as a zod schema so the
// client form and the signUp Server Action validate off the same source —
// see lib/signup-schema.ts, which composes this with signup-password.ts's
// schema into the one schema both sides import. Pulled out of
// actions/auth.ts originally — a "use server" file, where every export must
// be an async Server Action — so this stays a plain module, mirroring
// lib/signup-password.ts and lib/signup-allowlist.ts.
//
// The rules mirror supabase/migrations/0015_profile_username.sql's
// `profiles_username_charset_check` exactly (3-20 chars, [A-Za-z0-9_] only)
// on purpose: this is the client-side half of a check that also has to
// live in the database, because the database is the only layer that can
// actually enforce it against a hand-crafted request. Duplicating the
// regex here means a mistyped username is rejected with an explanation
// before the round trip, instead of surfacing as an opaque failure from
// signUp — see actions/auth.ts for why that failure is otherwise not
// cleanly detectable.

import { z } from "zod";

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 20;

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

const USERNAME_LENGTH_MESSAGE = `Username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`;

/** The username field alone, reused directly by the composed signup form schema. */
export const usernameFieldSchema = z
  .string()
  .min(MIN_USERNAME_LENGTH, USERNAME_LENGTH_MESSAGE)
  .max(MAX_USERNAME_LENGTH, USERNAME_LENGTH_MESSAGE)
  .regex(USERNAME_PATTERN, "Username can only contain letters, numbers, and underscores.");

export type UsernameCheckResult = { valid: true } | { valid: false; reason: string };

/**
 * Checks a username against the same length/charset rules as the CHECK
 * constraint. Kept as a plain function for callers that want one combined
 * result rather than a zod issue list (actions/auth.ts's early-exit
 * validation); reports the length problem before the charset problem when
 * both are wrong, matching the schema's field order.
 */
export function checkSignupUsername(username: string): UsernameCheckResult {
  const result = usernameFieldSchema.safeParse(username);
  if (result.success) {
    return { valid: true };
  }

  // safeParse failed, so zod guarantees at least one issue.
  const lengthIssue = result.error.issues.find(
    (issue) => issue.code === "too_small" || issue.code === "too_big",
  );
  const issue = lengthIssue ?? result.error.issues[0]!;
  return { valid: false, reason: issue.message };
}
