"use server";

// The /users burn drawer's read: one account's daily spend and spend by model
// over the last 14 or 30 Manila days. Admin only — the drawer is a control of
// /users, and the read is cross-account, which RLS also allows only an admin.
// Returned as data, not thrown: React redacts a thrown message in production.

import { requireAdmin } from "@/actions/guard";
import { runModelLabel } from "@/lib/accounts-control";
import { manilaDayKeys } from "@/lib/burn";
import { getDailySpendByUser, getModelSpendByUser } from "@/lib/burn-data";
import { createClient } from "@/lib/supabase/server";

export type BurnWindowDays = 14 | 30;

export interface AccountBurnDetail {
  /** Manila day keys, oldest first, ending today. */
  dates: string[];
  days: number[];
  models: { label: string; runs: number; costUsd: number }[];
}

export type AccountBurnResult = { error: string } | { detail: AccountBurnDetail };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getAccountBurn(userId: string, days: number): Promise<AccountBurnResult> {
  await requireAdmin();
  if (!UUID.test(userId)) return { error: "That account id is not valid." };
  const windowDays: BurnWindowDays = days === 30 ? 30 : 14;

  try {
    const supabase = await createClient();
    const now = new Date();
    const [daily, modelRows] = await Promise.all([
      getDailySpendByUser(supabase, [userId], windowDays, now),
      getModelSpendByUser(supabase, userId, windowDays, now),
    ]);

    // BytePlus and kie share Seedance 2.5's wire id; the vendor tells them apart
    // (same rule as accounts-control's buildModelUsage).
    const byLabel = new Map<string, { label: string; runs: number; costUsd: number }>();
    for (const row of modelRows) {
      const label = runModelLabel(row.model) + (row.vendor === "byteplus" ? " · BytePlus" : "");
      const entry = byLabel.get(label) ?? { label, runs: 0, costUsd: 0 };
      entry.runs += row.runs;
      entry.costUsd += row.costUsd;
      byLabel.set(label, entry);
    }

    return {
      detail: {
        dates: manilaDayKeys(now, windowDays),
        days: daily.get(userId) ?? [],
        models: [...byLabel.values()].sort((a, b) => b.costUsd - a.costUsd),
      },
    };
  } catch (error) {
    console.error(`Failed to load burn detail for ${userId}`, error);
    return { error: "Could not load this account's spend. Try again." };
  }
}
