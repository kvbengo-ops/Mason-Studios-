import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-auth";
import { apiError } from "@/lib/api-v1";
import { getAccountBudgetSnapshot } from "@/lib/spend";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireApiToken(request, "read");
  if (!auth.ok) return auth.response;

  try {
    const budget = await getAccountBudgetSnapshot(auth.userId, auth.profile);
    return NextResponse.json({
      daily_remaining_usd: Math.max(0, budget.dailyRemainingUsd),
      weekly_remaining_usd: Math.max(0, budget.weeklyRemainingUsd),
      daily_cap_usd: budget.dailyCapUsd,
      weekly_cap_usd: budget.weeklyCapUsd,
      daily_cap_enabled: budget.dailyCapEnabled,
    });
  } catch (error) {
    console.error("GET /api/v1/allowance failed", error);
    return apiError("Could not read allowance.", "allowance_failed", 500);
  }
}
