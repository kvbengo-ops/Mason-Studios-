import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { Database } from "@/types/db";

// /signup belongs here for the obvious reason and one less obvious one: a
// signup page that is only reachable once you are signed in is not a signup
// page. Nothing in the type system or the test suite catches that — the
// route builds, the component renders, and every visitor still lands on
// /login.
// /pending is public in the sense that matters here — "do not bounce this
// request to /login" — even though only a signed-in account ever has a
// reason to be there. It is where requireUser() sends an account an admin
// has not approved yet (0052_account_approval.sql), and the page decides
// for itself who may see it: signed out goes to /login, approved goes to
// /create. Note what it is NOT in: the authenticated-user bounce below
// covers /login and /signup only, which is what lets a pending account
// stay on /pending instead of being volleyed back to /create and
// redirected out again by the guard.
const PUBLIC_PATHS = ["/login", "/signup", "/auth/callback", "/pending", "/api/v1"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Refreshes the Supabase session cookie on every request and redirects:
 *   - unauthenticated users away from anything but the public paths, to /login
 *   - authenticated users away from /login and /signup, to /create
 *
 * Called from web/middleware.ts.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
    );
  }

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll(): { name: string; value: string }[] {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[],
      ): void {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const redirectUrl = new URL("/login", request.url);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const redirectUrl = new URL("/create", request.url);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
