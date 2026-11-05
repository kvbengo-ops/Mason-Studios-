// Fail-soft read of applied_schema_version() for the sidebar footer
// (app/(app)/layout.tsx). Extracted out of that layout's inline IIFE so this
// contract has a test file of its own — see db-version.test.ts.
import { createClient } from "@/lib/supabase/server";

/**
 * Reads applied_schema_version() (supabase/migrations, the migration a
 * separate change introduces) for display in the sidebar footer. This is a
 * diagnostic readout, not a gate — a missing function (not yet migrated), a
 * network hiccup, or an RLS/auth surprise must degrade to `null` and let the
 * sidebar footer render `db ?`, never take the shell down. Uses the
 * request-scoped client (createClient), not the admin one, because the
 * function is only granted to `authenticated` — matching who's actually
 * asking here, same as every other user-facing read in this layout.
 */
export async function readAppliedSchemaVersion(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("applied_schema_version");
    if (error) return null;
    return data ?? null;
  } catch (error) {
    console.error("Failed to read applied_schema_version for sidebar footer", error);
    return null;
  }
}
