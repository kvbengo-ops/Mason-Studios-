"use server";

import { requireUser } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * Presence heartbeat: stamps the caller's own profiles.last_seen_at (0130).
 * Accounts Control turns it into a green or red dot. requireUser first, then
 * one write keyed on the session's own user id, never on an argument.
 *
 * rateLimit: false. The heartbeat fires every 60s per open tab and must not
 * eat the action budget real work spends.
 */
export async function touchPresence(): Promise<void> {
  const { user } = await requireUser({ rateLimit: false });
  const { error } = await createAdminClient()
    .from("profiles")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", user.id);
  if (error) console.warn(`touchPresence: ${error.message}`);
}
