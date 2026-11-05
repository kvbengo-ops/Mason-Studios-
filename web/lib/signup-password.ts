// Password rules for the signup form, expressed as zod schemas so the
// client form and the signUp Server Action validate off the same source —
// see lib/signup-schema.ts, which composes this with signup-username.ts's
// field schema into the one schema both sides import. Pulled out of
// actions/auth.ts originally — a "use server" file, where every export must
// be an async Server Action — so this stays a plain module, mirroring
// lib/enqueue-guard.ts and lib/recompile-guard.ts.
//
// Deliberately just a length floor plus a confirm-match check. This app
// provisioned its first three accounts by hand with whatever passwords an
// admin typed into the Supabase dashboard — there is no complexity-rule
// tradition here to extend, and inventing one now (mixed case, digits,
// symbols) would only produce friction Supabase's own auth server doesn't
// require and this codebase never asked for.

import { z } from "zod";

export const MIN_PASSWORD_LENGTH = 8;

/** The password field on its own — reused wherever only the length floor applies. */
export const passwordFieldSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

/**
 * Password + confirm together, with the match check as a superRefine so the
 * "do these match" issue lands on `confirmPassword` specifically rather than
 * being indistinguishable from the length issue on `password`. This is the
 * single place the match rule is expressed — lib/signup-schema.ts intersects
 * it with the username/email fields for the full form, and
 * checkSignupPassword below is a thin adapter over the same schema.
 */
export const signupPasswordSchema = z
  .object({
    password: passwordFieldSchema,
    confirmPassword: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.password !== data.confirmPassword) {
      ctx.addIssue({
        code: "custom",
        message: "Passwords do not match.",
        path: ["confirmPassword"],
      });
    }
  });

export type PasswordCheckResult = { valid: true } | { valid: false; reason: string };

/**
 * Checks a password against the length floor and, if given, a confirm
 * value. Kept as a plain function for callers that want one combined
 * result rather than a zod issue list (actions/auth.ts's early-exit
 * validation). Reports the length problem before the mismatch when both
 * are wrong, matching the schema's field order.
 */
export function checkSignupPassword(
  password: string,
  confirmPassword: string,
): PasswordCheckResult {
  const result = signupPasswordSchema.safeParse({ password, confirmPassword });
  if (result.success) {
    return { valid: true };
  }

  // safeParse failed, so zod guarantees at least one issue.
  const lengthIssue = result.error.issues.find((issue) => issue.path[0] === "password");
  const issue = lengthIssue ?? result.error.issues[0]!;
  return { valid: false, reason: issue.message };
}
