import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Exchanges a Supabase auth code for a session. Hit by the redirect link
 * in email-confirmation and password-recovery emails — there is no public
 * signup flow, but existing accounts still go through this route for
 * password resets.
 */
const DEFAULT_NEXT = "/create";

/**
 * `next` arrives from a link in an email, so it is attacker-influenced: a
 * crafted recovery URL could otherwise bounce a freshly-authenticated user
 * to an external site that mimics the login page. Only same-origin relative
 * paths are honoured; anything else falls back to the default.
 */
export function safeNext(candidate: string | null): string {
  if (!candidate) return DEFAULT_NEXT;

  // Reject protocol-relative ("//evil.com") and backslash-smuggled variants
  // before they ever reach the URL parser.
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return DEFAULT_NEXT;
  }

  return candidate;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"));

  // `origin` above is the address this process is listening on, not the
  // address the user typed: Render's proxy strips the public host, so inside
  // the container it resolves to https://0.0.0.0:10000 and every redirect
  // below sends the user somewhere unroutable. NEXT_PUBLIC_APP_URL is this
  // service's own public URL (render.yaml) — fall back to the request origin
  // so local dev keeps working with it unset. Re-parsing through `.origin`
  // normalises away a trailing slash or path, which the guard below compares
  // against exactly.
  const base = new URL(process.env.NEXT_PUBLIC_APP_URL || origin).origin;

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const target = new URL(next, base);
      // Belt and braces: resolution must not have escaped our origin.
      if (target.origin === base) {
        return NextResponse.redirect(target);
      }
    } else {
      // Without this the /login fallback below is indistinguishable from a
      // link that never carried a code at all — which is exactly the state
      // that made the 0.0.0.0 redirect above so slow to diagnose.
      console.error(`[auth/callback] exchange failed: ${error.message}`);
    }
  }

  return NextResponse.redirect(new URL("/login", base));
}
