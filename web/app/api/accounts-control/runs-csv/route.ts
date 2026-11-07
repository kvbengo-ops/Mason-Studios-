import { NextResponse } from "next/server";
import { AuthorizationError, requireAdmin } from "@/actions/guard";
import { providerLabel } from "@/lib/accounts-control";
import { buildAccountsRunsCsv } from "@/lib/accounts-runs-csv";
import { contentDispositionHeader } from "@/lib/archive";
import { categorizeRun } from "@/lib/spend-categories";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
const UTF8_BOM = "\uFEFF";

interface RunRow {
  model: string;
  vendor: string;
  cost_usd: number | null;
  user_id: string | null;
  projects: { user_id: string } | null;
  scenes: { duration_s: number } | null;
}

export async function GET(_request: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const supabase = await createClient();
  const runs: RunRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("runs")
      .select("model, vendor, cost_usd, user_id, projects ( user_id ), scenes ( duration_s )")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      return NextResponse.json({ error: `Failed to load runs: ${error.message}` }, { status: 500 });
    }
    const batch = (data ?? []) as unknown as RunRow[];
    runs.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const userIds = [
    ...new Set(
      runs
        .map((run) => run.user_id ?? run.projects?.user_id)
        .filter((userId): userId is string => Boolean(userId)),
    ),
  ];
  const usernames = new Map<string, string>();
  for (let from = 0; from < userIds.length; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username")
      .in("id", userIds.slice(from, from + PAGE_SIZE));
    if (error) {
      return NextResponse.json(
        { error: `Failed to load run usernames: ${error.message}` },
        { status: 500 },
      );
    }
    for (const profile of data ?? []) usernames.set(profile.id, profile.username);
  }

  const csv = buildAccountsRunsCsv(
    runs.map((run) => {
      const userId = run.user_id ?? run.projects?.user_id;
      return {
        username: userId ? (usernames.get(userId) ?? null) : null,
        model: run.model,
        provider: providerLabel(run.vendor),
        costUsd: run.cost_usd,
        durationS:
          categorizeRun(run.vendor, run.model) === "render"
            ? (run.scenes?.duration_s ?? null)
            : null,
      };
    }),
  );

  return new Response(UTF8_BOM + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDispositionHeader("all-runs.csv"),
      "Cache-Control": "no-store",
    },
  });
}
