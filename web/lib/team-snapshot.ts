// Whole-team reads behind the admin dashboards' tiles and filters (/users,
// /accounts-control): who exists, who is online, what each account spent
// this Manila week, and who is near the weekly cap. Three reads of one row
// per account, never one per row of a page.
//
// ponytail: the profiles and account_spend_windows reads are unpaged, so
// PostgREST's max_rows (1000, supabase/config.toml) is the ceiling. Past
// ~1000 accounts this needs a SQL view that resolves the near-cap set.
//
// The cap is resolved here rather than in SQL because the role defaults are
// render.yaml env vars no view can read (see 0031's account_spend_windows
// header). lib/spend.ts is loaded with a dynamic import for the reason
// /users' own comment gives: a malformed cap env var throws at its module
// load, and these pages must still render then — nearCapIds is null instead.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserActiveGrantsTotals } from "@/lib/db-aggregates";
import { isNearWeeklyCap } from "@/lib/period-change";
import { PRESENCE_WINDOW_MS } from "@/lib/presence";
import type { Database, ProfileRole, ProfileStatus } from "@/types/db";

type Client = SupabaseClient<Database>;

export interface TeamAccount {
  id: string;
  username: string;
  email: string;
  role: ProfileRole;
  status: ProfileStatus;
  avatar_storage_key: string | null;
  last_seen_at: string | null;
}

export interface TeamSnapshot {
  /** Every profile, archived (deactivated) ones included — callers filter. */
  accounts: TeamAccount[];
  /** Non-archived accounts. */
  activeAccounts: TeamAccount[];
  /** Non-archived accounts seen in the presence window, most recent first. */
  onlineAccounts: TeamAccount[];
  /** This Manila week's spend per account, archived accounts included. */
  weekSpentByUser: Map<string, number>;
  /** Non-archived accounts at 80%+ of weekly cap + active grants; null when caps could not be resolved. */
  nearCapIds: Set<string> | null;
}

export async function loadTeamSnapshot(supabase: Client, now: Date = new Date()): Promise<TeamSnapshot> {
  const [profiles, windows] = await Promise.all([
    supabase
      .from("profiles")
      .select(
        "id, username, email, role, status, avatar_storage_key, last_seen_at, daily_cap_override_usd, weekly_cap_override_usd",
      ),
    supabase.from("account_spend_windows").select("user_id, spent_this_week_usd"),
  ]);
  if (profiles.error) throw new Error(`Failed to load team profiles: ${profiles.error.message}`);
  if (windows.error) throw new Error(`Failed to load team spend: ${windows.error.message}`);

  const rows = profiles.data ?? [];
  const accounts: TeamAccount[] = rows.map(
    ({ id, username, email, role, status, avatar_storage_key, last_seen_at }) => ({
      id,
      username,
      email,
      role,
      status,
      avatar_storage_key,
      last_seen_at,
    }),
  );
  const activeAccounts = accounts.filter((a) => a.status !== "deactivated");
  const cutoff = now.getTime() - PRESENCE_WINDOW_MS;
  const onlineAccounts = activeAccounts
    .filter((a) => a.last_seen_at !== null && Date.parse(a.last_seen_at) >= cutoff)
    .sort((a, b) => (a.last_seen_at! < b.last_seen_at! ? 1 : -1));

  const weekSpentByUser = new Map<string, number>();
  for (const row of windows.data ?? []) {
    if (row.user_id) weekSpentByUser.set(row.user_id, row.spent_this_week_usd ?? 0);
  }

  let nearCapIds: Set<string> | null = null;
  try {
    const { resolveAccountCaps } = await import("@/lib/spend");
    const spenders = rows.filter(
      (r) => r.status !== "deactivated" && (weekSpentByUser.get(r.id) ?? 0) > 0,
    );
    // Grants only for accounts that spent anything: nobody else can be near.
    const grants = await getUserActiveGrantsTotals(
      supabase,
      spenders.map((r) => r.id),
      now.toISOString(),
    );
    nearCapIds = new Set(
      spenders
        .filter((r) =>
          isNearWeeklyCap(
            weekSpentByUser.get(r.id) ?? 0,
            resolveAccountCaps(r).weeklyCapUsd + (grants.get(r.id)?.totalUsd ?? 0),
          ),
        )
        .map((r) => r.id),
    );
  } catch (error) {
    console.error("Failed to resolve near-cap accounts", error);
  }

  return { accounts, activeAccounts, onlineAccounts, weekSpentByUser, nearCapIds };
}

/** `runs.error` of every attempt that failed since `sinceIso`. ponytail: capped at 1000 rows; a day with more failures under-counts the groups. */
export async function loadFailedRunErrors(supabase: Client, sinceIso: string): Promise<(string | null)[]> {
  const { data, error } = await supabase
    .from("runs")
    .select("error")
    .not("error", "is", null)
    .gte("created_at", sinceIso)
    .limit(1000);
  if (error) throw new Error(`Failed to load failed runs: ${error.message}`);
  return (data ?? []).map((r) => r.error);
}
