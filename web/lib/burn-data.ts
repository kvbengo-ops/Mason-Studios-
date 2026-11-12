// Reads behind the burn column, strip and drawer: spend_daily_by_user /
// spend_models_by_user (0135_spend_burn_rate.sql). Same source as the caps and
// Accounts Control: runs.cost_usd plus the archive of deleted projects, so a
// deactivated account's past spend still counts. No per-user read here is
// unbounded: the callers pass the ids on one /users page, or one account.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import {
  SPEND_DAY_SHIFT_MS,
  fillDays,
  manilaDayKeys as midnightDayKeys,
  manilaWindowEndIso as midnightWindowEndIso,
  manilaWindowStartIso as midnightWindowStartIso,
  spendDay,
} from "@/lib/burn";

// Spend days (05:00 to 05:00 Manila), matching spend_daily_by_user since 0141.
const shiftIso = (iso: string): string =>
  new Date(Date.parse(iso) + SPEND_DAY_SHIFT_MS).toISOString();
const manilaDayKeys = (now: Date, days: number): string[] => midnightDayKeys(spendDay(now), days);
const manilaWindowStartIso = (now: Date, days: number): string =>
  shiftIso(midnightWindowStartIso(spendDay(now), days));
const manilaWindowEndIso = (now: Date): string => shiftIso(midnightWindowEndIso(spendDay(now)));

type Client = SupabaseClient<Database>;

/** Per-day spend (oldest first, ending today, Manila) for each account in `userIds`. One query. */
export async function getDailySpendByUser(
  supabase: Client,
  userIds: readonly string[],
  days: number,
  now: Date = new Date(),
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (userIds.length === 0) return out;
  const { data, error } = await supabase.rpc("spend_daily_by_user", {
    from_ts: manilaWindowStartIso(now, days),
    to_ts: manilaWindowEndIso(now),
    user_ids: [...userIds],
  });
  if (error) throw new Error(`Failed to load daily spend: ${error.message}`);
  const keys = manilaDayKeys(now, days);
  const rowsByUser = new Map<string, { day: string; total_usd: number }[]>();
  for (const row of data ?? []) {
    if (!row.user_id) continue;
    const rows = rowsByUser.get(row.user_id) ?? [];
    rows.push(row);
    rowsByUser.set(row.user_id, rows);
  }
  for (const id of userIds) out.set(id, fillDays(rowsByUser.get(id) ?? [], keys));
  return out;
}

/** The whole team's per-day spend, archived (deactivated/deleted) spend included. */
export async function getTeamDailySpend(
  supabase: Client,
  days: number,
  now: Date = new Date(),
): Promise<number[]> {
  const { data, error } = await supabase.rpc("spend_daily_by_user", {
    from_ts: manilaWindowStartIso(now, days),
    to_ts: manilaWindowEndIso(now),
    user_ids: null,
  });
  if (error) throw new Error(`Failed to load team daily spend: ${error.message}`);
  return fillDays(data ?? [], manilaDayKeys(now, days));
}

export interface BurnModelRow {
  model: string;
  vendor: string;
  runs: number;
  costUsd: number;
}

/** One account's spend by model over the last `days` Manila days. */
export async function getModelSpendByUser(
  supabase: Client,
  userId: string,
  days: number,
  now: Date = new Date(),
): Promise<BurnModelRow[]> {
  const { data, error } = await supabase.rpc("spend_models_by_user", {
    target_user_id: userId,
    from_ts: manilaWindowStartIso(now, days),
    to_ts: manilaWindowEndIso(now),
  });
  if (error) throw new Error(`Failed to load spend by model: ${error.message}`);
  return (data ?? []).map((row) => ({
    model: row.model,
    vendor: row.vendor,
    runs: Number(row.run_count),
    costUsd: row.cost_usd,
  }));
}
