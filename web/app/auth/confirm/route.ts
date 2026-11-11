import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/app/auth/callback/route";

/**
 * Verifies a password-recovery token_hash via verifyOtp and redirects to `next`
 * on the app's own origin. Unlike /auth/callback's PKCE code exchange (which
 * needs a verifier cookie from the browser that requested the reset),
 * token_hash + verifyOtp works when the email link is opened on any device.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeNext(searchParams.get("next"));

  const base = new URL(process.env.NEXT_PUBLIC_APP_URL || origin).origin;

  if (tokenHash && type === "recovery") {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "recovery",
    });
    if (!error) {
      const target = new URL(next, base);
      if (target.origin === base) {
        return NextResponse.redirect(target);
      }
    } else {
      console.error(`[auth/confirm] verifyOtp failed: ${error.message}`);
    }
  }

  return NextResponse.redirect(new URL("/login", base));
}
