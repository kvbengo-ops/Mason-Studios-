import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }
  return value;
}

/**
 * Request-scoped Supabase client. Anon key, respects RLS, carries the
 * signed-in user's session via cookies. Default choice for reads in Server
 * Components and for any Server Action that acts on behalf of the current
 * user.
 */
export async function createClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();
  const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll(): { name: string; value: string }[] {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]): void {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll called from a Server Component (not a Server Action or
          // Route Handler) — cookies can't be written here. Middleware
          // refreshes the session on every request, so this is safe to
          // ignore.
        }
      },
    },
  });
}

/**
 * Service-role Supabase client. BYPASSES ROW LEVEL SECURITY ENTIRELY.
 *
 * Only call this from Server Actions that have already verified ownership
 * via `actions/guard.ts` (requireUser / requireProject / requireScene).
 * Never use it to serve a user-driven read — every list/detail read the
 * user sees must go through `createClient()` above so RLS (and the
 * admin-is-read-only rule in 0002_rls.sql) actually applies.
 */
// Memoized at module scope, and safe to be: this client carries no
// per-request state. `persistSession: false` and `autoRefreshToken: false`
// below mean there is no session, no token to refresh, and nothing tied to
// one caller — every request already authenticates as service_role via the
// key. Sharing one instance across requests is therefore the same client,
// not a leak between users. (createClient() above is the opposite and is
// deliberately NOT memoized: it reads the caller's own cookies.)
//
// Why bother: a single sidebar render used to build about six of these —
// four of the five budget reads construct their own, plus getSidebarBudget
// itself — and there are 75 call sites overall. Production perf logs put
// budget_ms at 169ms p50 inside a region where a warm connection is ~5ms,
// and the sequential-vs-parallel shape of those reads looks like connection
// establishment rather than query work. Reusing one client lets the
// underlying fetch agent keep connections alive instead of starting over.
//
// That last part is a hypothesis, not a measurement — see the task notes.
// This change stands on its own regardless: building six identical
// stateless clients to do five reads was waste whatever the timing says.
let adminClient: SupabaseClient<Database> | null = null;

export function createAdminClient(): SupabaseClient<Database> {
  if (adminClient) return adminClient;

  const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  // Assigned only after both getEnv calls have succeeded, so a missing or
  // malformed env var keeps throwing on every call rather than being
  // memoized into a permanently broken client.
  adminClient = createSupabaseClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return adminClient;
}
