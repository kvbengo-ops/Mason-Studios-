// Pure check for the self-serve signup domain lever (SIGNUP_ALLOWED_DOMAINS
// in render.yaml). Pulled out of actions/auth.ts — a "use server" file,
// where every export must be an async Server Action — so this stays a
// plain, synchronous, unit-testable function, mirroring lib/enqueue-guard.ts
// and lib/recompile-guard.ts.
//
// Unset or empty means open signup: that is the default the operator asked
// for today, and it also means a deploy that forgets to configure the env
// var fails open rather than silently locking everyone out. If spending
// gets abused, setting the var to a comma-separated domain list is the
// lever that closes signup down to a company domain without a code change.
//
// Deliberately NOT a zod schema alongside lib/signup-username.ts and
// lib/signup-password.ts: SIGNUP_ALLOWED_DOMAINS is a server-only env var,
// unavailable in the browser, so there is nothing for a client-side schema
// to check it against. Folding it into lib/signup-schema.ts (the shared
// client+server schema) would either bake a build-time env value into the
// client bundle or silently pass client-side, neither of which this check
// can afford — it stays a function actions/auth.ts calls directly.

/**
 * Parses SIGNUP_ALLOWED_DOMAINS into a normalized domain list. Domains are
 * lowercased and trimmed so "Example.com, foo.com" and "example.com,foo.com"
 * behave identically — this is meant to be hand-edited in a dashboard env
 * var field, where stray capitalization and spacing are inevitable.
 */
function parseAllowedDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
}

/**
 * Returns the domain (lowercased) after the last "@" in an email, or null
 * if the email has no "@". Signup already validates email shape via
 * supabase.auth.signUp, so this only needs to be good enough to key off of
 * — not a full RFC 5321 parser.
 */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

export type SignupAllowedResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Checks `email` against SIGNUP_ALLOWED_DOMAINS (raw env var value, so the
 * caller doesn't need to know the parsing rules). An empty or unset list
 * allows every domain — that's the "open signup" default described above.
 */
export function checkSignupDomainAllowed(
  email: string,
  allowedDomainsEnv: string | undefined,
): SignupAllowedResult {
  const allowedDomains = parseAllowedDomains(allowedDomainsEnv);

  // Open signup: no allowlist configured.
  if (allowedDomains.length === 0) {
    return { allowed: true };
  }

  const domain = emailDomain(email);
  if (domain && allowedDomains.includes(domain)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Signup is limited to ${allowedDomains.join(", ")} email addresses.`,
  };
}
